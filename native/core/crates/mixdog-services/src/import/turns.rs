//! Shared shape of an imported conversation: plain-text user/assistant turns, the markers that
//! stand in for dropped content, and the title rule. The Codex and Claude parsers both emit raw
//! turns and normalize them here. Pure, no IO.
//!
//! Text lengths are counted in UTF-16 units, as the limits and the stored `toolRuns` offsets
//! have always been.

use serde::Serialize;

pub const WARNING_IMAGE_OMITTED: &str = "imageOmitted";
pub const WARNING_MALFORMED: &str = "malformed";
pub const WARNING_CWD_MISSING: &str = "cwdMissing";
/// The conversation continues a history stored in another file that was not followed.
pub const WARNING_HISTORY_PARTIAL: &str = "historyPartial";
/// Earlier history was left out because following it would pass the import size limit.
pub const WARNING_HISTORY_SIZE_LIMIT: &str = "historySizeLimit";
/// Earlier history was left out because its file is missing or could not be read.
pub const WARNING_HISTORY_UNAVAILABLE: &str = "historyUnavailable";
/// Failure code of a record the source app writes for its own use.
pub const ERROR_INTERNAL: &str = "internalRecord";
pub const ERROR_TOO_LARGE: &str = "tooLarge";

pub const IMAGE_OMITTED_TEXT: &str = "[image omitted]";
pub const IMPORTED_USER_STUB_TEXT: &str = "[Imported conversation continues from an earlier assistant reply.]";

const TITLE_MAX_CHARS: usize = 100;
const TOOL_RUN_LINE_MAX_CHARS: usize = 400;
const TOOL_RUN_NAME_MAX_CHARS: usize = 40;

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub text: String,
    pub note: bool,
    /// Tool name of a tool note.
    pub tool: Option<String>,
    pub summary: bool,
    pub command: bool,
}

impl Part {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            note: false,
            tool: None,
            summary: false,
            command: false,
        }
    }

    /// A tool call: its name only, never its arguments.
    pub fn tool_note(name: &str) -> Self {
        let clean = mixdog_js::js_words(name).collect::<Vec<_>>().join(" ");
        let clean = if clean.is_empty() { "unknown".to_owned() } else { clean };
        Self {
            text: format!("[ran tool: {clean}]"),
            note: true,
            tool: Some(clean),
            summary: false,
            command: false,
        }
    }
}

/// A record's timestamp as the source wrote it.
#[derive(Clone, Debug, PartialEq)]
pub enum Stamp {
    Text(String),
    Number(f64),
}

impl Stamp {
    pub fn from_json(value: Option<&serde_json::Value>) -> Option<Self> {
        match value? {
            serde_json::Value::String(s) => Some(Self::Text(s.clone())),
            serde_json::Value::Number(n) => n.as_f64().map(Self::Number),
            _ => None,
        }
    }

    /// Bytes of bookkeeping this stamp costs.
    pub fn text_len(&self) -> usize {
        match self {
            Self::Text(s) => utf16_len(s),
            Self::Number(_) => 0,
        }
    }

    pub fn millis(&self) -> Option<i64> {
        let ms = match self {
            Self::Number(n) => *n,
            Self::Text(s) => chrono::DateTime::parse_from_rfc3339(s).ok()?.timestamp_millis() as f64,
        };
        (ms.is_finite() && ms > 0.0).then_some(ms as i64)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawTurn {
    pub role: Role,
    pub parts: Vec<Part>,
    pub at: Option<Stamp>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ToolCount {
    pub name: String,
    pub count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ToolRun {
    pub start: usize,
    pub end: usize,
    pub tools: Vec<ToolCount>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: Role,
    pub text: String,
    pub at: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_runs: Vec<ToolRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_text: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stub: bool,
}

/// A trimmed non-blank string, else `None`.
pub fn string_or_null(value: Option<&serde_json::Value>) -> Option<String> {
    let s = mixdog_js::js_trim(value?.as_str()?);
    (!s.is_empty()).then(|| s.to_owned())
}

/// Whole-text match of one XML-style envelope element (`<tag>…</tag>`).
pub fn is_whole_element(text: &str, tags: &[&str]) -> bool {
    let trimmed = mixdog_js::js_trim(text);
    tags.iter().any(|tag| {
        (trimmed.starts_with(&format!("<{tag}>")) || trimmed.starts_with(&format!("<{tag} ")))
            && trimmed.ends_with(&format!("</{tag}>"))
    })
}

/// `[ran tools: shell ×6, Read ×2]`, bounded: names are clipped and tools that do not fit are
/// counted as `, +N more`.
pub fn tool_run_line(tools: &[ToolCount]) -> String {
    let entries: Vec<String> = tools
        .iter()
        .map(|t| {
            let shown = if utf16_len(&t.name) > TOOL_RUN_NAME_MAX_CHARS {
                format!("{}…", mixdog_js::slice_utf16(&t.name, TOOL_RUN_NAME_MAX_CHARS - 1))
            } else {
                t.name.clone()
            };
            format!("{shown} ×{}", t.count)
        })
        .collect();
    let omitted_suffix = |omitted: usize| if omitted > 0 { format!(", +{omitted} more") } else { String::new() };
    let mut body = String::new();
    let mut shown_count = 0usize;
    for entry in &entries {
        let next = if shown_count > 0 { format!("{body}, {entry}") } else { entry.clone() };
        let length = utf16_len(&format!(
            "[ran tools: {next}{}]",
            omitted_suffix(entries.len() - shown_count - 1)
        ));
        if shown_count > 0 && length > TOOL_RUN_LINE_MAX_CHARS {
            break;
        }
        body = next;
        shown_count += 1;
    }
    format!("[ran tools: {body}{}]", omitted_suffix(entries.len() - shown_count))
}

fn tool_counts(notes: &[&Part]) -> Vec<ToolCount> {
    let mut counts: Vec<ToolCount> = Vec::new();
    for note in notes {
        let name = note.tool.clone().unwrap_or_default();
        match counts.iter_mut().find(|c| c.name == name) {
            Some(c) => c.count += 1,
            None => counts.push(ToolCount { name, count: 1 }),
        }
    }
    counts
}

/// Each run of consecutive tool notes collapses into one compact line; every boundary is a
/// blank line. The returned runs locate those lines in the text.
fn join_parts(parts: &[&Part]) -> (String, Vec<ToolRun>) {
    enum Block<'a> {
        Text(&'a str),
        Notes(Vec<&'a Part>),
    }
    let mut blocks: Vec<Block> = Vec::new();
    for part in parts {
        let piece = mixdog_js::js_trim(&part.text);
        if piece.is_empty() {
            continue;
        }
        match blocks.last_mut() {
            Some(Block::Notes(notes)) if part.note => notes.push(part),
            _ => blocks.push(if part.note { Block::Notes(vec![part]) } else { Block::Text(piece) }),
        }
    }
    let mut text = String::new();
    let mut runs = Vec::new();
    for block in &blocks {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        match block {
            Block::Notes(notes) => {
                let tools = tool_counts(notes);
                let line = tool_run_line(&tools);
                let start = utf16_len(&text);
                runs.push(ToolRun { start, end: start + utf16_len(&line), tools });
                text.push_str(&line);
            }
            Block::Text(piece) => text.push_str(piece),
        }
    }
    (text, runs)
}

/// Raw turns → normalized turns: empty turns dropped, consecutive same-role turns merged, and
/// a short user stub inserted when the conversation would otherwise begin with the assistant.
pub fn normalize_turns(raw_turns: &[RawTurn]) -> Vec<Turn> {
    struct Merged {
        role: Role,
        parts: Vec<Part>,
        at: Option<i64>,
    }
    let mut merged: Vec<Merged> = Vec::new();
    for raw in raw_turns {
        let parts: Vec<Part> = raw.parts.iter().filter(|p| !mixdog_js::js_trim(&p.text).is_empty()).cloned().collect();
        if parts.is_empty() {
            continue;
        }
        match merged.last_mut() {
            Some(prev) if prev.role == raw.role => prev.parts.extend(parts),
            _ => merged.push(Merged {
                role: raw.role,
                parts,
                at: raw.at.as_ref().and_then(Stamp::millis),
            }),
        }
    }
    let mut turns: Vec<Turn> = merged
        .into_iter()
        .map(|m| {
            let all: Vec<&Part> = m.parts.iter().collect();
            let (text, tool_runs) = join_parts(&all);
            let mut turn = Turn {
                role: m.role,
                text,
                at: m.at,
                tool_runs,
                title_text: None,
                command_text: None,
                stub: false,
            };
            // A carried-over compaction summary never names the conversation; a slash command
            // only when no typed prompt does.
            if m.parts.iter().any(|p| p.summary || p.command) {
                let typed: Vec<&Part> = m.parts.iter().filter(|p| !p.summary && !p.command).collect();
                turn.title_text = Some(join_parts(&typed).0);
            }
            if m.parts.iter().any(|p| p.command) {
                let commands: Vec<&Part> = m.parts.iter().filter(|p| p.command).collect();
                turn.command_text = Some(join_parts(&commands).0);
            }
            turn
        })
        .collect();
    if turns.first().is_some_and(|t| t.role == Role::Assistant) {
        let at = turns[0].at;
        turns.insert(
            0,
            Turn {
                role: Role::User,
                text: IMPORTED_USER_STUB_TEXT.to_owned(),
                at,
                tool_runs: Vec::new(),
                title_text: None,
                command_text: None,
                stub: true,
            },
        );
    }
    turns
}

fn text_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|line| mixdog_js::js_words(line).collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect()
}

/// First non-empty line of a title text, whitespace-normalized, at most 100 characters.
pub fn title_from_text(text: &str) -> Option<String> {
    let line = text_lines(text).into_iter().next()?;
    let title = mixdog_js::slice_utf16(&line, TITLE_MAX_CHARS);
    let title = mixdog_js::js_trim(&title);
    (!title.is_empty()).then(|| title.to_owned())
}

/// First line of the first genuine user turn (an image marker only when the turn has no text
/// line), else the first slash command.
pub fn conversation_title(turns: &[Turn]) -> Option<String> {
    let title_lines = |turn: &Turn| text_lines(turn.title_text.as_deref().unwrap_or(&turn.text));
    match turns.iter().find(|t| t.role == Role::User && !t.stub && !title_lines(t).is_empty()) {
        Some(first) => {
            let lines = title_lines(first);
            let pick = lines.iter().find(|l| *l != IMAGE_OMITTED_TEXT).unwrap_or(&lines[0]);
            title_from_text(pick)
        }
        None => turns
            .iter()
            .find(|t| t.role == Role::User && t.command_text.is_some())
            .and_then(|t| title_from_text(t.command_text.as_deref()?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(role: Role, parts: Vec<Part>) -> RawTurn {
        RawTurn { role, parts, at: None }
    }

    #[test]
    fn tool_notes_collapse_into_one_run_line() {
        let turns = normalize_turns(&[raw(
            Role::User,
            vec![
                Part::text("hi"),
                Part::tool_note("shell"),
                Part::tool_note("shell"),
                Part::tool_note("Read"),
            ],
        )]);
        assert_eq!(turns[0].text, "hi\n\n[ran tools: shell ×2, Read ×1]");
        assert_eq!(turns[0].tool_runs[0].start, 4);
        assert_eq!(turns[0].tool_runs[0].end, utf16_len(&turns[0].text));
    }

    #[test]
    fn assistant_first_gets_a_user_stub_and_same_roles_merge() {
        let turns = normalize_turns(&[
            raw(Role::Assistant, vec![Part::text("a")]),
            raw(Role::Assistant, vec![Part::text("b")]),
            raw(Role::User, vec![Part::text("   ")]),
        ]);
        assert_eq!(turns.len(), 2);
        assert!(turns[0].stub && turns[0].role == Role::User);
        assert_eq!(turns[1].text, "a\n\nb");
        assert_eq!(conversation_title(&turns), None);
    }

    #[test]
    fn title_skips_image_marker_and_falls_back_to_a_command() {
        let user = |text: &str| raw(Role::User, vec![Part::text(text)]);
        let t = normalize_turns(&[user("[image omitted]\n  real   title ")]);
        assert_eq!(conversation_title(&t).as_deref(), Some("real title"));
        let mut cmd = Part::text("/model sonnet");
        cmd.command = true;
        let t = normalize_turns(&[raw(Role::User, vec![cmd])]);
        assert_eq!(conversation_title(&t).as_deref(), Some("/model sonnet"));
        assert_eq!(title_from_text(&"x".repeat(150)).unwrap().len(), 100);
    }

    #[test]
    fn run_line_is_bounded() {
        let tools: Vec<ToolCount> = (0..80).map(|i| ToolCount { name: format!("tool-number-{i}"), count: 1 }).collect();
        let line = tool_run_line(&tools);
        assert!(utf16_len(&line) <= 400 && line.contains(", +") && line.ends_with(" more]"));
    }
}
