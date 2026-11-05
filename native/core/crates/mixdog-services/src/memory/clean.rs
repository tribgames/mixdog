//! The text scrubber applied before anything is indexed or searched: it strips
//! markdown, tool and system tags, URLs, emoji and transcript noise so what is
//! stored is the prose a person or a model wrote.

use mixdog_js::{JsRegex, js_trim};
use std::sync::LazyLock;


/// (pattern, flags, replacement), applied in order. The rules are a stable
/// best-effort sanitisation: extend only with a stored-data reason, since a
/// change alters what already-indexed text matches.
const RULES: &[(&str, &str, &str)] = &[
    (r"```[\s\S]*?```", "", ""),
    (r"<memory-context>[\s\S]*?</memory-context>", "i", ""),
    (r"<local-command-caveat>[\s\S]*?</local-command-caveat>", "i", ""),
    (r"<local-command-stdout>[\s\S]*?</local-command-stdout>", "i", ""),
    (r"<command-name>[\s\S]*?</command-name>", "i", ""),
    (r"<command-message>[\s\S]*?</command-message>", "i", ""),
    (r"<command-args>[\s\S]*?</command-args>", "i", ""),
    (r"<task-notification>[\s\S]*?</task-notification>", "i", ""),
    (r"<tool-use-id>[\s\S]*?</tool-use-id>", "i", ""),
    (r"<output-file>[\s\S]*?</output-file>", "i", ""),
    (r"<system-reminder>[\s\S]*?</system-reminder>", "i", ""),
    (r"<schedule-context>[\s\S]*?</schedule-context>", "i", ""),
    (r"<teammate-message[\s\S]*?</teammate-message>", "i", ""),
    (r"<channel[^>]*>\n?([\s\S]*?)\n?</channel>", "", "$1"),
    (r"^[ \t]*\|.*\|[ \t]*$", "m", ""),
    (r"`([^`]+)`", "", "$1"),
    (r"\*\*", "", ""),
    (r"^#{1,4}\s+", "m", ""),
    (r"^>\s?", "m", ""),
    (r"^[-*]\s+", "m", ""),
    (r"https?://\S+", "", ""),
    (r"^This session is being continued from a previous conversation[^\n\r\u2028\u2029]*", "im", ""),
    (r"^\[[^\]\n]{1,140}\]\s*$", "m", ""),
    (r"^\s*●\s.*$", "m", ""),
    (r"^\s*Ran .*$", "m", ""),
    (r"^\s*Command: .*$", "m", ""),
    (r"^\s*Process exited .*$", "m", ""),
    (r"^\s*Full transcript available at: .*$", "m", ""),
    (r"^\s*Read the output file to retrieve the result: .*$", "m", ""),
    (r"^\s*Original token count: .*$", "m", ""),
    (r"^\s*Wall time: .*$", "m", ""),
    (r"^\s*Chunk ID: .*$", "m", ""),
    (r"^\s*tool_uses: .*$", "m", ""),
    (r"^\s*menu item .*$", "m", ""),
    (r"</?[a-z][-a-z]*(?:\s[^>]*)?/?>", "i", ""),
    (r"[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]", "u", ""),
    (r"[ \t]+", "", " "),
    (r"\n{2,}", "", "\n"),
    (r"^\s+|\s+$", "m", ""),
];

static COMPILED: LazyLock<Vec<(JsRegex, &'static str)>> = LazyLock::new(|| {
    RULES.iter().map(|(pattern, flags, replacement)| (JsRegex::new_static(pattern, &format!("g{flags}")), *replacement)).collect()
});

pub fn clean_memory_text(text: &str) -> String {
    let mut out = text.to_owned();
    for (pattern, replacement) in COMPILED.iter() {
        out = pattern.replace_all_with(&out, |caps| if *replacement == "$1" { caps.get(1).unwrap_or_default().to_owned() } else { (*replacement).to_owned() });
    }
    js_trim(&out).to_owned()
}
#[cfg(test)]
mod tests {
    use super::clean_memory_text;

    #[test]
    fn strips_markup_and_noise() {
        let text = "# Title\n**bold** `code` see https://example.com now\n```\nfenced\n```\n<system-reminder>x</system-reminder>\n- item";
        assert_eq!(clean_memory_text(text), "Title\nbold code see now\nitem");
    }
}
