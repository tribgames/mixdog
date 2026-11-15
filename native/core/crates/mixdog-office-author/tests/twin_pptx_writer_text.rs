//! Twin test `pptx_writer_text`: the recording of pptxgenjs 4.0.1 for text boxes and tables
//! (`native/core/fixtures/office-pptx-writer-text/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-pptx-writer-text.mjs`) against this crate's writer. Every recorded case
//! is a list of API calls (`addSlide`, `addShape`, `addText`, `addTable`, `addNotes`): they are replayed here against
//! `pptx_writer::Presentation`, and the package that comes out must have the recorded entries in the recorded order,
//! every XML and relationships part equal after canonicalisation (attribute order, white space between tags; the two
//! timestamps of `docProps/core.xml` are the moment of writing) and every other part equal byte for byte. A call that
//! threw in Node must be refused with its text. Re-recording is `twin_live_pptx_writer_text` (ignored: it runs Node).

use base64::Engine;
use mixdog_office_author::pptx_writer::{
    Border, Borders, Bullet, BulletSpec, ColWidths, Dim, Fill, Glow, Hyperlink, Line, Margin, Outline, Presentation, RowHeights, Shadow, ShapeOptions, Strike, TabStop, TableCell, TableOptions, TextContent,
    TextOptions, TextRun, Underline,
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

fn count(value: &Value, key: &str) -> Option<usize> {
    value.get(key).and_then(Value::as_u64).map(|count| usize::try_from(count).expect("a span"))
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

/// A key that is present and not `null`.
fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|found| **found != Value::Null)
}

fn border(value: &Value) -> Border {
    Border { kind: text(value, "type"), color: text(value, "color"), pt: number(value, "pt") }
}

fn borders(value: &Value) -> Option<Borders> {
    match value {
        Value::Array(sides) => Some(Borders::Each(sides.iter().map(|side| (*side != Value::Null).then(|| border(side))).collect())),
        Value::Object(_) => Some(Borders::One(border(value))),
        _ => None,
    }
}

fn bullet(value: &Value) -> Option<Bullet> {
    match value {
        Value::Bool(on) => Some(Bullet::Flag(*on)),
        Value::Object(_) => Some(Bullet::Spec(BulletSpec {
            indent: number(value, "indent"),
            kind: text(value, "type"),
            style: text(value, "style"),
            number_start_at: number(value, "numberStartAt"),
            start_at: number(value, "startAt"),
            character_code: text(value, "characterCode"),
            code: text(value, "code"),
        })),
        _ => None,
    }
}

fn underline(value: &Value) -> Option<Underline> {
    match value {
        Value::Bool(on) => Some(Underline::Flag(*on)),
        Value::String(style) => Some(Underline::Text(style.clone())),
        Value::Object(_) => Some(Underline::Style { style: text(value, "style"), color: text(value, "color") }),
        _ => None,
    }
}

fn strike(value: &Value) -> Option<Strike> {
    match value {
        Value::Bool(on) => Some(Strike::Flag(*on)),
        Value::String(style) => Some(Strike::Style(style.clone())),
        _ => None,
    }
}

fn margin(value: &Value) -> Option<Margin> {
    match value {
        Value::Number(each) => each.as_f64().map(Margin::All),
        Value::Array(each) => Some(Margin::Each(each.iter().map(|one| one.as_f64().unwrap_or(0.0)).collect())),
        _ => None,
    }
}

/// The options of a text box, a run, a table cell or a table, as JavaScript objects hold them.
fn text_options(options: &Value) -> TextOptions {
    TextOptions {
        frame: ShapeOptions {
            x: dim(options, "x"),
            y: dim(options, "y"),
            w: dim(options, "w"),
            h: dim(options, "h"),
            fill: present(options, "fill").and_then(fill),
            line: present(options, "line").map(line),
            rect_radius: number(options, "rectRadius"),
            angle_range: options.get("angleRange").and_then(Value::as_array).map(|angles| [angles[0].as_f64().unwrap_or(0.0), angles[1].as_f64().unwrap_or(0.0)]),
            arc_thickness_ratio: number(options, "arcThicknessRatio"),
            rotate: number(options, "rotate"),
            flip_h: flag(options, "flipH"),
            flip_v: flag(options, "flipV"),
            shadow: present(options, "shadow").map(shadow),
            object_name: text(options, "objectName"),
            hyperlink: present(options, "hyperlink").map(hyperlink),
        },
        shape: text(options, "shape"),
        is_text_box: flag(options, "isTextBox"),
        color: text(options, "color"),
        font_face: text(options, "fontFace"),
        font_size: number(options, "fontSize"),
        bold: flag(options, "bold"),
        italic: flag(options, "italic"),
        strike: present(options, "strike").and_then(strike),
        underline: present(options, "underline").and_then(underline),
        baseline: number(options, "baseline"),
        subscript: flag(options, "subscript"),
        superscript: flag(options, "superscript"),
        char_spacing: number(options, "charSpacing"),
        transparency: number(options, "transparency"),
        highlight: text(options, "highlight"),
        glow: present(options, "glow").map(|glow| Glow { size: number(glow, "size"), color: text(glow, "color"), opacity: number(glow, "opacity") }),
        outline: present(options, "outline").map(|outline| Outline { size: number(outline, "size"), color: text(outline, "color") }),
        lang: text(options, "lang"),
        align: text(options, "align"),
        valign: text(options, "valign"),
        line_spacing: number(options, "lineSpacing"),
        line_spacing_multiple: number(options, "lineSpacingMultiple"),
        indent_level: number(options, "indentLevel"),
        para_space_before: number(options, "paraSpaceBefore"),
        para_space_after: number(options, "paraSpaceAfter"),
        bullet: present(options, "bullet").and_then(bullet),
        tab_stops: options.get("tabStops").and_then(Value::as_array).map(|stops| stops.iter().map(|stop| TabStop { position: number(stop, "position"), alignment: text(stop, "alignment") }).collect()),
        rtl_mode: flag(options, "rtlMode"),
        break_line: flag(options, "breakLine"),
        soft_break_before: flag(options, "softBreakBefore"),
        margin: present(options, "margin").and_then(margin),
        wrap: options.get("wrap").and_then(Value::as_bool),
        vert: text(options, "vert"),
        fit: text(options, "fit"),
        shrink_text: flag(options, "shrinkText"),
        auto_fit: flag(options, "autoFit"),
        inset: number(options, "inset"),
        border: present(options, "border").and_then(borders),
        colspan: count(options, "colspan"),
        rowspan: count(options, "rowspan"),
        text_direction: text(options, "textDirection"),
        hyperlink_rid: None,
    }
}

/// The text of a call or of a cell: a string or a number (JavaScript turns a number into its text), or runs.
fn content(value: &Value) -> TextContent {
    match value {
        Value::String(text) => TextContent::Plain(text.clone()),
        Value::Number(each) => TextContent::Plain(mixdog_js::number_to_string(each.as_f64().expect("a number"))),
        Value::Array(runs) => TextContent::Runs(runs.iter().map(|run| TextRun { text: text(run, "text").unwrap_or_default(), options: present(run, "options").map(text_options) }).collect()),
        _ => TextContent::Plain(String::new()),
    }
}

fn table_cell(value: &Value) -> TableCell {
    match value {
        Value::Object(_) => TableCell::Cell { text: content(&value["text"]), options: present(value, "options").map(text_options) },
        other => match content(other) {
            TextContent::Plain(text) => TableCell::Plain(text),
            runs => TableCell::Cell { text: runs, options: None },
        },
    }
}

fn each_number(values: &[Value]) -> Vec<f64> {
    values
        .iter()
        .map(|value| match value {
            Value::String(text) => text.parse().unwrap_or(f64::NAN),
            other => other.as_f64().unwrap_or(f64::NAN),
        })
        .collect()
}

fn table_options(options: &Value) -> TableOptions {
    TableOptions {
        text: text_options(options),
        col_w: match options.get("colW") {
            Some(Value::Array(widths)) => Some(ColWidths::Each(each_number(widths))),
            Some(Value::Number(width)) => width.as_f64().map(ColWidths::One),
            _ => None,
        },
        row_h: match options.get("rowH") {
            Some(Value::Array(heights)) => Some(RowHeights::Each(each_number(heights))),
            Some(Value::Number(height)) => height.as_f64().map(RowHeights::One),
            _ => None,
        },
        auto_page: flag(options, "autoPage"),
    }
}

/// One recorded call against the presentation; the answer is what pptxgenjs threw, if it threw.
fn apply(deck: &mut Presentation, call: &Value) -> Result<(), String> {
    let op = call["op"].as_str().expect("op");
    let slide = call["slide"].as_u64().map_or(0, |index| usize::try_from(index).expect("slide index"));
    let empty = Value::Null;
    let options = call.get("options").unwrap_or(&empty);
    match op {
        "layout" => deck.set_layout(call["name"].as_str().expect("name")),
        "addSlide" => {
            deck.add_slide();
            Ok(())
        }
        "addShape" => deck.slide_mut(slide).expect("slide").add_shape(call["shape"].as_str().expect("shape"), text_options(options).frame),
        "addText" => deck.slide_mut(slide).expect("slide").add_text(content(&call["text"]), call.get("options").map(text_options)),
        "addTable" => {
            let rows = call["rows"].as_array().expect("rows").iter().map(|row| row.as_array().expect("row").iter().map(table_cell).collect()).collect();
            deck.slide_mut(slide).expect("slide").add_table(rows, table_options(options))
        }
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
    let golden = twin::load_golden("office-pptx-writer-text");
    let blobs = golden["blobs"].as_object().expect("blobs");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 15, "the recording has {} cases", cases.len());
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
fn a_hyperlink_without_a_target_is_refused_with_the_text_pptxgenjs_writes_it_with() {
    let mut deck = Presentation::new();
    deck.add_slide();
    let options = TextOptions { frame: ShapeOptions { hyperlink: Some(Hyperlink { tooltip: Some("nothing".to_owned()), ..Hyperlink::default() }), ..ShapeOptions::default() }, ..TextOptions::default() };
    let refused = deck.slide_mut(0).expect("slide").add_text(TextContent::Runs(vec![TextRun { text: "x".to_owned(), options: Some(options) }]), None);
    assert_eq!(refused, Err("ERROR: 'hyperlink requires either `url` or `slide`'".to_owned()));
}

#[test]
fn an_empty_table_and_an_auto_paged_one_are_refused() {
    let mut deck = Presentation::new();
    deck.add_slide();
    let slide = deck.slide_mut(0).expect("slide");
    let empty = slide.add_table(Vec::new(), TableOptions::default());
    assert_eq!(empty, Err("addTable: Array expected! EX: 'slide.addTable( [rows], {options} );' (https://gitbrent.github.io/PptxGenJS/docs/api-tables.html)".to_owned()));
    assert!(slide.add_table(vec![vec![TableCell::Plain("a".to_owned())]], TableOptions { auto_page: true, ..TableOptions::default() }).is_err());
}

#[test]
fn the_canonical_form_sorts_attributes_and_drops_the_white_space_between_tags() {
    assert_eq!(canonical("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<a:x b=\"2\"  a=\"1\">\n\t<a:y z='3'/> text </a:x>"), "<?xml encoding=\"UTF-8\" version=\"1.0\"?><a:x a=\"1\" b=\"2\"><a:y z=\"3\"/> text </a:x>");
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_pptx_writer_text -- --ignored`.
#[test]
#[ignore = "re-records through Node (pptxgenjs)"]
fn twin_live_pptx_writer_text() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-pptx-writer-text.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_case_equals_the_recording();
}
