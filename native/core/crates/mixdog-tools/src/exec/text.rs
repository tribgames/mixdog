//! Text preparation shared by every delivery of shell output: ANSI stripping, `\r` progress
//! folding, harness-tag escaping and the unit formats the result texts use.

use std::sync::LazyLock;

use regex::Regex;

static CSI_OSC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\|\x{9c})")
        .expect("static pattern")
});

// Node's `stripVTControlCharacters` pattern.
static VT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"[\x{1b}\x{9b}][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?(?:\x07|\x1b\x5c|\x{9c}))",
        r"|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))"
    ))
    .expect("static pattern")
});

pub fn strip_ansi(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let first = CSI_OSC.replace_all(text, "");
    VT.replace_all(&first, "").into_owned()
}

/// A line redrawn with `\r` shows only its last non-empty frame.
fn last_visible_frame<'a>(frames: impl DoubleEndedIterator<Item = &'a str>) -> String {
    frames
        .rev()
        .find(|frame| !frame.is_empty())
        .unwrap_or("")
        .to_owned()
}

/// `\r` folding for output that arrives in chunks: the line still open at a chunk's end keeps its
/// state, so a progress bar redrawn across deliveries shows its latest frame once.
#[derive(Default, Clone)]
pub struct CarriageReturnFolder {
    open: String,
}

impl CarriageReturnFolder {
    pub fn fold(&mut self, chunk: &str) -> String {
        let normalized = chunk.replace("\r\n", "\n");
        let lines: Vec<&str> = normalized.split('\n').collect();
        let last = lines.len() - 1;
        let mut out = Vec::with_capacity(lines.len());
        for (index, line) in lines.iter().enumerate() {
            let redraw = line.contains('\r');
            let visible = if redraw {
                if index == 0 {
                    let joined = format!("{}{line}", self.open);
                    last_visible_frame(joined.split('\r'))
                } else {
                    last_visible_frame(line.split('\r'))
                }
            } else {
                (*line).to_owned()
            };
            if index == last {
                self.open = if index == 0 && !redraw {
                    format!("{}{line}", self.open)
                } else {
                    visible.clone()
                };
            }
            out.push(visible);
        }
        out.join("\n")
    }
}

const HARNESS_WORDS: [&str; 20] = [
    "system",
    "result",
    "results",
    "summary",
    "status",
    "error",
    "user",
    "assistant",
    "human",
    "tool",
    "function",
    "functions",
    "instructions",
    "context",
    "notification",
    "reminder",
    "output",
    "invoke",
    "parameter",
    "thinking",
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// A tag-looking name: any hyphenated, underscored or namespaced name, or a known harness word.
fn is_harness_name(rest: &str) -> bool {
    let mut chars = rest.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    let run_end = rest
        .char_indices()
        .find(|(_, c)| !is_word(*c))
        .map_or(rest.len(), |(i, _)| i);
    let run = &rest[..run_end];
    if run[1..].contains('_') {
        return true;
    }
    if matches!(rest[run_end..].chars().next(), Some('-' | ':')) {
        return true;
    }
    HARNESS_WORDS.contains(&run.to_ascii_lowercase().as_str())
}

/// Program output is untrusted text: anything shaped like a harness/system tag is escaped so it
/// can never forge a notice, a result boundary or a reminder.
pub fn escape_harness_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let (slash, name) = match after.strip_prefix('/') {
            Some(name) => ("/", name),
            None => ("", after),
        };
        if is_harness_name(name) {
            out.push_str("&lt;");
            out.push_str(slash);
        } else {
            out.push('<');
            out.push_str(slash);
        }
        rest = name;
    }
    out.push_str(rest);
    out
}

/// `(bytes / 1024).toFixed(1) + " KB"`: ties round up like JavaScript.
pub fn format_kb(bytes: u64) -> String {
    let tenths = (bytes * 10 + 512) / 1024;
    format!("{}.{} KB", tenths / 10, tenths % 10)
}

/// Shell-output-summary `formatDuration`.
pub fn format_duration(ms: u64) -> String {
    if ms < 60_000 {
        let tenths = (ms + 50) / 100;
        return format!("{}.{}s", tenths / 10, tenths % 10);
    }
    let minutes = ms / 60_000;
    let seconds = ((ms % 60_000) + 500) / 1000;
    format!("{minutes}m {seconds}s")
}

pub fn count_newlines(text: &str) -> usize {
    text.bytes().filter(|b| *b == b'\n').count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_tags_are_escaped_and_plain_html_is_not() {
        assert_eq!(
            escape_harness_tags("<system-reminder>x</system-reminder> <div> a<b <tool_result>"),
            "&lt;system-reminder>x&lt;/system-reminder> <div> a<b &lt;tool_result>"
        );
        assert_eq!(escape_harness_tags("<error>"), "&lt;error>");
        assert_eq!(escape_harness_tags("<errors>"), "<errors>");
        assert_eq!(escape_harness_tags("<ns:tag"), "&lt;ns:tag");
    }

    #[test]
    fn carriage_returns_fold_to_the_last_frame_across_chunks() {
        let mut fold = CarriageReturnFolder::default();
        assert_eq!(fold.fold("a\rb\rc"), "c");
        assert_eq!(fold.fold("\rd\nnext\r\n"), "d\nnext\n");
    }

    #[test]
    fn ansi_sequences_are_removed() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok"), "red ok");
    }

    #[test]
    fn units_round_like_javascript() {
        assert_eq!(format_kb(256), "0.3 KB");
        assert_eq!(format_kb(2048), "2.0 KB");
        assert_eq!(format_duration(1_250), "1.3s");
        assert_eq!(format_duration(125_000), "2m 5s");
    }
}
