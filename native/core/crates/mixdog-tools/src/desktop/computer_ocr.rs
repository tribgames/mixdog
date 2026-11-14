//! OCR lines and marks in window captures (`observation/capture-ocr.ts`). The helper recognizes the frame inside its
//! `window_capture` (`include_ocr`) and answers the words and lines in frame pixels; this module decides when to ask, drops the words
//! the accessibility elements already cover, numbers the rest as `ocr:<frame>:<mark>` elements and renders them.

use std::sync::LazyLock;

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ToolPart;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use super::computer_command::text;
use super::computer_frames::Frame;
use super::computer_frames::FrameStore;
use super::computer_frames::OcrMark;

/// `DEFAULT_OCR_MAX_WORDS` and `MAX_OCR_WORDS` (`shared/common.ts`).
const DEFAULT_MAX_WORDS: i64 = 300;
const MAX_WORDS: i64 = 1_000;

/// An OCR pass a capture asks of the helper.
#[derive(Debug, PartialEq)]
pub(super) struct Ask {
    pub(super) limit: i64,
    pub(super) language: Option<String>,
}

impl Ask {
    /// The `window_capture` fields that make the helper recognize the frame (`recognizeCaptureOcr`'s `ocr_image` request).
    pub(super) fn apply(&self, request: &mut Map<String, Value>) {
        request.insert("include_ocr".into(), Value::Bool(true));
        request.insert("max_ocr_words".into(), self.limit.into());
        if let Some(language) = &self.language {
            request.insert("ocr_language".into(), Value::String(language.clone()));
        }
    }
}

/// `shouldUseOcrFallback` with `shouldRunCaptureOcr`: a capture recognizes its frame when asked to (`include_ocr`), or when it
/// lists elements (`state`, `som`) and the accessibility tree names no content. `max_ocr_words` is `screenshotInteger`'s.
pub(super) fn ask(command: &Map<String, Value>, mode: &str, semantic: bool) -> Result<Option<Ask>, ComputerError> {
    let explicit = command.get("include_ocr") == Some(&Value::Bool(true));
    if !explicit && (semantic || !matches!(mode, "state" | "som")) {
        return Ok(None);
    }
    let limit = match command.get("max_ocr_words") {
        None => DEFAULT_MAX_WORDS,
        Some(value) => value
            .as_i64()
            .or_else(|| value.as_f64().filter(|number| number.fract() == 0.0 && number.abs() < 9e15).map(|number| number as i64))
            .filter(|limit| (1..=MAX_WORDS).contains(limit))
            .ok_or_else(|| ComputerError::InvalidInput { reason: format!("max_ocr_words must be an integer from 1 to {MAX_WORDS}") })?,
    };
    let language = command.get("ocr_language").and_then(Value::as_str).map(str::to_string);
    Ok(Some(Ask { limit, language }))
}

/// What one window capture knows around its OCR.
pub(super) struct Capture<'a> {
    pub(super) command: &'a Map<String, Value>,
    pub(super) mode: &'a str,
    pub(super) ask: Option<&'a Ask>,
    /// The snapshot, when the accessibility read answered.
    pub(super) accessibility: Option<&'a Map<String, Value>>,
    /// `totalElementBudget`.
    pub(super) budget: i64,
}

/// A recognized word or line in frame pixels.
#[derive(Clone, Debug, PartialEq)]
struct Recognized {
    text: String,
    line: i64,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
    center_x: i64,
    center_y: i64,
}

/// Adds the OCR the helper returned with the window's pixels to the capture's parts, and records its marks for the frame
/// (`mergeCaptureOcr`). A failed or missing recognition is reported in the text, never an error of the capture. The answer is the
/// number of words listed as elements of the capture (state and som modes), which the capture's element counts include.
pub(super) fn augment(frames: &FrameStore, capture: &Capture, result: &Map<String, Value>, frame: Option<&Frame>, parts: &mut Vec<ToolPart>) -> usize {
    let Some(ask) = capture.ask else { return 0 };
    let automatic = capture.command.get("include_ocr") != Some(&Value::Bool(true));
    let skipped = |reason: &str| ToolPart::Text(format!("OCR skipped ({}): {reason}", if automatic { "automatic" } else { "include_ocr" }));
    let Some(frame) = frame else {
        parts.push(skipped("screenshot_unavailable"));
        return 0;
    };
    let shown = frame_elements(capture.accessibility, frame);
    // The words keep a share of the budget the accessibility elements cannot take: at most half of it (one at least), and no more
    // than the words asked for (`reservedOcrBudget` of `mergeCaptureOcr`).
    let reserved = ask.limit.min((capture.budget / 2).max(1));
    let kept = (shown.count as i64).min((capture.budget - reserved).max(0));
    let remaining = (capture.budget - kept).max(0);
    if remaining == 0 {
        parts.push(skipped("element_budget_exhausted"));
        return 0;
    }
    // The helper answers a recognition it could not make as `{available: false, error}`, a failed envelope as `ok: false`.
    let failed = |reply: &&Map<String, Value>| ["ok", "available"].iter().any(|key| reply.get(*key) == Some(&Value::Bool(false)));
    let reply = result.get("ocr").and_then(Value::as_object).filter(|reply| !failed(reply));
    let Some(reply) = reply else {
        let error = result.get("ocr").and_then(|reply| reply.get("error")).and_then(Value::as_str).filter(|error| !error.is_empty());
        parts.push(ToolPart::Text(format!("OCR failed: {}", error.unwrap_or("the helper returned no OCR"))));
        return 0;
    };
    let narrowing = Narrowing::of(capture.command);
    let words: Vec<Recognized> = dedupe(recognized(reply.get("words")), &shown.labelled)
        .into_iter()
        .take(remaining.min(ask.limit) as usize)
        .filter(|word| narrowing.matches(&word.text))
        .collect();
    let lines: Vec<Recognized> = recognized(reply.get("lines")).into_iter().filter(|line| narrowing.matches(&line.text)).collect();
    // Set-of-marks and state modes list the words as elements after the accessibility marks; the other modes owe the words themselves.
    let first_mark = matches!(capture.mode, "som" | "state").then_some(shown.max_mark + 1);
    if let Some(first) = first_mark {
        let marks = words.iter().enumerate().map(|(index, word)| (first + index as i64, OcrMark { x: word.center_x, y: word.center_y, bounds: [word.x, word.y, word.width, word.height] })).collect();
        frames.remember_marks(frame, marks);
    }
    let count = |key: &str| reply.get(key).and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let report = Report {
        language: reply.get("language").and_then(Value::as_str).unwrap_or_default(),
        lines: &lines,
        words: &words,
        total: count("total_words"),
        truncated: count("truncated_words"),
    };
    parts.push(ToolPart::Text(render(&report, frame, first_mark)));
    if first_mark.is_some() { words.len() } else { 0 }
}

/// The query and role of a read, applied to recognized text as the accessibility snapshot applies them: a role other than static
/// text cannot be answered from pixels at all.
struct Narrowing {
    query: String,
    role: String,
}

impl Narrowing {
    fn of(command: &Map<String, Value>) -> Narrowing {
        Narrowing { query: text(command, "query").to_lowercase(), role: text(command, "role").to_lowercase() }
    }

    fn matches(&self, candidate: &str) -> bool {
        (self.role.is_empty() || self.role == "text") && (self.query.is_empty() || candidate.to_lowercase().contains(&self.query))
    }
}

/// `normalizeOcrWords`: rows with text; absent or non-numeric numbers are 0.
fn recognized(rows: Option<&Value>) -> Vec<Recognized> {
    let Some(rows) = rows.and_then(Value::as_array) else { return Vec::new() };
    rows.iter()
        .filter_map(Value::as_object)
        .filter_map(|row| {
            let number = |key: &str| row.get(key).and_then(Value::as_f64).filter(|number| number.is_finite()).map_or(0, round);
            let text = row.get("text").and_then(Value::as_str).filter(|text| !text.is_empty())?;
            Some(Recognized {
                text: text.to_string(),
                line: number("line"),
                x: number("x"),
                y: number("y"),
                width: number("width"),
                height: number("height"),
                center_x: number("center_x"),
                center_y: number("center_y"),
            })
        })
        .collect()
}

/// `Math.round`: halves go up.
fn round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// An accessibility element in frame pixels, with the text a word could repeat.
struct Labelled {
    text: String,
    bounds: (i64, i64, i64, i64),
}

struct FrameElements {
    labelled: Vec<Labelled>,
    /// The elements the frame shows (`frameElements`), which the element budget counts.
    count: usize,
    /// The highest mark of the snapshot: OCR marks continue after it.
    max_mark: i64,
}

/// `frameElements` over the snapshot's elements (`clipElementToFrame`): each rectangle mapped into the frame's pixels and clipped;
/// one entirely outside is not shown.
fn frame_elements(snapshot: Option<&Map<String, Value>>, frame: &Frame) -> FrameElements {
    let mut found = FrameElements { labelled: Vec::new(), count: 0, max_mark: 0 };
    let Some(rows) = snapshot.and_then(|snapshot| snapshot.get("elements")).and_then(Value::as_array) else { return found };
    for row in rows.iter().filter_map(Value::as_object) {
        let number = |key: &str| row.get(key).and_then(Value::as_f64).filter(|number| number.is_finite()).unwrap_or(0.0);
        let string = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or_default();
        found.max_mark = found.max_mark.max(number("mark") as i64);
        let scale = |value: f64, origin: i64, capture: i64, physical: i64| round((value - origin as f64) * capture as f64 / physical as f64);
        let x = scale(number("x"), frame.origin_x, frame.capture_width, frame.physical_width);
        let y = scale(number("y"), frame.origin_y, frame.capture_height, frame.physical_height);
        let width = scale(number("width"), 0, frame.capture_width, frame.physical_width).max(1);
        let height = scale(number("height"), 0, frame.capture_height, frame.physical_height).max(1);
        if x + width <= 0 || y + height <= 0 || x >= frame.capture_width || y >= frame.capture_height {
            continue;
        }
        found.count += 1;
        let (left, top) = (x.max(0), y.max(0));
        let bounds = (left, top, (frame.capture_width - left).min(width - (left - x)).max(1), (frame.capture_height - top).min(height - (top - y)).max(1));
        let text = normalize(&format!("{} {}", string("name"), string("value")));
        if !text.is_empty() {
            found.labelled.push(Labelled { text, bounds });
        }
    }
    found
}

static DROPPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s\p{P}\p{S}]+").expect("static pattern"));

/// `normalizeGroundingText`.
fn normalize(value: &str) -> String {
    DROPPED.replace_all(&value.nfkc().collect::<String>().to_lowercase(), "").into_owned()
}

/// `dedupeOcrWords`: a word the accessibility elements already carry, at the same place, is not listed again.
fn dedupe(words: Vec<Recognized>, labelled: &[Labelled]) -> Vec<Recognized> {
    words
        .into_iter()
        .filter(|word| {
            let text = normalize(&word.text);
            if text.encode_utf16().count() < 2 || word.width < 2 || word.height < 2 {
                return false;
            }
            let (right, bottom) = (word.x + word.width, word.y + word.height);
            !labelled.iter().any(|candidate| {
                if !candidate.text.contains(&text) {
                    return false;
                }
                let (x, y, width, height) = candidate.bounds;
                let overlap = (right.min(x + width) - word.x.max(x)).max(0) * (bottom.min(y + height) - word.y.max(y)).max(0);
                overlap as f64 / (word.width * word.height).max(1) as f64 >= 0.5
            })
        })
        .collect()
}

struct Report<'a> {
    language: &'a str,
    lines: &'a [Recognized],
    words: &'a [Recognized],
    total: i64,
    truncated: i64,
}

/// The OCR as the model reads it: the lines, then each word as an element `[ocr:<frame>:<mark>]` (state and som) or as its text and
/// center (the other modes). Coordinates are pixels of the frame.
fn render(report: &Report, frame: &Frame, first_mark: Option<i64>) -> String {
    let mut out = format!("OCR (language={}, words={}, truncated={}):", report.language, report.total, report.truncated);
    for line in report.lines {
        out.push_str(&format!("\nline {}: {} @{},{},{},{}", line.line, one_line(&line.text, 200), line.x, line.y, line.width, line.height));
    }
    for (index, word) in report.words.iter().enumerate() {
        let name = one_line(&word.text, 80);
        match first_mark {
            Some(first) => {
                let mark = first + index as i64;
                out.push_str(&format!("\n[ocr:{}:{mark}] Text \"{name}\" mark={mark} @{},{}", frame.id, word.center_x, word.center_y));
            }
            None => out.push_str(&format!("\nword \"{name}\" @{},{}", word.center_x, word.center_y)),
        }
    }
    out
}

/// A recognized text on one line, bounded.
fn one_line(value: &str, maximum: usize) -> String {
    value.chars().map(|c| if c.is_control() { ' ' } else { c }).take(maximum).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::computer_frames::map_step;
    use super::*;

    fn frame() -> Frame {
        Frame {
            id: "frame-1".into(),
            window_id: Some("hwnd:0x1".into()),
            related_window_ids: None,
            origin_x: 2560,
            origin_y: -489,
            physical_width: 2000,
            physical_height: 1000,
            capture_width: 1000,
            capture_height: 500,
            idle: None,
        }
    }

    fn word(text: &str, x: i64, y: i64) -> Value {
        json!({"text": text, "line": 0, "x": x, "y": y, "width": 100, "height": 20, "center_x": x + 50, "center_y": y + 10})
    }

    fn reply(words: Vec<Value>) -> Map<String, Value> {
        json!({"ocr": {"ok": true, "language": "ko", "words": words, "lines": [{"text": "Main Canvas", "line": 0, "x": 5, "y": 6, "width": 7, "height": 8}], "total_words": 2, "truncated_words": 0}})
            .as_object()
            .unwrap()
            .clone()
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn run(command: Value, mode: &str, accessibility: Option<Value>, result: &Map<String, Value>, budget: i64) -> (String, FrameStore) {
        let command = object(command);
        let ask = ask(&command, mode, false).unwrap();
        let accessibility = accessibility.map(object);
        let capture = Capture { command: &command, mode, ask: ask.as_ref(), accessibility: accessibility.as_ref(), budget };
        let frames = FrameStore::default();
        let frame = frame();
        frames.remember(frame.clone());
        let mut parts = Vec::new();
        augment(&frames, &capture, result, Some(&frame), &mut parts);
        let ToolPart::Text(text) = &parts[0] else { panic!("no text") };
        (text.clone(), frames)
    }

    #[test]
    fn words_become_marked_elements_after_the_accessibility_marks() {
        let snapshot = json!({"elements": [{"mark": 3, "name": "Save", "value": "", "x": 2560, "y": -489, "width": 20, "height": 20}]});
        let (text, frames) = run(json!({"include_ocr": true}), "som", Some(snapshot), &reply(vec![word("MainCanvas", 300, 200), word("Other", 10, 10)]), 80);
        assert!(text.starts_with("OCR (language=ko, words=2, truncated=0):\nline 0: Main Canvas @5,6,7,8\n"), "{text}");
        assert!(text.contains("[ocr:frame-1:4] Text \"MainCanvas\" mark=4 @350,210"), "{text}");
        assert!(text.contains("[ocr:frame-1:5] Text \"Other\" mark=5 @60,20"), "{text}");
        let mut step = object(json!({"action": "click", "element": 4}));
        map_step(&frames, &mut step).unwrap();
        assert_eq!((step["x"].clone(), step["y"].clone()), (json!(2560 + 700), json!(-489 + 420)));
    }

    #[test]
    fn a_mode_without_elements_lists_the_words_unmarked_and_records_no_marks() {
        let (text, frames) = run(json!({"include_ocr": true}), "vision", None, &reply(vec![word("Hello", 0, 0)]), 80);
        assert!(text.contains("\nword \"Hello\" @50,10"), "{text}");
        assert!(map_step(&frames, &mut object(json!({"action": "click", "ref": "ocr:frame-1:1"}))).is_err());
    }

    #[test]
    fn a_word_an_element_already_carries_is_not_listed_again() {
        // The element covers (2560,-489) 200x40 physical = (0,0) 100x20 frame pixels, and names "Save File".
        let snapshot = json!({"elements": [{"mark": 1, "name": "Save File", "x": 2560, "y": -489, "width": 200, "height": 40}]});
        let (text, _) = run(json!({"include_ocr": true}), "state", Some(snapshot), &reply(vec![word("Save", 0, 0), word("Save", 400, 0), word("a", 0, 100)]), 80);
        assert_eq!(text.matches("Text \"Save\"").count(), 1, "{text}");
        assert!(text.contains("@450,10"), "{text}");
        assert!(!text.contains("\"a\""), "{text}");
    }

    #[test]
    fn a_query_or_role_narrows_what_pixels_can_answer() {
        let words = vec![word("Console", 0, 0), word("Inspector", 0, 40)];
        let (by_query, _) = run(json!({"include_ocr": true, "query": "console"}), "som", None, &reply(words.clone()), 80);
        assert!(by_query.contains("Console") && !by_query.contains("Inspector") && !by_query.contains("Main Canvas"), "{by_query}");
        let (by_role, _) = run(json!({"include_ocr": true, "role": "Button"}), "som", None, &reply(words), 80);
        assert!(!by_role.contains("Console") && !by_role.contains("line 0"), "{by_role}");
    }

    #[test]
    fn the_element_budget_bounds_the_words_and_can_exhaust() {
        let words: Vec<Value> = (0..5).map(|i| word(&format!("word{i}"), i * 150, 0)).collect();
        let snapshot = json!({"elements": [{"mark": 1, "name": "", "x": 2560, "y": -489, "width": 20, "height": 20}]});
        let (text, _) = run(json!({"include_ocr": true}), "som", Some(snapshot.clone()), &reply(words.clone()), 3);
        assert_eq!(text.matches("[ocr:").count(), 2, "{text}");
        // The budget reserves a share for the words: one at least, whatever the elements take.
        let (reserved, _) = run(json!({"include_ocr": true}), "som", Some(snapshot.clone()), &reply(words.clone()), 1);
        assert_eq!(reserved.matches("[ocr:").count(), 1, "{reserved}");
        let (none, _) = run(json!({"include_ocr": true}), "som", Some(snapshot), &reply(words), 0);
        assert_eq!(none, "OCR skipped (include_ocr): element_budget_exhausted");
    }

    #[test]
    fn a_failed_or_missing_recognition_is_reported_not_raised() {
        let failed = object(json!({"ocr": {"ok": false, "error": "ocr engine unavailable"}}));
        assert_eq!(run(json!({"include_ocr": true}), "som", None, &failed, 80).0, "OCR failed: ocr engine unavailable");
        let unavailable = object(json!({"ocr": {"available": false, "error": "ocr_failed: the frame could not be encoded"}}));
        assert_eq!(run(json!({"include_ocr": true}), "som", None, &unavailable, 80).0, "OCR failed: ocr_failed: the frame could not be encoded");
        assert_eq!(run(json!({"include_ocr": true}), "som", None, &Map::new(), 80).0, "OCR failed: the helper returned no OCR");
    }

    #[test]
    fn the_language_and_limit_are_forwarded_and_bad_limits_refused() {
        let command = object(json!({"include_ocr": true, "ocr_language": "ko", "max_ocr_words": 5}));
        let mut request = Map::new();
        ask(&command, "som", true).unwrap().unwrap().apply(&mut request);
        assert_eq!(Value::Object(request), json!({"include_ocr": true, "max_ocr_words": 5, "ocr_language": "ko"}));
        let mut plain = Map::new();
        ask(&Map::new(), "state", false).unwrap().unwrap().apply(&mut plain);
        assert_eq!(Value::Object(plain), json!({"include_ocr": true, "max_ocr_words": 300}));
        for bad in [json!(0), json!(1001), json!(1.5), json!("9")] {
            let command = object(json!({"include_ocr": true, "max_ocr_words": bad}));
            assert!(matches!(ask(&command, "som", false), Err(ComputerError::InvalidInput { .. })));
        }
    }

    #[test]
    fn ocr_runs_for_a_window_without_content_or_when_asked() {
        let none = Map::new();
        assert!(ask(&none, "state", false).unwrap().is_some() && ask(&none, "som", false).unwrap().is_some());
        assert!(ask(&none, "state", true).unwrap().is_none());
        assert!(ask(&none, "vision", false).unwrap().is_none() && ask(&none, "ax", false).unwrap().is_none());
        assert!(ask(&object(json!({"include_ocr": true})), "vision", true).unwrap().is_some());
    }
}
