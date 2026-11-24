//! The tool output a peer shows, cut where the frame leaves for it. A peer that announced `toolOutput` at initialize (a phone) is
//! written each notification frame with the outputs of its tool rows cut to the size it shows them at; the frame the feed encoded is
//! shared by every peer, so the cut belongs to the writer of the one connection. An answer (`thread/items/read`) is not cut: it is how
//! the peer reads an output whole.

use bytes::Bytes;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The size a peer shows a tool output at: its first `lines` lines, at most `chars` characters (a shell tool's one line more).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Display {
    pub(crate) chars: usize,
    pub(crate) lines: usize,
}

/// Said on a row (`meta.ext`) whose output was cut: the length of its longest output, and per field where the text now ends.
const TRUNCATED: &str = "remoteOutputTruncated";
const NOTES: &str = "remoteOutputNotes";
/// Said beside them: the whole output is read when the person asks for it (`thread/items/read`), never ahead of that.
const ON_REQUEST: &str = "remoteOutputOnRequest";
const COMMAND_TOOLS: [&str; 4] = ["shell", "bash", "bash_session", "shell_command"];

/// `frame` with the outputs of the tool rows it carries cut to `display`; `frame` itself when it is no notification, carries no tool
/// row or has nothing over the size.
pub(crate) fn cut_frame(frame: Bytes, display: &Display) -> Bytes {
    if frame.len() <= display.chars || !contains(&frame, b"\"toolCall\"") {
        return frame;
    }
    let Ok(mut value) = serde_json::from_slice::<Value>(&frame) else { return frame };
    if !value.get("method").is_some_and(Value::is_string) {
        return frame;
    }
    let mut cut = false;
    walk(&mut value, display, &mut cut);
    if !cut {
        return frame;
    }
    serde_json::to_vec(&value).map_or(frame, Bytes::from)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn walk(value: &mut Value, display: &Display, cut: &mut bool) {
    match value {
        Value::Array(list) => list.iter_mut().for_each(|item| walk(item, display, cut)),
        Value::Object(object) if object.get("type").and_then(Value::as_str) == Some("toolCall") => {
            *cut |= cut_item(object, display);
        }
        Value::Object(object) => object.values_mut().for_each(|item| walk(item, display, cut)),
        _ => {}
    }
}

/// The tools whose cards read their summary from the output's line counts, its head and its exit markers alone, which the row
/// carries (`remoteOutputStats`) when its text is cut: the phone computes the card's facts from them as from the whole output. The
/// output of any other tool is sent whole.
const READ_TOOLS: [&str; 1] = ["read"];
const LIST_TOOLS: [&str; 4] = ["glob", "find", "list", "ls"];
/// Said on a cut row beside its length: how many lines the whole output had (its trailing blank space, which the card does not count,
/// left out), and how many of them were not blank.
const STATS: &str = "remoteOutputStats";

/// One tool row's outputs: the text its card is drawn from (`output`, else `run.result`) and the raw result, of a tool the card facts
/// of a cut output can be carried for, and the responses a sub-agent card extends with (`meta.ext.agentResponseEntries`, no page of
/// the phone reads a body from them: they are cut whatever they hold).
fn cut_item(item: &mut Map<String, Value>, display: &Display) -> bool {
    let entries_cut = cut_entries(item, display);
    let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
    let command = COMMAND_TOOLS.contains(&name);
    let carried = command || READ_TOOLS.contains(&name) || LIST_TOOLS.contains(&name);
    if !carried || failed(item) || shown_whole_row(item) {
        return entries_cut;
    }
    let lines = display.lines + usize::from(command);
    let stats =
        item.get("output").filter(|output| output.is_string()).or_else(|| item.get("run").and_then(|run| run.get("result"))).and_then(Value::as_str).map(
            |text| json!({ "lines": text.trim_end().split('\n').count(), "nonBlankLines": text.split('\n').filter(|line| !line.trim().is_empty()).count() }),
        );
    let mut longest = 0;
    let mut notes = Map::new();
    let mut note = |field: &str, text: &mut Value, longest: &mut usize| {
        if let Some((kept, length, note)) = preview(&*text, display.chars, lines) {
            *text = Value::String(kept);
            *longest = (*longest).max(length);
            notes.insert(field.to_owned(), note);
        }
    };
    if let Some(output) = item.get_mut("output") {
        note("result", output, &mut longest);
    }
    if let Some(run) = item.get_mut("run").and_then(Value::as_object_mut) {
        if let Some(result) = run.get_mut("result") {
            note("result", result, &mut longest);
        }
        if let Some(raw) = run.get_mut("rawResult") {
            note("rawResult", raw, &mut longest);
        }
    }
    if notes.is_empty() {
        return entries_cut;
    }
    if let Some(ext) = item.get_mut("meta").and_then(Value::as_object_mut).map(|meta| meta.entry("ext").or_insert_with(|| json!({})))
        && let Some(ext) = ext.as_object_mut()
    {
        ext.insert(TRUNCATED.to_owned(), json!(longest));
        if notes.contains_key("result")
            && let Some(stats) = stats
        {
            ext.insert(STATS.to_owned(), stats);
        }
        ext.insert(NOTES.to_owned(), Value::Object(notes));
        ext.insert(ON_REQUEST.to_owned(), Value::Bool(true));
    }
    true
}

/// A row that failed, was stopped, or says it is an error: the card reads its cause from the output.
fn failed(item: &Map<String, Value>) -> bool {
    let status = item.get("meta").and_then(|meta| meta.get("status")).and_then(Value::as_str);
    let flagged = |flag: Option<&Value>| flag == Some(&Value::Bool(true));
    matches!(status, Some("failed" | "interrupted"))
        || flagged(item.get("run").and_then(|run| run.get("isError")))
        || flagged(item.get("meta").and_then(|meta| meta.get("ext")).and_then(|ext| ext.get("isError")))
}

/// Whether the card reads any of the row's texts whole: decided for the row, so its texts are all cut or none is.
fn shown_whole_row(item: &Map<String, Value>) -> bool {
    let run = item.get("run");
    [item.get("output"), run.and_then(|run| run.get("result")), run.and_then(|run| run.get("rawResult"))]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(shown_whole)
}

fn cut_entries(item: &mut Map<String, Value>, display: &Display) -> bool {
    let entries = item.get_mut("meta").and_then(|meta| meta.get_mut("ext")).and_then(|ext| ext.get_mut("agentResponseEntries")).and_then(Value::as_array_mut);
    let mut cut = false;
    for entry in entries.into_iter().flatten().filter_map(Value::as_object_mut) {
        for field in ["raw", "result"] {
            if let Some(text) = entry.get_mut(field)
                && let Some((kept, ..)) = preview(text, display.chars, display.lines)
            {
                *text = Value::String(kept);
                cut = true;
            }
        }
    }
    cut
}
/// The text `value` shows at `chars` characters and `lines` lines, its length and what was left out; `None` when it is no text or
/// fits.
fn preview(value: &Value, chars: usize, lines: usize) -> Option<(String, usize, Value)> {
    let text = value.as_str()?;
    let length = text.chars().count();
    let mut end = length.min(chars);
    let mut at = 0;
    for _ in 0..lines {
        match text.chars().skip(at).position(|c| c == '\n') {
            Some(offset) => at += offset + 1,
            None => {
                at = usize::MAX;
                break;
            }
        }
    }
    if at != usize::MAX {
        end = end.min(at - 1);
    }
    if end >= length {
        return None;
    }
    let kept: String = text.chars().take(end).collect();
    Some((kept, length, json!({ "kind": "omitted", "at": end, "omitted": length - end })))
}

/// The outputs a card reads whole: structured text, and the task and answer notices (the phone's `HISTORY_WHOLE_OUTPUT`).
fn shown_whole(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let start = lower.trim_start();
    if lower.contains("task-notification>") || start.starts_with('{') || start.starts_with("agent task:") {
        return true;
    }
    if start.starts_with("background task") || start.starts_with("user has answered") || start.starts_with("user replied in chat") {
        return true;
    }
    // A command's exit, status and job lines, and an image, are what its card reads its summary from, wherever they stand: after
    // leading spaces, and after the `Error:` and `[shell-run-failed]` a failed run opens with.
    if lower.lines().any(|line| {
        let line = line.trim_start();
        let line = line.strip_prefix("error:").unwrap_or(line).trim_start();
        let line = line.strip_prefix("[shell-run-failed]").unwrap_or(line).trim_start();
        ["[exit", "[status:", "[task_id:", "[job:", "[image:"].iter().any(|marker| line.starts_with(marker))
    }) {
        return true;
    }
    let Some(array) = start.strip_prefix('[') else { return false };
    let array = array.trim_start();
    array.starts_with(['[', '{', '"', ']', '-'])
        || array.starts_with(|c: char| c.is_ascii_digit())
        || ["true", "false", "null"].iter().any(|word| array.starts_with(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(method: Option<&str>, item: Value) -> Bytes {
        let mut frame = json!({ "params": { "added": [{ "units": [{ "items": [item] }] }] } });
        if let Some(method) = method {
            frame["method"] = json!(method);
        }
        Bytes::from(serde_json::to_vec(&frame).unwrap())
    }

    fn tool(output: &str) -> Value {
        json!({ "type": "toolCall", "id": "i1", "name": "read", "input": {"path": "a"}, "output": output,
                "run": { "result": output, "rawResult": output }, "meta": { "ext": { "historyPosition": "p1" } } })
    }

    fn first_item(frame: &Bytes) -> Value {
        serde_json::from_slice::<Value>(frame).unwrap()["params"]["added"][0]["units"][0]["items"][0].clone()
    }

    const SHOWN: Display = Display { chars: 600, lines: 5 };

    #[test]
    fn an_output_over_the_size_is_cut_everywhere_it_stands_and_its_length_is_said() {
        let text = "line of output\n".repeat(400);
        let cut = cut_frame(frame(Some("thread/window/changed"), tool(&text)), &SHOWN);
        let item = first_item(&cut);
        let kept = "line of output\n".repeat(4) + "line of output";
        assert_eq!(item["output"], kept);
        assert_eq!(item["run"]["result"], kept);
        assert_eq!(item["meta"]["ext"]["remoteOutputTruncated"], text.chars().count());
        assert_eq!(item["meta"]["ext"]["remoteOutputOnRequest"], true);
        assert_eq!(item["meta"]["ext"]["remoteOutputNotes"]["result"], json!({ "kind": "omitted", "at": kept.len(), "omitted": text.len() - kept.len() }));
        assert_eq!(item["meta"]["ext"]["historyPosition"], "p1", "what the row carried stays");
        assert_eq!(item["run"]["rawResult"], kept);
        assert_eq!(
            item["meta"]["ext"]["remoteOutputStats"],
            json!({ "lines": 400, "nonBlankLines": 400 }),
            "the whole output's line counts, which the card's facts read, are said beside its length"
        );
    }

    #[test]
    fn only_the_outputs_whose_card_facts_are_carried_are_cut_and_never_past_an_exit_marker_or_a_failure() {
        let text = "line of output\n".repeat(400);
        let named = |name: &str, output: &str| {
            let mut item = tool(output);
            item["name"] = json!(name);
            let cut = first_item(&cut_frame(frame(Some("thread/snapshot"), item.clone()), &SHOWN));
            (item, cut)
        };
        for tool_name in ["agent", "git", "grep", "edit", "memory"] {
            let (item, cut) = named(tool_name, &text);
            assert_eq!(cut, item, "{tool_name}: its facts are not carried, so its output is sent whole");
        }
        for tool_name in ["read", "bash", "glob", "ls"] {
            let (_, cut) = named(tool_name, &text);
            assert!(cut["output"].as_str().unwrap().len() < text.len(), "{tool_name} is cut");
        }
        let with_exit = format!("{text}[exit code: 1]");
        let (item, cut) = named("bash", &with_exit);
        assert_eq!(cut, item, "a command's exit line is what its summary reads");
        let mut failed = tool(&text);
        failed["run"]["isError"] = json!(true);
        let cut = first_item(&cut_frame(frame(Some("thread/snapshot"), failed.clone()), &SHOWN));
        assert_eq!(cut, failed, "a failure's cause is read from the output");
    }

    #[test]
    fn a_frame_that_is_no_notification_or_fits_or_holds_a_whole_output_is_unchanged() {
        let text = "x".repeat(5_000);
        let answer = frame(None, tool(&text));
        assert_eq!(cut_frame(answer.clone(), &SHOWN), answer, "an answer is how the whole output is read");
        let small = frame(Some("thread/snapshot"), tool("short"));
        assert_eq!(cut_frame(small.clone(), &SHOWN), small);
        let structured = frame(Some("thread/snapshot"), tool(&format!("{{\"k\": \"{text}\"}}")));
        assert_eq!(cut_frame(structured.clone(), &SHOWN), structured);
    }

    #[test]
    fn a_sub_agent_card_s_response_entries_are_cut_whatever_they_hold_while_the_result_that_is_a_notice_stays_whole() {
        let notice = format!("<task-notification>\n<result>{}</result>\n</task-notification>", "y".repeat(4_000));
        let mut item = tool("short");
        item["run"] = json!({ "result": notice, "rawResult": notice });
        item["meta"]["ext"]["agentResponseEntries"] = json!([{ "key": "k", "raw": notice, "result": notice, "hasBody": true }]);
        let cut = first_item(&cut_frame(frame(Some("thread/snapshot"), item), &SHOWN));
        assert_eq!(cut["run"]["result"], notice, "a card reads a task notice whole");
        let entry = &cut["meta"]["ext"]["agentResponseEntries"][0];
        assert!(entry["raw"].as_str().unwrap().len() <= 600 && entry["result"].as_str().unwrap().len() <= 600);
        assert_eq!(entry["hasBody"], true, "the entry's other facts stay");
        assert!(cut["meta"]["ext"].get("remoteOutputTruncated").is_none(), "no output of the card itself was cut");
    }

    #[test]
    fn a_row_is_cut_whole_or_not_at_all_by_what_any_of_its_texts_holds() {
        let text = "line of output\n".repeat(400);
        let mut item = tool(&text);
        item["name"] = json!("bash");
        item["run"]["rawResult"] = json!(format!("{text}[exit code: 0]"));
        let cut = first_item(&cut_frame(frame(Some("thread/snapshot"), item.clone()), &SHOWN));
        assert_eq!(cut, item, "the exit line is in the raw result: neither text is cut, the card reads both");
    }

    #[test]
    fn the_exit_lines_the_phone_reads_are_found_after_spaces_and_a_failed_run_s_prefixes() {
        let text = "line of output\n".repeat(400);
        for marker in [
            "  [exit code: 0]",
            "Error: [shell-run-failed] [exit code: 2]",
            "[shell-run-failed] [exit code: 2]",
            "[session: s1]\n[exit code: 1]",
            "[status: running]",
        ] {
            let mut item = tool(&format!("{marker}\n{text}"));
            item["name"] = json!("shell");
            let cut = first_item(&cut_frame(frame(Some("thread/snapshot"), item.clone()), &SHOWN));
            assert_eq!(cut, item, "{marker:?} is kept whole");
        }
    }

    #[test]
    fn a_row_that_failed_was_stopped_or_says_it_is_an_error_is_sent_whole() {
        let text = "line of output\n".repeat(400);
        let marks: [(&str, fn(&mut Value)); 4] = [
            ("status failed", |item| item["meta"]["status"] = json!("failed")),
            ("status interrupted", |item| item["meta"]["status"] = json!("interrupted")),
            ("ext isError", |item| item["meta"]["ext"]["isError"] = json!(true)),
            ("run isError", |item| item["run"]["isError"] = json!(true)),
        ];
        for (path, mark) in marks {
            let mut item = tool(&text);
            mark(&mut item);
            let cut = first_item(&cut_frame(frame(Some("thread/snapshot"), item.clone()), &SHOWN));
            assert_eq!(cut, item, "{path} marks a failure");
        }
    }
}
