//! Read-row line numbers (`shared/read-row-numbers.mjs`), shared by the read tool and every transcript surface.
//!
//! Every row is numbered internally as `<n>→<content>`; the model-facing result drops the numbers: each run of consecutive
//! rows becomes one `[lines a-b]` marker line followed by the bare rows. Displays rebuild the numbered rows from the markers.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::json_number;
use mixdog_js::number_to_string;
use mixdog_js::string_to_number;
use serde_json::Map;
use serde_json::Value;

pub const READ_LINE_NO_SEP: char = '→';

static ROW: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d+)→", ""));
static RUN_MARKER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[lines (\d+)-(\d+)\]$", ""));
static NUMBERED_ROW: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d+)→([\s\S]*)$", ""));
static FOOTER: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^\[lines (\d+)-(\d+) of (\d+)(?:; offset:\d+ for more)?\]$", ""));
static EMPTY_FILE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^<system-reminder>File exists but has empty contents: [^\n]*</system-reminder>$", ""));
static EMPTY_RANGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\(no lines in range; file has (\d+) lines\)$", ""));

/// The row number a line opens with and the length of its `<n>→` prefix in bytes.
fn row_prefix(line: &str) -> Option<(f64, usize)> {
    let caps = ROW.captures(line)?;
    Some((string_to_number(caps.get(1)?), caps.get(0)?.len()))
}

/// `readRowsForModel`: bare content under one `[lines a-b]` marker per run.
pub fn read_rows_for_model(text: &str) -> String {
    if !text.contains(READ_LINE_NO_SEP) {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut changed = false;
    let mut i = 0;
    while i < lines.len() {
        let Some((start, prefix)) = row_prefix(lines[i]) else {
            out.push(lines[i].to_owned());
            i += 1;
            continue;
        };
        let mut bodies: Vec<&str> = vec![&lines[i][prefix..]];
        i += 1;
        while i < lines.len() {
            match row_prefix(lines[i]) {
                Some((number, prefix)) if number == start + bodies.len() as f64 => {
                    bodies.push(&lines[i][prefix..]);
                    i += 1;
                }
                _ => break,
            }
        }
        let marker = format!("[lines {}-{}]", number_to_string(start), number_to_string(start + bodies.len() as f64 - 1.0));
        out.push(marker.clone());
        out.extend(bodies.iter().map(|body| (*body).to_owned()));
        // A footer naming exactly the same run adds nothing beyond the marker.
        if lines.get(i).is_some_and(|line| *line == marker) {
            i += 1;
        }
        changed = true;
    }
    if changed { out.join("\n") } else { text.to_owned() }
}

/// `readRowsForDisplay`: numbered `<n>→<content>` rows rebuilt from the run markers.
pub fn read_rows_for_display(text: &str) -> String {
    if !text.contains("[lines ") {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let run = RUN_MARKER.captures(lines[i]).map(|caps| {
            let start = string_to_number(caps.get(1).unwrap_or_default());
            (start, string_to_number(caps.get(2).unwrap_or_default()) - start + 1.0)
        });
        match run {
            Some((start, count)) if count >= 1.0 && (i as f64) + count < lines.len() as f64 => {
                let count = count as usize;
                for k in 0..count {
                    out.push(format!("{}{READ_LINE_NO_SEP}{}", number_to_string(start + k as f64), lines[i + 1 + k]));
                }
                i += count;
            }
            _ => out.push(lines[i].to_owned()),
        }
        i += 1;
    }
    out.join("\n")
}

/// One contiguous model-facing read window (`readSourceWindow`).
#[derive(Clone, Debug, PartialEq)]
pub struct SourceWindow {
    pub content: String,
    pub total_lines: Option<f64>,
    pub start_line: Option<f64>,
    pub end_line: Option<f64>,
    pub truncated: bool,
}

impl SourceWindow {
    /// The object Node returns (`totalLines` absent when unknown, `startLine`/`endLine` null for an empty range).
    pub fn to_value(&self) -> Value {
        let number = |value: Option<f64>| value.map_or(Value::Null, json_number);
        let mut map = Map::new();
        map.insert("content".to_owned(), Value::from(self.content.clone()));
        if let Some(total) = self.total_lines {
            map.insert("totalLines".to_owned(), json_number(total));
        }
        map.insert("startLine".to_owned(), number(self.start_line));
        map.insert("endLine".to_owned(), number(self.end_line));
        map.insert("truncated".to_owned(), Value::Bool(self.truncated));
        Value::Object(map)
    }
}

/// `readSourceWindow`: decodes one contiguous model-facing read window, never display metadata. Unknown or disjoint views
/// are not safe substitutes for file text.
pub fn read_source_window(text: &str) -> Option<SourceWindow> {
    if EMPTY_FILE.is_match(text) {
        return Some(SourceWindow { content: String::new(), total_lines: Some(0.0), start_line: Some(1.0), end_line: Some(0.0), truncated: false });
    }
    if let Some(caps) = EMPTY_RANGE.captures(text) {
        let total = string_to_number(caps.get(1).unwrap_or_default());
        return Some(SourceWindow { content: String::new(), total_lines: Some(total), start_line: None, end_line: None, truncated: false });
    }
    if !RUN_MARKER.is_match(text.split('\n').next().unwrap_or_default()) {
        return None;
    }
    let mut rows: Vec<(f64, String)> = Vec::new();
    let mut footer: Option<(f64, f64, f64)> = None;
    for line in read_rows_for_display(text).split('\n') {
        if let Some(caps) = NUMBERED_ROW.captures(line) {
            if footer.is_some() {
                return None;
            }
            let number = string_to_number(caps.get(1).unwrap_or_default());
            if rows.last().is_some_and(|(last, _)| number != last + 1.0) {
                return None;
            }
            rows.push((number, caps.get(2).unwrap_or_default().to_owned()));
            continue;
        }
        let caps = FOOTER.captures(line)?;
        if footer.is_some() {
            return None;
        }
        let part = |group: usize| string_to_number(caps.get(group).unwrap_or_default());
        footer = Some((part(1), part(2), part(3)));
    }
    let (start_line, end_line) = (rows.first()?.0, rows.last()?.0);
    if let Some((from, to, total)) = footer
        && (from != start_line || to != end_line || total < end_line)
    {
        return None;
    }
    let total_lines = footer.map(|(_, _, total)| total);
    Some(SourceWindow {
        content: rows.iter().map(|(_, content)| content.as_str()).collect::<Vec<_>>().join("\n"),
        total_lines,
        start_line: Some(start_line),
        end_line: Some(end_line),
        truncated: total_lines.is_none_or(|total| end_line < total),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_become_runs_and_back() {
        let numbered = "1→a\n2→b\n5→c\nplain";
        let model = read_rows_for_model(numbered);
        assert_eq!(model, "[lines 1-2]\na\nb\n[lines 5-5]\nc\nplain");
        assert_eq!(read_rows_for_display(&model), numbered);
        assert_eq!(read_rows_for_model("no rows"), "no rows");
    }

    #[test]
    fn a_footer_naming_the_same_run_is_dropped() {
        assert_eq!(read_rows_for_model("1→a\n2→b\n[lines 1-2]"), "[lines 1-2]\na\nb");
    }

    #[test]
    fn a_marker_without_its_rows_stays() {
        assert_eq!(read_rows_for_display("[lines 1-3]\nonly"), "[lines 1-3]\nonly");
        assert_eq!(read_rows_for_display("[lines 3-1]\nx"), "[lines 3-1]\nx");
    }

    #[test]
    fn a_window_is_decoded() {
        let window = read_source_window("[lines 3-4]\nx\ny\n[lines 3-4 of 9; offset:5 for more]").expect("window");
        assert_eq!(window.content, "x\ny");
        assert_eq!((window.start_line, window.end_line, window.total_lines, window.truncated), (Some(3.0), Some(4.0), Some(9.0), true));
        let whole = read_source_window("[lines 1-2]\nx\ny").expect("window");
        assert!(whole.truncated && whole.total_lines.is_none());
        assert!(read_source_window("[lines 1-2]\nx\ny\n[lines 1-3 of 3]").is_none());
        assert!(read_source_window("plain text").is_none());
    }

    #[test]
    fn empty_reads_are_windows() {
        let empty = read_source_window("(no lines in range; file has 7 lines)").expect("window");
        assert_eq!((empty.total_lines, empty.start_line), (Some(7.0), None));
        let file = read_source_window("<system-reminder>File exists but has empty contents: a.txt</system-reminder>").expect("window");
        assert_eq!((file.start_line, file.end_line), (Some(1.0), Some(0.0)));
    }
}
