//! The statusline colour bridge (`src/tui/statusline-ansi-bridge.mjs`): the footer text comes from the shared
//! statusline stack with hard-coded colours (status text 198,198,198, subtle 136, success 0,170,75, warning 255,193,7,
//! error 220,70,88). The terminal UI rewrites them into the active theme at display time, so `/theme` re-tones the
//! footer without touching the statusline.

use mixdog_js::{is_js_space, to_number_of};
use serde_json::Value;

use crate::color::rgb_to_ansi256;

const RESET: &str = "\x1b[0m";

/// An absent footer argument that is compared field by field (every field of it is absent).
static NO_ARGS: Value = Value::Null;

/// The footer's SGR colours in the active theme: the replacement for each role.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatuslineColors {
    pub status: String,
    pub subtle: String,
    pub success: String,
    pub warning: String,
    pub error: String,
}

/// The truecolor values the shared statusline emits, with the role of each (a bright variant maps to its role).
const CANONICAL: [([u8; 3], Role); 7] = [
    ([198, 198, 198], Role::Status),
    ([136, 136, 136], Role::Subtle),
    ([0, 170, 75], Role::Success),
    ([0, 185, 88], Role::Success),
    ([255, 193, 7], Role::Warning),
    ([255, 210, 80], Role::Warning),
    ([220, 70, 88], Role::Error),
];

#[derive(Clone, Copy)]
enum Role {
    Status,
    Subtle,
    Success,
    Warning,
    Error,
}

impl StatuslineColors {
    fn of(&self, role: Role) -> &str {
        match role {
            Role::Status => &self.status,
            Role::Subtle => &self.subtle,
            Role::Success => &self.success,
            Role::Warning => &self.warning,
            Role::Error => &self.error,
        }
    }
}

/// `footerLocalNum`: the number, or 0 when it is not finite.
fn local_number(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_finite() { number } else { 0.0 }
}

/// `isResetStatsState`: every counter of the footer's stats is zero. Stats that are not an object read as empty.
fn is_reset_stats_state(stats: Option<&Value>) -> bool {
    let stats = stats.and_then(Value::as_object);
    ["currentContextTokens", "currentEstimatedContextTokens", "inputTokens", "latestInputTokens", "promptTokens", "turns"]
        .iter()
        .all(|key| local_number(stats.and_then(|object| object.get(*key))) == 0.0)
}

/// JavaScript truthiness of a value (`!args`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// The property of a footer argument: only an object has one (`undefined` for a string, a number or an array).
fn field<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.as_object().and_then(|object| object.get(key))
}

/// True when the footer should snap local and invalidate its cached async output: no previous arguments, or the
/// session, provider, model, effort, fast / ultra flags, a context window, a compaction limit changed, or the stats
/// turned into the reset state. `agentRevision` is deliberately not checked: agent churn must only start the async
/// full-render refresh, never snap the footer back to the usage-less boot line before or after the first full render.
/// Values compare strictly, an absent field being its own value.
pub fn statusline_footer_identity_changed(args: Option<&Value>, last_args: Option<&Value>) -> bool {
    if !truthy(args) {
        return false;
    }
    if !truthy(last_args) {
        return true;
    }
    let (args, last) = (args.unwrap_or(&NO_ARGS), last_args.unwrap_or(&NO_ARGS));
    const FIELDS: [&str; 11] = [
        "sessionId",
        "provider",
        "model",
        "effort",
        "fast",
        "ultra",
        "contextWindow",
        "rawContextWindow",
        "displayContextWindow",
        "compactBoundaryTokens",
        "autoCompactTokenLimit",
    ];
    if FIELDS.iter().any(|key| field(args, key) != field(last, key)) {
        return true;
    }
    is_reset_stats_state(field(args, "stats")) && !is_reset_stats_state(field(last, "stats"))
}

/// The SGR sequences of one canonical colour: the truecolor form and the 256-colour form.
fn canonical_variants(rgb: [u8; 3]) -> [String; 2] {
    let [r, g, b] = rgb;
    [format!("\x1b[38;2;{r};{g};{b}m"), format!("\x1b[38;5;{}m", rgb_to_ansi256(f64::from(r), f64::from(g), f64::from(b)))]
}

/// `remapCanonicalStatuslineTruecolor`: every canonical colour of the statusline, in either form, replaced by the
/// theme colour of its role, one pair after the other; a role with no colour (empty) is left alone.
fn remap_canonical_colors(text: &str, colors: &StatuslineColors) -> String {
    let mut out = text.to_owned();
    for (rgb, role) in CANONICAL {
        let to = colors.of(role);
        if to.is_empty() {
            continue;
        }
        for from in canonical_variants(rgb) {
            out = out.replace(&from, to);
        }
    }
    out
}

/// Consumes `(?:\x1b\[[0-9;]*m)*` from the start of `text` and returns the rest.
fn skip_sgr_run(mut text: &str) -> &str {
    while let Some(rest) = text.strip_prefix("\x1b[") {
        let digits = rest.bytes().take_while(|c| c.is_ascii_digit() || *c == b';').count();
        match rest[digits..].strip_prefix('m') {
            Some(after) => text = after,
            None => break,
        }
    }
    text
}

/// `/^((?:\x1b\[[0-9;]*m)*)◆((?:\x1b\[[0-9;]*m)*)(\s?)/` replaced by `STATUS◆$2$3`: the first colours before a leading
/// diamond are dropped and the diamond takes the status colour.
fn recolor_leading_diamond(text: &str, status: &str) -> String {
    let after_first = skip_sgr_run(text);
    let Some(after_diamond) = after_first.strip_prefix('\u{25c6}') else { return text.to_owned() };
    let after_second = skip_sgr_run(after_diamond);
    let second = &after_diamond[..after_diamond.len() - after_second.len()];
    let space_len = after_second.chars().next().filter(|c| is_js_space(*c)).map_or(0, char::len_utf8);
    format!("{status}\u{25c6}{second}{}{}", &after_second[..space_len], &after_second[space_len..])
}

/// `/(\x1b\[0m )(\d+(?:\.\d+)?%)(?= |$)/g` replaced by `$1STATUS$2reset`: a percentage after a reset and a space takes
/// the status colour and is closed by the reset.
fn recolor_percentages(text: &str, status: &str, reset: &str) -> String {
    const LEAD: &str = "\x1b[0m ";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while let Some(found) = text[at..].find(LEAD) {
        let start = at + found;
        let number_at = start + LEAD.len();
        let digits = bytes[number_at..].iter().take_while(|c| c.is_ascii_digit()).count();
        let mut end = number_at + digits;
        if digits > 0 {
            if bytes.get(end) == Some(&b'.') {
                let fraction = bytes[end + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                if fraction > 0 {
                    end += 1 + fraction;
                }
            }
            if bytes.get(end) == Some(&b'%') && matches!(bytes.get(end + 1), None | Some(b' ')) {
                out.push_str(&text[copied..start]);
                out.push_str(LEAD);
                out.push_str(status);
                out.push_str(&text[number_at..=end]);
                out.push_str(reset);
                copied = end + 1;
                at = copied;
                continue;
            }
        }
        // No match here: the scan resumes one character on (the lead-in starts with an escape byte, one byte wide).
        at = start + 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// `applyDefaultStatusForegroundAfterReset`: gateway quota segments end a dim label with a reset and then bare values
/// (`Credit $1.23`); Ink would draw them in the terminal's foreground, so the status colour opens after the reset
/// (and the spaces after it) until the next explicit SGR.
fn apply_default_status_foreground_after_reset(text: &str, status: &str, reset: &str) -> String {
    if status.is_empty() || reset.is_empty() {
        return text.to_owned();
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let Some(found) = text[at..].find(reset) else {
            out.push_str(&text[at..]);
            break;
        };
        let end = at + found + reset.len();
        out.push_str(&text[at..end]);
        let mut next = end;
        while bytes.get(next) == Some(&b' ') {
            out.push(' ');
            next += 1;
        }
        if next < text.len() && bytes[next] != 0x1b {
            out.push_str(status);
        }
        at = next;
    }
    out
}

/// `normalizeStatuslineAnsi(text, colors, { reset })`: the vendored or native statusline ANSI rewritten for Ink with
/// the theme's colours. `reset` is the sequence the footer closes a segment with ([`RESET`] by default).
pub fn normalize_statusline_ansi(text: &str, colors: &StatuslineColors, reset: Option<&str>) -> String {
    let reset = reset.unwrap_or(RESET);
    let mut out = remap_canonical_colors(text, colors);
    out.truncate(out.trim_end_matches('\n').len());
    for (code, role) in [
        ("\x1b[1m", Role::Status),
        ("\x1b[2m", Role::Subtle),
        ("\x1b[31m", Role::Error),
        ("\x1b[32m", Role::Success),
        ("\x1b[33m", Role::Warning),
        ("\x1b[36m", Role::Subtle),
        ("\x1b[90m", Role::Subtle),
    ] {
        out = out.replace(code, colors.of(role));
    }
    out = recolor_leading_diamond(&out, &colors.status);
    out = recolor_percentages(&out, &colors.status, reset);
    out = out.replace(&format!("{reset} {}│{reset} ", colors.subtle), &format!(" {}│{reset} ", colors.subtle));
    apply_default_status_foreground_after_reset(&out, &colors.status, reset)
}
