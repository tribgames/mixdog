//! `authoring/pptx-brief.mjs` and `htmlBriefScript` of `authoring/pptx-html-runner.mjs`: the authoring brief.
//!
//! The brief is a comment block at the top of the script (the pptx skill, section 3), or the HTML comment that
//! opens with `BRIEF` in an HTML deck. The runtime reads it back as information: the slide plan (each slide's job,
//! relationship, move, composition and carriers), the three directions and the selected one, the style line, and
//! the fact sheet (which numbers the deck may show, with their sources). The plan is the contract the author
//! writes before any geometry exists, and [`plan_gate`] holds the deck to it.
//!
//! The brief, the saved deck's snapshot (`{ slides: [{ index, shapes: [...] }] }`) and every answer are JSON values
//! with the key order Node writes, so the wording and the figures are Node's.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, is_js_space, js_to_lowercase, js_trim, json_number, number_to_string, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_office_design::discipline::is_picture_shape;
use mixdog_office_quality::issue::issue_with;
use serde_json::{Map, Value, json};

const PLAN_KEYS: [&str; 7] = ["job", "relationship", "move", "composition", "carriers", "texture", "rhythm"];

macro_rules! pattern {
    ($name:ident, $pattern:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
    };
}

pattern!(COMMENT_LINE, r"^\s*//", "");
pattern!(COMMENT_PREFIX, r"^\s*//\s*", "");
pattern!(NEXT_BRIEF_KEY, r"^\s*//\s*[a-z][a-z /-]*:", "i");
pattern!(DOT_RUN, r"(?:\s*·\s*){2,}", "g");
pattern!(SPACES, r"\s+", "g");
pattern!(DOT_SEPARATOR, r"\s*·\s*", "");
pattern!(PLAN_START, r"^(\d+)\s+(.*)$", "");
pattern!(PLAN_FIELD, r"^([a-z]+)\s*:\s*(.*)$", "i");
pattern!(CARRIER_SEPARATOR, r"\s*[,+/]\s*", "");
pattern!(ROLE_COVER, r"\bcover\b", "i");
pattern!(ROLE_CLOSING, r"\bclosing\b", "i");
pattern!(ROLE_SECTION, r"\bsection\b", "i");
pattern!(DIRECTION_PICK, r"^selected\s*:\s*([A-Za-z0-9]+)", "i");
pattern!(DIRECTION_CANDIDATE, r"^([A-Z]|\d)\b[\s:.)-]*(.+)$", "");
pattern!(DIRECTION_WHY, r"^why\s*:", "i");
pattern!(FACT_LINE, r"^(F\d+)\s+(.+?)\s+[—–-]\s+(.+)$", "");
pattern!(
    LOCATOR,
    r"\bp\.?\s?\d|\bpage\s*\d|\d+\s*(?:쪽|페이지)|![A-Z]{1,3}\$?\d+|§\s*\d|https?:\/\/|\bslide\s*\d|\bsheet\s*\d|\bfig(?:ure)?\.?\s*\d|\btable\s*\d|\bline\s*\d|\b\d+:\d+",
    "i"
);
pattern!(SAMPLE_FACTS, r"^\s*(?:sample|illustrative|example)\b\s*[—–:-]?\s*", "i");
pattern!(STYLE_FAMILY, r"^\s*([a-z-]+)", "i");
pattern!(BRIEF_MARK, r"//\s*BRIEF\b", "");
pattern!(STYLE_PALETTE, r"\bpalette\s*:\s*([^·]+)", "i");
pattern!(READING_MODE_WORD, r"^\s*([a-z]+)", "i");
pattern!(STYLE_MODE, r"\bMODE\s+([a-z]+)", "");
pattern!(ARGUMENT_MODE_IN_LINE, r"argument mode\s*:\s*([a-z]+)", "i");
pattern!(NUMBER, r"(?<![\w.])[+\-−]?\d[\d,]*(?:\.\d+)?\s?%?(?![\w.])", "g");
pattern!(DATE, r"^\d{4}$|^\d{4}[-.](?:0[1-9]|1[0-2])(?:[-.](?:0[1-9]|[12]\d|3[01]))?$", "");
pattern!(DATELINE, r"(?<![\d.])\d{4}[-.](?:0[1-9]|1[0-2])(?:[-.](?:0[1-9]|[12]\d|3[01]))?(?![\d.])", "g");
pattern!(SHORT_NUMBER, r"^\d{1,2}$", "");
pattern!(HTML_BRIEF, r"<!--\s*BRIEF\b([\s\S]*?)-->", "");
pattern!(LINE_LEAD, r"^\s*(?:\/\/\s*)?", "");

/// `facts: sample` declares every figure illustrative: no fact sheet exists, the author gate lets the deck land, and
/// the delivery says the numbers are examples.
pub const FACTS_SAMPLE_DISCLOSURE: &str =
    "The brief declares facts: sample — every figure on this deck is illustrative. Tell the user so in the delivery and never present the numbers as measured.";

/// `text.split(separator)` for a separator that never matches the empty text.
fn split_by<'a>(separator: &JsRegex, text: &'a str) -> Vec<&'a str> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in separator.find_iter(text) {
        parts.push(&text[last..found.start]);
        last = found.end;
    }
    parts.push(&text[last..]);
    parts
}

/// The text after the match of an anchored pattern (`text.replace(pattern, '')`).
fn without_lead<'a>(pattern: &JsRegex, text: &'a str) -> &'a str {
    pattern.find(text).map_or(text, |found| &text[found.end..])
}

/// The value of a brief key: its `// key: value` line with the comment lines that continue it, joined as list items.
fn brief_line(script: &str, key: &str) -> String {
    let prefix = JsRegex::new_static(&format!(r"^\s*//\s*{key}\s*:"), "i");
    let lines: Vec<&str> = script.split('\n').collect();
    let Some(start) = lines.iter().position(|line| prefix.is_match(line)) else {
        return String::new();
    };
    let mut collected = vec![without_lead(&prefix, lines[start])];
    for line in &lines[start + 1..] {
        // The next brief key ends the value.
        if !COMMENT_LINE.is_match(line) || NEXT_BRIEF_KEY.is_match(line) {
            break;
        }
        collected.push(without_lead(&COMMENT_PREFIX, line));
    }
    // Continuation lines are joined as list items (` · `), so a facts or plan line may wrap across comment lines
    // without two entries fusing into one.
    let joined = collected.into_iter().map(js_trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" · ");
    let joined = DOT_RUN.replace_all_with(&joined, |_| " · ".to_owned());
    let joined = SPACES.replace_all_with(&joined, |_| " ".to_owned());
    js_trim(&joined).to_owned()
}

fn plan_slide_role(head: &str) -> &'static str {
    if ROLE_COVER.is_match(head) {
        "cover"
    } else if ROLE_CLOSING.is_match(head) {
        "closing"
    } else if ROLE_SECTION.is_match(head) {
        "section"
    } else {
        ""
    }
}

fn parse_slide_plan(text: &str) -> Vec<Value> {
    let mut entries: Vec<(f64, Vec<String>)> = Vec::new();
    for token in split_by(&DOT_SEPARATOR, text) {
        let token = js_trim(token);
        if let Some(started) = PLAN_START.captures(token) {
            let number = started.get(1).unwrap_or_default().parse::<f64>().unwrap_or(f64::NAN);
            entries.push((number, vec![js_trim(started.get(2).unwrap_or_default()).to_owned()]));
        } else if let Some(last) = entries.last_mut() {
            if !token.is_empty() {
                last.1.push(token.to_owned());
            }
        }
    }
    entries
        .into_iter()
        .map(|(slide, tokens)| {
            let mut fields = Map::new();
            for token in &tokens {
                if let Some(field) = PLAN_FIELD.captures(token) {
                    let name = js_to_lowercase(field.get(1).unwrap_or_default());
                    if PLAN_KEYS.contains(&name.as_str()) {
                        fields.insert(name, Value::String(js_trim(field.get(2).unwrap_or_default()).to_owned()));
                    }
                }
            }
            let job = fields.get("job").and_then(Value::as_str).unwrap_or_default();
            let role = plan_slide_role(&format!("{} {job}", tokens[0]));
            let named = fields.get("carriers").and_then(Value::as_str).unwrap_or_default();
            let carriers: Vec<Value> = split_by(&CARRIER_SEPARATOR, named)
                .into_iter()
                .map(|word| js_to_lowercase(js_trim(word)))
                .filter(|word| !word.is_empty())
                .map(Value::String)
                .collect();
            let mut entry = Map::new();
            entry.insert("slide".into(), json_number(slide));
            entry.insert("role".into(), Value::String(role.into()));
            for (name, value) in fields {
                entry.insert(name, value);
            }
            entry.insert("carriers".into(), Value::Array(carriers));
            entry.insert("text".into(), Value::String(tokens.join(" · ")));
            Value::Object(entry)
        })
        .collect()
}

/// `directions: A <…> · B <…> · C <…> · selected: B · why: <…>`: the candidates and the pick.
fn parse_directions(text: &str) -> Value {
    let mut candidates = Vec::new();
    let mut selected = String::new();
    for token in split_by(&DOT_SEPARATOR, text) {
        let token = js_trim(token);
        if let Some(pick) = DIRECTION_PICK.captures(token) {
            selected = pick.get(1).unwrap_or_default().to_ascii_uppercase();
            continue;
        }
        if let Some(candidate) = DIRECTION_CANDIDATE.captures(token) {
            if !DIRECTION_WHY.is_match(token) {
                candidates.push(json!({
                    "id": candidate.get(1).unwrap_or_default().to_ascii_uppercase(),
                    "text": js_trim(candidate.get(2).unwrap_or_default()),
                }));
            }
        }
    }
    json!({ "candidates": candidates, "selected": selected })
}

/// A fact's source is a locator when it points into material the reader can open at that spot: a page, a cell or
/// range, a section, a slide, a figure, or a URL. Grounding is the half of deck quality the runtime can check
/// cheaply: a deck built from supplied sources is only as good as its citations.
fn parse_facts(text: &str) -> Vec<Value> {
    let mut facts = Vec::new();
    for token in split_by(&DOT_SEPARATOR, text) {
        if let Some(fact) = FACT_LINE.captures(js_trim(token)) {
            let source = js_trim(fact.get(3).unwrap_or_default());
            facts.push(json!({
                "id": fact.get(1).unwrap_or_default(),
                "value": js_trim(fact.get(2).unwrap_or_default()),
                "source": source,
                "locator": LOCATOR.is_match(source),
            }));
        }
    }
    facts
}

/// `sources: <file, document, or url> · <…>`: the supplied material the deck is built from.
fn parse_sources(text: &str) -> Vec<Value> {
    split_by(&DOT_SEPARATOR, text).into_iter().map(js_trim).filter(|token| !token.is_empty()).map(|token| Value::String(token.to_owned())).collect()
}

fn first_group(pattern: &JsRegex, text: &str) -> Option<String> {
    pattern.captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

/// `parseAuthoringBrief(script)`: the brief a script (or the script form of an HTML brief) opens with.
pub fn parse_authoring_brief(script: &str) -> Value {
    let plan = parse_slide_plan(&brief_line(script, "slide plan"));
    let facts_line = brief_line(script, "facts");
    let sample = SAMPLE_FACTS.is_match(&facts_line);
    let facts = if sample { Vec::new() } else { parse_facts(&facts_line) };
    let facts_mode = if sample {
        "sample"
    } else if facts.is_empty() {
        "none"
    } else {
        "sourced"
    };
    let facts_note = if sample { js_trim(without_lead(&SAMPLE_FACTS, &facts_line)).to_owned() } else { String::new() };
    let style_line = brief_line(script, "style");
    let style_source = if style_line.is_empty() { brief_line(script, "family") } else { style_line.clone() };
    let style = first_group(&STYLE_FAMILY, &style_source).unwrap_or_default();
    let directions = parse_directions(&brief_line(script, "directions"));
    let present = BRIEF_MARK.is_match(script);
    let sources = parse_sources(&brief_line(script, "sources"));
    // `concept: <id> — <reason>`: the design concept chosen for this situation, free text.
    let concept = brief_line(script, "concept");
    let palette_line = brief_line(script, "palette");
    let mut palette = js_trim(palette_line.split('·').next().unwrap_or_default()).to_owned();
    if palette.is_empty() {
        palette = first_group(&STYLE_PALETTE, &style_line).map(|found| js_trim(&found).to_owned()).unwrap_or_default();
    }
    // `reading mode: presentation | balanced | text · argument mode: …`; the style line's `MODE <mode>` is the fallback.
    let mode_line = brief_line(script, "reading mode");
    let reading_mode = js_to_lowercase(&first_group(&READING_MODE_WORD, &mode_line).or_else(|| first_group(&STYLE_MODE, &style_line)).unwrap_or_default());
    let argument_mode = js_to_lowercase(
        &first_group(&ARGUMENT_MODE_IN_LINE, &mode_line).or_else(|| first_group(&READING_MODE_WORD, &brief_line(script, "argument mode"))).unwrap_or_default(),
    );
    json!({
        "present": present,
        "plan": plan,
        "facts": facts,
        "factsMode": facts_mode,
        "factsNote": facts_note,
        "style": style,
        "family": style,
        "directions": directions,
        "sources": sources,
        "concept": concept,
        "palette": palette,
        "readingMode": reading_mode,
        "argumentMode": argument_mode,
    })
}

/// `htmlBriefScript(html)`: the brief of an HTML deck is an HTML comment that opens with BRIEF, written with the
/// same keys as a script's `// key: value` lines; it is handed to [`parse_authoring_brief`] in the script's own form.
pub fn html_brief_script(html: &str) -> String {
    let Some(found) = HTML_BRIEF.captures(html) else {
        return String::new();
    };
    let lines = found.get(1).unwrap_or_default().split('\n').map(|line| without_lead(&LINE_LEAD, line)).filter(|line| !js_trim(line).is_empty());
    std::iter::once("// BRIEF".to_owned()).chain(lines.map(|line| format!("// {line}"))).collect::<Vec<_>>().join("\n")
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

fn field_of<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|inner| field(inner, key))
}

/// `Boolean(value[key])`.
fn is_true(value: &Value, key: &str) -> bool {
    field(value, key).is_some_and(truthy)
}

/// `Array.isArray(value) ? value : []`.
fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `String(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(inner) if truthy(inner) => value_to_string(inner),
        _ => String::new(),
    }
}

const SHOW_MODES: [&str; 3] = ["presentation", "keynote", "showcase"];

/// `isShowcaseBrief(brief)`: a deck read from the back of a room (presentation / keynote / showcase): body-page
/// density rules do not apply.
pub fn is_showcase_brief(brief: &Value) -> bool {
    ["readingMode", "argumentMode"].iter().any(|key| SHOW_MODES.contains(&text_or_empty(field(brief, key)).as_str()))
}

/// What a slide of the saved deck shows: the counts and the text steps the plan's carriers are read against.
struct SlideFacts {
    block_arc: bool,
    charts: usize,
    tables: usize,
    pictures: usize,
    drawn: usize,
    /// `(size, bold)` of each text shape that is not a placeholder.
    text: Vec<(f64, bool)>,
}

fn slide_facts(slide: &Value) -> SlideFacts {
    let mut facts = SlideFacts { block_arc: false, charts: 0, tables: 0, pictures: 0, drawn: 0, text: Vec::new() };
    for shape in list(field(slide, "shapes")) {
        let (chart, table, placeholder) = (is_true(shape, "chart"), is_true(shape, "table"), is_true(shape, "placeholder"));
        let picture = is_picture_shape(shape);
        facts.charts += usize::from(chart);
        facts.tables += usize::from(table);
        facts.pictures += usize::from(picture);
        if field(shape, "geometry") == Some(&Value::String("blockArc".into())) {
            facts.block_arc = true;
        }
        if !js_trim(&text_or_empty(field(shape, "text"))).is_empty() && !placeholder {
            // `Number(shape.font?.size) || 0`.
            let size = to_number_of(field_of(field(shape, "font"), "size"));
            let size = if size.is_nan() || size == 0.0 { 0.0 } else { size };
            facts.text.push((size, field_of(field(shape, "font"), "bold") == Some(&Value::Bool(true))));
        } else if !chart && !table && !placeholder && !picture {
            facts.drawn += 1;
        }
    }
    facts
}

/// What each named carrier promises on the saved slide: whether the slide keeps it, and the label the review reads
/// back. A name that is no carrier promises nothing.
fn carrier_promise(carrier: &str, facts: &SlideFacts) -> Option<(bool, &'static str)> {
    let largest = |size: f64| facts.text.iter().any(|(candidate, _)| *candidate >= size);
    Some(match carrier {
        "chart" => (facts.charts > 0, "a native chart"),
        "table" => (facts.tables > 0, "a native table"),
        "picture" => (facts.pictures > 0, "a picture"),
        "hero" => (largest(40.0), "a hero numeral (40 pt+)"),
        "statement" => (largest(22.0), "a statement at 22 pt or larger"),
        "quote" => (largest(24.0), "a quote at 24 pt or larger"),
        "specimen" => {
            let steps: BTreeSet<(u64, bool)> = facts.text.iter().map(|(size, bold)| (size.to_bits(), *bold)).collect();
            (steps.len() >= 3, "a specimen (three or more size/weight steps drawn)")
        }
        "gauge" => (facts.block_arc, "a gauge (block arc)"),
        "diagram" => (facts.drawn >= 2, "a drawn construction (two or more shapes without text)"),
        _ => return None,
    })
}

fn issue(code: &str, path: &str, message: &str, severity: &str) -> Value {
    issue_with(code, path, message, "design-review", severity)
}

/// `plannedCarrierGaps(document, brief)`: plan lines whose named carriers the saved slide does not show. A
/// geometry-based promise (gauge, diagram) is only checked when the snapshot carries shape geometry (the OOXML
/// reader does; the Office COM snapshot reports shape kinds without preset geometry, and a check that cannot see
/// the shapes stays silent). Shared by the advisory review and the receipt.
pub fn planned_carrier_gaps(document: &Value, brief: &Value) -> Vec<Value> {
    let slides = list(field(document, "slides"));
    let geometry_visible = slides.iter().any(|slide| list(field(slide, "shapes")).iter().any(|shape| is_true(shape, "geometry")));
    let mut gaps = Vec::new();
    for entry in list(field(brief, "plan")) {
        let planned = to_number_of(field(entry, "slide"));
        let Some(slide) = slides.iter().find(|candidate| to_number_of(field(candidate, "index")) == planned) else {
            continue;
        };
        let facts = slide_facts(slide);
        for carrier in list(field(entry, "carriers")) {
            let Some(name) = carrier.as_str() else { continue };
            let Some((kept, label)) = carrier_promise(name, &facts) else { continue };
            if (name == "gauge" || name == "diagram") && !geometry_visible {
                continue;
            }
            if !kept {
                gaps.push(json!({ "slide": field(entry, "slide").cloned().unwrap_or(Value::Null), "carrier": name, "label": label }));
            }
        }
    }
    gaps
}

/// `reviewBriefPromises(document, brief)`: the review reports the same reading the gate refuses on: a carrier the
/// plan named and the slide does not show is a defect (the page was designed for it), while a stale slide count is
/// information.
pub fn review_brief_promises(document: &Value, brief: &Value) -> Vec<Value> {
    let slides = list(field(document, "slides"));
    let plan = list(field(brief, "plan"));
    let mut issues = Vec::new();
    if plan.is_empty() {
        return issues;
    }
    // `Math.max(...)`: any NaN makes the whole maximum NaN.
    let planned = plan
        .iter()
        .map(|entry| to_number_of(field(entry, "slide")))
        .fold(f64::NEG_INFINITY, |most, number| if most.is_nan() || number.is_nan() { f64::NAN } else { most.max(number) });
    if slides.len() as f64 != planned {
        issues.push(issue(
            "plan_count_mismatch",
            "/",
            &format!("The brief plans {} slides but the deck has {}.", number_to_string(planned), slides.len()),
            "info",
        ));
    }
    for gap in planned_carrier_gaps(document, brief) {
        let slide = field(&gap, "slide").map(value_to_string).unwrap_or_default();
        let carrier = text_or_empty(field(&gap, "carrier"));
        let label = text_or_empty(field(&gap, "label"));
        issues.push(issue(
            "plan_promise_missing",
            &format!("/slide[{slide}]"),
            &format!("The plan names {carrier} among the slide's carriers but the slide does not seem to carry {label}."),
            "warning",
        ));
    }
    issues
}

/// A deck of two or more slides is a presentation, and its brief answers two questions per page before any
/// geometry exists: what job the page does, and what carries it.
const PLAN_REQUIRED_SLIDES: usize = 2;

fn blocked(code: &str, slides: Vec<Value>) -> Value {
    json!({ "blocked": true, "code": code, "slides": slides })
}

/// `planGate(document, brief)`: a plan that leaves a page unwritten, a line with no job or carriers, and a page
/// that does not carry what its own line named are refused at author, the way the fact sheet is. A single slide is
/// a specimen or a probe, not a presentation, so it is not gated.
pub fn plan_gate(document: &Value, brief: &Value) -> Value {
    let open = json!({ "blocked": false });
    if !is_true(brief, "present") {
        return open;
    }
    let slides = list(field(document, "slides"));
    if slides.len() < PLAN_REQUIRED_SLIDES {
        return open;
    }
    let plan = list(field(brief, "plan"));
    if plan.is_empty() {
        return blocked("plan_missing", Vec::new());
    }
    let planned: Vec<f64> = plan.iter().map(|entry| to_number_of(field(entry, "slide"))).collect();
    let indexes: Vec<f64> = slides.iter().map(|slide| to_number_of(field(slide, "index"))).collect();
    let unplanned: Vec<Value> =
        indexes.iter().filter(|index| index.is_finite() && !planned.contains(index)).map(|index| json!({ "slide": json_number(*index) })).collect();
    if !unplanned.is_empty() {
        return blocked("plan_slide_unplanned", unplanned);
    }
    let incomplete: Vec<Value> = plan
        .iter()
        .filter(|entry| indexes.contains(&to_number_of(field(entry, "slide"))))
        .filter_map(|entry| {
            let mut missing = Vec::new();
            if !is_true(entry, "job") {
                missing.push("job");
            }
            if list(field(entry, "carriers")).is_empty() {
                missing.push("carriers");
            }
            (!missing.is_empty()).then(|| json!({ "slide": field(entry, "slide").cloned().unwrap_or(Value::Null), "missing": missing }))
        })
        .collect();
    if !incomplete.is_empty() {
        return blocked("plan_incomplete", incomplete);
    }
    let gaps = planned_carrier_gaps(document, brief);
    if gaps.is_empty() { open } else { blocked("plan_promise_missing", gaps) }
}

/// `normalizedNumber(token)`: the figure without thousands commas and spaces, the minus sign as a hyphen.
fn normalized_number(token: &str) -> String {
    let compact: String = token.chars().filter(|c| *c != ',' && !is_js_space(*c)).collect();
    compact.replacen('−', "-", 1)
}

/// `comparableFigure(token)`: the figure as the number it states, so 96.0 and 96 are one figure.
fn comparable_figure(token: &str) -> String {
    let value = normalized_number(token).replacen('%', "", 1);
    let numeric: String = value.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    match numeric.parse::<f64>() {
        Ok(parsed) if !numeric.is_empty() && parsed.is_finite() => number_to_string(parsed),
        _ => value,
    }
}

/// `reviewSourceGrounding(brief)`: a deck built from supplied sources says where each figure came from. With a
/// `sources` line in the brief, a fact whose source names no page, cell, section, or URL is reported: information,
/// not a gate. Without a `sources` line the facts line is the whole contract and nothing here applies.
pub fn review_source_grounding(brief: &Value) -> Vec<Value> {
    let sources = list(field(brief, "sources"));
    let facts = list(field(brief, "facts"));
    if sources.is_empty() || facts.is_empty() {
        return Vec::new();
    }
    let loose: Vec<String> = facts.iter().filter(|fact| !is_true(fact, "locator")).map(|fact| text_or_empty(field(fact, "id"))).collect();
    if loose.is_empty() {
        return Vec::new();
    }
    vec![issue(
        "fact_without_locator",
        "/",
        &format!(
            "The brief names {} source{} but {} {} no locator. Point each fact where a reader can open it (F1 38건 — 운영 리포트 p.12, Sheet1!B4, §3, or a URL).",
            sources.len(),
            if sources.len() > 1 { "s" } else { "" },
            loose.join(", "),
            if loose.len() > 1 { "cite" } else { "cites" }
        ),
        "warning",
    )]
}

/// The figures the slides show that no fact covers, per slide, and whether any figure appears at all. The gate
/// compares figures, not strings: each fact contributes the figures it states, and a series fact every value in it.
struct Unlisted {
    any_number: bool,
    /// The slide's `index` (absent when the slide has none) and the figures, in the order they appear.
    slides: Vec<(Option<Value>, Vec<String>)>,
}

fn unlisted_figures(document: &Value, brief: &Value) -> Unlisted {
    let mut known = BTreeSet::new();
    for fact in list(field(brief, "facts")) {
        let value = match field(fact, "value") {
            None | Some(Value::Null) => String::new(),
            Some(inner) => value_to_string(inner),
        };
        for raw in NUMBER.find_iter(&value) {
            known.insert(comparable_figure(&value[raw]));
        }
    }
    let mut any_number = false;
    let mut missing = Vec::new();
    for slide in list(field(document, "slides")) {
        let mut figures: Vec<String> = Vec::new();
        for shape in list(field(slide, "shapes")) {
            if is_true(shape, "placeholder") {
                continue;
            }
            // A dateline is chrome: it leaves the text first, so a hyphenated date does not read as figures.
            let text = DATELINE.replace_all_with(&text_or_empty(field(shape, "text")), |_| " ".to_owned());
            for raw in NUMBER.find_iter(&text) {
                let token = js_trim(&text[raw]);
                let value = normalized_number(token);
                let digits = value.chars().filter(char::is_ascii_digit).count();
                let small = digits == 2 && SHORT_NUMBER.is_match(&value) && value.parse::<f64>().is_ok_and(|number| number <= 12.0);
                if DATE.is_match(token) || digits < 2 || small {
                    continue;
                }
                any_number = true;
                if !known.contains(&comparable_figure(token)) && !figures.iter().any(|seen| seen == token) {
                    figures.push(token.to_owned());
                }
            }
        }
        if !figures.is_empty() {
            missing.push((field(slide, "index").cloned(), figures));
        }
    }
    Unlisted { any_number, slides: missing }
}

/// `reviewFactCoverage(document, brief)`: the figures the slides show that no fact covers; the review and the
/// author gate read the same list.
pub fn review_fact_coverage(document: &Value, brief: &Value) -> Vec<Value> {
    if field(brief, "factsMode") == Some(&Value::String("sample".into())) {
        return vec![issue(
            "facts_illustrative",
            "/",
            "The brief declares facts: sample, so every figure on the deck is illustrative; the delivery says so.",
            "info",
        )];
    }
    let mut issues = Vec::new();
    let has_facts = !list(field(brief, "facts")).is_empty();
    let unlisted = unlisted_figures(document, brief);
    if has_facts {
        for (slide, figures) in &unlisted.slides {
            let slide = slide.as_ref().map_or_else(|| "undefined".to_owned(), value_to_string);
            issues.push(issue(
                "number_without_fact",
                &format!("/slide[{slide}]"),
                &format!("Figures with no fact behind them: {}. Add them to the brief's facts line with a source, or remove them.", figures.join(", ")),
                "warning",
            ));
        }
    }
    if unlisted.any_number && !has_facts && is_true(brief, "present") {
        issues.push(issue(
            "facts_missing",
            "/",
            "The deck shows figures but the brief has no facts line; list each figure with its source (F1 <value> — <source>).",
            "warning",
        ));
    }
    issues
}

/// `factsGate(document, brief)`: the same reading as the review, but a refusal instead of a report. A script
/// without a brief is not gated (the brief is the contract that names the facts), and a sample declaration passes
/// with its disclosure.
pub fn facts_gate(document: &Value, brief: &Value) -> Value {
    let open = json!({ "blocked": false });
    if !is_true(brief, "present") || field(brief, "factsMode") == Some(&Value::String("sample".into())) {
        return open;
    }
    let has_facts = !list(field(brief, "facts")).is_empty();
    let unlisted = unlisted_figures(document, brief);
    let any_number = unlisted.any_number;
    let slides: Vec<Value> = unlisted
        .slides
        .into_iter()
        .map(|(slide, figures)| {
            let mut entry = Map::new();
            if let Some(slide) = slide {
                entry.insert("slide".into(), slide);
            }
            entry.insert("figures".into(), json!(figures));
            Value::Object(entry)
        })
        .collect();
    if !has_facts {
        return if any_number { blocked("facts_missing", slides) } else { open };
    }
    if slides.is_empty() { open } else { blocked("number_without_fact", slides) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "
// BRIEF
// subject/audience/action: board · approve the plan
// reading mode: balanced · argument mode: pyramid
// directions: A editorial · hue 205 · serif · vertical rule — document-like · B swiss-minimal · hue 225 · concord · oversized plane — number-led
//   · C dark-tech · hue 215 · weight · glow — stage-led · selected: B · why: the numbers carry the argument
// style: swiss-minimal · palette: hue 225 · accent: 1F7A4D · type: MODE balanced → body 18 · script: ko · pairing: concord · fonts: noto
// facts: F1 38건 — 1차 리뷰 로그 · F2 0.72 — 3차 미학 점수 · F3 97% — QA 통과율
// slide plan: 1 job: cover · move: the room knows the ask · composition: dark field, ghost numeral · carriers: statement
//   · 2 job: evidence · relationship: evidence · move: trust the trend · composition: chart as spine · carriers: chart, takeaway · rhythm: dense
//   · 3 job: claim · relationship: none · move: the number lands · composition: hero entering high · carriers: hero · rhythm: breathing
//   · 4 job: process · relationship: order · move: see the path · composition: stepped blocks rising · carriers: diagram · 5 job: closing · move: approve · carriers: statement
const x = 1;
";

    fn strings(value: &Value) -> Vec<String> {
        value.as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_owned()).collect()
    }

    fn codes(issues: &[Value]) -> Vec<(String, String, String)> {
        issues
            .iter()
            .map(|entry| {
                let text = |key: &str| entry[key].as_str().unwrap().to_owned();
                (text("code"), text("path"), text("severity"))
            })
            .collect()
    }

    #[test]
    fn the_parser_reads_the_plan_fields_the_directions_the_style_and_the_facts() {
        let brief = parse_authoring_brief(SCRIPT);
        assert_eq!(brief["present"], json!(true));
        assert_eq!(brief["style"], json!("swiss-minimal"));
        assert_eq!(brief["family"], json!("swiss-minimal"));
        let ids: Vec<&str> = brief["directions"]["candidates"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["A", "B", "C"]);
        assert_eq!(brief["directions"]["selected"], json!("B"));
        let plan: Vec<Value> = brief["plan"].as_array().unwrap().iter().map(|e| json!([e["slide"], e["job"], e["role"], e["carriers"]])).collect();
        assert_eq!(
            plan,
            vec![
                json!([1, "cover", "cover", ["statement"]]),
                json!([2, "evidence", "", ["chart", "takeaway"]]),
                json!([3, "claim", "", ["hero"]]),
                json!([4, "process", "", ["diagram"]]),
                json!([5, "closing", "closing", ["statement"]]),
            ]
        );
        assert_eq!(brief["plan"][1]["relationship"], json!("evidence"));
        assert_eq!(brief["plan"][1]["composition"], json!("chart as spine"));
        assert_eq!(brief["plan"][2]["rhythm"], json!("breathing"));
        let values: Vec<&str> = brief["facts"].as_array().unwrap().iter().map(|f| f["value"].as_str().unwrap()).collect();
        assert_eq!(values, ["38건", "0.72", "97%"]);
        assert_eq!(brief["readingMode"], json!("balanced"));
        assert_eq!(brief["argumentMode"], json!("pyramid"));
        assert_eq!(brief["palette"], json!("hue 225"));
    }

    #[test]
    fn a_plan_entry_keeps_the_key_order_node_writes() {
        let brief = parse_authoring_brief("// BRIEF\n// slide plan: 1 job: cover · carriers: statement, hero · move: m\n");
        assert_eq!(
            mixdog_js::json_stringify(&brief["plan"][0]),
            r#"{"slide":1,"role":"cover","job":"cover","carriers":["statement","hero"],"move":"m","text":"job: cover · carriers: statement, hero · move: m"}"#
        );
    }

    fn deck_of(slides: Value) -> Value {
        json!({ "slides": slides })
    }

    #[test]
    fn the_review_reads_the_carriers_each_plan_line_named_back_as_information() {
        let brief = parse_authoring_brief(SCRIPT);
        let slides = json!([
            { "index": 1, "shapes": [{ "text": "01", "font": { "size": 240 } }] },
            { "index": 2, "shapes": [{ "text": "Title", "font": { "size": 32 } }, { "text": "a body paragraph", "font": { "size": 14 } }] },
            { "index": 3, "shapes": [{ "text": "38", "font": { "size": 96 } }] },
            { "index": 4, "shapes": [{ "geometry": "round1Rect", "fill": { "color": "EEEEEE" } }, { "geometry": "line" }] },
            { "index": 5, "shapes": [{ "text": "The ask", "font": { "size": 36 } }] },
        ]);
        let issues = review_brief_promises(&deck_of(slides.clone()), &brief);
        assert_eq!(codes(&issues), [("plan_promise_missing".to_owned(), "/slide[2]".to_owned(), "warning".to_owned())]);
        assert!(issues[0]["message"].as_str().unwrap().contains("chart"));
        let four = deck_of(json!(slides.as_array().unwrap()[..4]));
        assert!(review_brief_promises(&four, &brief).iter().any(|entry| entry["code"] == "plan_count_mismatch"));
    }

    #[test]
    fn lines_that_wrap_across_comment_lines_keep_every_entry_apart() {
        let brief = parse_authoring_brief(
            "
// BRIEF
// facts: F1 38건 — 리뷰 로그 · F2 0.72 — 미학 점수
//        F3 97% — QA 통과율 · F4 133 — 테스트 수
// slide plan: 1 job: cover · move: 잡는다
//   2 job: evidence · carriers: hero, chart · move: 규모
//   3 job: closing
",
        );
        let ids: Vec<&str> = brief["facts"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["F1", "F2", "F3", "F4"]);
        assert_eq!(brief["facts"][1]["source"], json!("미학 점수"));
        let plan: Vec<Value> = brief["plan"].as_array().unwrap().iter().map(|e| json!([e["slide"], e["role"], e["carriers"]])).collect();
        assert_eq!(plan, vec![json!([1, "cover", []]), json!([2, "", ["hero", "chart"]]), json!([3, "closing", []])]);
    }

    #[test]
    fn geometry_promises_stay_silent_when_the_snapshot_has_no_geometry() {
        let brief = parse_authoring_brief(SCRIPT);
        let with_geometry = review_brief_promises(
            &deck_of(json!([
                { "index": 1, "shapes": [{ "text": "01", "font": { "size": 240 } }] },
                { "index": 2, "shapes": [{ "text": "Title", "font": { "size": 32 } }] },
                { "index": 3, "shapes": [{ "text": "38", "font": { "size": 96 } }] },
                { "index": 4, "shapes": [{ "geometry": "round1Rect" }, { "geometry": "line" }] },
                { "index": 5, "shapes": [{ "text": "The ask", "font": { "size": 36 } }] },
            ])),
            &brief,
        );
        assert_eq!(
            with_geometry.iter().map(|entry| (entry["code"].as_str().unwrap(), entry["severity"].as_str().unwrap())).collect::<Vec<_>>(),
            [("plan_promise_missing", "warning")]
        );
        // The Office COM snapshot reports shape kinds without preset geometry: a diagram cannot be seen there, a chart can.
        let slides: Vec<Value> = (1..=4).map(|index| json!({ "index": index, "shapes": [{ "type": 1, "text": "x", "font": { "size": 14 } }] })).collect();
        let com = review_brief_promises(&deck_of(Value::Array(slides)), &brief);
        assert_eq!(
            codes(&com).into_iter().map(|(code, path, _)| (code, path)).collect::<Vec<_>>(),
            [
                ("plan_count_mismatch".to_owned(), "/".to_owned()),
                ("plan_promise_missing".to_owned(), "/slide[1]".to_owned()),
                ("plan_promise_missing".to_owned(), "/slide[2]".to_owned()),
                ("plan_promise_missing".to_owned(), "/slide[3]".to_owned()),
            ]
        );
    }

    #[test]
    fn a_deck_built_from_supplied_sources_cites_where_each_figure_can_be_opened() {
        let grounded = parse_authoring_brief(
            "
// BRIEF
// sources: 2026 운영 리포트.pdf · metrics.xlsx
// facts: F1 38건 — 운영 리포트 p.12 · F2 0.72 — metrics.xlsx Sheet1!B4 · F3 97% — https://status.example.com/qa
",
        );
        assert_eq!(strings(&grounded["sources"]), ["2026 운영 리포트.pdf", "metrics.xlsx"]);
        let locators: Vec<&Value> = grounded["facts"].as_array().unwrap().iter().map(|f| &f["locator"]).collect();
        assert_eq!(locators, [&json!(true), &json!(true), &json!(true)]);
        assert!(review_source_grounding(&grounded).is_empty());

        let loose = parse_authoring_brief(
            "
// BRIEF
// sources: 2026 운영 리포트.pdf
// facts: F1 38건 — 운영 리포트 · F2 0.72 — 미학 점수 · F3 97% — 리포트 p.9
",
        );
        let issues = review_source_grounding(&loose);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["code"], json!("fact_without_locator"));
        let message = issues[0]["message"].as_str().unwrap();
        assert!(message.contains("F1, F2"));
        assert!(!message.contains("F3"));
        // No sources line: the facts line is the whole contract and nothing is demanded of it.
        assert!(review_source_grounding(&parse_authoring_brief(SCRIPT)).is_empty());
    }

    #[test]
    fn figures_without_a_fact_are_reported_while_dates_and_slide_numbers_are_not() {
        let brief = parse_authoring_brief(SCRIPT);
        let document = deck_of(json!([
            { "index": 1, "shapes": [{ "text": "2026-09-03 · 38건 → 0" }, { "text": "3", "placeholder": true }] },
            { "index": 2, "shapes": [{ "text": "품질 0.72, 통과율 97%, 비용 1,250만원" }] },
        ]));
        let issues = review_fact_coverage(&document, &brief);
        assert_eq!(issues.iter().map(|entry| entry["path"].as_str().unwrap()).collect::<Vec<_>>(), ["/slide[2]"]);
        let message = issues[0]["message"].as_str().unwrap();
        assert!(message.contains("1,250"));
        assert!(!message.contains("0.72") && !message.contains("97%"));
        let none = review_fact_coverage(&document, &json!({ "present": true, "facts": [] }));
        assert!(none.iter().any(|entry| entry["code"] == "facts_missing"));
    }

    #[test]
    fn a_concept_is_optional_free_text_and_does_not_change_factual_review() {
        let without = parse_authoring_brief(SCRIPT);
        assert_eq!(without["concept"], json!(""));
        let with = parse_authoring_brief(&SCRIPT.replace("// facts:", "// concept: field-led — the colour carries the brand\n// facts:"));
        assert_eq!(with["concept"], json!("field-led — the colour carries the brand"));
        let document = deck_of(json!([{ "index": 1, "shapes": [{ "text": "38건, 999건" }] }]));
        let issues = review_fact_coverage(&document, &without);
        assert_eq!(review_fact_coverage(&document, &with), issues);
        assert!(issues.iter().any(|entry| entry["code"] == "number_without_fact"));
        assert!(is_showcase_brief(&parse_authoring_brief(&SCRIPT.replace("reading mode: balanced", "reading mode: keynote"))));
        assert!(!is_showcase_brief(&without));
    }

    #[test]
    fn a_standalone_palette_line_is_read_beside_a_non_empty_style_line() {
        assert_eq!(parse_authoring_brief("// BRIEF\n// style: custom\n// palette: red, blue, white\n")["palette"], json!("red, blue, white"));
        assert_eq!(parse_authoring_brief("// BRIEF\n// style: custom · palette: teal, ivory\n")["palette"], json!("teal, ivory"));
    }

    #[test]
    fn the_brief_names_its_facts_mode_and_the_author_gate_mirrors_the_fact_review() {
        let sourced = parse_authoring_brief("// BRIEF\n// facts: F1 47% — user brief\n");
        assert_eq!(sourced["factsMode"], json!("sourced"));
        let sample = parse_authoring_brief("// BRIEF\n// facts: sample — projections not measured yet\n");
        assert_eq!(sample["factsMode"], json!("sample"));
        assert_eq!(sample["factsNote"], json!("projections not measured yet"));
        assert_eq!(sample["facts"], json!([]));
        let none = parse_authoring_brief("// BRIEF\n// subject/audience/action: review\n");
        assert_eq!(none["factsMode"], json!("none"));

        let document = deck_of(json!([
            { "index": 1, "shapes": [{ "text": "Retention reached 47% and churn fell 12%" }] },
            { "index": 2, "shapes": [{ "text": "Q3 2024 review" }, { "placeholder": true, "text": "99 placeholder" }] },
        ]));
        assert_eq!(facts_gate(&document, &none), json!({ "blocked": true, "code": "facts_missing", "slides": [{ "slide": 1, "figures": ["47%", "12%"] }] }));
        assert_eq!(facts_gate(&document, &sourced), json!({ "blocked": true, "code": "number_without_fact", "slides": [{ "slide": 1, "figures": ["12%"] }] }));
        let both = parse_authoring_brief("// BRIEF\n// facts: F1 47% — user brief · F2 12% — user brief\n");
        assert_eq!(facts_gate(&document, &both), json!({ "blocked": false }));
        assert_eq!(facts_gate(&document, &sample), json!({ "blocked": false }));
        assert_eq!(facts_gate(&document, &parse_authoring_brief("const deckWithoutBrief = 1;")), json!({ "blocked": false }));
        assert_eq!(facts_gate(&deck_of(json!([{ "index": 1, "shapes": [{ "text": "No figures here" }] }])), &none), json!({ "blocked": false }));
        // A dateline is chrome, dotted or hyphenated; a decimal that only looks like one is still a figure.
        let dated = deck_of(json!([{ "index": 1, "shapes": [{ "text": "2026.09 · 운영 보고" }, { "text": "2026.09.12 기준 · 2026-09" }] }]));
        assert_eq!(facts_gate(&dated, &sourced), json!({ "blocked": false }));
        let decimal = deck_of(json!([{ "index": 1, "shapes": [{ "text": "2026.5 배" }] }]));
        assert_eq!(
            facts_gate(&decimal, &sourced),
            json!({ "blocked": true, "code": "number_without_fact", "slides": [{ "slide": 1, "figures": ["2026.5"] }] })
        );
        let illustrative = review_fact_coverage(&document, &sample);
        assert_eq!(
            illustrative.iter().map(|entry| (entry["code"].as_str().unwrap(), entry["severity"].as_str().unwrap())).collect::<Vec<_>>(),
            [("facts_illustrative", "info")]
        );

        // The gate compares figures, not strings: 42 is not covered by 84,200, nor 96 by 96.1%.
        let table = deck_of(json!([{ "index": 1, "shapes": [{ "text": "대전 128,400 92.8% 96 · 광주 84,200 96.1% 42" }] }]));
        let listed = parse_authoring_brief("// BRIEF\n// facts: F1 처리량 128,400 84,200 — 시트 B4 · F2 정시 출고율 92.8% 96.1% — 시트 B5\n");
        assert_eq!(facts_gate(&table, &listed), json!({ "blocked": true, "code": "number_without_fact", "slides": [{ "slide": 1, "figures": ["96", "42"] }] }));
        let covered = parse_authoring_brief(
            "// BRIEF\n// facts: F1 처리량 128,400 84,200 — 시트 B4 · F2 정시 출고율 92.8% 96.1% — 시트 B5 · F3 지연 건수 96 42 — 시트 B6\n",
        );
        assert_eq!(facts_gate(&table, &covered), json!({ "blocked": false }));
    }

    #[test]
    fn the_plan_gate_refuses_a_deck_whose_pages_are_unplanned_or_do_not_carry_what_they_planned() {
        let document = deck_of(json!([
            { "index": 1, "shapes": [{ "text": "표지", "font": { "size": 40 } }] },
            { "index": 2, "shapes": [{ "text": "근거", "font": { "size": 28 } }] },
        ]));
        let no_plan = parse_authoring_brief("// BRIEF\n// subject/audience/action: 리뷰\n");
        assert_eq!(plan_gate(&document, &no_plan), json!({ "blocked": true, "code": "plan_missing", "slides": [] }));
        let single = deck_of(json!([document["slides"][0].clone()]));
        assert_eq!(plan_gate(&single, &no_plan), json!({ "blocked": false }));
        assert_eq!(plan_gate(&document, &parse_authoring_brief("const deckWithoutBrief = 1;")), json!({ "blocked": false }));

        let partial = parse_authoring_brief("// BRIEF\n// slide plan: 1 job: cover · carriers: statement\n");
        assert_eq!(plan_gate(&document, &partial), json!({ "blocked": true, "code": "plan_slide_unplanned", "slides": [{ "slide": 2 }] }));

        let no_carriers = parse_authoring_brief("// BRIEF\n// slide plan: 1 job: cover · carriers: statement\n//   2 job: evidence · move: 규모를 본다\n");
        assert_eq!(
            plan_gate(&document, &no_carriers),
            json!({ "blocked": true, "code": "plan_incomplete", "slides": [{ "slide": 2, "missing": ["carriers"] }] })
        );

        let promised = parse_authoring_brief("// BRIEF\n// slide plan: 1 job: cover · carriers: statement\n//   2 job: evidence · carriers: chart\n");
        assert_eq!(
            plan_gate(&document, &promised),
            json!({ "blocked": true, "code": "plan_promise_missing", "slides": [{ "slide": 2, "carrier": "chart", "label": "a native chart" }] })
        );
        let charted = deck_of(json!([document["slides"][0].clone(), { "index": 2, "shapes": [{ "chart": { "type": "bar" } }] }]));
        assert_eq!(plan_gate(&charted, &promised), json!({ "blocked": false }));
    }

    #[test]
    fn an_html_brief_comment_reads_as_the_script_brief() {
        let html = "<!doctype html><!-- BRIEF
facts: sample — illustrative numbers
slide plan: 1 job: cover · move: know the deck · carriers: statement
  · 2 job: evidence · move: see the gap · carriers: chart
-->
<section class=\"slide\"></section>";
        let brief = parse_authoring_brief(&html_brief_script(html));
        assert_eq!(brief["present"], json!(true));
        assert_eq!(brief["factsMode"], json!("sample"));
        let plan: Vec<Value> = brief["plan"].as_array().unwrap().iter().map(|e| json!([e["slide"], e["carriers"]])).collect();
        assert_eq!(plan, vec![json!([1, ["statement"]]), json!([2, ["chart"]])]);
        assert_eq!(html_brief_script("<section class=\"slide\"></section>"), "");
    }
}
