//! Post-process `no-history-comment` matches. The ast-grep rule can only flag a comment node that
//! contains a history phrase, and applying `fix: ""` to that node deletes mixed prose, one `//`
//! line out of a paragraph, or a whole `/** */` header. This re-reads the file, expands contiguous
//! line-comment runs, and: drops comments whose history words sit inside other sentences,
//! auto-deletes a comment/block only when every sentence is history, and reports mixed comments
//! as manual (no fix) with the offending sentence.

use std::sync::OnceLock;

use mixdog_js::{JsRegex, js_trim, js_trim_end, js_trim_start, js_words};
use serde_json::{Value, json};

const HISTORY_COMMENT_RULE_ID: &str = "no-history-comment";
const LOCATION_TOKEN: &str = r"(?:\.\.?/)*[\w][\w.-]*(?:/[\w.-]+)*";

fn sentence_re() -> &'static JsRegex {
    static RE: OnceLock<JsRegex> = OnceLock::new();
    RE.get_or_init(|| {
        JsRegex::new_static(&format!(
            r"^(?:(?:extracted|moved|copied|lifted|split)(?:\s+verbatim)?\s+(?:from|out of)\s+{LOCATION_TOKEN}(?:\s+\((?:behaviou?r-preserving|no behaviou?r change)\))?|behaviou?r-preserving\s+(?:move|extraction)|previously\s+(?:lived|defined)\s+in\s+{LOCATION_TOKEN}|formerly\s+{LOCATION_TOKEN})\.?$"
        ), "i")
    })
}

fn phrase_re() -> &'static JsRegex {
    static RE: OnceLock<JsRegex> = OnceLock::new();
    RE.get_or_init(|| {
        JsRegex::new_static(r"\b(?:(?:extracted|moved|copied|lifted|split)\s+(?:verbatim\s+)?(?:from|out of)|moved(?:\s+here)?\s+from|behaviou?r-preserving\s+(?:move|extraction)|previously\s+(?:lived|defined)\s+in|was\s+previously\s+in|formerly)\b", "i")
    })
}

fn collapse(text: &str) -> String {
    js_words(text).collect::<Vec<_>>().join(" ")
}

pub fn is_history_sentence(text: &str) -> bool {
    let s = collapse(text);
    !s.is_empty() && sentence_re().is_match(&s)
}

/// Splits on `[.!?;]+` followed by whitespace or the end.
fn split_sentences(text: &str) -> Vec<String> {
    let cleaned = collapse(text);
    let (mut out, mut current) = (Vec::new(), String::new());
    let chars: Vec<char> = cleaned.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if matches!(chars[i], '.' | '!' | '?' | ';') {
            let mut j = i;
            while j < chars.len() && matches!(chars[j], '.' | '!' | '?' | ';') {
                j += 1;
            }
            if j == chars.len() || chars[j] == ' ' {
                out.push(std::mem::take(&mut current));
                i = j + usize::from(j < chars.len());
                continue;
            }
        }
        current.push(chars[i]);
        i += 1;
    }
    out.push(current);
    out.into_iter().map(|s| js_trim(&s).to_owned()).filter(|s| !s.is_empty()).collect()
}

fn comment_body(text: &str) -> String {
    let raw = text.replace("\r\n", "\n");
    let mut inner = js_trim(&raw).to_owned();
    if inner.starts_with("/*") {
        inner = inner.trim_start_matches('/').trim_start_matches('*').to_owned();
        inner = js_trim_end(&inner).trim_end_matches('/').trim_end_matches('*').to_owned();
    } else if inner.starts_with("--[[") {
        inner = js_trim_end(&inner["--[[".len()..]).trim_end_matches("]]").to_owned();
    } else if inner.starts_with("<!--") {
        inner = js_trim_end(&inner["<!--".len()..]).trim_end_matches("-->").to_owned();
    }
    let joined = inner
        .split('\n')
        .map(|line| {
            let body = js_trim(line);
            let body = ["//", "--", "#", "*"].iter().find_map(|p| body.strip_prefix(p)).unwrap_or(body);
            js_trim(body).to_owned()
        })
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    js_trim(&joined).to_owned()
}

#[derive(Debug, PartialEq)]
pub struct Classified {
    /// `none | pure | mixed`
    pub kind: &'static str,
    pub offending: Option<String>,
}

pub fn classify_history_comment(text: &str) -> Classified {
    let sentences = split_sentences(&comment_body(text));
    let (history, other): (Vec<&String>, Vec<&String>) = sentences.iter().partition(|s| is_history_sentence(s));
    match (history.first(), other.is_empty()) {
        (None, _) => Classified { kind: "none", offending: None },
        (Some(_), true) => Classified { kind: "pure", offending: None },
        (Some(first), false) => Classified { kind: "mixed", offending: Some((*first).clone()) },
    }
}

fn line_start(buf: &[u8], index: usize) -> usize {
    let mut c = index.min(buf.len());
    while c > 0 && buf[c - 1] != b'\n' {
        c -= 1;
    }
    c
}

fn line_end(buf: &[u8], index: usize) -> usize {
    let mut c = index.min(buf.len());
    while c < buf.len() && buf[c] != b'\n' && buf[c] != b'\r' {
        c += 1;
    }
    c
}

fn text(buf: &[u8], start: usize, end: usize) -> String {
    String::from_utf8_lossy(&buf[start.min(buf.len())..end.min(buf.len())]).into_owned()
}

fn line_comment_kind(line: &str) -> &'static str {
    let t = js_trim_start(line);
    if t.starts_with("//") {
        "//"
    } else if t.starts_with("--") {
        "--"
    } else if t.starts_with('#') {
        "#"
    } else {
        ""
    }
}

fn is_block_comment_text(t: &str) -> bool {
    let t = js_trim(t);
    t.starts_with("/*") ||t.starts_with("--[[") || t.starts_with("<!--")
}

fn is_full_line_comment(buf: &[u8], start: usize) -> bool {
    js_trim(&text(buf, line_start(buf, start), start)).is_empty()
}

fn skip_one_newline(buf: &[u8], index: usize) -> usize {
    let mut c = index;
    if c < buf.len() && buf[c] == b'\r' {
        c += 1;
    }
    if c < buf.len() && buf[c] == b'\n' {
        c += 1;
    }
    c
}

fn previous_full_line_comment(buf: &[u8], current_start: usize, kind: &str) -> Option<(usize, usize)> {
    if current_start == 0 {
        return None;
    }
    let start = line_start(buf, current_start - 1);
    if start >= current_start {
        return None;
    }
    let hi = line_end(buf, start);
    let body = text(buf, start, hi);
    (!js_trim(&body).is_empty() && line_comment_kind(&body) == kind).then_some((start, hi))
}

fn next_full_line_comment(buf: &[u8], current_hi: usize, kind: &str) -> Option<(usize, usize)> {
    let start = skip_one_newline(buf, current_hi);
    if start >= buf.len() || start == current_hi {
        return None;
    }
    let end = line_end(buf, start);
    let body = text(buf, start, end);
    (!js_trim(&body).is_empty() && line_comment_kind(&body) == kind).then_some((start, end))
}

fn range_is_comment_only(buf: &[u8], start: usize, end: usize) -> bool {
    let t = text(buf, start, end);
    if is_block_comment_text(&t) {
        let tr = js_trim(&t);
        return (tr.starts_with("/*") && tr.ends_with("*/")) || tr.starts_with("--[[") || tr.starts_with("<!--");
    }
    let mut lines: Vec<&str> = t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    !lines.is_empty() && lines.iter().all(|l| js_trim(l).is_empty() || !line_comment_kind(l).is_empty())
}

/// Comment-only byte range. A `//` run runs from the first comment line's start through the last
/// comment line's end (the newline is not consumed: it belongs to source layout). Trailing
/// comments on a code line stay on the comment node, never the following statement.
fn expand_comment_range(buf: &[u8], start: usize, end: usize) -> (usize, usize) {
    let node_start = start.min(buf.len());
    let node_end = end.min(buf.len()).max(node_start);
    let slice = text(buf, node_start, node_end);
    if is_block_comment_text(&slice) || !is_full_line_comment(buf, node_start) {
        if range_is_comment_only(buf, node_start, node_end) {
            return (node_start, node_end);
        }
        let clamped = (node_start, node_end.min(line_end(buf, node_start)));
        return if range_is_comment_only(buf, clamped.0, clamped.1) { clamped } else { (node_start, node_start) };
    }
    let kind = line_comment_kind(&text(buf, line_start(buf, node_start), line_end(buf, node_start)));
    if kind.is_empty() {
        return (node_start, node_end);
    }
    let (mut lo, mut hi) = (line_start(buf, node_start), line_end(buf, node_start));
    while let Some((s, _)) = previous_full_line_comment(buf, lo, kind) {
        lo = s;
    }
    while let Some((_, e)) = next_full_line_comment(buf, hi, kind) {
        hi = e;
    }
    let mut range = (lo, hi);
    if !range_is_comment_only(buf, range.0, range.1) {
        range = (if is_full_line_comment(buf, node_start) { line_start(buf, node_start) } else { node_start }, line_end(buf, node_start));
    }
    if range_is_comment_only(buf, range.0, range.1) { range } else { (node_start, node_end) }
}

fn offsets_of(m: &Value) -> Option<(usize, usize)> {
    let range = m.pointer("/range/byteOffset").or_else(|| m.pointer("/fix/byteOffset"))?.as_array()?;
    let (s, e) = (range.first()?.as_u64()? as usize, range.get(1)?.as_u64()? as usize);
    (e >= s).then_some((s, e))
}

fn merge_ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for r in ranges {
        match merged.last_mut() {
            Some(last) if r.0 <= last.1 => last.1 = last.1.max(r.1),
            _ => merged.push(r),
        }
    }
    merged
}

fn manual(mut m: Value) -> Value {
    m["fix"] = Value::Null;
    m["manual"] = json!(true);
    m
}

/// Refines graph matches for `no-history-comment`. `source_for(file)` returns the file bytes in the
/// same coordinate space as the match byte offsets.
pub fn refine_history_comment_matches(matches: Vec<Value>, source_for: &dyn Fn(&str) -> Option<Vec<u8>>) -> Vec<Value> {
    let (history, rest): (Vec<Value>, Vec<Value>) = matches.into_iter().partition(|m| m["ruleId"] == HISTORY_COMMENT_RULE_ID);
    if history.is_empty() {
        return rest;
    }
    let mut files: Vec<String> = Vec::new();
    for m in &history {
        let f = m["file"].as_str().unwrap_or("").to_owned();
        if !files.contains(&f) {
            files.push(f);
        }
    }
    let mut refined = Vec::new();
    for file in files {
        let file_matches: Vec<&Value> = history.iter().filter(|m| m["file"] == file.as_str()).collect();
        let Some(buf) = source_for(&file) else {
            refined.extend(file_matches.into_iter().cloned().map(manual));
            continue;
        };
        let mut expanded = Vec::new();
        for m in &file_matches {
            let Some((s, e)) = offsets_of(m) else {
                refined.push(manual((*m).clone()));
                continue;
            };
            let (start, end) = expand_comment_range(&buf, s, e);
            if phrase_re().is_match(&text(&buf, start, end)) {
                expanded.push((start, end));
            }
        }
        let sample = file_matches[0];
        for (start, end) in merge_ranges(expanded) {
            let comment = text(&buf, start, end);
            let classified = classify_history_comment(&comment);
            let refine = |fix: Value, is_manual: bool, message: Value| {
                let mut r = sample.clone();
                r["file"] = json!(file);
                r["range"]["byteOffset"] = json!([start, end]);
                r["fix"] = fix;
                r["manual"] = json!(is_manual);
                if !message.is_null() {
                    r["message"] = message;
                }
                r
            };
            match classified.kind {
                "none" => {}
                "pure" => {
                    let block = is_block_comment_text(&comment);
                    let embedded = block && (!is_full_line_comment(&buf, start) || !js_trim(&text(&buf, end, line_end(&buf, end))).is_empty());
                    if embedded {
                        refined.push(refine(Value::Null, true, json!("History comment shares a line with code; preserve token boundaries and line terminators.")));
                        continue;
                    }
                    // A block comment keeps its line terminators so line numbers do not shift.
                    let keep: String = if block { comment.chars().filter(|c| matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}')).collect() } else { String::new() };
                    let message = sample.get("message").filter(|m| m.as_str().is_some_and(|s| !s.is_empty())).cloned().unwrap_or_else(|| json!("Delete comments that only record a move or copy."));
                    refined.push(refine(json!({"byteOffset": [start, end], "text": keep}), false, message));
                }
                _ => refined.push(refine(Value::Null, true, json!(format!("History phrase mixed with other comment text; edit by hand: \"{}\"", classified.offending.unwrap_or_default())))),
            }
        }
    }
    rest.into_iter().chain(refined).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(file: &str, start: usize, end: usize) -> Value {
        json!({"file": file, "ruleId": HISTORY_COMMENT_RULE_ID, "message": "", "range": {"byteOffset": [start, end]}, "fix": {"byteOffset": [start, end], "text": ""}})
    }

    fn refine(src: &str, start: usize, end: usize) -> Vec<Value> {
        let bytes = src.as_bytes().to_vec();
        refine_history_comment_matches(vec![m("a.ts", start, end)], &move |_| Some(bytes.clone()))
    }

    #[test]
    fn only_whole_history_sentences_count() {
        assert!(is_history_sentence("Extracted verbatim from ../shared/foo.mjs (no behaviour change)."));
        assert!(is_history_sentence("formerly lib/old"));
        assert!(!is_history_sentence("Moved from the loop because it is faster"));
        assert_eq!(classify_history_comment("// Moved from a/b.\n// Parses the header.").kind, "mixed");
        assert_eq!(classify_history_comment("// Moved from a/b.\n// Behavior-preserving move.").kind, "pure");
        assert_eq!(classify_history_comment("// plain note").kind, "none");
        assert_eq!(classify_history_comment("/** Previously lived in x/y */").kind, "pure");
        assert_eq!(classify_history_comment("// Moved from a/b. Parses.").offending.as_deref(), Some("Moved from a/b"));
    }

    #[test]
    fn a_pure_line_run_is_deleted_whole_but_never_its_newline() {
        let src = "const a = 1;\n// Moved from lib/a.\n// formerly lib/b\nconst b = 2;\n";
        let start = src.find("// formerly").unwrap();
        let out = refine(src, start, start + "// formerly lib/b".len());
        assert_eq!(out.len(), 1);
        let first = src.find("// Moved").unwrap();
        let end = src.find("lib/b").unwrap() + 5;
        assert_eq!(out[0]["fix"]["byteOffset"], json!([first, end]));
        assert_eq!(out[0]["fix"]["text"], "");
        assert_eq!(out[0]["manual"], false);
    }

    #[test]
    fn mixed_prose_is_manual_and_innocent_comments_are_dropped() {
        let mixed = "// Moved from lib/a.\n// Parses the header.\nlet x;";
        let out = refine(mixed, 0, 21);
        assert_eq!((out[0]["manual"].clone(), out[0]["fix"].clone()), (json!(true), Value::Null));
        assert!(out[0]["message"].as_str().unwrap().contains("edit by hand: \"Moved from lib/a\""));
        let innocent = "// We moved from callbacks to promises because it is simpler\nlet x;";
        assert!(refine(innocent, 0, 59).is_empty());
    }

    #[test]
    fn block_comments_keep_their_line_terminators_and_embedded_ones_are_manual() {
        let src = "/*\n * Extracted from lib/a.\n */\nlet x;";
        let out = refine(src, 0, src.find("*/").unwrap() + 2);
        assert_eq!(out[0]["fix"]["text"], "\n\n");
        let embedded = "let x; /* moved from lib/a */ let y;";
        let s = embedded.find("/*").unwrap();
        let out = refine(embedded, s, s + 22);
        assert_eq!((out[0]["manual"].clone(), out[0]["fix"].clone()), (json!(true), Value::Null));
    }

    #[test]
    fn other_rules_pass_through_and_unreadable_files_become_manual() {
        let other = json!({"file": "a.ts", "ruleId": "other", "fix": {"text": "x"}});
        let out = refine_history_comment_matches(vec![other.clone(), m("gone.ts", 0, 1), json!({"file": "b.ts", "ruleId": HISTORY_COMMENT_RULE_ID})], &|f| (f == "b.ts").then(|| b"x".to_vec()));
        assert_eq!(out[0], other);
        assert_eq!(out[1]["manual"], true);
        assert_eq!(out[2]["manual"], true, "a match without a byte range is manual");
    }
}
