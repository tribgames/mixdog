//! The answer to an exec the run handed over as a tool call, written back on the run that asked for it: an MCP call's
//! result, or the typed result of a native read, write, search, listing, fetch or shell the call was redirected from.

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;

use super::request::text_of;
use super::schema::ExecServer;
use super::schema::GrepArgs;
use crate::providers::connect::pb::Writer;

const MAX_TOOL_TEXT_BYTES: usize = 512 * 1024;
const MAX_TOOL_MEDIA_BYTES: usize = 16 * 1024 * 1024;
const TRUNCATED_NOTICE: &str = "\n\n[Mixdog truncated this Cursor tool result to stay within the wire limit.]";
const UNCLEAN_READ: &str = "This read result is not a complete contiguous source window. Use the mixdog MCP read tool with file_path, offset and limit; do not treat display markers as file content.";

/// What a tool returned, as the run is told it.
struct Outcome {
    ok: bool,
    text: String,
    media: Vec<(Vec<u8>, String)>,
}

impl Outcome {
    fn of(result: &Message) -> Self {
        let mut media = Vec::new();
        let mut bytes = 0;
        if let Content::Parts(parts) = &result.content {
            for part in parts {
                let ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) = part else { continue };
                let Ok(data) = STANDARD.decode(data.as_bytes()) else { continue };
                if data.len() > MAX_TOOL_MEDIA_BYTES {
                    continue;
                }
                if bytes + data.len() > MAX_TOOL_MEDIA_BYTES {
                    break;
                }
                bytes += data.len();
                media.push((data, mime_type.clone()));
            }
        }
        Self { ok: !result.is_error, text: capped(text_of(&result.content)), media }
    }
}

fn capped(text: String) -> String {
    if text.len() <= MAX_TOOL_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_TOOL_TEXT_BYTES.saturating_sub(TRUNCATED_NOTICE.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATED_NOTICE}", &text[..end])
}

fn or<'a>(text: &'a str, fallback: &'a str) -> &'a str {
    if text.is_empty() { fallback } else { text }
}

/// `AgentClientMessage{execClientMessage{id, <result field>, execId}}`.
fn exec_message(exec: &ExecServer, field: u32, result: Writer) -> Vec<u8> {
    let mut m = Writer::new();
    m.varint(1, exec.id);
    m.message(field, result);
    m.string(15, &exec.exec_id);
    let mut message = Writer::new();
    message.message(2, m);
    message.finish()
}

/// A result whose one case is `case` holding `body`.
fn case(case: u32, body: Writer) -> Writer {
    let mut w = Writer::new();
    w.message(case, body);
    w
}

fn path_reason(path: &str, reason: &str) -> Writer {
    let mut w = Writer::new();
    w.string(1, path);
    w.string(2, reason);
    w
}

/// The messages that answer `exec` with `result`, in the order they are written.
pub fn answer(exec: &ExecServer, result: &Message) -> Vec<Vec<u8>> {
    let outcome = Outcome::of(result);
    let text = outcome.text.as_str();
    if let Some(args) = &exec.read {
        // A window that starts a number of lines before the file's end was read as the file's tail: the rows asked
        // for are the first of it.
        let rows = (args.offset < 0 && args.limit != 0 && args.limit < args.offset.unsigned_abs()).then_some(args.limit as usize);
        return vec![exec_message(exec, 7, read_result(&args.path, args.offset != 0 || args.limit != 0, rows, &outcome))];
    }
    if let Some(args) = &exec.write {
        return vec![exec_message(exec, 3, write_result(args, &outcome))];
    }
    if let Some(args) = &exec.fetch {
        return vec![exec_message(exec, 20, fetch_result(args, &outcome))];
    }
    if let Some(args) = &exec.shell_stream {
        // The stream's events, then the whole result, then the close: the service reads the outcome off the result.
        let ran = exit_code(&outcome);
        let mut out = vec![exec_message(exec, 14, case(4, Writer::new()))];
        if !text.is_empty() && ran.is_some() {
            let mut stdout = Writer::new();
            stdout.string(1, text);
            out.push(exec_message(exec, 14, case(1, stdout)));
        }
        if let Some(code) = ran {
            let mut exit = Writer::new();
            // The stream's exit holds the code as an unsigned number; the result behind it holds it signed.
            exit.varint(1, u64::from(code as u32));
            out.push(exec_message(exec, 14, case(3, exit)));
        }
        out.push(exec_message(exec, 2, shell_result(args, &outcome)));
        out.push(super::schema::exec_stream_close(exec.id));
        return out;
    }
    if let Some(args) = &exec.shell {
        return vec![exec_message(exec, 2, shell_result(args, &outcome))];
    }
    if let Some(args) = &exec.ls {
        let result = if outcome.ok { case(1, case(1, listing(text, &args.path))) } else { case(3, path_reason(&args.path, or(text, "List failed"))) };
        return vec![exec_message(exec, 8, result)];
    }
    if let Some(args) = &exec.grep {
        let result = if outcome.ok {
            grep_success(text, args)
        } else {
            let mut error = Writer::new();
            error.string(1, or(text, "Grep failed"));
            case(2, error)
        };
        return vec![exec_message(exec, 5, result)];
    }
    vec![exec_message(exec, 11, mcp_outcome(&outcome))]
}

fn write_result(args: &super::schema::WriteArgs, outcome: &Outcome) -> Writer {
    if !outcome.ok {
        return case(5, path_reason(&args.path, or(&outcome.text, "Write failed")));
    }
    let written = if args.file_bytes.is_empty() { args.file_text.clone() } else { String::from_utf8_lossy(&args.file_bytes).into_owned() };
    let mut success = Writer::new();
    success.string(1, &args.path);
    success.varint(2, if written.is_empty() { 0 } else { written.split('\n').count() as u64 });
    // The bytes the tool says it wrote (`nativeWrittenBytes`), which line endings or an encoding can make
    // other than the bytes asked for.
    let reported = outcome.text.lines().next().and_then(|line| WRITTEN.captures(line)).and_then(|caps| caps[1].parse().ok());
    success.varint(3, reported.unwrap_or(written.len() as u64));
    // Under the bound every result text is held to; content past it is not echoed in part.
    if args.return_content && written.len() <= MAX_TOOL_TEXT_BYTES {
        success.string(4, &written);
    }
    case(1, success)
}

fn fetch_result(args: &super::schema::FetchArgs, outcome: &Outcome) -> Writer {
    if !outcome.ok {
        return case(2, path_reason(&args.url, or(&outcome.text, "Fetch failed")));
    }
    let mut success = Writer::new();
    success.string(1, &args.url);
    success.string(2, &outcome.text);
    success.varint(3, 200);
    success.string(4, "text/markdown");
    case(1, success)
}

/// The result of an MCP call: its text and images, or its failure.
fn mcp_outcome(outcome: &Outcome) -> Writer {
    if !outcome.ok {
        let mut error = Writer::new();
        error.string(1, or(&outcome.text, "Tool failed"));
        return case(2, error);
    }
    let mut success = Writer::new();
    let mut item = Writer::new();
    let mut body = Writer::new();
    body.string(1, &outcome.text);
    item.message(1, body);
    success.message(1, item);
    for (data, mime) in &outcome.media {
        let mut image = Writer::new();
        image.bytes(1, data);
        image.string(2, mime);
        success.message(1, case(2, image));
    }
    success.varint(2, 0);
    case(1, success)
}

/// `result` as the MCP call it answered would have been told it on the run, under the same bounds.
pub(super) fn mcp_result(result: &Message) -> Writer {
    mcp_outcome(&Outcome::of(result))
}

/// What the shell tool heads the output of a command that exited: its code as the system gave it, sign included.
static EXIT_CODE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^(?:Error: )?\[exit code: (-?\d+)\]").expect("constant pattern"));

/// What it heads the output of a command that started and ended with no exit code, behind the `Error: ` every failed
/// tool's text starts with: one it killed at the time limit, one that was cancelled or killed, one a signal ended,
/// one whose status was lost.
static ENDED: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^(?:Error: )?\[shell-run-failed\] \[(?:timeout|signal|cause: cancellation|missing exit status)").expect("constant pattern")
});

/// The code the wire is given for a command that ended with none of its own; the reason heads its output.
const NO_EXIT_CODE: i32 = 1;

/// The exit code of the command a shell result reports: the one its text names, zero for a result that names none and
/// did not fail, [`NO_EXIT_CODE`] for a command that ended without one. `None`: the command did not run.
fn exit_code(outcome: &Outcome) -> Option<i32> {
    match EXIT_CODE.captures(&outcome.text).and_then(|caps| caps[1].parse().ok()) {
        Some(code) => Some(code),
        None if outcome.ok => Some(0),
        None => ENDED.is_match(&outcome.text).then_some(NO_EXIT_CODE),
    }
}

/// `ShellResult`: success for exit code zero, failure with the command's own code for any other, and a rejection for
/// a command that did not run.
fn shell_result(args: &super::schema::ShellArgs, outcome: &Outcome) -> Writer {
    let Some(code) = exit_code(outcome) else {
        let mut rejected = Writer::new();
        rejected.string(1, &args.command);
        rejected.string(2, &args.working_directory);
        rejected.string(3, or(&outcome.text, "Command failed"));
        return case(4, rejected);
    };
    let mut ran = Writer::new();
    ran.string(1, &args.command);
    ran.string(2, &args.working_directory);
    ran.varint(3, i64::from(code) as u64);
    ran.string(5, &outcome.text);
    case(if code == 0 { 1 } else { 2 }, ran)
}

fn read_result(path: &str, ranged: bool, rows: Option<usize>, outcome: &Outcome) -> Writer {
    if !outcome.ok {
        return case(3, path_reason(path, or(&outcome.text, "Read failed")));
    }
    let Some(window) = read_window(&outcome.text) else { return case(3, path_reason(path, UNCLEAN_READ)) };
    let mut success = Writer::new();
    success.string(1, path);
    // Rows of the tail read that the window asked for does not hold are rows it was cut short of.
    let cut = rows.is_some_and(|rows| window.content.split_inclusive('\n').count() > rows);
    match rows {
        Some(rows) => success.string(2, &window.content.split_inclusive('\n').take(rows).collect::<String>()),
        None => success.string(2, &window.content),
    }
    if let Some(total) = window.total_lines {
        success.varint(3, total);
    }
    success.varint(6, u64::from(window.truncated || cut));
    success.varint(8, u64::from(ranged || window.start_line.is_some_and(|start| start > 1)));
    case(1, success)
}

#[derive(Debug, PartialEq)]
struct Window {
    content: String,
    total_lines: Option<u64>,
    start_line: Option<u64>,
    truncated: bool,
}

static RUN_MARKER: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^\[lines (\d+)-(\d+)\]$").expect("constant pattern"));
static FOOTER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\[lines (\d+)-(\d+) of (\d+)(?:; offset:\d+ for more)?\]$").expect("constant pattern"));
static EMPTY_FILE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^<system-reminder>File exists but has empty contents: [^\n]*</system-reminder>$").expect("constant pattern"));
static EMPTY_RANGE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^\(no lines in range; file has (\d+) lines\)$").expect("constant pattern"));

/// A row the read tool clipped for display (`clip_line`): its first 1,500 characters, the count, its last 300. The tool
/// reports the clip nowhere but in the row, so the row's shape is what tells it; a file line of this very shape is
/// refused with it.
static CLIP_MARK: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r" \.\.\. \[line truncated: \d+ chars total\] \.\.\. ").expect("constant pattern"));

fn clipped(row: &str) -> bool {
    CLIP_MARK.find_iter(row).any(|mark| row[..mark.start()].chars().count() == 1_500 && row[mark.end()..].chars().count() == 300)
}

/// What the edit tool answers a write with: `Created <path> (<n> bytes)`.
static WRITTEN: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^(?:Created|Updated) .* \((\d+) bytes\)$").expect("constant pattern"));

fn number(caps: &regex::Captures<'_>, group: usize) -> u64 {
    caps.get(group).and_then(|m| m.as_str().parse().ok()).unwrap_or(0)
}

/// The one contiguous source window a read result shows (`[lines a-b]` runs and an optional `[lines a-b of n]` footer);
/// `None` for anything that is not a faithful copy of the file's text.
fn read_window(text: &str) -> Option<Window> {
    if EMPTY_FILE.is_match(text) {
        return Some(Window { content: String::new(), total_lines: Some(0), start_line: Some(1), truncated: false });
    }
    if let Some(caps) = EMPTY_RANGE.captures(text) {
        return Some(Window { content: String::new(), total_lines: Some(number(&caps, 1)), start_line: None, truncated: false });
    }
    let lines: Vec<&str> = text.split('\n').collect();
    if !RUN_MARKER.is_match(lines[0]) {
        return None;
    }
    let (mut rows, mut start, mut next, mut footer) = (Vec::new(), None, 0, None);
    let mut i = 0;
    while i < lines.len() {
        let run = RUN_MARKER.captures(lines[i]).map(|caps| (number(&caps, 1), number(&caps, 2)));
        if let Some((from, to)) = run
            && to >= from
            && i + ((to - from) as usize + 1) < lines.len()
        {
            if footer.is_some() || start.is_some_and(|_| from != next) {
                return None;
            }
            start.get_or_insert(from);
            let count = (to - from) as usize + 1;
            rows.extend_from_slice(&lines[i + 1..=i + count]);
            next = to + 1;
            i += count + 1;
            continue;
        }
        let caps = FOOTER.captures(lines[i])?;
        if footer.replace((number(&caps, 1), number(&caps, 2), number(&caps, 3))).is_some() {
            return None;
        }
        i += 1;
    }
    let start_line = start?;
    // A clipped row is not the line the file holds (`lineClipped`).
    if rows.iter().any(|row| clipped(row)) {
        return None;
    }
    let end_line = next - 1;
    if let Some((from, to, total)) = footer
        && (from != start_line || to != end_line || total < end_line)
    {
        return None;
    }
    let total_lines = footer.map(|(_, _, total)| total);
    Some(Window { content: rows.join("\n"), total_lines, start_line: Some(start_line), truncated: total_lines.is_none_or(|total| end_line < total) })
}

/// `LsDirectoryTreeNode` of the listed paths, all as files of `root`.
fn listing(text: &str, root: &str) -> Writer {
    let mut node = Writer::new();
    node.string(1, if root.is_empty() { "." } else { root });
    let mut extensions: Vec<(String, u64)> = Vec::new();
    let mut files = 0u64;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let normalized = line.replace('\\', "/");
        let Some(name) = normalized.split('/').rfind(|part| !part.is_empty()) else { continue };
        let mut file = Writer::new();
        file.string(1, name);
        node.message(3, file);
        files += 1;
        if let Some(dot) = name.rfind('.').filter(|dot| *dot > 0) {
            let extension = &name[dot + 1..];
            match extensions.iter_mut().find(|(known, _)| known == extension) {
                Some((_, count)) => *count += 1,
                None => extensions.push((extension.to_owned(), 1)),
            }
        }
    }
    node.varint(4, 1);
    for (extension, count) in extensions {
        let mut entry = Writer::new();
        entry.string(1, &extension);
        entry.varint(2, count);
        node.message(5, entry);
    }
    node.varint(6, files);
    node
}

static GROUPED_ROW: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^ {2}(\d+): (.*)$").expect("constant pattern"));
static PATH_ROW: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^(.+?):(\d+):").expect("constant pattern"));
static NUMBER_ROW: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^(\d+)[:-]").expect("constant pattern"));
static HITS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r" \(\d+ hits\)$").expect("constant pattern"));

/// `path:count` of a count-mode row (a drive letter's colon is part of the path).
fn count_row(line: &str) -> Option<(&str, u64)> {
    if line.is_empty() || line.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let from = if line.len() > 1 && line.as_bytes()[0].is_ascii_alphabetic() && line.as_bytes()[1] == b':' { 2 } else { 0 };
    let at = line.rfind(':').filter(|at| *at > from)?;
    let count = &line[at + 1..];
    (!count.is_empty() && count.bytes().all(|b| b.is_ascii_digit())).then(|| (&line[..at], count.parse().unwrap_or(0)))
}

fn grep_success(text: &str, args: &GrepArgs) -> Writer {
    let mode = if args.output_mode.is_empty() { "content" } else { args.output_mode.as_str() };
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty() && !line.starts_with("[total ") && !line.starts_with("... ["))
        .collect();
    // The results the search skipped at the request's offset, said where the result kind says it.
    let offset_applied = |result: &mut Writer, field: u32| {
        if args.offset > 0 {
            result.varint(field, args.offset as u64);
        }
    };
    let union = match mode {
        "files_with_matches" => {
            let files: Vec<&str> = lines.iter().map(|line| line.trim()).filter(|line| !line.starts_with("(no matches)")).collect();
            let mut result = Writer::new();
            for file in &files {
                result.string(1, file);
            }
            result.varint(2, files.len() as u64);
            offset_applied(&mut result, 6);
            case(2, result)
        }
        "count" => {
            let mut result = Writer::new();
            let (mut files, mut total) = (0u64, 0u64);
            for line in &lines {
                let (file, count) = match count_row(line) {
                    Some(parsed) => parsed,
                    None if line.bytes().all(|b| b.is_ascii_digit()) => (args.path.as_str(), line.parse().unwrap_or(0)),
                    None => continue,
                };
                let mut entry = Writer::new();
                entry.string(1, file);
                entry.varint(2, count);
                result.message(1, entry);
                files += 1;
                total += count;
            }
            result.varint(2, files);
            result.varint(3, total);
            offset_applied(&mut result, 7);
            case(1, result)
        }
        _ => {
            let mut by_file: Vec<(String, Vec<(u64, String)>)> = Vec::new();
            let mut current = args.path.clone();
            for line in &lines {
                let (file, row) = if let Some(caps) = GROUPED_ROW.captures(line) {
                    (current.clone(), (number(&caps, 1), caps.get(2).map_or("", |m| m.as_str()).to_owned()))
                } else if let Some(caps) = PATH_ROW.captures(line) {
                    (caps[1].to_owned(), (number(&caps, 2), line[caps.get(0).map_or(0, |m| m.end())..].to_owned()))
                } else if let Some(caps) = NUMBER_ROW.captures(line) {
                    (current.clone(), (number(&caps, 1), line[caps.get(0).map_or(0, |m| m.end())..].to_owned()))
                } else {
                    current = HITS.replace(line, "").into_owned();
                    continue;
                };
                match by_file.iter_mut().find(|(known, _)| *known == file) {
                    Some((_, rows)) => rows.push(row),
                    None => by_file.push((file, vec![row])),
                }
            }
            let mut result = Writer::new();
            let mut matched = 0u64;
            for (file, rows) in &by_file {
                let mut entry = Writer::new();
                entry.string(1, file);
                for (line_number, content) in rows {
                    let mut row = Writer::new();
                    row.varint(1, *line_number);
                    row.string(2, content);
                    entry.message(2, row);
                }
                matched += rows.len() as u64;
                result.message(1, entry);
            }
            result.varint(2, matched);
            result.varint(3, matched);
            offset_applied(&mut result, 7);
            case(3, result)
        }
    };
    let mut success = Writer::new();
    success.string(1, &args.pattern);
    success.string(2, &args.path);
    success.string(3, mode);
    let mut entry = Writer::new();
    entry.string(1, if args.path.is_empty() { "." } else { &args.path });
    entry.message(2, union);
    success.message(4, entry);
    case(1, success)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_window_is_its_rows_and_anything_else_is_not() {
        let window = read_window("[lines 3-4]\nx\ny\n[lines 3-4 of 9; offset:5 for more]").expect("window");
        assert_eq!(window, Window { content: "x\ny".into(), total_lines: Some(9), start_line: Some(3), truncated: true });
        assert_eq!(read_window("[lines 1-2]\na\nb").map(|w| w.content), Some("a\nb".into()));
        assert_eq!(read_window("[lines 1-1]\na\n[lines 2-2]\nb").map(|w| w.content), Some("a\nb".into()));
        assert_eq!(read_window("[lines 1-1]\na\n[lines 5-5]\nb"), None, "disjoint runs");
        assert_eq!(read_window("plain text"), None);
        assert_eq!(read_window("[lines 1-3]\nonly"), None, "a marker without its rows");
    }

    fn fields(bytes: &[u8]) -> Vec<(u32, crate::providers::connect::pb::Value<'_>)> {
        let mut reader = crate::providers::connect::pb::Reader::new(bytes);
        std::iter::from_fn(|| reader.next_field().ok().flatten()).collect()
    }

    /// The result case (`field` of the exec's result) of the one message that answers `exec` with `text`.
    fn answered(exec: &ExecServer, text: &str, field: u32) -> Vec<u8> {
        let result = Message::new(mixdog_core_api::domain::provider::Role::Tool, Content::Text(text.to_owned().into()));
        let messages = answer(exec, &result);
        let exec_message = fields(&messages[0]).into_iter().find(|(n, _)| *n == 2).expect("an exec message").1.bytes().to_vec();
        fields(&exec_message).into_iter().find(|(n, _)| *n == field).expect("the result").1.bytes().to_vec()
    }

    /// A row the read tool clipped (2,000 characters shown as the first 1,500, the count and the last 300) is not the
    /// file's line: the read is answered as refused, never as the file's content. The same file read unclipped is its
    /// content.
    #[test]
    fn a_read_with_a_clipped_row_is_never_the_files_content() {
        let exec = ExecServer { id: 1, read: Some(super::super::schema::ReadArgs { path: "a.txt".into(), ..Default::default() }), ..Default::default() };
        let line = "x".repeat(2_500);
        let clipped = format!("{} ... [line truncated: 2500 chars total] ... {}", &line[..1_500], &line[2_200..]);
        let window = |row: &str| format!("[lines 1-2]\nshort\n{row}\n[lines 1-2 of 2]");
        let refused = answered(&exec, &window(&clipped), 7);
        assert_eq!(fields(&refused).iter().map(|(n, _)| *n).collect::<Vec<_>>(), [3], "the rejected case");
        assert!(String::from_utf8_lossy(&refused).contains("not a complete contiguous source window"));
        let whole = answered(&exec, &window(&line), 7);
        assert_eq!(fields(&whole).iter().map(|(n, _)| *n).collect::<Vec<_>>(), [1], "the success case");
        assert_eq!(read_window(&window(&line)).map(|w| w.content), Some(format!("short\n{line}")));
    }

    /// A native write reports the bytes the tool says it wrote, and the bytes asked for when the tool's answer names
    /// none.
    #[test]
    fn a_write_reports_the_bytes_the_tool_wrote() {
        let args = super::super::schema::WriteArgs { path: "a.txt".into(), file_text: "one\ntwo\n".into(), ..Default::default() };
        let exec = ExecServer { id: 1, write: Some(args), ..Default::default() };
        let size = |text: &str| {
            let success = fields(&answered(&exec, text, 3)).into_iter().find(|(n, _)| *n == 1).expect("success").1.bytes().to_vec();
            fields(&success).into_iter().find(|(n, _)| *n == 3).expect("the size").1.as_u64()
        };
        assert_eq!(size("Created a.txt (10 bytes)"), 10, "the tool wrote CRLF line ends");
        assert_eq!(size("done"), 8);
        let content = |asked: bool| {
            let args = super::super::schema::WriteArgs { path: "a.txt".into(), file_text: "one\n".into(), return_content: asked, ..Default::default() };
            let exec = ExecServer { id: 1, write: Some(args), ..Default::default() };
            let success = fields(&answered(&exec, "done", 3)).into_iter().find(|(n, _)| *n == 1).expect("success").1.bytes().to_vec();
            fields(&success).into_iter().find(|(n, _)| *n == 4).map(|(_, v)| v.text())
        };
        assert_eq!((content(true), content(false)), (Some("one\n".into()), None), "the content after the write, when asked for");
    }

    /// The cases of the shell result that answers `text`: `(the result's case, its exit code)`.
    fn shell_case(result: &[u8]) -> (u32, u64) {
        let (case, body) = fields(result).into_iter().next().map(|(n, v)| (n, v.bytes().to_vec())).expect("a case");
        (case, fields(&body).into_iter().find(|(n, _)| *n == 3).map_or(0, |(_, v)| v.as_u64()))
    }

    /// A command that ran is a success or, with its own exit code, a failure; only a command that did not run is a
    /// rejection. A streamed shell ends with its exit, then the whole result, then the close of its stream.
    #[test]
    fn a_shell_result_carries_the_commands_exit_code() {
        let args = || super::super::schema::ShellArgs { command: "make".into(), ..Default::default() };
        let exec = ExecServer { id: 4, shell: Some(args()), ..Default::default() };
        let failed = |text: &str| {
            let mut result = Message::new(mixdog_core_api::domain::provider::Role::Tool, Content::Text(text.to_owned().into()));
            result.is_error = true;
            result
        };
        assert_eq!(shell_case(&answered(&exec, "built", 2)), (1, 0));
        assert_eq!(shell_case(&answered(&exec, "[exit code: 3]\n\nno rule", 2)), (2, 3));
        let exec_result = |message: &[u8]| fields(message).into_iter().find(|(n, _)| *n == 2).map(|(_, v)| v.bytes().to_vec());
        let refused = answer(&exec, &failed("not allowed here"));
        assert_eq!(shell_case(&fields(&exec_result(&refused[0]).expect("exec")).into_iter().find(|(n, _)| *n == 2).expect("result").1.bytes().to_vec()).0, 4);

        let stream = ExecServer { id: 4, shell_stream: Some(args()), ..Default::default() };
        let written = answer(&stream, &failed("[exit code: 3]\n\nno rule"));
        // Each message as `(its exec result field, that result's case)`; the close is a control message.
        let shape: Vec<(u32, u32)> = written
            .iter()
            .map(|message| match exec_result(message) {
                Some(exec) => {
                    let (field, body) = fields(&exec).into_iter().find(|(n, _)| matches!(n, 2 | 14)).map(|(n, v)| (n, v.bytes().to_vec())).expect("a result");
                    (field, fields(&body)[0].0)
                }
                None => (0, fields(message)[0].0),
            })
            .collect();
        assert_eq!(shape, [(14, 4), (14, 1), (14, 3), (2, 2), (0, 5)], "start, output, exit, the failure result, the close");
        let exit = exec_result(&written[2]).expect("exec");
        let exit = fields(&exit).into_iter().find(|(n, _)| *n == 14).expect("stream").1.bytes().to_vec();
        let event = fields(&exit).into_iter().find(|(n, _)| *n == 3).expect("the exit event").1.bytes().to_vec();
        assert_eq!(fields(&event).into_iter().find(|(n, _)| *n == 1).map(|(_, v)| v.as_u64()), Some(3), "the command's own exit code");
    }

    /// The shell tool's own texts for a command that started: a negative exit code (a crash on Windows) is the
    /// command's code, sign included, and a command killed at its time limit, cancelled or ended by a signal is a
    /// failure with what it printed and the reason, never a rejection. On a stream each has its output and its exit.
    #[test]
    fn a_command_that_started_is_never_a_rejection() {
        let args = || super::super::schema::ShellArgs { command: "make".into(), ..Default::default() };
        let failed = |text: &str| {
            let mut result = Message::new(mixdog_core_api::domain::provider::Role::Tool, Content::Text(text.to_owned().into()));
            result.is_error = true;
            result
        };
        let exec_result = |message: &[u8]| fields(message).into_iter().find(|(n, _)| *n == 2).map(|(_, v)| v.bytes().to_vec()).expect("exec");
        // The texts as the adapter receives them: a failed tool's text is headed `Error: `.
        let texts: [(&str, u64); 8] = [
            ("[exit code: -1073741819]\n\npartial", (-1_073_741_819_i64) as u64),
            ("Error: [exit code: -1]\n\npartial", (-1_i64) as u64),
            ("Error: [shell-run-failed] [timeout: 5ms signal: SIGKILL cause: timeout] — command killed; partial effects may remain\n\n(no output)", 1),
            ("Error: [shell-run-failed] [timeout: 1500ms signal: SIGKILL cause: timeout] — command killed; partial effects may remain\n\nbegin\n", 1),
            ("Error: [shell-run-failed] [signal: SIGKILL cause: cancellation]\n\nstarted\n", 1),
            ("Error: [shell-run-failed] [cause: cancellation; process exit not confirmed]\n\nstarted\n", 1),
            ("Error: [shell-run-failed] [signal: SIGSEGV]\n\npartial", 1),
            ("Error: [shell-run-failed] [missing exit status]\n\npartial", 1),
        ];
        for (text, code) in texts {
            let exec = ExecServer { id: 4, shell: Some(args()), ..Default::default() };
            let result = fields(&exec_result(&answer(&exec, &failed(text))[0])).into_iter().find(|(n, _)| *n == 2).expect("result").1.bytes().to_vec();
            assert_eq!(shell_case(&result), (2, code), "{text}");
            let body = fields(&result)[0].1.bytes().to_vec();
            assert_eq!(fields(&body).into_iter().find(|(n, _)| *n == 5).map(|(_, v)| v.text()), Some(text.to_owned()), "what it printed, the reason first");

            let stream = ExecServer { id: 4, shell_stream: Some(args()), ..Default::default() };
            let written = answer(&stream, &failed(text));
            assert_eq!(written.len(), 5, "{text}: start, output, exit, the result, the close");
            let exit = fields(&exec_result(&written[2])).into_iter().find(|(n, _)| *n == 14).expect("stream").1.bytes().to_vec();
            let event = fields(&exit).into_iter().find(|(n, _)| *n == 3).expect("the exit event").1.bytes().to_vec();
            assert_eq!(
                fields(&event).into_iter().find(|(n, _)| *n == 1).map(|(_, v)| v.as_u64()),
                Some(u64::from(code as u32)),
                "{text}: unsigned on the stream"
            );
        }
        // A command that did not start is still a rejection.
        let exec = ExecServer { id: 4, shell: Some(args()), ..Default::default() };
        let result = fields(&exec_result(&answer(&exec, &failed("Error: shell is not available here"))[0]))
            .into_iter()
            .find(|(n, _)| *n == 2)
            .expect("result")
            .1
            .bytes()
            .to_vec();
        assert_eq!(shell_case(&result).0, 4);
    }

    /// A window that starts lines before the file's end is read as the file's tail; when it asks for fewer rows than
    /// that, the answer holds the rows asked for and no more.
    #[test]
    fn a_window_counted_from_the_end_holds_the_rows_asked_for() {
        let content = |offset: i64, limit: u64| {
            let args = super::super::schema::ReadArgs { path: "a.txt".into(), offset, limit, ..Default::default() };
            let exec = ExecServer { id: 1, read: Some(args), ..Default::default() };
            let tail = "[lines 8-10]\none\ntwo\nthree\n[lines 8-10 of 10]";
            let success = fields(&answered(&exec, tail, 7)).into_iter().find(|(n, _)| *n == 1).expect("success").1.bytes().to_vec();
            let cut = fields(&success).into_iter().find(|(n, _)| *n == 6).is_some_and(|(_, v)| v.as_u64() == 1);
            (fields(&success).into_iter().find(|(n, _)| *n == 2).map(|(_, v)| v.text().trim_end().to_owned()), cut)
        };
        assert_eq!(content(-3, 2), (Some("one\ntwo".into()), true), "cut short of the tail's last row");
        assert_eq!(content(-3, 0), (Some("one\ntwo\nthree".into()), false));
        assert_eq!(content(-3, 5), (Some("one\ntwo\nthree".into()), false));
    }

    /// Content past the bound of a result's text is not echoed after a write.
    #[test]
    fn a_write_echoes_no_content_past_the_text_bound() {
        let args = super::super::schema::WriteArgs {
            path: "a.txt".into(),
            file_text: "x".repeat(MAX_TOOL_TEXT_BYTES + 1),
            return_content: true,
            ..Default::default()
        };
        let exec = ExecServer { id: 1, write: Some(args), ..Default::default() };
        let success = fields(&answered(&exec, "done", 3)).into_iter().find(|(n, _)| *n == 1).expect("success").1.bytes().to_vec();
        assert!(fields(&success).into_iter().all(|(n, _)| n != 4));
    }

    /// A search that skipped results at the request's offset says so in its result.
    #[test]
    fn a_search_reports_the_offset_it_applied() {
        let args = GrepArgs { pattern: "fox".into(), path: "src".into(), offset: 20, ..Default::default() };
        let exec = ExecServer { id: 1, grep: Some(args), ..Default::default() };
        let mut found = answered(&exec, "src/a.rs:3:the fox", 5);
        for field in [1, 4, 2, 3] {
            let inner = fields(&found).into_iter().find(|(n, _)| *n == field).expect("the content result").1.bytes().to_vec();
            found = inner;
        }
        assert_eq!(fields(&found).into_iter().find(|(n, _)| *n == 7).map(|(_, v)| v.as_u64()), Some(20));
    }
}
