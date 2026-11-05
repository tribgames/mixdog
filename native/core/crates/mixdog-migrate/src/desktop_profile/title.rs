//! The desktop's session-title read model: `generatedSessionTitle` and
//! `normalizeSessionTitle` (`apps/desktop/src/shared/session-title.mjs`) with the
//! injected-block stripping they call (`src/runtime/shared/injected-display-text.mjs`).
//! Stored titles pass through the same functions on every desktop read, so the migrated
//! title is what the desktop shows today.
//!
//! JavaScript semantics are kept where they differ from the `regex` crate's: `\s` is
//! ECMAScript white space, `\d` is ASCII, `.` stops at the four line terminators, and
//! lengths and clipping count UTF-16 code units.

use std::sync::LazyLock;

use regex::Regex;

/// ECMAScript `\s`.
const SPACE: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const NOT_SPACE: &str = r"[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
/// ECMAScript `.` without the `s` flag.
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

/// Compiles `pattern`, where `{S}`, `{NS}` and `{DOT}` stand for the ECMAScript classes.
fn rx(pattern: &str) -> Regex {
    let pattern = pattern
        .replace("{S}", SPACE)
        .replace("{NS}", NOT_SPACE)
        .replace("{DOT}", DOT);
    Regex::new(&pattern).expect("a fixed title pattern compiles")
}

pub(super) fn is_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

const INJECTED_TAGS: [&str; 6] = [
    "system-reminder",
    "available-deferred-tools",
    "mcp-instructions",
    "memory-context",
    "skill",
    "event",
];

struct TagPatterns {
    closed: Regex,
    unterminated: Regex,
    orphan: Regex,
}

static TAGS: LazyLock<Vec<TagPatterns>> = LazyLock::new(|| {
    INJECTED_TAGS
        .iter()
        .map(|tag| TagPatterns {
            closed: rx(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}{{S}}*>")),
            unterminated: rx(&format!(r"(?is)<{tag}\b[^>]*>.*$")),
            orphan: rx(&format!(r"(?i)</{tag}{{S}}*>")),
        })
        .collect()
});

/// `stripInjectedBlocks(value, { dropUnterminated })`.
pub(super) fn strip_injected_blocks(value: &str, drop_unterminated: bool) -> String {
    let mut text = value.to_owned();
    for tag in TAGS.iter() {
        text = tag.closed.replace_all(&text, " ").into_owned();
        if drop_unterminated {
            text = tag.unterminated.replace(&text, " ").into_owned();
        }
        text = tag.orphan.replace_all(&text, " ").into_owned();
    }
    text
}

static ENVELOPES: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        rx(r"(?i)^# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?"),
        rx(r"(?i)^#{S}*Session{S}+Cwd:{S}+{DOT}*?{S}+Model:{S}+{DOT}*?{S}+Workflow:{S}+{NS}+{S}*"),
        rx(r"(?i)^#{S}*Session{S}+Cwd:{S}+{NS}+(?:{S}+Model:{S}+{NS}*)?(?:{S}+Workflow:{S}+{NS}*)?{S}*"),
    ]
});

/// `stripSessionEnvelope`: each pattern removes its first match.
fn strip_session_envelope(value: &str) -> String {
    let mut text = value.to_owned();
    for pattern in ENVELOPES.iter() {
        text = pattern.replace(&text, "").into_owned();
    }
    text
}

static REFERENCE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(?i)^{S}*(?:확인{S}*)?\[[0-9]{4}-[0-9]{2}-[0-9]{2}{S}+[0-9]{2}:[0-9]{2}\]{S}*"));
/// The quoted excerpt up to its ellipsis and the first character after it; the character
/// is matched here (the crate has no look-ahead) and handed back by the caller.
static REFERENCE_QUOTE: LazyLock<Regex> = LazyLock::new(|| {
    rx(r"(?i)^{S}*(?:확인{S}*)?\[[0-9]{4}-[0-9]{2}-[0-9]{2}{S}+[0-9]{2}:[0-9]{2}\]{S}*(?s:.){0,160}?(?:…|\.\.\.){S}*{NS}")
});
static DEICTIC: LazyLock<Regex> = LazyLock::new(|| rx(r"^(?:이거|이게|그거){S}*"));

/// `stripSessionReference`.
fn strip_session_reference(value: &str) -> String {
    if let Some(quoted) = REFERENCE_QUOTE.find(value) {
        let last = value[..quoted.end()].chars().next_back().map_or(0, char::len_utf8);
        let rest = &value[quoted.end() - last..];
        return DEICTIC.replace(rest, "").into_owned();
    }
    REFERENCE_PREFIX.replace(value, "").into_owned()
}

static MEDIA: LazyLock<Regex> = LazyLock::new(|| {
    rx(r"(?i)\[(Image|Video)(?:{S}*#?[0-9]+(?:{S}*:[^\]\r\n]*)?|{S}+source:{S}*[^\]\r\n]+|:{S}*([^\]\r\n]+))\]")
});
static MEDIA_DETAIL: LazyLock<Regex> = LazyLock::new(|| {
    rx(r"(?i)source:|[0-9]{1,6}{S}*[x×]{S}*[0-9]{1,6}|displayed{S}+at(?-u:\b)|duration(?-u:\b)")
});

/// The `MEDIA_DISPLAY_BLOCK` matches as (start, end, is video). Its third form
/// (`[Image: …]`) only counts when the text carries a source, size, display or duration
/// note; that condition is a look-ahead in the original.
fn media_matches(text: &str) -> Vec<(usize, usize, bool)> {
    MEDIA
        .captures_iter(text)
        .filter_map(|caps| {
            let whole = caps.get(0)?;
            let video = caps.get(1)?.as_str().eq_ignore_ascii_case("video");
            if let Some(detail) = caps.get(2)
                && !MEDIA_DETAIL.is_match(detail.as_str())
            {
                return None;
            }
            Some((whole.start(), whole.end(), video))
        })
        .collect()
}

fn replace_media(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (start, end, _) in media_matches(text) {
        out.push_str(&text[at..start]);
        out.push(' ');
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

static FILE_CHIP: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(?i)\[(?:PDF|File){S}*#[0-9]+:{S}*([^\]\r\n]+)\]"));
static FILE_BLOCK: LazyLock<Regex> = LazyLock::new(|| rx(r"(?is)<file\b[^>]*>.*?</file>"));
static PASTED: LazyLock<Regex> = LazyLock::new(|| {
    rx(r"(?i)\[Pasted text{S}*#?[0-9]+(?:{S}*(?::[^\]\r\n]*|\+[0-9]+{S}+lines))?\]")
});
static REFERENCE_FILES: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^Reference files:{S}*"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| rx(r"{S}+"));

/// `cleanSessionTitleText`.
fn clean(source: &str) -> String {
    let stripped = strip_injected_blocks(&strip_session_envelope(source), true);
    let text = strip_session_reference(&stripped);
    let text = FILE_BLOCK.replace_all(&text, " ");
    let text = PASTED.replace_all(&text, " ");
    let text = replace_media(&text);
    let text = FILE_CHIP.replace_all(&text, " ");
    let text = REFERENCE_FILES.replace(&text, "");
    trim(&SPACES.replace_all(&text, " ")).to_owned()
}

/// `normalizeSessionTitle(value, fallback, maxLength)`.
pub(super) fn normalize(value: &str, fallback: &str, max_length: usize) -> String {
    let text = clean(value);
    if text.is_empty() {
        return fallback.to_owned();
    }
    let limit = max_length.max(16);
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= limit {
        return text;
    }
    let clipped = &units[..limit - 1];
    let boundary = clipped.iter().rposition(|&unit| unit == u16::from(b' '));
    let head = match boundary {
        Some(at) if at >= limit * 6 / 10 => &clipped[..at],
        _ => clipped,
    };
    let head = String::from_utf16_lossy(head);
    format!("{}…", head.trim_end_matches(is_space))
}

/// `normalizeSessionTitle(value, '')`, the read of a user-given name.
pub fn normalized_name(value: &str) -> String {
    normalize(value, "", 100)
}

static NOISE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)^\[mixdog-runtime\]",
        r"(?i)^\[(?:truncated|request interrupted by (?:user(?: for tool use)?|process restart))\]$",
        r"(?i)^a previous model worked on this task and produced the compacted handoff summary below(?-u:\b)",
        r"(?i)^re-attached after compaction(?-u:\b)",
        r"(?i)^reference files:{S}",
        r"(?i)^the async (?:agent|shell) task(?-u:\b)",
        r"(?i)^#{S}*permission(?-u:\b)",
        r"(?i)^permission:{S}*",
        r"(?i)^cwd:{S}*",
    ]
    .iter()
    .map(|pattern| rx(pattern))
    .collect()
});

static LEGACY_MEDIA: LazyLock<Regex> = LazyLock::new(|| {
    rx(r"(?i)^{S}*{DOT}+?\.(png|jpe?g|gif|webp|bmp|avif|mp4|mov|m4v|webm|mkv|avi){S}+[0-9]{1,6}{S}*[x×]{S}*[0-9]{1,6}(?:{S}*,?{S}*displayed{S}+at{S}+[0-9]{1,6}{S}*[x×]{S}*[0-9]{1,6})?{S}*(?:…|\.\.\.)?{S}*")
});

fn is_synthetic(value: &str) -> bool {
    let text = trim(value);
    text.is_empty() || NOISE.iter().any(|pattern| pattern.is_match(text))
}

/// `legacyMediaDisplay`: the placeholder and the text after the media prefix.
fn legacy_media(value: &str) -> Option<(&'static str, &str)> {
    let caps = LEGACY_MEDIA.captures(value)?;
    let extension = caps.get(1)?.as_str().to_ascii_lowercase();
    let placeholder = if matches!(extension.as_str(), "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi") {
        "[Video]"
    } else {
        "[Image]"
    };
    Some((placeholder, trim(&value[caps.get(0)?.end()..])))
}

/// `attachmentTitleFallback`.
fn attachment_fallback(value: &str) -> String {
    let media = media_matches(value).into_iter().next();
    let file = FILE_CHIP.captures(value);
    if let Some(file) = &file
        && media.is_none_or(|(start, _, _)| file.get(0).is_some_and(|whole| whole.start() < start))
    {
        return trim(file.get(1).map_or("", |name| name.as_str())).to_owned();
    }
    match media {
        None => String::new(),
        Some((_, _, true)) => "[Video]".to_owned(),
        Some((_, _, false)) => "[Image]".to_owned(),
    }
}

static LETTER_OR_NUMBER: LazyLock<Regex> = LazyLock::new(|| rx(r"[\p{L}\p{N}]"));

fn has_meaningful_text(title: &str) -> bool {
    LETTER_OR_NUMBER.is_match(&normalize(title, "", 100))
}

/// `generatedSessionTitle(value, '')`: the sidebar title the desktop derives from a
/// stored one (32 characters, media and envelope noise removed); empty when nothing
/// meaningful is left.
pub fn generated_title(value: &str) -> String {
    const MAX: usize = 32;
    if is_synthetic(value) {
        return String::new();
    }
    let title = match legacy_media(value) {
        Some((placeholder, text)) => normalize(text, placeholder, MAX),
        None => {
            let attachment = attachment_fallback(value);
            let fallback = if attachment.is_empty() {
                String::new()
            } else {
                normalize(&attachment, "", MAX)
            };
            normalize(value, &fallback, MAX)
        }
    };
    if has_meaningful_text(&title) { title } else { String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_blocks_are_stripped_closed_or_with_their_unterminated_tail() {
        assert_eq!(
            strip_injected_blocks("a<system-reminder>x</system-reminder>b</skill>c", false),
            "a b c"
        );
        assert_eq!(strip_injected_blocks("a <event x=1>cut off", true), "a  ");
        assert_eq!(strip_injected_blocks("a <event x=1>kept", false), "a <event x=1>kept");
    }

    #[test]
    fn titles_are_clipped_at_a_word_boundary_with_an_ellipsis() {
        let title = generated_title("alpha beta gamma delta epsilon zeta eta theta iota");
        assert_eq!(title, "alpha beta gamma delta epsilon…");
        assert!(title.encode_utf16().count() <= 32);
        assert_eq!(generated_title("  hello \n world  "), "hello world");
    }

    #[test]
    fn runtime_noise_and_envelopes_never_title_a_session() {
        assert_eq!(generated_title("[mixdog-runtime] restarted"), "");
        assert_eq!(generated_title("<system-reminder>only</system-reminder>"), "");
        assert_eq!(generated_title("# Session\nCwd: /w\nModel: m\nWorkflow: w\n\nfix the build"), "fix the build");
        assert_eq!(generated_title("!!!"), "");
    }

    #[test]
    fn attachments_title_a_message_without_words() {
        assert_eq!(generated_title("[Image #3]"), "[Image]");
        assert_eq!(generated_title("[Video source: a.mp4]"), "[Video]");
        assert_eq!(generated_title("[PDF #1: report.pdf]"), "report.pdf");
        assert_eq!(generated_title("look [Image #2: a.png] at this"), "look at this");
        assert_eq!(generated_title("[Image: just a note]"), "[Image: just a note]");
    }

    #[test]
    fn a_legacy_media_prefix_and_a_session_reference_are_dropped() {
        assert_eq!(generated_title("shot.png 800x600, displayed at 400x300 fix the layout"), "fix the layout");
        assert_eq!(
            generated_title("확인 [2026-07-01 10:20] quoted text that is long… 이거 고쳐줘"),
            "고쳐줘"
        );
        assert_eq!(generated_title("[2026-07-01 10:20] 안녕"), "안녕");
    }

    #[test]
    fn names_keep_up_to_one_hundred_units() {
        assert_eq!(normalized_name("  My   name "), "My name");
        assert_eq!(normalized_name("   "), "");
        let long = "word ".repeat(40);
        let name = normalized_name(&long);
        assert!(name.ends_with('…') && name.encode_utf16().count() <= 100);
    }
}
