//! The fonts against what pdf.js answered to the same files (`fixtures/pdf-reader`, recorded by
//! `benchmarks/rust-core/recorders/record-pdf-reader.mjs` from the Node product's own pdf.js 6.4.299).
//!
//! For every page of the recording that has text: the `str` of the `getTextContent` items, in order and without
//! separators, must be what the glyphs of the page's show-text operators say. The operator walk below is the minimum
//! that takes: `Tf`, `Tj`, `TJ`, `'`, `"`, `Do` of form XObjects and the font of an `ExtGState`. It is not the text
//! reader (the text-content task holds the item builder and its gate); it checks the Unicode mapping and the order
//! of the font objects before that exists.
//!
//! The `styles` of the page (the `fontFamily`, `ascent`, `descent` and `vertical` of each font that shows text) are
//! compared too, as a set: they come from the font objects.
//!
//! What the item builder does and the walk does not is undone on both sides before comparing: white space is dropped
//! (pdf.js turns the spaces of a line into its own), characters are normalised the way pdf.js normalises an item,
//! and a page with right-to-left text (which pdf.js reorders and mirrors) is compared as the sorted characters
//! without the mirrored ones. The reader goldens record two behaviours; the one followed here is the one of
//! `withReadableDataUrls`, where the predefined CMaps and the standard font data load, because the reference
//! configuration's `file:` urls do not load in Node and nothing in use may be narrowed.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::fonts::data;
use mixdog_pdf::fonts::font::{FontLoader, LoadContext, NoType3Scan, TranslatedFont};
use mixdog_pdf::{ByteStream, Dict, Lexer, Obj, Parser, Ref};
use serde_json::Value;

/// Pages whose text the walk cannot be expected to give, with the reason: `(file, page number, why)`.
const ALLOWED: &[(&str, usize, &str)] = &[
    (
        "samples/matplotlib-korean-truetype.pdf",
        1,
        "text outside the page box (the x axis label) is dropped by pdf.js's item builder",
    ),
    (
        "samples/matplotlib-truetype-fonts.pdf",
        1,
        "text outside the page box (the x axis label) is dropped by pdf.js's item builder",
    ),
    (
        "samples/matplotlib-type3-fonts.pdf",
        1,
        "text outside the page box (the x axis label) is dropped by pdf.js's item builder",
    ),
    (
        "samples/reportlab-truetype-subset.pdf",
        1,
        "the last letter of the first line passes the page's right edge and is dropped by the item builder",
    ),
];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pdf-reader")
}

// ---- the operator walk -----------------------------------------------------------------------------------------------

/// The deepest form XObject nesting the walk follows (pdf.js has no limit but its cycle guard).
const MAX_FORM_DEPTH: usize = 12;

/// One entry of a page's `styles`, as text (a number to six places, `null` for what JSON writes `null` for).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Style {
    family: String,
    ascent: String,
    descent: String,
    vertical: bool,
}

fn number_key(value: f64) -> String {
    if value.is_finite() {
        format!("{value:.6}")
    } else {
        "null".to_owned()
    }
}

struct Walk<'a> {
    document: &'a Document,
    loader: FontLoader,
    type3_refs: HashSet<Ref>,
    text: Vec<u16>,
    /// The style of each font (by loaded name) that showed a character that is not white space.
    styles: BTreeMap<String, Style>,
}

impl Walk<'_> {
    fn load_font(
        &self,
        name: Option<&str>,
        font: Option<&Obj>,
        resources: &Dict,
    ) -> Option<Arc<TranslatedFont>> {
        let context = LoadContext {
            type3_font_refs: &self.type3_refs,
            parsing_type3_font: false,
            type3: &NoType3Scan,
        };
        self.loader
            .load_font(self.document.xref(), name, font, resources, &context)
            .ok()
    }

    fn show(&mut self, font: &Option<Arc<TranslatedFont>>, chars: &[u8]) {
        let Some(font) = font else {
            return;
        };
        for glyph in font.chars_to_glyphs(chars) {
            if glyph.category().is_invisible_format_mark {
                continue;
            }
            self.text.extend_from_slice(&glyph.unicode);
            let visible = glyph.unicode.iter().any(|unit| {
                char::from_u32(u32::from(*unit)).is_none_or(|ch| !data::is_js_whitespace(ch))
            });
            if let (true, Some(font_object)) = (visible, font.font()) {
                self.styles
                    .entry(font.loaded_name.clone())
                    .or_insert_with(|| Style {
                        family: font_object.fallback_name.clone(),
                        ascent: number_key(font_object.ascent),
                        descent: number_key(font_object.descent),
                        vertical: font_object.vertical,
                    });
            }
        }
    }

    fn strings_of(value: Option<&Obj>) -> Vec<u8> {
        match value {
            Some(Obj::Str(bytes)) => bytes.to_vec(),
            Some(Obj::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    Obj::Str(bytes) => Some(bytes.to_vec()),
                    _ => None,
                })
                .flatten()
                .collect(),
            _ => Vec::new(),
        }
    }

    fn run(
        &mut self,
        content: &[u8],
        resources: &Dict,
        depth: usize,
        seen_forms: &mut HashSet<Ref>,
    ) {
        let xref = self.document.xref();
        let lexer = Lexer::new(ByteStream::from_vec(content.to_vec()), xref.guard().clone());
        let Ok(mut parser) = Parser::new(lexer, Some(xref), false, false) else {
            return;
        };
        let mut args: Vec<Obj> = Vec::new();
        let mut font: Option<Arc<TranslatedFont>> = None;
        loop {
            let Ok(obj) = parser.get_obj(None) else {
                break;
            };
            if obj.is_eof() {
                break;
            }
            let Obj::Cmd(command) = obj else {
                args.push(obj);
                if args.len() > 40 {
                    args.remove(0);
                }
                continue;
            };
            match &*command {
                "Tf" => {
                    let name = args.first().and_then(Obj::as_name).map(str::to_owned);
                    font = self.load_font(name.as_deref(), None, resources);
                }
                "Tj" | "TJ" => self.show(&font, &Self::strings_of(args.first())),
                "'" => self.show(&font, &Self::strings_of(args.first())),
                "\"" => self.show(&font, &Self::strings_of(args.get(2))),
                "gs" => {
                    let state = args
                        .first()
                        .and_then(Obj::as_name)
                        .and_then(|name| {
                            let states = xref.get(resources, "ExtGState").ok()?;
                            let states = states.as_dict()?.clone();
                            xref.get(&states, name).ok()
                        })
                        .and_then(|state| state.as_dict().cloned());
                    if let Some(state) = state
                        && let Ok(Obj::Array(entry)) = xref.get(&state, "Font")
                        && let Some(first) = entry.first()
                    {
                        font = self.load_font(None, Some(first), resources);
                    }
                }
                "Do" if depth < MAX_FORM_DEPTH => {
                    let Some(name) = args.first().and_then(Obj::as_name) else {
                        args.clear();
                        continue;
                    };
                    let Some(Ok(Obj::Dict(xobjects))) = resources
                        .has("XObject")
                        .then(|| xref.get(resources, "XObject"))
                    else {
                        args.clear();
                        continue;
                    };
                    let raw = xobjects.get_raw(name).cloned();
                    let reference = raw.as_ref().and_then(Obj::as_ref_value);
                    if let Some(reference) = reference
                        && !seen_forms.insert(reference)
                    {
                        args.clear();
                        continue;
                    }
                    if let Some(Ok(Obj::Stream(form))) =
                        raw.map(|raw| xref.fetch_if_ref(&raw, false))
                        && matches!(xref.get(&form.dict, "Subtype"), Ok(Obj::Name(kind)) if &*kind == "Form")
                        && let Ok(bytes) = form.decode(xref.filters().as_ref(), xref.guard())
                    {
                        let own = match xref.get(&form.dict, "Resources") {
                            Ok(Obj::Dict(own)) => own,
                            _ => Arc::new(resources.clone()),
                        };
                        self.run(&bytes, &own, depth + 1, seen_forms);
                    }
                    if let Some(reference) = reference {
                        seen_forms.remove(&reference);
                    }
                }
                _ => {}
            }
            args.clear();
        }
    }
}

/// What the glyphs of the show-text operators of page `index` say, in UTF-16, and the styles of their fonts.
fn page_text(document: &Document, index: usize, doc_id: &str) -> Option<(Vec<u16>, Vec<Style>)> {
    let page = document.page(index).ok()?;
    let resources = page.resources(document).ok()?;
    let content = page.content(document).ok()?;
    let mut walk = Walk {
        document,
        loader: FontLoader::new(doc_id, true),
        type3_refs: HashSet::new(),
        text: Vec::new(),
        styles: BTreeMap::new(),
    };
    walk.run(&content, &resources, 0, &mut HashSet::new());
    let mut styles: Vec<Style> = walk.styles.into_values().collect();
    styles.sort();
    Some((walk.text, styles))
}

// ---- comparing ---------------------------------------------------------------------------------------------------------

/// Characters that bidi mirrors inside right-to-left text.
const MIRRORED: &str = "()[]{}<>\u{ab}\u{bb}";

/// The text as compared: normalised like an item, without white space; a right-to-left page as its sorted characters
/// without the mirrored ones.
fn canonical(units: &[u16], right_to_left: bool) -> Vec<u16> {
    let normalised = data::normalize_unicode(&String::from_utf16_lossy(units));
    let mut kept: Vec<u16> = normalised
        .encode_utf16()
        .filter(|unit| {
            char::from_u32(u32::from(*unit)).is_none_or(|ch| {
                !data::is_js_whitespace(ch) && !(right_to_left && MIRRORED.contains(ch))
            })
        })
        .collect();
    if right_to_left {
        kept.sort_unstable();
    }
    kept
}

fn show(units: &[u16]) -> String {
    let text = String::from_utf16_lossy(units);
    text.chars().take(80).collect()
}

struct Recorded {
    file: String,
    number: usize,
    text: Vec<u16>,
    right_to_left: bool,
    styles: Vec<Style>,
}

/// The pages with text of every recording, as the target behaviour has them.
fn recorded_pages() -> Vec<Recorded> {
    let mut found = Vec::new();
    let manifest: Value = serde_json::from_str(&mixdog_testkit::read_string(
        fixtures().join("MANIFEST.json"),
    ))
    .expect("the manifest parses");
    for case in manifest["cases"].as_array().expect("the cases") {
        let path = fixtures()
            .join("goldens")
            .join(format!("{}.json", case.as_str().expect("a case name")));
        let golden: Value =
            serde_json::from_str(&mixdog_testkit::read_string(&path)).expect("a recording parses");
        let outcome = match golden["withReadableDataUrls"].get("outcome") {
            Some(readable)
                if golden["withReadableDataUrls"]["sameAsReference"] == Value::Bool(false) =>
            {
                readable
            }
            _ => &golden["outcome"],
        };
        if outcome["ok"] != Value::Bool(true) {
            continue;
        }
        for page in outcome["pages"].as_array().expect("pages") {
            let Some(items) = page["text"]["items"].as_array() else {
                continue;
            };
            let text: String = items
                .iter()
                .map(|item| item["str"].as_str().expect("an item has its text"))
                .collect();
            let mut styles: Vec<Style> = page["text"]["styles"]
                .as_object()
                .map(|styles| {
                    styles
                        .values()
                        .map(|style| Style {
                            family: style["fontFamily"].as_str().unwrap_or("").to_owned(),
                            ascent: style["ascent"]
                                .as_f64()
                                .map_or("null".to_owned(), number_key),
                            descent: style["descent"]
                                .as_f64()
                                .map_or("null".to_owned(), number_key),
                            vertical: style["vertical"] == Value::Bool(true),
                        })
                        .collect()
                })
                .unwrap_or_default();
            styles.sort();
            found.push(Recorded {
                file: golden["file"].as_str().expect("a file").to_owned(),
                number: page["number"].as_u64().expect("a page number") as usize,
                text: text.encode_utf16().collect(),
                right_to_left: items.iter().any(|item| item["dir"] == "rtl"),
                styles,
            });
        }
    }
    found
}

#[test]
fn the_glyph_text_of_every_page_is_the_text_pdfjs_extracts() {
    let pages = recorded_pages();
    assert!(
        pages.len() >= 150,
        "the pdf-reader recording has {} pages with text",
        pages.len()
    );
    let mut differences = Vec::new();
    let mut files: Vec<&str> = pages.iter().map(|page| page.file.as_str()).collect();
    files.dedup();
    let mut compared = 0;
    for file in files {
        let bytes = mixdog_testkit::read(fixtures().join(file));
        let Ok(document) = Document::open(bytes, &OpenOptions::default()) else {
            differences.push(format!("{file}: does not open"));
            continue;
        };
        for page in pages.iter().filter(|page| page.file == file) {
            if let Some((_, _, reason)) = ALLOWED
                .iter()
                .find(|(allowed, number, _)| *allowed == file && *number == page.number)
            {
                println!("{file} page {}: allowed ({reason})", page.number);
                continue;
            }
            compared += 1;
            let Some((walked, styles)) = page_text(&document, page.number - 1, "d0") else {
                differences.push(format!(
                    "{file} page {}: the page cannot be read",
                    page.number
                ));
                continue;
            };
            let ours = canonical(&walked, page.right_to_left);
            let theirs = canonical(&page.text, page.right_to_left);
            if styles != page.styles {
                differences.push(format!(
                    "{file} page {}: font styles {:?}, pdf.js {:?}",
                    page.number, styles, page.styles
                ));
            }
            if ours != theirs {
                differences.push(format!(
                    "{file} page {}: glyphs say {:?}, pdf.js {:?}",
                    page.number,
                    show(&ours),
                    show(&theirs)
                ));
            }
        }
    }
    println!("compared {compared} pages");
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}
