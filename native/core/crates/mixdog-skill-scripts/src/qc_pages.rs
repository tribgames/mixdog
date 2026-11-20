//! `pptx/scripts/qc-pages.mjs`: per-page layout QC. Each selected slide gets one fresh model session that sees only that
//! page (its rendered image when the engine can render, its element inventory and its measured defects), with the office
//! tool alone and a fix-only mandate. The fixer edits a working copy; the runner, not the model, decides whether that
//! copy becomes the deck: it is adopted only when the page's measured defects did not grow and no other slide changed,
//! and discarded otherwise.

use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::json_stringify;
use mixdog_js::json_stringify_indent;
use mixdog_js::nodepath;
use mixdog_js::number_to_string;
use mixdog_js::slice_utf16;
use mixdog_js::to_number_of;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::Outcome;
use crate::mixdogd_exec::ExecOptions;
use crate::mixdogd_exec::ToolMode;
use crate::parse_args::OptionSpec;
use crate::parse_args::ParseConfig;
use crate::parse_args::parse_args;
use crate::review_deck::sha256_hex;
use crate::source_extract::Measured;
use crate::source_extract::OfficeHost;
use crate::source_extract::basename_without_extension;
use crate::source_extract::collapse_spaces;
use crate::source_extract::dirname;
use crate::source_extract::extname;
use crate::source_extract::finite;
use crate::source_extract::fs_message;
use crate::source_extract::get;
use crate::source_extract::items;
use crate::source_extract::join;
use crate::source_extract::string_or_empty;
use crate::source_extract::template;
use crate::source_extract::text;
use crate::source_extract::to_fixed_2;
use crate::source_extract::truthy;

pub const QC_MAX_PAGES: usize = 20;
const QC_MAX_ROUNDS: usize = 2;

/// The features the model turn's child process runs with: the office tool alone.
const CHILD_FEATURES: [(&str, &str); 4] =
    [("MIXDOG_FEATURE_OFFICE", "1"), ("MIXDOG_FEATURE_GIT", "0"), ("MIXDOG_FEATURE_BROWSER", "0"), ("MIXDOG_FEATURE_COMPUTER", "0")];

const USAGE: &str = "Usage: qc-pages.mjs deck.pptx --provider <provider> --model <model> --output qc-report.json [--pages 1-12] [--no-vision]";

/// `Number(value.toFixed(2))` of a finite number, null otherwise.
fn number(value: Option<&Value>) -> Value {
    finite(value).map_or(Value::Null, |value| json_number(to_fixed_2(value)))
}

/// Portable sessions edit an output copy, never the source, so the fixer is pointed at a per-page working copy beside
/// the deck. Not dot-prefixed: Windows cloud-sync drives refuse to create such names.
pub fn working_copy_path(deck: &str, page: usize) -> String {
    let extension = extname(deck);
    join(&dirname(deck), &format!("{}.qc-page-{page}{extension}", basename_without_extension(deck)))
}

/// `parsePages`: the pages a selection names, ascending, each once.
pub fn parse_pages(spec: Option<&str>, total: usize) -> Result<Vec<usize>, String> {
    let spec = spec.unwrap_or("all");
    if js_trim(spec).is_empty() || spec == "all" {
        return Ok((1..=total).collect());
    }
    let mut pages = std::collections::BTreeSet::new();
    for part in spec.split(',') {
        let Some((from, to)) = page_range(part) else { return Err(format!("invalid page selection: {}", js_trim(part))) };
        if from < 1.0 || to < from || to > total as f64 {
            return Err(format!("page selection out of range: {} (the deck has {total} slides)", js_trim(part)));
        }
        pages.extend((from as usize)..=(to as usize));
    }
    Ok(pages.into_iter().collect())
}

/// `/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/` on one part of the selection: its first and last page.
fn page_range(part: &str) -> Option<(f64, f64)> {
    let spaced = |text: &str| mixdog_js::js_trim_start(text).to_owned();
    let digits = |text: &str| -> Option<(f64, String)> {
        let end = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len());
        (end > 0).then(|| (text[..end].parse().unwrap_or(f64::INFINITY), text[end..].to_owned()))
    };
    let (from, rest) = digits(&spaced(part))?;
    let rest = spaced(&rest);
    let after = rest.strip_prefix('-').map(str::to_owned);
    let (to, rest) = match after {
        Some(after) => digits(&spaced(&after))?,
        None => (from, rest),
    };
    mixdog_js::js_trim(&rest).is_empty().then_some((from, to))
}

/// The inventory the fixer reads: every shape on the page with the id the tools accept, its kind, geometry in points
/// (the unit the portable snapshot reports and the batch operations take), type size, fill and text.
pub fn slide_inventory(document: &Value, page: usize) -> Vec<String> {
    let slide = items(get(document, "slides")).iter().find(|slide| to_number_of(get(slide, "index")) == page as f64);
    let Some(slide) = slide else { return Vec::new() };
    items(get(slide, "shapes"))
        .iter()
        .map(|shape| {
            let content = collapse_spaces(&if truthy(get(shape, "text")) { string_or_empty(get(shape, "text")) } else { String::new() });
            let kind = if truthy(get(shape, "chart")) {
                "chart".to_owned()
            } else if let Some(table) = get(shape, "table").filter(|table| truthy(Some(*table))) {
                format!("table {}×{}", template(get(table, "rows")), template(get(table, "columns")))
            } else if truthy(get(shape, "group")) {
                "group".to_owned()
            } else if get(shape, "type").and_then(Value::as_str) == Some("p:pic") {
                "picture".to_owned()
            } else if !content.is_empty() {
                "text".to_owned()
            } else if truthy(get(shape, "geometry")) {
                template(get(shape, "geometry"))
            } else {
                "shape".to_owned()
            };
            let sides: Vec<Option<f64>> = ["left", "top", "width", "height"].iter().map(|key| finite(get(shape, key)).map(to_fixed_2)).collect();
            let geometry = match sides.as_slice() {
                [Some(left), Some(top), Some(width), Some(height)] => format!(
                    " left {} top {} width {} height {}",
                    number_to_string(*left),
                    number_to_string(*top),
                    number_to_string(*width),
                    number_to_string(*height)
                ),
                _ => String::new(),
            };
            let font = get(shape, "font");
            let size = font.and_then(|font| get(font, "size")).filter(|size| truthy(Some(*size)));
            let bold = if font.is_some_and(|font| truthy(get(font, "bold"))) { " bold" } else { "" };
            let font_text = size.map_or_else(String::new, |size| format!(" font {}{bold}", template(Some(size))));
            let fill = get(shape, "fill").and_then(|fill| get(fill, "color")).filter(|color| truthy(Some(*color)));
            let fill_text = fill.map_or_else(String::new, |color| format!(" fill {}", template(Some(color))));
            let clipped = if utf16_len(&content) > 120 { format!("{}…", slice_utf16(&content, 117)) } else { content.clone() };
            let preview = if content.is_empty() { String::new() } else { format!(" \"{clipped}\"") };
            let placeholder = if truthy(get(shape, "placeholder")) { " placeholder" } else { "" };
            format!("shape[{}] {kind}{placeholder}{geometry}{font_text}{fill_text}{preview}", template(get(shape, "index")))
        })
        .collect()
}

/// Measured defects on one page: what a fix must answer (errors and warnings); advisories stay out, as in the inline
/// audit.
pub fn page_defects(issues: &[Value], page: usize) -> Vec<Value> {
    let prefix = format!("/slide[{page}]");
    let below = format!("{prefix}/");
    issues
        .iter()
        .filter(|issue| truthy(Some(*issue)))
        .filter(|issue| string_or_empty(get(issue, "severity").filter(|value| truthy(Some(*value)))) != "info")
        .filter(|issue| {
            let path = string_or_empty(get(issue, "path").filter(|value| truthy(Some(*value))));
            path == prefix || path.starts_with(&below)
        })
        .map(|issue| {
            let mut picked = Map::new();
            for key in ["severity", "code", "path", "message"] {
                if let Some(value) = get(issue, key) {
                    picked.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(picked)
        })
        .collect()
}

/// What the guard compares: every slide's text and geometry, by slide number.
pub type Fingerprints = Vec<(f64, String)>;

fn same_key(left: f64, right: f64) -> bool {
    left == right || (left.is_nan() && right.is_nan())
}

/// A change on any slide but the one under repair, or a different slide count, reverts the page.
pub fn slide_fingerprints(document: &Value) -> Fingerprints {
    let mut fingerprints: Fingerprints = Vec::new();
    for slide in items(get(document, "slides")) {
        let shapes: Vec<Value> = items(get(slide, "shapes"))
            .iter()
            .map(|shape| {
                json!([
                    get(shape, "type").cloned().unwrap_or(Value::Null),
                    get(shape, "text").cloned().unwrap_or(Value::Null),
                    number(get(shape, "left")),
                    number(get(shape, "top")),
                    number(get(shape, "width")),
                    number(get(shape, "height")),
                    get(shape, "font").and_then(|font| get(font, "size")).cloned().unwrap_or(Value::Null),
                ])
            })
            .collect();
        let mut body = Map::new();
        if let Some(text) = get(slide, "text") {
            body.insert("text".to_owned(), text.clone());
        }
        body.insert("shapes".to_owned(), Value::Array(shapes));
        let key = to_number_of(get(slide, "index"));
        let print = json_stringify(&Value::Object(body));
        match fingerprints.iter_mut().find(|(known, _)| same_key(*known, key)) {
            Some(slot) => slot.1 = print,
            None => fingerprints.push((key, print)),
        }
    }
    fingerprints
}

pub fn others_changed(before: &Fingerprints, after: &Fingerprints, page: usize) -> bool {
    if before.len() != after.len() {
        return true;
    }
    before.iter().any(|(index, print)| *index != page as f64 && after.iter().find(|(known, _)| same_key(*known, *index)).map(|(_, after)| after) != Some(print))
}

/// One page's verdict from the measured evidence alone; the model's own account of what it fixed never decides.
pub fn decide_page(before: usize, after: usize, scope_changed: bool, audit_failed: bool) -> (bool, &'static str) {
    if audit_failed {
        return (false, "audit_failed");
    }
    if scope_changed {
        return (false, "scope");
    }
    if after > before {
        return (false, "regression");
    }
    (true, if after < before { "improved" } else { "unchanged" })
}

/// What the fixer is told about one page.
#[derive(Clone, Copy, Debug)]
pub struct Instruction<'a> {
    pub deck: &'a str,
    pub copy: &'a str,
    pub page: usize,
    pub total: usize,
    pub inventory: &'a [String],
    pub defects: &'a [Value],
    pub image_path: &'a str,
}

pub fn qc_instruction(input: &Instruction<'_>) -> String {
    let Instruction { deck, copy, page, total, inventory, defects, image_path } = *input;
    let rendering = if image_path.is_empty() {
        "No rendering is available: judge only from the inventory and the measured defects below, and do not infer a visual problem the measurements do not establish.".to_owned()
    } else {
        format!(
            "Rendered page: {image_path} — open it with the read tool first. The picture is the ground truth; the inventory below carries the ids the tools accept."
        )
    };
    let measured = if defects.is_empty() {
        "The measured audit found nothing on this slide — trust the rendering for what it cannot measure: collisions, clipping, contrast, crowding.".to_owned()
    } else {
        let lines: Vec<String> = defects
            .iter()
            .map(|issue| format!("- {} {}: {}", template(get(issue, "code")), template(get(issue, "path")), template(get(issue, "message"))))
            .collect();
        format!("Measured defects on this slide ({}):\n{}", defects.len(), lines.join("\n"))
    };
    let inventory = if inventory.is_empty() { "(no shapes)".to_owned() } else { inventory.join("\n") };
    let more_rounds = QC_MAX_ROUNDS - 1;
    format!(
        r#"You are a slide layout QA fixer working on ONE slide of a saved PowerPoint deck. Fix objective layout defects on that slide only; never redesign it.
Deck: {deck}
Slide {page} of {total}. Canvas 960 × 540 pt (13.33 × 7.5 in); the geometry below is in points from the top-left corner, and the tools take points too.
{rendering}

Element inventory (slide {page}):
{inventory}

{measured}

Objective defects to fix: text overflowing or clipped by its box, text colliding with a neighbour, an element past the canvas edge, unreadable contrast, a distorted picture. Nothing else.

Tools: the office tool (and read, for the picture). Procedure:
1. office action:"open" path:"{deck}" mode:"portable" output:"{copy}" snapshotAfter:false — note the session id. Your edits land in that working copy; the runner adopts it only when the measurements agree.
2. office action:"batch" session:<id> operations:[…] — every operation names slide: {page}. Allowed: set_shape (properties left, top, width, height in points, fontSize), fit_text (shape, minFontSize 12), and set_text only to mend a break or a stray space, never to rewrite copy. Put every change for this slide in ONE batch. The result carries audit: read it, and if it still lists a defect on slide {page}, send at most {more_rounds} more batch.
3. office action:"close" session:<id>.
STRICTLY FORBIDDEN: touching any other slide, adding or deleting elements, changing colours, fonts, theme, or wording, regenerating the slide, any tool other than office and read. Every change is measured after you finish: a slide whose defects grew or whose neighbours changed is reverted.
When the slide is already clean, make NO tool call.
Final reply: one line under 15 words naming what you fixed, or exactly "OK"."#
    )
}

/// The report of a run, in the order its JSON keys are written.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub ok: bool,
    pub deck: String,
    pub route: (String, String, String),
    pub total: usize,
    pub pages: Vec<Map<String, Value>>,
    pub skipped_pages: Vec<usize>,
    pub fixed: usize,
    pub polished: usize,
    pub discarded: usize,
    pub skipped: usize,
    pub failed: usize,
}

impl Report {
    pub fn to_value(&self) -> Value {
        let (provider, model, effort) = &self.route;
        json!({
            "ok": self.ok,
            "deck": self.deck,
            "route": { "provider": provider, "model": model, "effort": effort },
            "isolation": "pristine-per-page",
            "total": self.total,
            "pages": self.pages,
            "skippedPages": self.skipped_pages,
            "fixed": self.fixed,
            "polished": self.polished,
            "discarded": self.discarded,
            "skipped": self.skipped,
            "failed": self.failed,
        })
    }
}

/// What `runPageQc` is given.
#[derive(Clone, Copy, Debug)]
pub struct QcRequest<'a> {
    pub deck: &'a str,
    pub pages: Option<&'a str>,
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub output: Option<&'a str>,
    pub vision: bool,
    pub max_pages: usize,
}

struct Run<'a, 'h, P> {
    proof: &'a P,
    host: &'a OfficeHost<'h>,
    deck: String,
    total: usize,
    provider: String,
    model: String,
    effort: String,
    target: String,
    vision: bool,
}

fn file_exists<P: WriteProof>(proof: &P, path: &str) -> bool {
    mixdog_fsio::exists(proof, path).unwrap_or(false)
}

fn digest_of<P: WriteProof>(proof: &P, path: &str) -> Result<String, String> {
    mixdog_fsio::read(proof, path).map(|bytes| sha256_hex(&bytes)).map_err(|error| fs_message(&error, "open", Path::new(path)))
}

fn measure(host: &OfficeHost<'_>, path: &str) -> Result<Measured, String> {
    host.engine()?.measure(Path::new(path))
}

/// The page image comes from the same renderer the author reviews with; a missing renderer leaves the page to the
/// geometry read.
fn render_page<P: WriteProof>(run: &Run<'_, '_, P>, page: usize) -> Result<String, String> {
    let deck = run.deck.as_str();
    let cwd = dirname(deck);
    let scratch = join(&cwd, &format!("{}.qc-render{}", basename_without_extension(deck), extname(deck)));
    let engine = run.host.engine()?;
    let opened = engine.call(&json!({ "action": "open", "path": deck, "mode": "portable", "output": scratch, "snapshotAfter": false }), Path::new(&cwd))?;
    let session = get(&opened, "session").cloned();
    let with_session = |action: &str| {
        let mut args = Map::new();
        args.insert("action".to_owned(), json!(action));
        if let Some(session) = &session {
            args.insert("session".to_owned(), session.clone());
        }
        args
    };
    let mut render = with_session("render");
    render.insert("pages".to_owned(), json!([page]));
    let rendered = engine.call(&Value::Object(render), Path::new(&cwd));
    let _ = engine.call(&Value::Object(with_session("close")), Path::new(&cwd));
    let _ = mixdog_fsio::remove_file(run.proof, &scratch);
    let rendered = rendered?;
    let images = items(get(&rendered, "images"));
    let image = images.iter().find(|image| to_number_of(get(image, "page")) == page as f64).or_else(|| images.first());
    Ok(text(image.and_then(|image| get(image, "path"))))
}

/// Keep/discard verdict for an edited copy from its re-measurement; an unedited page is kept as it is (or marked
/// execution_failed when the run never completed).
fn judge_page<P: WriteProof>(
    run: &Run<'_, '_, P>,
    entry: &mut Map<String, Value>,
    copy: &str,
    code: i32,
    page: usize,
    fingerprints: &Fingerprints,
) -> (bool, &'static str) {
    if entry.get("edited") != Some(&json!(true)) {
        return (true, if code == 0 { "unchanged" } else { "execution_failed" });
    }
    let end = measure(run.host, copy).ok();
    let before = entry.get("before").and_then(Value::as_u64).unwrap_or(0) as usize;
    let after = end.as_ref().map_or(before, |end| page_defects(&end.issues, page).len());
    entry.insert("after".to_owned(), json!(after));
    let scope_changed = end.as_ref().is_some_and(|end| others_changed(fingerprints, &slide_fingerprints(&end.document), page));
    decide_page(before, after, scope_changed, end.is_none())
}

fn qc_page_body<P: WriteProof>(
    run: &Run<'_, '_, P>,
    report: &mut Report,
    outcome: &mut Outcome,
    entry: &mut Map<String, Value>,
    copy: &str,
    page: usize,
) -> Result<(), String> {
    let deck = run.deck.as_str();
    let start = measure(run.host, deck)?;
    let defects = page_defects(&start.issues, page);
    entry.insert("before".to_owned(), json!(defects.len()));
    entry.insert("after".to_owned(), json!(defects.len()));
    let image_path = if run.vision {
        match render_page(run, page) {
            Ok(path) => path,
            Err(message) => {
                entry.insert("renderError".to_owned(), json!(if message.is_empty() { "Error".to_owned() } else { message }));
                String::new()
            }
        }
    } else {
        String::new()
    };
    entry.insert("vision".to_owned(), json!(!image_path.is_empty()));
    // A text-only read with nothing measured has nothing to act on: no request, no chance of a speculative edit.
    if image_path.is_empty() && defects.is_empty() {
        entry.insert("reason".to_owned(), json!("clean"));
        report.skipped += 1;
        return Ok(());
    }
    let _ = mixdog_fsio::remove_file(run.proof, copy);
    let hash_before = digest_of(run.proof, deck)?;
    let fingerprints = slide_fingerprints(&start.document);
    let inventory = slide_inventory(&start.document, page);
    let message = qc_instruction(&Instruction { deck, copy, page, total: run.total, inventory: &inventory, defects: &defects, image_path: &image_path });
    let executed = run.host.exec.run(&ExecOptions {
        message,
        provider: run.provider.clone(),
        model: run.model.clone(),
        effort: Some(run.effort.clone()),
        cwd: Some(dirname(deck).into()),
        web_search: false,
        usage_log_path: (!run.target.is_empty()).then(|| format!("{}.page-{page}.usage.json", run.target)),
        tool_mode: ToolMode::Full,
        env: CHILD_FEATURES.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect(),
    });
    outcome.stderr.push_str(&executed.stderr);
    entry.insert("reply".to_owned(), json!(slice_utf16(js_trim(&executed.stdout), 400)));
    if !executed.stderr.is_empty() {
        entry.insert("errors".to_owned(), json!([executed.stderr]));
    }
    let edited = file_exists(run.proof, copy) && digest_of(run.proof, copy)? != hash_before;
    entry.insert("edited".to_owned(), json!(edited));
    let (keep, reason) = judge_page(run, entry, copy, executed.code, page, &fingerprints);
    entry.insert("kept".to_owned(), json!(keep));
    entry.insert("reason".to_owned(), json!(reason));
    // A page whose run never produced a reply was not reviewed; counting it as kept would make it read like a clean one.
    if reason == "execution_failed" {
        report.failed += 1;
        report.ok = false;
    }
    if !keep {
        let before = entry.get("before").cloned().unwrap_or(json!(0));
        entry.insert("after".to_owned(), before);
        report.discarded += 1;
    } else if edited {
        mixdog_fsio::copy(run.proof, copy, deck).map_err(|error| fs_message(&error, "copyfile", Path::new(copy)))?;
        if reason == "improved" {
            report.fixed += 1;
        } else {
            report.polished += 1;
        }
    }
    Ok(())
}

fn qc_page<P: WriteProof>(run: &Run<'_, '_, P>, report: &mut Report, outcome: &mut Outcome, page: usize) {
    let mut entry = Map::new();
    for (key, value) in [
        ("page", json!(page)),
        ("vision", json!(false)),
        ("before", json!(0)),
        ("after", json!(0)),
        ("edited", json!(false)),
        ("kept", json!(true)),
        ("reason", json!("")),
        ("reply", json!("")),
    ] {
        entry.insert(key.to_owned(), value);
    }
    let copy = working_copy_path(&run.deck, page);
    if let Err(message) = qc_page_body(run, report, outcome, &mut entry, &copy, page) {
        entry.insert("kept".to_owned(), json!(true));
        entry.insert("reason".to_owned(), json!("error"));
        entry.insert("error".to_owned(), json!(message));
        report.failed += 1;
        report.ok = false;
    }
    let _ = mixdog_fsio::remove_file(run.proof, &copy);
    report.pages.push(entry);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use mixdog_fsio::Unlaned;

    use super::*;
    use crate::mixdogd_exec::ExecResult;
    use crate::mixdogd_exec::ExecRunner;
    use crate::source_extract::OfficeEngine;

    #[test]
    fn a_page_selection_is_a_sorted_set_of_ranges_inside_the_deck() {
        assert_eq!(parse_pages(None, 3), Ok(vec![1, 2, 3]));
        assert_eq!(parse_pages(Some(" "), 2), Ok(vec![1, 2]));
        assert_eq!(parse_pages(Some("all"), 2), Ok(vec![1, 2]));
        assert_eq!(parse_pages(Some("3, 1-2 ,2"), 5), Ok(vec![1, 2, 3]));
        assert_eq!(parse_pages(Some("2 - 3"), 5), Ok(vec![2, 3]));
        assert_eq!(parse_pages(Some("a"), 5), Err("invalid page selection: a".into()));
        assert_eq!(parse_pages(Some(" all "), 5), Err("invalid page selection: all".into()));
        assert_eq!(parse_pages(Some("1-"), 5), Err("invalid page selection: 1-".into()));
        assert_eq!(parse_pages(Some("1,,2"), 5), Err("invalid page selection: ".into()));
        assert_eq!(parse_pages(Some("0"), 5), Err("page selection out of range: 0 (the deck has 5 slides)".into()));
        assert_eq!(parse_pages(Some("3-2"), 5), Err("page selection out of range: 3-2 (the deck has 5 slides)".into()));
        assert_eq!(parse_pages(Some("6"), 5), Err("page selection out of range: 6 (the deck has 5 slides)".into()));
    }

    #[test]
    fn the_working_copy_sits_beside_the_deck_without_a_leading_dot() {
        let deck = if cfg!(windows) { "C:\\work\\deck.pptx" } else { "/work/deck.pptx" };
        let copy = working_copy_path(deck, 3);
        assert!(copy.ends_with("deck.qc-page-3.pptx"), "{copy}");
        assert!(!copy.contains("\\.") && !copy.contains("/."));
        assert_eq!(dirname(&copy), dirname(deck));
    }

    fn document() -> Value {
        json!({ "slides": [
            { "index": 1, "text": "one", "shapes": [
                { "index": 1, "text": "Title  text", "left": 10.004, "top": 20, "width": 300.125, "height": 40, "font": { "size": 28, "bold": true }, "fill": { "color": "FFFFFF" }, "placeholder": true },
                { "index": 2, "chart": {} },
                { "index": 3, "table": { "rows": 2, "columns": 3 } },
                { "index": 4, "type": "p:pic" },
                { "index": 5, "geometry": "rect" },
                { "index": 6 }
            ] },
            { "index": 2, "text": "two", "shapes": [] }
        ] })
    }

    #[test]
    fn the_inventory_lists_every_shape_with_its_kind_geometry_font_fill_and_text() {
        let lines = slide_inventory(&document(), 1);
        assert_eq!(lines[0], "shape[1] text placeholder left 10 top 20 width 300.13 height 40 font 28 bold fill FFFFFF \"Title text\"");
        assert_eq!(&lines[1..], ["shape[2] chart", "shape[3] table 2×3", "shape[4] picture", "shape[5] rect", "shape[6] shape"]);
        assert!(slide_inventory(&document(), 9).is_empty());
        let long = json!({ "slides": [{ "index": 1, "shapes": [{ "index": 1, "text": "y".repeat(130) }] }] });
        assert_eq!(slide_inventory(&long, 1)[0], format!("shape[1] text \"{}…\"", "y".repeat(117)));
    }

    #[test]
    fn defects_are_the_errors_and_warnings_on_the_page_alone() {
        let issues = vec![
            json!({ "severity": "error", "code": "overflow", "path": "/slide[2]/shape[1]", "message": "m", "extra": 1 }),
            json!({ "severity": "info", "code": "note", "path": "/slide[2]", "message": "m" }),
            json!({ "severity": "warning", "code": "w", "path": "/slide[2]", "message": "x" }),
            json!({ "severity": "error", "code": "other", "path": "/slide[22]/shape[1]", "message": "m" }),
            json!({ "code": "nosev", "path": "/slide[1]" }),
            Value::Null,
        ];
        let defects = page_defects(&issues, 2);
        assert_eq!(defects.len(), 2);
        assert_eq!(defects[0], json!({ "severity": "error", "code": "overflow", "path": "/slide[2]/shape[1]", "message": "m" }));
        assert_eq!(page_defects(&issues, 1).len(), 1);
    }

    #[test]
    fn a_page_is_kept_only_when_its_measurements_agree() {
        assert_eq!(decide_page(2, 1, false, false), (true, "improved"));
        assert_eq!(decide_page(2, 2, false, false), (true, "unchanged"));
        assert_eq!(decide_page(2, 3, false, false), (false, "regression"));
        assert_eq!(decide_page(2, 0, true, false), (false, "scope"));
        assert_eq!(decide_page(2, 0, true, true), (false, "audit_failed"));
    }

    #[test]
    fn a_change_on_another_slide_or_in_the_slide_count_is_a_change_of_scope() {
        let before = slide_fingerprints(&document());
        assert!(!others_changed(&before, &slide_fingerprints(&document()), 1));
        let mut edited = document();
        edited["slides"][0]["shapes"][0]["left"] = json!(11);
        assert!(!others_changed(&before, &slide_fingerprints(&edited), 1));
        assert!(others_changed(&before, &slide_fingerprints(&edited), 2));
        let mut other = document();
        other["slides"][1]["shapes"] = json!([{ "index": 1, "text": "new" }]);
        assert!(others_changed(&before, &slide_fingerprints(&other), 1));
        let mut fewer = document();
        fewer["slides"].as_array_mut().expect("slides").pop();
        assert!(others_changed(&before, &slide_fingerprints(&fewer), 1));
    }

    #[test]
    fn the_instruction_names_the_deck_copy_page_inventory_and_defects() {
        let defects = vec![json!({ "code": "overflow", "path": "/slide[1]/shape[1]", "message": "too long" })];
        let inventory = vec!["shape[1] text".to_owned()];
        let with_image =
            qc_instruction(&Instruction { deck: "D", copy: "C", page: 1, total: 4, inventory: &inventory, defects: &defects, image_path: "P.png" });
        assert!(with_image.contains("Rendered page: P.png — open it with the read tool first."));
        assert!(with_image.contains("Slide 1 of 4. Canvas 960 × 540 pt"));
        assert!(with_image.contains("Measured defects on this slide (1):\n- overflow /slide[1]/shape[1]: too long"));
        assert!(with_image.contains("path:\"D\" mode:\"portable\" output:\"C\" snapshotAfter:false"));
        assert!(with_image.contains("send at most 1 more batch."));
        let bare = qc_instruction(&Instruction { deck: "D", copy: "C", page: 2, total: 4, inventory: &[], defects: &[], image_path: "" });
        assert!(bare.contains("No rendering is available:"));
        assert!(bare.contains("(no shapes)"));
        assert!(bare.contains("The measured audit found nothing on this slide"));
    }

    /// An engine with scripted measurements by file name and a renderer that answers one page image.
    struct Scripted {
        measures: HashMap<String, Measured>,
        render: Option<String>,
        calls: Mutex<Vec<Value>>,
    }

    impl OfficeEngine for Scripted {
        fn call(&self, args: &Value, _cwd: &Path) -> Result<Value, String> {
            self.calls.lock().expect("calls").push(args.clone());
            match args["action"].as_str() {
                Some("open") => Ok(json!({ "session": "s1" })),
                Some("render") => match &self.render {
                    Some(path) => Ok(json!({ "images": [{ "page": args["pages"][0], "path": path }] })),
                    None => Err("no renderer".to_owned()),
                },
                _ => Ok(json!({})),
            }
        }

        fn measure(&self, deck: &Path) -> Result<Measured, String> {
            let name = deck.file_name().expect("a file name").to_string_lossy().into_owned();
            self.measures.get(&name).cloned().ok_or_else(|| format!("cannot measure {name}"))
        }
    }

    /// A model turn that writes the bytes it is told to into the working copy named in the instruction.
    struct Fixer {
        edit: Option<Vec<u8>>,
        code: i32,
        calls: Mutex<Vec<ExecOptions>>,
    }

    impl ExecRunner for Fixer {
        fn run(&self, options: &ExecOptions) -> ExecResult {
            self.calls.lock().expect("calls").push(options.clone());
            if let Some(bytes) = &self.edit {
                let marker = "output:\"";
                let from = options.message.find(marker).expect("an output") + marker.len();
                let copy = options.message[from..].split('"').next().expect("a path").to_owned();
                mixdog_testkit::write(PathBuf::from(copy), bytes);
            }
            ExecResult { code: self.code, stdout: " OK \n".to_owned(), stderr: String::new() }
        }
    }

    fn measured(defects: usize, text: &str) -> Measured {
        let issues = (0..defects).map(|n| json!({ "severity": "error", "code": format!("c{n}"), "path": "/slide[1]/shape[1]", "message": "m" })).collect();
        Measured { issues, document: json!({ "slides": [{ "index": 1, "text": text, "shapes": [{ "index": 1, "text": text }] }] }) }
    }

    fn args(extra: &[&str]) -> Vec<String> {
        let mut all: Vec<String> = ["deck.pptx", "--provider", "p", "--model", "m", "--output", "out/qc.json"].map(str::to_owned).into();
        all.extend(extra.iter().map(|arg| (*arg).to_owned()));
        all
    }

    fn setup(engine_measures: Vec<(&str, Measured)>, render: Option<&str>) -> (tempfile::TempDir, Scripted) {
        let root = tempfile::tempdir().expect("temp dir");
        mixdog_testkit::write(root.path().join("deck.pptx"), "original");
        let engine = Scripted {
            measures: engine_measures.into_iter().map(|(name, m)| (name.to_owned(), m)).collect(),
            render: render.map(str::to_owned),
            calls: Mutex::new(Vec::new()),
        };
        (root, engine)
    }

    fn report_of(root: &Path) -> Value {
        serde_json::from_slice(&mixdog_testkit::read(root.join("out/qc.json"))).expect("report")
    }

    #[test]
    fn a_fix_that_lowers_the_defects_is_adopted() {
        let (root, engine) = setup(vec![("deck.pptx", measured(2, "a")), ("deck.qc-page-1.pptx", measured(1, "a"))], Some("page1.png"));
        let fixer = Fixer { edit: Some(b"edited".to_vec()), code: 0, calls: Mutex::new(Vec::new()) };
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        let outcome = run_qc_pages(&Unlaned, &args(&[]), &host);
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        let report = report_of(root.path());
        assert_eq!(report["isolation"], "pristine-per-page");
        assert_eq!((report["fixed"].clone(), report["total"].clone(), report["skippedPages"].clone()), (json!(1), json!(1), json!([])));
        let page = &report["pages"][0];
        assert_eq!(
            (page["reason"].clone(), page["kept"].clone(), page["edited"].clone(), page["vision"].clone()),
            (json!("improved"), json!(true), json!(true), json!(true))
        );
        assert_eq!((page["before"].clone(), page["after"].clone(), page["reply"].clone()), (json!(2), json!(1), json!("OK")));
        assert_eq!(mixdog_testkit::read(root.path().join("deck.pptx")), b"edited");
        assert!(!mixdog_testkit::exists(root.path().join("deck.qc-page-1.pptx")));
        let printed: Value = serde_json::from_str(outcome.stdout.trim()).expect("one JSON line");
        assert_eq!(printed["pages"], json!(["1:improved"]));
        let calls = fixer.calls.lock().expect("calls");
        assert_eq!(calls[0].tool_mode, ToolMode::Full);
        assert_eq!(calls[0].effort.as_deref(), Some("medium"));
        assert!(calls[0].env.contains(&("MIXDOG_FEATURE_OFFICE".to_owned(), "1".to_owned())));
        assert!(calls[0].usage_log_path.as_deref().is_some_and(|log| log.ends_with("qc.json.page-1.usage.json")));
        let engine_calls = engine.calls.lock().expect("calls");
        let actions: Vec<&str> = engine_calls.iter().map(|call| call["action"].as_str().expect("action")).collect();
        assert_eq!(actions, ["open", "render", "close"]);
    }
    #[test]
    fn a_fix_that_grows_the_defects_or_touches_another_slide_is_discarded() {
        let (root, engine) = setup(vec![("deck.pptx", measured(1, "a")), ("deck.qc-page-1.pptx", measured(2, "a"))], Some("p.png"));
        let fixer = Fixer { edit: Some(b"edited".to_vec()), code: 0, calls: Mutex::new(Vec::new()) };
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        run_qc_pages(&Unlaned, &args(&[]), &host);
        let page = report_of(root.path())["pages"][0].clone();
        assert_eq!((page["reason"].clone(), page["kept"].clone(), page["after"].clone()), (json!("regression"), json!(false), json!(1)));
        assert_eq!(mixdog_testkit::read(root.path().join("deck.pptx")), b"original");
        let two = |second: &str| {
            let mut deck = measured(1, "a");
            deck.document["slides"].as_array_mut().expect("slides").push(json!({ "index": 2, "text": second, "shapes": [] }));
            deck
        };
        let (root, engine) = setup(vec![("deck.pptx", two("same")), ("deck.qc-page-1.pptx", two("changed"))], Some("p.png"));
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        run_qc_pages(&Unlaned, &args(&[]), &host);
        assert_eq!(report_of(root.path())["pages"][0]["reason"], "scope");
    }
    #[test]
    fn a_run_that_never_replied_fails_the_report_and_a_clean_page_is_skipped() {
        let (root, engine) = setup(vec![("deck.pptx", measured(1, "a"))], Some("p.png"));
        let fixer = Fixer { edit: None, code: 2, calls: Mutex::new(Vec::new()) };
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        let outcome = run_qc_pages(&Unlaned, &args(&[]), &host);
        assert_eq!(outcome.code, 1);
        let report = report_of(root.path());
        assert_eq!((report["ok"].clone(), report["failed"].clone(), report["pages"][0]["reason"].clone()), (json!(false), json!(1), json!("execution_failed")));
        let (root, engine) = setup(vec![("deck.pptx", measured(0, "a"))], None);
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        let outcome = run_qc_pages(&Unlaned, &args(&["--no-vision"]), &host);
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        let report = report_of(root.path());
        assert_eq!(
            (report["skipped"].clone(), report["pages"][0]["reason"].clone(), report["pages"][0]["vision"].clone()),
            (json!(1), json!("clean"), json!(false))
        );
    }
    #[test]
    fn a_missing_renderer_leaves_the_page_to_the_geometry_read() {
        let (root, engine) = setup(vec![("deck.pptx", measured(1, "a"))], None);
        let fixer = Fixer { edit: None, code: 0, calls: Mutex::new(Vec::new()) };
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        run_qc_pages(&Unlaned, &args(&[]), &host);
        let page = report_of(root.path())["pages"][0].clone();
        assert_eq!((page["renderError"].clone(), page["vision"].clone(), page["reason"].clone()), (json!("no renderer"), json!(false), json!("unchanged")));
    }
    #[test]
    fn at_most_twenty_pages_are_worked_and_the_rest_are_named() {
        let slides: Vec<Value> = (1..=22).map(|n| json!({ "index": n, "shapes": [] })).collect();
        let deck = Measured { issues: Vec::new(), document: json!({ "slides": slides }) };
        let (root, engine) = setup(vec![("deck.pptx", deck)], None);
        let fixer = Fixer { edit: None, code: 0, calls: Mutex::new(Vec::new()) };
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        let outcome = run_qc_pages(&Unlaned, &args(&["--no-vision"]), &host);
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        let report = report_of(root.path());
        assert_eq!(report["pages"].as_array().expect("pages").len(), 20);
        assert_eq!(report["skippedPages"], json!([21, 22]));
    }
    #[test]
    fn a_missing_route_a_bad_selection_or_no_engine_is_refused_with_its_reason() {
        let (root, engine) = setup(vec![("deck.pptx", measured(0, "a"))], None);
        let fixer = Fixer { edit: None, code: 0, calls: Mutex::new(Vec::new()) };
        let host = OfficeHost { engine: Some(&engine), exec: &fixer, cwd: root.path() };
        let bare: Vec<String> = ["deck.pptx", "--output", "q.json"].map(str::to_owned).into();
        assert_eq!(run_qc_pages(&Unlaned, &bare, &host).stderr, "explicit --provider and --model are required\n");
        let usage = run_qc_pages(&Unlaned, &["deck.pptx".to_owned()], &host);
        assert_eq!((usage.code, usage.stderr), (1, format!("{USAGE}\n")));
        let range = run_qc_pages(&Unlaned, &args(&["--pages", "5"]), &host);
        assert_eq!(range.stderr, "page selection out of range: 5 (the deck has 1 slides)\n");
        let off = OfficeHost { engine: None, exec: &fixer, cwd: root.path() };
        assert_eq!(run_qc_pages(&Unlaned, &args(&[]), &off).stderr, "the office engine is not available in this process\n");
        assert!(fixer.calls.lock().expect("calls").is_empty());
    }
}

/// `runPageQc`: `Err` is a failure thrown before the pages were worked or while the report was written.
pub fn run_page_qc<P: WriteProof>(proof: &P, request: QcRequest<'_>, host: &OfficeHost<'_>, outcome: &mut Outcome) -> Result<Report, String> {
    let provider = request.provider.unwrap_or_default();
    let model = request.model.unwrap_or_default();
    if js_trim(provider).is_empty() || js_trim(model).is_empty() {
        return Err("explicit --provider and --model are required".to_owned());
    }
    let cwd = host.cwd.to_string_lossy().into_owned();
    let deck = nodepath::resolve_host(&[&cwd, request.deck]);
    host.engine()?;
    let target = request.output.filter(|output| !js_trim(output).is_empty()).map(|output| nodepath::resolve_host(&[&cwd, output])).unwrap_or_default();
    if !target.is_empty() {
        let folder = dirname(&target);
        mixdog_fsio::create_dir_all(proof, &folder).map_err(|error| fs_message(&error, "mkdir", Path::new(&folder)))?;
    }
    let initial = measure(host, &deck)?;
    let total = items(get(&initial.document, "slides")).len();
    let requested = parse_pages(request.pages, total)?;
    let selected: Vec<usize> = requested.iter().copied().take(request.max_pages).collect();
    let effort = request.effort.unwrap_or("medium").to_owned();
    let mut report = Report {
        ok: true,
        deck: deck.clone(),
        route: (provider.to_owned(), model.to_owned(), effort.clone()),
        total,
        pages: Vec::new(),
        skipped_pages: requested.iter().copied().skip(request.max_pages).collect(),
        fixed: 0,
        polished: 0,
        discarded: 0,
        skipped: 0,
        failed: 0,
    };
    let run = Run { proof, host, deck, total, provider: provider.to_owned(), model: model.to_owned(), effort, target: target.clone(), vision: request.vision };
    for page in selected {
        qc_page(&run, &mut report, outcome, page);
    }
    if !target.is_empty() {
        let body = json_stringify_indent(&report.to_value(), 2);
        mixdog_fsio::write(proof, &target, body).map_err(|error| fs_message(&error, "open", Path::new(&target)))?;
    }
    Ok(report)
}
/// `qc-pages.mjs deck.pptx --provider P --model M --output qc-report.json [--effort E] [--pages 1-12] [--no-vision]`.
pub fn run_qc_pages<P: WriteProof>(proof: &P, args: &[String], host: &OfficeHost<'_>) -> Outcome {
    let mut outcome = Outcome::default();
    let options = [
        OptionSpec::string("provider"),
        OptionSpec::string("model"),
        OptionSpec::string("effort"),
        OptionSpec::string("output"),
        OptionSpec::string("pages"),
        OptionSpec::boolean("no-vision"),
    ];
    let parsed = match parse_args(args, &ParseConfig { options: &options, allow_positionals: true }) {
        Ok(parsed) => parsed,
        Err(error) => {
            outcome.eprint(&error.message);
            outcome.code = 1;
            return outcome;
        }
    };
    let output = parsed.text("output").filter(|output| !output.is_empty());
    let (true, Some(output)) = (parsed.positionals.len() == 1, output) else {
        outcome.eprint(USAGE);
        outcome.code = 1;
        return outcome;
    };
    let request = QcRequest {
        deck: &parsed.positionals[0],
        pages: parsed.text("pages"),
        provider: parsed.text("provider"),
        model: parsed.text("model"),
        effort: parsed.text("effort"),
        output: Some(output),
        vision: !parsed.flag("no-vision"),
        max_pages: QC_MAX_PAGES,
    };
    match run_page_qc(proof, request, host, &mut outcome) {
        Ok(report) => {
            let cwd = host.cwd.to_string_lossy();
            let reasons: Vec<String> =
                report.pages.iter().map(|entry| format!("{}:{}", value_to_string(&entry["page"]), value_to_string(&entry["reason"]))).collect();
            let line = json!({
                "ok": report.ok,
                "output": nodepath::resolve_host(&[&cwd, output]),
                "fixed": report.fixed,
                "polished": report.polished,
                "discarded": report.discarded,
                "skipped": report.skipped,
                "failed": report.failed,
                "skippedPages": report.skipped_pages,
                "pages": reasons,
            });
            outcome.print(&json_stringify(&line));
            if !report.ok {
                outcome.code = 1;
            }
        }
        Err(message) => {
            outcome.eprint(&message);
            outcome.code = 1;
        }
    }
    outcome
}
