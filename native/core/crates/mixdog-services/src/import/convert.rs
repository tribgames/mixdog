//! JSONL lines of a foreign conversation → normalized plain-text turns, one line at a time:
//! each parsed record is reduced to its kept plain text and dropped. Tolerates a BOM, CRLF line
//! ends and individual malformed lines (reported as the `malformed` warning). Pure, no IO.

use serde::Serialize;
use serde_json::Value;

use super::claude::ClaudeReducer;
use super::codex::CodexReducer;
use super::turns::{
    ERROR_INTERNAL, ERROR_TOO_LARGE, RawTurn, Turn, WARNING_MALFORMED, conversation_title, normalize_turns, utf16_len,
};

/// Bytes read from one source file before it fails as `tooLarge`.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
/// Normalized transcript text (the final turns, separators and stub included).
pub const MAX_TRANSCRIPT_CHARS: usize = 4 * 1024 * 1024;
/// Entries a reducer may retain (Claude chain links, Codex turns).
pub const MAX_RETAINED_ENTRIES: usize = 200_000;
/// Bookkeeping a reducer retains besides kept text.
pub const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Codex,
    Claude,
    Cowork,
}

impl Source {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            "cowork" => Some(Self::Cowork),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Cowork => "cowork",
        }
    }

    /// Claude Code transcripts (also inside a Cowork conversation).
    pub fn is_claude_format(self) -> bool {
        self != Self::Codex
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_file_bytes: u64,
    pub max_line_bytes: usize,
    pub max_transcript_chars: usize,
    pub max_retained_entries: usize,
    pub max_metadata_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_FILE_BYTES,
            max_line_bytes: MAX_LINE_BYTES,
            max_transcript_chars: MAX_TRANSCRIPT_CHARS,
            max_retained_entries: MAX_RETAINED_ENTRIES,
            max_metadata_bytes: MAX_METADATA_BYTES,
        }
    }
}

enum Reducer {
    Codex(CodexReducer),
    Claude(ClaudeReducer),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Conversion {
    pub source: Source,
    /// `None` for an importable result, else `empty` | `malformed` | `unsupported` |
    /// `internalRecord` | `tooLarge` (whose turns are not returned).
    pub error_code: Option<String>,
    pub foreign_session_id: Option<String>,
    pub cwd: Option<String>,
    pub internal_kind: Option<String>,
    pub history_base: Option<Value>,
    pub turns: Vec<Turn>,
    pub title: Option<String>,
    pub message_count: usize,
    pub warnings: Vec<String>,
}

pub struct Converter {
    source: Source,
    limits: Limits,
    reducer: Reducer,
    records: u64,
    malformed: u64,
    too_large: bool,
    history_partial: Option<String>,
}

impl Converter {
    pub fn new(source: Source, limits: Limits) -> Self {
        Self {
            source,
            limits,
            reducer: if source == Source::Codex {
                Reducer::Codex(CodexReducer::default())
            } else {
                Reducer::Claude(ClaudeReducer::default())
            },
            records: 0,
            malformed: 0,
            too_large: false,
            history_partial: None,
        }
    }

    /// True while every message seen so far is a Claude sidechain message.
    pub fn sidechain_only(&self) -> bool {
        matches!(&self.reducer, Reducer::Claude(r) if r.sidechain_only())
    }

    /// Records a limit enforced by the reader (an over-long line or file).
    pub fn mark_too_large(&mut self) {
        self.too_large = true;
    }

    /// A history base could not be followed in full; `warning` names why.
    pub fn mark_history_partial(&mut self, warning: &str) {
        self.history_partial = Some(warning.to_owned());
    }

    /// Feeds a line for the stored title only (Claude Code's tail window).
    pub fn push_title_line(&mut self, raw: &str) {
        let Ok(value) = serde_json::from_str::<Value>(mixdog_js::js_trim(raw)) else { return };
        if value.is_object() {
            if let Reducer::Claude(r) = &mut self.reducer {
                r.push_title(&value);
            }
        }
    }

    /// Returns false once the conversion is over a limit (`tooLarge`). `inherited` lines belong
    /// to a history base followed ahead of this file's own lines.
    pub fn push_line(&mut self, raw: &str, inherited: bool) -> bool {
        if self.too_large {
            return false;
        }
        let line = raw.strip_prefix('\u{feff}').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if mixdog_js::js_trim(line).is_empty() {
            return true;
        }
        let value = match serde_json::from_str::<Value>(line) {
            Ok(v) if v.is_object() => v,
            _ => {
                self.malformed += 1;
                return true;
            }
        };
        self.records += 1;
        let (chars, entries, metadata) = match &mut self.reducer {
            Reducer::Codex(r) => {
                r.push(&value, inherited);
                (r.chars(), r.entries(), r.metadata_bytes())
            }
            Reducer::Claude(r) => {
                r.push(&value);
                (r.chars(), r.entries(), r.metadata_bytes())
            }
        };
        if chars > self.limits.max_transcript_chars
            || entries > self.limits.max_retained_entries
            || metadata > self.limits.max_metadata_bytes
        {
            self.too_large = true;
        }
        !self.too_large
    }

    /// May be called repeatedly; also holds the normalized turns to `max_transcript_chars`.
    pub fn result(&mut self) -> Conversion {
        struct Parsed {
            recognized: bool,
            foreign_session_id: Option<String>,
            cwd: Option<String>,
            internal_kind: Option<String>,
            history_base: Option<Value>,
            raw_turns: Vec<RawTurn>,
            warnings: Vec<String>,
            stored_title: Option<String>,
        }
        let parsed = match &self.reducer {
            Reducer::Codex(r) => {
                let o = r.result();
                Parsed {
                    recognized: o.recognized,
                    foreign_session_id: o.foreign_session_id,
                    cwd: o.cwd,
                    internal_kind: o.internal_kind,
                    history_base: o.history_base,
                    raw_turns: o.raw_turns,
                    warnings: o.warnings,
                    stored_title: None,
                }
            }
            Reducer::Claude(r) => {
                let o = r.result();
                Parsed {
                    recognized: o.recognized,
                    foreign_session_id: o.foreign_session_id,
                    cwd: o.cwd,
                    internal_kind: o.internal_kind,
                    history_base: None,
                    raw_turns: o.raw_turns,
                    warnings: o.warnings,
                    stored_title: o.stored_title,
                }
            }
        };
        let turns = normalize_turns(&parsed.raw_turns);
        // Joins and the user stub add text the reducer never counted.
        if turns.iter().map(|t| utf16_len(&t.text)).sum::<usize>() > self.limits.max_transcript_chars {
            self.too_large = true;
        }
        let mut warnings = parsed.warnings;
        let mut add = |code: &str| {
            if !warnings.iter().any(|w| w == code) {
                warnings.push(code.to_owned());
            }
        };
        if self.malformed > 0 {
            add(WARNING_MALFORMED);
        }
        if let Some(partial) = &self.history_partial {
            add(partial);
        }
        let error_code = if self.too_large {
            Some(ERROR_TOO_LARGE)
        } else if parsed.internal_kind.is_some() {
            Some(ERROR_INTERNAL)
        } else if self.records == 0 {
            Some(if self.malformed > 0 { "malformed" } else { "empty" })
        } else if !parsed.recognized {
            Some("unsupported")
        } else if turns.is_empty() {
            Some("empty")
        } else {
            None
        };
        let title = parsed.stored_title.or_else(|| conversation_title(&turns));
        let message_count = if self.too_large { 0 } else { turns.len() };
        Conversion {
            source: self.source,
            error_code: error_code.map(str::to_owned),
            foreign_session_id: parsed.foreign_session_id,
            cwd: parsed.cwd,
            internal_kind: parsed.internal_kind,
            history_base: parsed.history_base,
            turns: if self.too_large { Vec::new() } else { turns },
            title,
            message_count,
            warnings,
        }
    }
}

/// Converts an in-memory JSONL body; `complete: false` drops a trailing partial line.
pub fn convert_conversation_text(source: Source, text: &str, complete: bool, limits: Limits) -> Conversion {
    let mut converter = Converter::new(source, limits);
    let body = if complete {
        text
    } else {
        text.rfind('\n').map_or("", |end| &text[..end])
    };
    for line in body.split('\n') {
        if !converter.push_line(line, false) {
            break;
        }
    }
    converter.result()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX: &str = concat!(
        "\u{feff}{\"type\":\"session_meta\",\"payload\":{\"id\":\"c1\",\"cwd\":\"/w\"}}\r\n",
        "not json\n",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Fix the build\\nplease\"}]}}\n",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done\"}]}}\n",
    );

    #[test]
    fn codex_text_converts_with_title_and_malformed_warning() {
        let c = convert_conversation_text(Source::Codex, CODEX, true, Limits::default());
        assert_eq!(c.error_code, None);
        assert_eq!((c.foreign_session_id.as_deref(), c.cwd.as_deref()), (Some("c1"), Some("/w")));
        assert_eq!(c.message_count, 2);
        assert_eq!(c.title.as_deref(), Some("Fix the build"));
        assert_eq!(c.warnings, vec!["malformed".to_owned()]);
    }

    #[test]
    fn error_codes() {
        let run = |s, t: &str| convert_conversation_text(s, t, true, Limits::default()).error_code;
        assert_eq!(run(Source::Codex, "").as_deref(), Some("empty"));
        assert_eq!(run(Source::Codex, "nope").as_deref(), Some("malformed"));
        assert_eq!(run(Source::Codex, "{\"a\":1}").as_deref(), Some("unsupported"));
        assert_eq!(
            run(Source::Codex, "{\"type\":\"session_meta\",\"payload\":{\"thread_source\":\"subagent\"}}").as_deref(),
            Some("internalRecord")
        );
        assert_eq!(run(Source::Codex, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}").as_deref(), Some("empty"));
    }

    #[test]
    fn transcript_limit_fails_the_file_without_turns() {
        let limits = Limits { max_transcript_chars: 5, ..Limits::default() };
        let c = convert_conversation_text(Source::Codex, CODEX, true, limits);
        assert_eq!(c.error_code.as_deref(), Some("tooLarge"));
        assert!(c.turns.is_empty() && c.message_count == 0);
    }

    #[test]
    fn incomplete_text_drops_the_trailing_partial_line() {
        let c = convert_conversation_text(Source::Codex, &format!("{CODEX}{{\"type\":\"resp"), false, Limits::default());
        assert_eq!(c.message_count, 2);
        assert_eq!(c.warnings, vec!["malformed".to_owned()], "only the unparsable middle line");
    }
}
