//! Twin test `pptx_writer`: the recording of pptxgenjs 4.0.1 (`native/core/fixtures/office-pptx-writer/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-pptx-writer.mjs`) against this crate's writer. Every recorded
//! case is a list of API calls: they are replayed here against `pptx_writer::Presentation`, and the package that comes
//! out must have the recorded entries in the recorded order, every XML and relationships part equal after
//! canonicalisation (attribute order, white space between tags; the two timestamps of `docProps/core.xml` are the moment
//! of writing) and every other part equal byte for byte. A call that threw in Node must be refused with its text.
//! Re-recording is `twin_live_pptx_writer` (ignored: it runs Node).

use base64::Engine;
use mixdog_office_author::pptx_writer::{
    Background, Dim, Fill, Hyperlink, ImageOptions, ImageSizing, Line, Presentation, Shadow, ShapeOptions, SizingKind, SlideNumber, SlideNumberMargin, ThemeFonts,
};
use mixdog_office_base::twin;
use serde_json::Value;

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// A position or size as JavaScript passes it: a number, a numeric string, or a percentage string.
fn dim(value: &Value, key: &str) -> Option<Dim> {
    match value.get(key)? {
        Value::Number(number) => number.as_f64().map(Dim::Number),
        Value::String(text) if text.contains('%') => text.trim_end_matches('%').parse().ok().map(Dim::Percent),
        Value::String(text) => Some(Dim::Number(text.parse().unwrap_or(0.0))),
        _ => None,
    }
}

fn fill(value: &Value) -> Option<Fill> {
    match value {
        Value::String(color) if color.is_empty() => None,
        Value::String(color) => Some(Fill::color(color)),
        Value::Object(_) => Some(Fill { kind: text(value, "type"), color: text(value, "color"), alpha: number(value, "alpha"), transparency: number(value, "transparency") }),
        _ => None,
    }
}

fn line(value: &Value) -> Line {
    Line {
        kind: text(value, "type"),
        color: text(value, "color"),
        transparency: number(value, "transparency"),
        width: number(value, "width"),
        dash_type: text(value, "dashType"),
        begin_arrow_type: text(value, "beginArrowType"),
        end_arrow_type: text(value, "endArrowType"),
    }
}

fn shadow(value: &Value) -> Shadow {
    Shadow { kind: text(value, "type"), color: text(value, "color"), blur: number(value, "blur"), offset: number(value, "offset"), angle: number(value, "angle"), opacity: number(value, "opacity") }
}

fn hyperlink(value: &Value) -> Hyperlink {
    Hyperlink { url: text(value, "url"), slide: number(value, "slide"), tooltip: text(value, "tooltip") }
}

fn shape_options(options: &Value) -> ShapeOptions {
    ShapeOptions {
        x: dim(options, "x"),
        y: dim(options, "y"),
        w: dim(options, "w"),
        h: dim(options, "h"),
        fill: options.get("fill").and_then(fill),
        line: options.get("line").map(line),
        rect_radius: number(options, "rectRadius"),
        angle_range: options.get("angleRange").and_then(Value::as_array).map(|angles| [angles[0].as_f64().unwrap_or(0.0), angles[1].as_f64().unwrap_or(0.0)]),
        arc_thickness_ratio: number(options, "arcThicknessRatio"),
        rotate: number(options, "rotate"),
        flip_h: flag(options, "flipH"),
        flip_v: flag(options, "flipV"),
        shadow: options.get("shadow").map(shadow),
        object_name: text(options, "objectName"),
        hyperlink: options.get("hyperlink").map(hyperlink),
    }
}

fn image_options(options: &Value) -> ImageOptions {
    let sizing = options.get("sizing").map(|sizing| ImageSizing {
        kind: match sizing["type"].as_str() {
            Some("cover") => SizingKind::Cover,
            Some("contain") => SizingKind::Contain,
            Some("crop") => SizingKind::Crop,
            other => panic!("the replay does not know the sizing {other:?}"),
        },
        x: dim(sizing, "x"),
        y: dim(sizing, "y"),
        w: dim(sizing, "w"),
        h: dim(sizing, "h"),
    });
    ImageOptions {
        data: text(options, "data"),
        file: None,
        x: dim(options, "x"),
        y: dim(options, "y"),
        w: dim(options, "w"),
        h: dim(options, "h"),
        alt_text: text(options, "altText"),
        rounding: flag(options, "rounding"),
        sizing,
        rotate: number(options, "rotate"),
        flip_h: flag(options, "flipH"),
        flip_v: flag(options, "flipV"),
        transparency: number(options, "transparency"),
        object_name: text(options, "objectName"),
        shadow: options.get("shadow").map(shadow),
        hyperlink: options.get("hyperlink").map(hyperlink),
    }
}

fn slide_number(props: &Value) -> SlideNumber {
    SlideNumber {
        x: dim(props, "x"),
        y: dim(props, "y"),
        w: dim(props, "w"),
        h: dim(props, "h"),
        margin: match props.get("margin") {
            Some(Value::Array(values)) => Some(SlideNumberMargin::Each(values.iter().map(|value| value.as_f64().unwrap_or(0.0)).collect())),
            Some(Value::Number(value)) => value.as_f64().map(SlideNumberMargin::All),
            _ => None,
        },
        valign: text(props, "valign"),
        align: text(props, "align"),
        font_face: text(props, "fontFace"),
        font_size: number(props, "fontSize"),
        color: text(props, "color"),
        bold: flag(props, "bold"),
    }
}

/// What pptxgenjs only reports on the console, then adds nothing.
fn console_only(message: &str) -> bool {
    message.starts_with("ERROR: addImage() requires") || message.starts_with("ERROR: Image `data` value lacks")
}

/// One recorded call against the presentation; the answer is what pptxgenjs threw, if it threw.
fn apply(deck: &mut Presentation, call: &Value) -> Result<(), String> {
    let op = call["op"].as_str().expect("op");
    let slide = call["slide"].as_u64().map_or(0, |index| usize::try_from(index).expect("slide index"));
    let empty = Value::Null;
    let options = call.get("options").unwrap_or(&empty);
    match op {
        "layout" => deck.set_layout(call["name"].as_str().expect("name")),
        "defineLayout" => {
            deck.define_layout(call["name"].as_str().expect("name"), call["width"].as_f64().expect("width"), call["height"].as_f64().expect("height"));
            Ok(())
        }
        "set" => {
            let value = &call["value"];
            match call["key"].as_str().expect("key") {
                "title" => deck.set_title(value.as_str().expect("title")),
                "subject" => deck.set_subject(value.as_str().expect("subject")),
                "author" => deck.set_author(value.as_str().expect("author")),
                "company" => deck.set_company(value.as_str().expect("company")),
                "revision" => deck.set_revision(value.as_str().expect("revision")),
                "rtlMode" => deck.set_rtl_mode(value.as_bool().expect("rtlMode")),
                "theme" => deck.set_theme(ThemeFonts { head_font_face: text(value, "headFontFace"), body_font_face: text(value, "bodyFontFace") }),
                other => panic!("the replay does not know the property {other}"),
            }
            Ok(())
        }
        "addSlide" => {
            deck.add_slide();
            Ok(())
        }
        "hidden" => {
            deck.slide_mut(slide).expect("slide").set_hidden(true);
            Ok(())
        }
        "background" => {
            let props = &call["props"];
            deck.slide_mut(slide).expect("slide").set_background(Background { color: text(props, "color"), fill: text(props, "fill"), transparency: number(props, "transparency"), data: text(props, "data"), file: None });
            Ok(())
        }
        "slideNumber" => deck.set_slide_number(slide, slide_number(&call["props"])),
        "addShape" => deck.slide_mut(slide).expect("slide").add_shape(call["shape"].as_str().expect("shape"), shape_options(options)),
        "addImage" => deck.slide_mut(slide).expect("slide").add_image(image_options(options)),
        "addNotes" => {
            deck.slide_mut(slide).expect("slide").add_notes(call["text"].as_str().expect("text"));
            Ok(())
        }
        other => panic!("the replay does not know the call {other}"),
    }
}

fn replay(calls: &[Value]) -> Presentation {
    let mut deck = Presentation::new();
    for call in calls {
        let outcome = apply(&mut deck, call);
        match (call.get("thrown").and_then(Value::as_str), outcome) {
            (Some(thrown), Err(message)) => assert_eq!(message, thrown, "the text of a refused {} call", call["op"]),
            (Some(thrown), Ok(())) => panic!("pptxgenjs threw `{thrown}` for {call}, the writer took it"),
            (None, Ok(())) => {}
            (None, Err(message)) if call["op"] == "addImage" && console_only(&message) => {}
            (None, Err(message)) => panic!("the writer refused {call}: {message}"),
        }
    }
    deck
}

/// The XML with the attributes of each tag in name order and the white space between tags gone.
fn canonical(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(open) = rest.find('<') {
        let between = &rest[..open];
        if !between.trim().is_empty() {
            out.push_str(between);
        }
        let tail = &rest[open..];
        let mut quote = None;
        let mut end = tail.len() - 1;
        for (at, ch) in tail.char_indices() {
            match (quote, ch) {
                (None, '"' | '\'') => quote = Some(ch),
                (Some(open_quote), found) if found == open_quote => quote = None,
                (None, '>') => {
                    end = at;
                    break;
                }
                _ => {}
            }
        }
        out.push_str(&canonical_tag(&tail[..=end]));
        rest = &tail[end + 1..];
    }
    if !rest.trim().is_empty() {
        out.push_str(rest);
    }
    out
}

fn canonical_tag(tag: &str) -> String {
    let inner = tag.trim_start_matches('<').trim_end_matches('>');
    let (inner, closing) = match inner.strip_suffix('/') {
        Some(inner) => (inner, "/"),
        None => match inner.strip_suffix('?') {
            Some(inner) => (inner, "?"),
            None => (inner, ""),
        },
    };
    let name_end = inner.find(|ch: char| ch.is_whitespace()).unwrap_or(inner.len());
    let (name, mut attributes_text) = inner.split_at(name_end);
    if name.starts_with('/') || name.starts_with('!') {
        return format!("<{}>", inner.trim());
    }
    let mut attributes = Vec::new();
    loop {
        attributes_text = attributes_text.trim_start();
        let Some(eq) = attributes_text.find('=') else { break };
        let key = attributes_text[..eq].trim();
        let after = attributes_text[eq + 1..].trim_start();
        let Some(quote) = after.chars().next() else { break };
        let Some(close) = after[1..].find(quote) else { break };
        attributes.push((key.to_owned(), after[1..=close].to_owned()));
        attributes_text = &after[close + 2..];
    }
    attributes.sort();
    let attributes: String = attributes.iter().map(|(key, value)| format!(" {key}=\"{value}\"")).collect();
    format!("<{name}{attributes}{closing}>")
}

/// `docProps/core.xml` without the two times, which are the moment of writing.
fn without_times(xml: &str) -> String {
    let mut out = xml.to_owned();
    for tag in ["created", "modified"] {
        let open = format!("<dcterms:{tag} xsi:type=\"dcterms:W3CDTF\">");
        if let Some(at) = out.find(&open) {
            let from = at + open.len();
            if let Some(len) = out[from..].find('<') {
                out.replace_range(from..from + len, "<time>");
            }
        }
    }
    out
}

fn cut(text: &str, around: usize) -> String {
    let start = text.char_indices().map(|(at, _)| at).rfind(|at| *at <= around.saturating_sub(60)).unwrap_or(0);
    text[start..].chars().take(200).collect()
}

fn compare_text(case: &str, part: &str, expected: &str, actual: &str, failures: &mut Vec<String>) {
    let (want, got) = if part == "docProps/core.xml" { (without_times(expected), without_times(actual)) } else { (expected.to_owned(), actual.to_owned()) };
    let (want, got) = (canonical(&want), canonical(&got));
    if want != got {
        let at = want.chars().zip(got.chars()).take_while(|(left, right)| left == right).count();
        failures.push(format!("{case}: {part} differs at {at}\n  recorded ...{}\n  produced ...{}", cut(&want, at), cut(&got, at)));
    }
}

fn every_case_equals_the_recording() {
    let golden = twin::load_golden("office-pptx-writer");
    let blobs = golden["blobs"].as_object().expect("blobs");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 20, "the recording has {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let calls = case["calls"].as_array().expect("calls");
        let package = replay(calls).package().unwrap_or_else(|error| panic!("{name}: {error}"));
        let parts = case["parts"].as_array().expect("parts");
        let recorded: Vec<&str> = parts.iter().map(|part| part["name"].as_str().expect("part name")).collect();
        let produced = package.names();
        if recorded != produced.iter().map(String::as_str).collect::<Vec<_>>() {
            failures.push(format!("{name}: entries\n  recorded {recorded:?}\n  produced {produced:?}"));
            continue;
        }
        for part in parts {
            let part_name = part["name"].as_str().expect("part name");
            if part["dir"].as_bool().unwrap_or(false) {
                assert!(package.entry(part_name).is_some_and(|entry| entry.dir), "{name}: {part_name} is a folder");
                continue;
            }
            let blob = &blobs[part["blob"].as_str().expect("blob id")];
            let bytes = package.file(part_name).unwrap_or_else(|| panic!("{name}: {part_name} has no content"));
            match blob["text"].as_str() {
                Some(expected) => compare_text(name, part_name, expected, &String::from_utf8_lossy(bytes), &mut failures),
                None => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                    if blob["base64"].as_str() != Some(encoded.as_str()) {
                        failures.push(format!("{name}: {part_name} bytes differ"));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} differences\n{}", failures.len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn every_package_equals_the_recorded_one() {
    every_case_equals_the_recording();
}

#[test]
fn the_canonical_form_sorts_attributes_and_drops_the_white_space_between_tags() {
    assert_eq!(canonical("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<a:x b=\"2\"  a=\"1\">\n\t<a:y z='3'/> text </a:x>"), "<?xml encoding=\"UTF-8\" version=\"1.0\"?><a:x a=\"1\" b=\"2\"><a:y z=\"3\"/> text </a:x>");
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_pptx_writer -- --ignored`.
#[test]
#[ignore = "re-records through Node (pptxgenjs)"]
fn twin_live_pptx_writer() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-pptx-writer.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_case_equals_the_recording();
}
