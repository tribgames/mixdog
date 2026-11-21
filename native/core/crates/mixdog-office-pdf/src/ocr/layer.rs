//! The invisible text layer of a recognised page (`pdf/pdf-ocr.mjs` `placeRecognizedText`, and the drawing of pdf-lib's
//! `drawText` with `opacity: 0`).

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_js::number_to_string;
use mixdog_pdf::embed::{EmbedError, Font, SuffixRng};
use mixdog_pdf::write::PdfDocument;
use mixdog_pdf::write::flate_stream;
use mixdog_pdf::{Dict, Obj, Ref};

use super::tsv::{OcrLine, OcrWord};
use crate::analysis::{js_max, js_min};

/// What one page was read as: the lines the engine's table gave, in the pixels of the image that was read.
#[derive(Debug, Clone)]
pub struct RecognizedPage {
    pub page_number: usize,
    pub image_width: f64,
    pub image_height: f64,
    pub lines: Vec<OcrLine>,
    pub text: String,
}

/// The words placed so far, how many were left out for want of a glyph, and the sum of the confidences of the placed.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tally {
    pub word_count: usize,
    pub skipped_words: usize,
    pub total_confidence: f64,
}

/// A run of text: where its baseline starts (user space, origin bottom left) and the size it is set in.
#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub size: f64,
}

/// A box in image pixels.
struct Region {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

/// The words of the page that reach `min_confidence`, with the line each belongs to (`words` of `recognizePage`).
pub(crate) fn kept_words(lines: &[OcrLine], min_confidence: f64) -> impl Iterator<Item = (usize, usize, &OcrWord)> + '_ {
    lines
        .iter()
        .enumerate()
        .flat_map(|(line, entry)| entry.words.iter().enumerate().map(move |(word, found)| (line, word, found)))
        .filter(move |(_, _, word)| word.confidence >= min_confidence)
}

/// Plans the text layer of one page of `page_width` by `page_height` points.
pub fn plan_page(
    recognized: &RecognizedPage,
    page_width: f64,
    page_height: f64,
    font: &Font,
    min_confidence: f64,
    tally: &mut Tally,
) -> Result<Vec<Placement>, EmbedError> {
    let scale_x = page_width / recognized.image_width;
    let scale_y = page_height / recognized.image_height;
    let mut placed = Vec::new();
    // Fit the invisible text to its box in both directions so extraction reads it as one phrase and layout queries land
    // where the picture shows it.
    let mut place = |value: &str, region: Region| -> Result<(), EmbedError> {
        let natural_width = font.width_of_text_at_size(value, 1.0)?;
        let by_width = if natural_width > 0.0 { (region.width * scale_x) / natural_width } else { f64::INFINITY };
        placed.push(Placement {
            text: value.to_owned(),
            x: region.left * scale_x,
            y: page_height - (region.top + region.height) * scale_y,
            size: js_max(3.0, js_min(region.height * scale_y * 0.8, by_width)),
        });
        Ok(())
    };
    let mut settled: HashSet<(usize, usize)> = HashSet::new();
    for (index, line) in recognized.lines.iter().enumerate() {
        let kept: Vec<&OcrWord> = line.words.iter().filter(|word| word.confidence >= min_confidence).collect();
        // A dropped word, a column gap, or a glyph the font lacks sends this row back to its boxes: a stretched run would
        // then carry text the page does not show, or show it in the wrong place.
        if kept.len() != line.words.len() {
            continue;
        }
        if line.column_gap > line.height * 1.5 {
            continue;
        }
        if line.text.is_empty() || !font.covers(&line.text) {
            continue;
        }
        place(&line.text, Region { left: line.left, top: line.top, width: line.width, height: line.height })?;
        for word in 0..line.words.len() {
            settled.insert((index, word));
        }
        tally.word_count += kept.len();
        tally.total_confidence += kept.iter().fold(0.0, |sum, word| sum + word.confidence);
    }
    for (line, index, word) in kept_words(&recognized.lines, min_confidence) {
        if settled.contains(&(line, index)) {
            continue;
        }
        if !font.covers(&word.text) {
            tally.skipped_words += 1;
            continue;
        }
        place(&word.text, Region { left: word.left, top: word.top, width: word.width, height: word.height })?;
        tally.word_count += 1;
        tally.total_confidence += word.confidence;
    }
    Ok(placed)
}

/// The page's resources as they stand, inherited ones included (`Resources` is an inheritable attribute).
fn page_resources(document: &PdfDocument, page: Ref) -> Dict {
    let store = document.store();
    let mut current = page;
    for _ in 0..64 {
        let Some(dict) = store.dict(current) else { break };
        if let Some(found) = dict.get_raw("Resources").and_then(|raw| store.resolve(raw)).and_then(Obj::as_dict) {
            return (**found).clone();
        }
        match dict.get_raw("Parent").and_then(Obj::as_ref_value) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    Dict::new()
}

/// A copy of the dictionary under `key` of `resources` (a reference followed), empty when there is none.
fn sub_dictionary(document: &PdfDocument, resources: &Dict, key: &str) -> Dict {
    resources.get_raw(key).and_then(|raw| document.store().resolve(raw)).and_then(Obj::as_dict).map_or_else(Dict::new, |found| (**found).clone())
}

/// A resource name not yet in `taken`.
fn fresh_name(rng: &mut SuffixRng, prefix: &str, taken: &Dict) -> String {
    loop {
        let name = rng.name(prefix, 10);
        if !taken.has(&name) {
            return name;
        }
    }
}

fn stream_of(document: &mut PdfDocument, contents: &[u8]) -> Ref {
    document.store_mut().register(flate_stream(Dict::new(), contents))
}

/// The page's `Contents` as a list of references, whatever form it was written in.
fn content_refs(document: &PdfDocument, page: Ref) -> Vec<Obj> {
    let store = document.store();
    let Some(raw) = store.dict(page).and_then(|dict| dict.get_raw("Contents")) else {
        return Vec::new();
    };
    match store.resolve(raw) {
        Some(Obj::Array(items)) => items.iter().cloned().collect(),
        Some(Obj::Stream(_)) => vec![raw.clone()],
        _ => Vec::new(),
    }
}

/// `<hex>` of a string's bytes.
fn hex_string(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + 2);
    out.push('<');
    for byte in bytes {
        out.push_str(&format!("{byte:02X}"));
    }
    out.push('>');
    out
}

/// The content stream of the invisible text of one page: the runs set in the font under the names given.
fn layer_stream(font: &Font, placements: &[Placement], font_key: &str, state_key: &str) -> Result<String, EmbedError> {
    let mut ops = format!("q\n/{state_key} gs\nBT\n0 0 0 rg\n");
    for placement in placements {
        let encoded = font.encode_text(&placement.text)?;
        ops.push_str(&format!(
            "/{font_key} {} Tf\n1 0 0 1 {} {} Tm\n{} Tj\n",
            number_to_string(placement.size),
            number_to_string(placement.x),
            number_to_string(placement.y),
            hex_string(&encoded),
        ));
    }
    ops.push_str("ET\nQ\n");
    Ok(ops)
}

/// The names and objects a layer stream refers to.
struct LayerResources {
    font_key: String,
    state_key: String,
    font_ref: Ref,
    state_ref: Ref,
}

/// Appends `ops` after the page's own content (wrapped, so that an unbalanced one cannot leak its state into the layer)
/// and names the font and the graphics state in the page's resources.
fn attach_layer(document: &mut PdfDocument, rng: &mut SuffixRng, page: Ref, ops: &str, layer: &LayerResources) {
    let mut resources = page_resources(document, page);
    let mut fonts = sub_dictionary(document, &resources, "Font");
    let mut states = sub_dictionary(document, &resources, "ExtGState");
    let font_name = if fonts.has(&layer.font_key) { fresh_name(rng, "F", &fonts) } else { layer.font_key.clone() };
    let state_name = if states.has(&layer.state_key) { fresh_name(rng, "GS", &states) } else { layer.state_key.clone() };
    fonts.set(&font_name, Obj::Ref(layer.font_ref));
    states.set(&state_name, Obj::Ref(layer.state_ref));
    resources.set("Font", Obj::Dict(Arc::new(fonts)));
    resources.set("ExtGState", Obj::Dict(Arc::new(states)));
    let ops =
        ops.replace(&format!("/{} ", layer.font_key), &format!("/{font_name} ")).replace(&format!("/{} gs", layer.state_key), &format!("/{state_name} gs"));
    let existing = content_refs(document, page);
    let mut contents: Vec<Obj> = Vec::with_capacity(existing.len() + 3);
    if !existing.is_empty() {
        contents.push(Obj::Ref(stream_of(document, b"q\n")));
        contents.extend(existing);
        contents.push(Obj::Ref(stream_of(document, b"Q\n")));
    }
    contents.push(Obj::Ref(stream_of(document, ops.as_bytes())));
    document.store_mut().modify_dict(page, |dict| {
        dict.set("Resources", Obj::Dict(Arc::new(resources)));
        dict.set("Contents", Obj::Array(Arc::new(contents)));
    });
}

/// Writes the invisible text of each `(page, placements)` onto `document`: the font once, a graphics state of opacity 0
/// once, and one content stream per page appended after the page's own.
pub fn draw_layer(document: &mut PdfDocument, font: &Font, pages: &[(Ref, Vec<Placement>)]) -> Result<(), EmbedError> {
    let mut rng = SuffixRng::default();
    let font_key = rng.name("F", 10);
    let state_key = rng.name("GS", 10);
    // The text is encoded before the font is written: an embedded face keeps only the glyphs that were encoded.
    let mut streams: Vec<(Ref, String)> = Vec::new();
    for (page, placements) in pages {
        if !placements.is_empty() {
            streams.push((*page, layer_stream(font, placements, &font_key, &state_key)?));
        }
    }
    if streams.is_empty() {
        return Ok(());
    }
    let font_ref = font.embed_into(document.store_mut(), None, &mut rng)?;
    let mut state = Dict::new();
    state.set("Type", Obj::name("ExtGState"));
    state.set("ca", Obj::Num(0.0));
    state.set("CA", Obj::Num(0.0));
    let state_ref = document.store_mut().register(Obj::Dict(Arc::new(state)));
    let layer = LayerResources { font_key, state_key, font_ref, state_ref };
    for (page, ops) in streams {
        attach_layer(document, &mut rng, page, &ops, &layer);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use mixdog_pdf::embed::{Font, StandardFontName};

    use super::*;

    fn word(text: &str, confidence: f64, left: f64, top: f64, width: f64, height: f64) -> OcrWord {
        OcrWord { text: text.to_owned(), confidence, left, top, width, height }
    }

    fn line(words: Vec<OcrWord>, text: &str) -> OcrLine {
        let left = words.iter().map(|w| w.left).fold(f64::INFINITY, f64::min);
        let top = words.iter().map(|w| w.top).fold(f64::INFINITY, f64::min);
        let right = words.iter().map(|w| w.left + w.width).fold(f64::NEG_INFINITY, f64::max);
        let bottom = words.iter().map(|w| w.top + w.height).fold(f64::NEG_INFINITY, f64::max);
        let gap = words.windows(2).fold(0.0, |widest: f64, pair| widest.max(pair[1].left - (pair[0].left + pair[0].width)));
        OcrLine { text: text.to_owned(), from_engine: true, words, left, top, width: right - left, height: bottom - top, column_gap: gap }
    }

    fn page(lines: Vec<OcrLine>) -> RecognizedPage {
        RecognizedPage { page_number: 1, image_width: 1000.0, image_height: 2000.0, lines, text: String::new() }
    }

    #[test]
    fn an_intact_row_is_one_run_fitted_to_its_box() {
        let font = Font::standard(StandardFontName::Helvetica);
        let row = line(vec![word("Hello", 90.0, 100.0, 200.0, 100.0, 40.0), word("world", 80.0, 220.0, 200.0, 100.0, 40.0)], "Hello world");
        let mut tally = Tally::default();
        let placed = plan_page(&page(vec![row]), 500.0, 1000.0, &font, 40.0, &mut tally).expect("planned");
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].text, "Hello world");
        assert_eq!(placed[0].x, 50.0);
        assert_eq!(placed[0].y, 1000.0 - 240.0 * 0.5);
        let natural = font.width_of_text_at_size("Hello world", 1.0).expect("width");
        assert_eq!(placed[0].size, js_max(3.0, js_min(40.0 * 0.5 * 0.8, (220.0 * 0.5) / natural)));
        assert_eq!((tally.word_count, tally.skipped_words, tally.total_confidence), (2, 0, 170.0));
    }

    #[test]
    fn a_dropped_word_or_a_column_gap_sends_the_row_back_to_its_boxes() {
        let font = Font::standard(StandardFontName::Helvetica);
        let dropped = line(vec![word("Keep", 90.0, 10.0, 10.0, 60.0, 20.0), word("drop", 10.0, 80.0, 10.0, 60.0, 20.0)], "Keep drop");
        let columns = line(vec![word("Left", 90.0, 10.0, 100.0, 60.0, 20.0), word("Right", 90.0, 500.0, 100.0, 60.0, 20.0)], "Left Right");
        let mut tally = Tally::default();
        let placed = plan_page(&page(vec![dropped, columns]), 1000.0, 2000.0, &font, 40.0, &mut tally).expect("planned");
        assert_eq!(placed.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["Keep", "Left", "Right"]);
        assert_eq!(tally.word_count, 3);
        assert_eq!(tally.total_confidence, 270.0);
    }

    #[test]
    fn a_word_no_glyph_covers_is_counted_and_not_placed() {
        let font = Font::standard(StandardFontName::Helvetica);
        let row = line(vec![word("Ω", 90.0, 10.0, 10.0, 30.0, 20.0)], "Ω");
        let mut tally = Tally::default();
        let placed = plan_page(&page(vec![row]), 1000.0, 2000.0, &font, 40.0, &mut tally).expect("planned");
        assert!(placed.is_empty());
        assert_eq!((tally.word_count, tally.skipped_words), (0, 1));
    }

    #[test]
    fn the_size_never_falls_below_three_points() {
        let font = Font::standard(StandardFontName::Helvetica);
        let row = line(vec![word("tiny", 90.0, 10.0, 10.0, 4.0, 2.0)], "tiny");
        let mut tally = Tally::default();
        let placed = plan_page(&page(vec![row]), 1000.0, 2000.0, &font, 40.0, &mut tally).expect("planned");
        assert_eq!(placed[0].size, 3.0);
    }
}
