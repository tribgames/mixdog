//! The desktop session title (`apps/desktop/src/shared/session-title.mjs`
//! `sessionSummaryTitle`) and its placeholder labels, for the catalog's title fold
//! (FORMAT.md §8.2). Patterns are the JavaScript ones run by an ECMAScript engine, and
//! lengths count UTF-16 code units, so the result equals the desktop's.

use std::sync::LazyLock;

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::js_words;
use regress::Regex;

pub const DEFAULT_SESSION_TITLE: &str = "Untitled session";

const INJECTED_TAGS: [&str; 6] = [
    "system-reminder",
    "available-deferred-tools",
    "mcp-instructions",
    "memory-context",
    "skill",
    "event",
];

struct Patterns {
    noise: Vec<Regex>,
    media: Regex,
    legacy_media: Regex,
    video_ext: Regex,
    reference_prefix: Regex,
    reference_quote: Regex,
    reference_deictic: Regex,
    file_chip: Regex,
    envelope: [Regex; 3],
    injected: Vec<(Regex, Regex, Regex)>,
    file_block: Regex,
    pasted: Regex,
    reference_files: Regex,
    spaces: Regex,
    meaningful: Regex,
    placeholder: Regex,
}

fn re(pattern: &str, flags: &str) -> Regex {
    Regex::with_flags(pattern, flags).expect("title pattern compiles")
}

static P: LazyLock<Patterns> = LazyLock::new(|| Patterns {
    noise: [
        r"^\[mixdog-runtime\]",
        r"^\[(?:truncated|request interrupted by (?:user(?: for tool use)?|process restart))\]$",
        r"^a previous model worked on this task and produced the compacted handoff summary below\b",
        r"^re-attached after compaction\b",
        r"^reference files:\s",
        r"^the async (?:agent|shell) task\b",
        r"^#\s*permission\b",
        r"^permission:\s*",
        r"^cwd:\s*",
    ]
    .iter()
    .map(|p| re(p, "i"))
    .collect(),
    media: re(
        r"\[(Image|Video)(?:\s*#?\d+(?:\s*:[^\]\r\n]*)?|\s+source:\s*[^\]\r\n]+|:\s*(?=[^\]\r\n]*(?:source:|\d{1,6}\s*[x×]\s*\d{1,6}|displayed\s+at\b|duration\b))[^\]\r\n]+)\]",
        "i",
    ),
    legacy_media: re(
        r"^\s*.+?\.(png|jpe?g|gif|webp|bmp|avif|mp4|mov|m4v|webm|mkv|avi)\s+\d{1,6}\s*[x×]\s*\d{1,6}(?:\s*,?\s*displayed\s+at\s+\d{1,6}\s*[x×]\s*\d{1,6})?\s*(?:…|\.\.\.)?\s*",
        "i",
    ),
    video_ext: re(r"^(?:mp4|mov|m4v|webm|mkv|avi)$", "i"),
    reference_prefix: re(r"^\s*(?:확인\s*)?\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*", "i"),
    reference_quote: re(
        r"^\s*(?:확인\s*)?\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*[\s\S]{0,160}?(?:…|\.\.\.)\s*(?=\S)",
        "i",
    ),
    reference_deictic: re(r"^(?:이거|이게|그거)\s*", ""),
    file_chip: re(r"\[(?:PDF|File)\s*#\d+:\s*([^\]\r\n]+)\]", "i"),
    envelope: [
        re(r"^# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?", "i"),
        re(r"^#\s*Session\s+Cwd:\s+.*?\s+Model:\s+.*?\s+Workflow:\s+\S+\s*", "i"),
        re(r"^#\s*Session\s+Cwd:\s+\S+(?:\s+Model:\s+\S*)?(?:\s+Workflow:\s+\S*)?\s*", "i"),
    ],
    injected: INJECTED_TAGS
        .iter()
        .map(|tag| {
            (
                re(&format!(r"<{tag}\b[^>]*>[\s\S]*?<\/{tag}\s*>"), "i"),
                re(&format!(r"<{tag}\b[^>]*>[\s\S]*$"), "i"),
                re(&format!(r"<\/{tag}\s*>"), "i"),
            )
        })
        .collect(),
    file_block: re(r"<file\b[^>]*>[\s\S]*?<\/file>", "i"),
    pasted: re(r"\[Pasted text\s*#?\d+(?:\s*(?::[^\]\r\n]*|\+\d+\s+lines))?\]", "i"),
    reference_files: re(r"^Reference files:\s*", "i"),
    spaces: re(r"\s+", ""),
    meaningful: re(r"[\p{L}\p{N}]", "u"),
    placeholder: re(r"^\[(Image|Video|File)\]$", "i"),
});

static PREVIEW_CHIP: LazyLock<Regex> =
    LazyLock::new(|| re(r"\[(?:Pasted text|Image)\s*#?\d+(?:\s*(?::[^\]\r\n]*|\+\d+\s+lines))?\]", "i"));
static TRAILING_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"\s+\S*$", ""));

fn utf16_prefix(s: &str, units: usize) -> String {
    let v: Vec<u16> = s.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&v)
}

/// `session-text.mjs` `cleanSessionPreview(text, max)`.
pub fn clean_session_preview(text: &str, max: usize) -> String {
    let p = &*P;
    let limit = max.max(16);
    let text = strip_injected_blocks(&strip_session_envelope(text), true);
    let text = replace(&PREVIEW_CHIP, &text, " ", true);
    let text = replace(&p.reference_files, &text, "", false);
    let text = replace(&p.spaces, &text, " ", true);
    let cleaned = js_trim(&text);
    if utf16_len(cleaned) <= limit { cleaned.to_owned() } else { utf16_prefix(cleaned, limit) }
}

/// `store-summary-last-message.mjs` `cleanSummaryPreview(text, max)`.
pub fn clean_summary_preview(text: &str, max: usize) -> String {
    let value = clean_session_preview(text, max);
    if utf16_len(&value) <= max {
        return value;
    }
    js_trim(&replace(&TRAILING_WORD, &utf16_prefix(&value, max), "", false)).to_owned()
}

/// The 1.4.5 prompt-history key (`promptHistoryKey`): `text.trim().replace(/\s+/g, ' ')`.
pub fn prompt_history_key(text: &str) -> String {
    js_words(text).collect::<Vec<_>>().join(" ")
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `text.replace(re, ' ')` with the `g` flag when `all`.
fn replace(re: &Regex, text: &str, with: &str, all: bool) -> String {
    if all {
        re.replace_all(text, with)
    } else {
        re.replace(text, with)
    }
}

fn strip_session_envelope(value: &str) -> String {
    let p = &*P;
    let mut text = value.to_owned();
    for re in &p.envelope {
        text = replace(re, &text, "", false);
    }
    text
}

fn strip_injected_blocks(value: &str, drop_unterminated: bool) -> String {
    let mut text = value.to_owned();
    for (closed, open, orphan) in &P.injected {
        text = replace(closed, &text, " ", true);
        if drop_unterminated {
            text = replace(open, &text, " ", false);
        }
        text = replace(orphan, &text, " ", true);
    }
    text
}

fn strip_session_reference(source: &str) -> String {
    let p = &*P;
    if let Some(m) = p.reference_quote.find(source) {
        return replace(&p.reference_deictic, &source[m.end()..], "", false);
    }
    replace(&p.reference_prefix, source, "", false)
}

fn clean(source: &str) -> String {
    let p = &*P;
    let text = strip_session_reference(&strip_injected_blocks(&strip_session_envelope(source), true));
    let text = replace(&p.file_block, &text, " ", true);
    let text = replace(&p.pasted, &text, " ", true);
    let text = replace(&p.media, &text, " ", true);
    let text = replace(&p.file_chip, &text, " ", true);
    let text = replace(&p.reference_files, &text, "", false);
    let text = replace(&p.spaces, &text, " ", true);
    js_trim(&text).to_owned()
}

/// `normalizeSessionTitle`.
pub fn normalize_session_title(value: &str, fallback: &str, max_length: usize) -> String {
    let text = clean(value);
    if text.is_empty() {
        return fallback.to_owned();
    }
    let limit = max_length.max(16);
    if utf16_len(&text) <= limit {
        return text;
    }
    let units: Vec<u16> = text.encode_utf16().take(limit - 1).collect();
    let space = u16::from(b' ');
    let head = match units.iter().rposition(|&u| u == space) {
        Some(b) if b >= limit * 6 / 10 => &units[..b],
        _ => &units[..],
    };
    let head = String::from_utf16_lossy(head);
    format!("{}…", head.trim_end_matches(is_js_space))
}

fn attachment_title_fallback(source: &str) -> String {
    let p = &*P;
    let media = p.media.find(source);
    if let Some(file) = p.file_chip.find(source)
        && media.as_ref().is_none_or(|m| file.start() < m.start())
    {
        let name = file.group(1).expect("chip name");
        return js_trim(&source[name]).to_owned();
    }
    let Some(media) = media else {
        return String::new();
    };
    let kind = &source[media.group(1).expect("media kind")];
    if kind.eq_ignore_ascii_case("video") { "[Video]" } else { "[Image]" }.to_owned()
}

fn attachment_title(value: &str, fallback: &str, max_length: usize) -> String {
    let attachment = attachment_title_fallback(value);
    if attachment.is_empty() {
        fallback.to_owned()
    } else {
        normalize_session_title(&attachment, fallback, max_length)
    }
}

/// `(text, placeholder)` of a legacy `name.png 640x480 …` media prefix.
fn legacy_media_display(source: &str) -> Option<(String, &'static str)> {
    let p = &*P;
    let m = p.legacy_media.find(source)?;
    let ext = &source[m.group(1).expect("extension")];
    let fallback = if p.video_ext.find(ext).is_some() { "[Video]" } else { "[Image]" };
    Some((js_trim(&source[m.end()..]).to_owned(), fallback))
}

fn is_synthetic(value: &str) -> bool {
    let text = js_trim(value);
    text.is_empty() || P.noise.iter().any(|re| re.find(text).is_some())
}

fn has_meaningful_text(value: &str) -> bool {
    P.meaningful.find(&normalize_session_title(value, "", 100)).is_some()
}

/// `generatedSessionTitle`.
pub fn generated_session_title(value: &str, fallback: &str, max_length: usize) -> String {
    if is_synthetic(value) {
        return fallback.to_owned();
    }
    let title = match legacy_media_display(value) {
        Some((text, placeholder)) => normalize_session_title(&text, placeholder, max_length),
        None => normalize_session_title(value, &attachment_title(value, fallback, max_length), max_length),
    };
    if has_meaningful_text(&title) { title } else { fallback.to_owned() }
}

static COMPACTED_LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^a previous model worked on this task\b", "i"));
static COMPACTED_EVENT_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s+([a-z]+):\s*(.*)$", "i"));
static COMPACTED_ID: LazyLock<Regex> = LazyLock::new(|| re(r"\s+#(\d+)\s*$", ""));
static COMPACTED_END: LazyLock<Regex> = LazyLock::new(|| re(r"^<\/?prior-compacted-context>|^\[context compacted\b|^session_id=", "i"));
static MEDIA_PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| re(r"^\[(?:Image|Video)\]$", "i"));

/// `compactedSessionTitle(value, '')`: the earliest real user entry of a compact handoff, which can be the only copy of the
/// prompt that named a CLI session. Media-only entries stay provisional.
pub fn compacted_session_title(value: &str) -> String {
    if COMPACTED_LEAD.find(value.trim_start_matches(is_js_space)).is_none() && !value.contains("\u{3c}prior-compacted-context>") {
        return String::new();
    }
    let lines: Vec<&str> = value.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    // (at, id, index, title)
    let mut entries: Vec<(String, u64, usize, String)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(event) = COMPACTED_EVENT_LINE.find(line) else { continue };
        if !line[event.group(2).expect("kind")].eq_ignore_ascii_case("u") {
            continue;
        }
        let body = &line[event.group(3).expect("text")];
        let id = COMPACTED_ID.find(body);
        let mut parts = vec![id.as_ref().map_or(body, |m| &body[..m.start()]).to_owned()];
        for next in &lines[index + 1..] {
            if COMPACTED_EVENT_LINE.find(next).is_some() || COMPACTED_END.find(next).is_some() {
                break;
            }
            parts.push((*next).to_owned());
        }
        let display = parts.join("\n");
        let display = js_trim(&display);
        let legacy = legacy_media_display(display);
        let source = match &legacy {
            Some((text, _)) if !text.is_empty() => text.lines().find(|l| !js_trim(l).is_empty()).unwrap_or(text),
            _ => display,
        };
        let title = generated_session_title(source, legacy.as_ref().map_or("", |(_, placeholder)| placeholder), 32);
        if title.is_empty() {
            continue;
        }
        let at = line[event.group(1).expect("time")].to_owned();
        let id = id.and_then(|m| m.group(1).and_then(|g| body[g].parse::<u64>().ok())).unwrap_or(9_007_199_254_740_991);
        entries.push((at, id, index, title));
    }
    entries.sort_by(|a, b| (&a.0, a.1, a.2).cmp(&(&b.0, b.1, b.2)));
    entries
        .iter()
        .find(|e| MEDIA_PLACEHOLDER.find(js_trim(&e.3)).is_none())
        .or(entries.first())
        .map(|e| e.3.clone())
        .unwrap_or_default()
}

/// The desktop roster's title from a preview: `compactedSessionTitle(preview, '') || generatedSessionTitle(preview, '')`.
pub fn roster_preview_title(preview: &str) -> String {
    let compacted = compacted_session_title(preview);
    if compacted.is_empty() { generated_session_title(preview, "", 32) } else { compacted }
}

/// `sessionSummaryTitle(session, fallback)`; an empty `title` counts as absent.
pub fn session_summary_title(title: Option<&str>, preview: Option<&str>, fallback: &str) -> String {
    match title.filter(|t| !t.is_empty()) {
        Some(title) => match legacy_media_display(title) {
            Some((text, placeholder)) => normalize_session_title(&text, placeholder, 100),
            None => normalize_session_title(title, &attachment_title(title, fallback, 100), 100),
        },
        None => generated_session_title(preview.unwrap_or(""), fallback, 32),
    }
}

/// The kind of an `[Image]`/`[Video]`/`[File]` placeholder title (`title_kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TitleKind {
    Image,
    Video,
    File,
}

impl TitleKind {
    pub fn of(title: &str) -> Option<TitleKind> {
        let text = js_trim(title);
        let m = P.placeholder.find(text)?;
        let kind = &text[m.group(1).expect("kind")];
        Some(if kind.eq_ignore_ascii_case("image") {
            TitleKind::Image
        } else if kind.eq_ignore_ascii_case("video") {
            TitleKind::Video
        } else {
            TitleKind::File
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TitleKind::Image => "image",
            TitleKind::Video => "video",
            TitleKind::File => "file",
        }
    }

    pub fn parse(s: &str) -> Option<TitleKind> {
        match s {
            "image" => Some(TitleKind::Image),
            "video" => Some(TitleKind::Video),
            "file" => Some(TitleKind::File),
            _ => None,
        }
    }
}

/// The UI language's labels of the placeholder kinds (renderer `t('Image')` …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceholderLabels {
    pub image: String,
    pub video: String,
    pub file: String,
}

impl Default for PlaceholderLabels {
    fn default() -> Self {
        Self {
            image: "Image".into(),
            video: "Video".into(),
            file: "File".into(),
        }
    }
}

impl PlaceholderLabels {
    pub fn label(&self, kind: TitleKind) -> &str {
        match kind {
            TitleKind::Image => &self.image,
            TitleKind::Video => &self.video,
            TitleKind::File => &self.file,
        }
    }
}

/// `sessionDisplayTitle(session, '')`: the summary title with a placeholder shown as its
/// label, and the placeholder kind.
pub fn session_display_title(
    title: Option<&str>,
    preview: Option<&str>,
    labels: &PlaceholderLabels,
) -> (String, Option<TitleKind>) {
    let summary = session_summary_title(title, preview, "");
    match TitleKind::of(&summary) {
        Some(kind) => (labels.label(kind).to_owned(), Some(kind)),
        None => (summary, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_match_desktop() {
        let t = |title: Option<&str>, preview: Option<&str>| session_summary_title(title, preview, "");
        assert_eq!(t(Some("Fix the build"), None), "Fix the build");
        assert_eq!(t(None, Some("[mixdog-runtime] x")), "");
        assert_eq!(t(None, Some("[Image #1] ")), "[Image]");
        assert_eq!(t(None, Some("[File #2: report.pdf]")), "report.pdf");
        assert_eq!(t(None, Some("shot.mp4 640x480 hello there")), "hello there");
        assert_eq!(t(None, Some("[Image: artistic direction]")), "[Image: artistic direction]");
        assert_eq!(
            t(None, Some("<system-reminder>x</system-reminder> real   words")),
            "real words"
        );
        assert_eq!(
            t(None, Some("one two three four five six seven eight nine")),
            "one two three four five six…"
        );
        let (shown, kind) = session_display_title(
            None,
            Some("[Video #1]"),
            &PlaceholderLabels { image: "이미지".into(), video: "영상".into(), file: "파일".into() },
        );
        assert_eq!((shown.as_str(), kind), ("영상", Some(TitleKind::Video)));
    }
}
