//! The spinner byline contract (`src/tui/spinner-meta.mjs`), shared by the terminal UI's spinner row and the desktop's
//! live-activity band: what is worth showing after the verb (the token count, "thinking" / "thought for Ns", the
//! quiet-time cue) and how it reads. Width gating stays with each surface. Also the quiet-time parts and label of
//! `runtime/shared/quiet-progress.mjs` that the byline uses.
//!
//! The clock is an argument (`now`, milliseconds since the epoch), never read here.

use mixdog_js::math::round;
use mixdog_js::{js_to_lowercase, js_trim, json_number, number_to_string};
use serde::{Serialize, Serializer};

/// A running turn with no counted progress for this long reads "quiet". Lenient on purpose: effort-mode models can
/// think for minutes without a semantic delta, so the cue stays neutral text; only the watchdog's own warn point
/// escalates it.
pub const QUIET_PROGRESS_CUE_MS: f64 = 120_000.0;

/// The structured thinking label: live, or a finished span (sub-second spans are noise and stay hidden). Each surface
/// formats it: the terminal UI through [`spinner_thinking_label`], the desktop through its own translations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ThinkingParts {
    Thinking { effort: String },
    Thought { seconds: u64 },
}

/// The input of [`spinner_thinking_parts`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Thinking<'a> {
    pub thinking: bool,
    pub thinking_since: f64,
    pub thinking_ms: f64,
    pub effort: &'a str,
}

/// The quiet state of a running turn as the core publishes it (`spinner.quiet`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Quiet {
    /// The frozen progress stamp, milliseconds since the epoch (0 when unknown).
    pub since: f64,
    pub wait: String,
    pub tool: Option<String>,
    /// The stall watchdog's warn point in milliseconds, 0 for none.
    pub warn_ms: f64,
}

/// Display parts of a quiet state: whole quiet minutes, what it waits on, whether the silence reached the warn point.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietParts {
    #[serde(serialize_with = "serialize_number")]
    pub quiet_ms: f64,
    #[serde(serialize_with = "serialize_number")]
    pub minutes: f64,
    pub wait: String,
    pub tool: String,
    pub escalated: bool,
}

fn serialize_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    json_number(*value).serialize(serializer)
}

/// The input of [`build_spinner_meta`]. `elapsedMs` and `verbose` of the Node signature are accepted and ignored there
/// (elapsed is never gated), so they are not carried here.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpinnerMetaInput<'a> {
    pub output_tokens: f64,
    pub thinking: Thinking<'a>,
    pub quiet: Option<Quiet>,
    pub now: f64,
}

/// What `buildSpinnerMeta` returns.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpinnerMeta {
    /// Structured twins of the texts, for surfaces that translate them.
    pub tokens_count: String,
    pub thinking_parts: Option<ThinkingParts>,
    pub tokens_text: String,
    /// The count appears with the first token: elapsed is never gated, so showing tokens with the first token keeps the
    /// byline from growing a second field mid-turn.
    pub show_tokens: bool,
    pub thinking_text: String,
    pub thinking_active: bool,
    pub quiet_parts: Option<QuietParts>,
    pub quiet_text: String,
}

/// `Number(x) || 0`: NaN counts as 0.
fn or_zero(value: f64) -> f64 {
    if value.is_nan() { 0.0 } else { value }
}

/// `new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })` of a value of 1000 or more, as
/// the lowercase text the byline shows: `1.2k`, `12k`, `999.5k`, `1m`, `2.5b`, `1t`, and past a trillion thousands of
/// trillions with grouping (`123,456.8t`). One fraction digit, half away from zero on the shortest decimal form of the
/// number; a carry to 1000 of a unit moves to the next unit.
fn compact_number(value: f64) -> String {
    if value.is_infinite() {
        return "\u{221e}".to_owned();
    }
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let mut digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).map(|c| c - b'0').collect();
    let integer_digits = exponent.parse::<i32>().unwrap_or(0) + 1;
    let mut unit = (((integer_digits - 1) / 3) as usize).min(4);
    let mut int_len = (integer_digits - 3 * unit as i32) as usize;

    // Round to one fraction digit.
    let keep = int_len + 1;
    if digits.len() <= keep {
        digits.resize(keep + 1, 0);
    }
    let round_up = digits[keep] >= 5;
    digits.truncate(keep);
    if round_up {
        let mut at = keep;
        loop {
            if at == 0 {
                digits.insert(0, 1);
                int_len += 1;
                break;
            }
            at -= 1;
            if digits[at] == 9 {
                digits[at] = 0;
            } else {
                digits[at] += 1;
                break;
            }
        }
    }
    if int_len == 4 && unit < 4 {
        unit += 1;
        int_len = 1;
        digits = vec![1, 0];
    }

    let integer: String = digits[..int_len].iter().map(|d| char::from(b'0' + d)).collect();
    let mut grouped = String::new();
    for (at, c) in integer.chars().enumerate() {
        // Compact notation groups only from five integer digits on (minimum grouping digits 2).
        if int_len >= 5 && at > 0 && (int_len - at) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let fraction = digits[int_len];
    let suffix = ["", "k", "m", "b", "t"][unit];
    if fraction == 0 { format!("{grouped}{suffix}") } else { format!("{grouped}.{fraction}{suffix}") }
}

/// `formatSpinnerTokens`: 1000 and more compact (`12k`), less rounded to an integer (`340`).
fn format_spinner_tokens(value: f64) -> String {
    let tokens = or_zero(value).max(0.0);
    if tokens >= 1000.0 {
        return compact_number(tokens);
    }
    number_to_string(round(tokens))
}

/// `effortLevel`: `auto` is the absence of a choice, so it never becomes a visible level; only an explicitly picked
/// level earns "thinking (high)".
fn effort_level(effort: &str) -> String {
    let level = js_to_lowercase(js_trim(effort));
    if matches!(level.as_str(), "" | "auto" | "default" | "off" | "none") { String::new() } else { level }
}

/// `spinnerThinkingParts`: `Thinking` while live, `Thought` for a finished span of a second or more, nothing otherwise.
pub fn spinner_thinking_parts(input: &Thinking<'_>) -> Option<ThinkingParts> {
    if input.thinking || input.thinking_since > 0.0 {
        return Some(ThinkingParts::Thinking { effort: effort_level(input.effort) });
    }
    let ms = or_zero(input.thinking_ms).max(0.0);
    if ms >= 1000.0 {
        return Some(ThinkingParts::Thought { seconds: round(ms / 1000.0).max(1.0) as u64 });
    }
    None
}

/// `spinnerThinkingLabel`: `thinking` / `thinking (high)` while live, `thought for 12s` for a finished span, empty
/// otherwise (lowercase English).
pub fn spinner_thinking_label(input: &Thinking<'_>) -> String {
    match spinner_thinking_parts(input) {
        None => String::new(),
        Some(ThinkingParts::Thinking { effort }) if effort.is_empty() => "thinking".to_owned(),
        Some(ThinkingParts::Thinking { effort }) => format!("thinking ({effort})"),
        Some(ThinkingParts::Thought { seconds }) => format!("thought for {seconds}s"),
    }
}

/// `quietProgressParts(quiet, now, warnMs)`: nothing until the silence reaches the cue window.
pub fn quiet_progress_parts(quiet: Option<&Quiet>, now: f64) -> Option<QuietParts> {
    let quiet = quiet?;
    let since = or_zero(quiet.since);
    if since == 0.0 {
        return None;
    }
    let quiet_ms = (now - since).max(0.0);
    if quiet_ms < QUIET_PROGRESS_CUE_MS {
        return None;
    }
    Some(QuietParts {
        quiet_ms,
        minutes: (quiet_ms / 60_000.0).floor(),
        wait: quiet.wait.clone(),
        tool: quiet.tool.clone().unwrap_or_default(),
        escalated: quiet.warn_ms > 0.0 && quiet_ms >= quiet.warn_ms,
    })
}

/// What a quiet turn waits on, as the byline says it (`WAIT_TEXT`).
fn wait_text(wait: &str) -> &'static str {
    match wait {
        "provider" => "waiting on provider",
        "thinking" => "model thinking",
        "model" => "waiting on model",
        "slot" => "waiting for a slot",
        "cancel" => "stopping",
        _ => "",
    }
}

/// `quietProgressLabel(parts)`: the lowercase English cue, `quiet for 2m - waiting on provider`.
pub fn quiet_progress_label(parts: Option<&QuietParts>) -> String {
    let Some(parts) = parts else { return String::new() };
    let wait = if parts.wait == "tool" {
        format!("running {}", if parts.tool.is_empty() { "a tool" } else { &parts.tool })
    } else {
        wait_text(&parts.wait).to_owned()
    };
    let minutes = format!("quiet for {}m", number_to_string(parts.minutes));
    if wait.is_empty() { minutes } else { format!("{minutes} \u{b7} {wait}") }
}

/// `buildSpinnerMeta`: the byline pieces for one live turn.
pub fn build_spinner_meta(input: &SpinnerMetaInput<'_>) -> SpinnerMeta {
    let tokens = or_zero(input.output_tokens).max(0.0);
    let quiet_parts = quiet_progress_parts(input.quiet.as_ref(), input.now);
    let thinking_parts = spinner_thinking_parts(&input.thinking);
    let thinking_text = spinner_thinking_label(&input.thinking);
    let tokens_count = if tokens > 0.0 { format_spinner_tokens(tokens) } else { String::new() };
    SpinnerMeta {
        tokens_text: if tokens > 0.0 { format!("{tokens_count} tokens") } else { String::new() },
        tokens_count,
        thinking_parts,
        show_tokens: tokens > 0.0,
        thinking_text,
        thinking_active: input.thinking.thinking || input.thinking.thinking_since > 0.0,
        quiet_text: quiet_progress_label(quiet_parts.as_ref()),
        quiet_parts,
    }
}

/// `isReducedMotion(env)`: one switch for the whole process; animation is a nicety, and low-power, SSH or recording
/// sessions must be able to drop it without losing the timer or the token readout. `value` is
/// `MIXDOG_REDUCED_MOTION`.
pub fn is_reduced_motion(value: Option<&str>) -> bool {
    let value = js_to_lowercase(js_trim(value.unwrap_or("")));
    matches!(value.as_str(), "1" | "true" | "on" | "yes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(output_tokens: f64) -> SpinnerMeta {
        build_spinner_meta(&SpinnerMetaInput { output_tokens, ..SpinnerMetaInput::default() })
    }

    #[test]
    fn the_tui_byline_stays_lowercase_english() {
        let live = |effort| Thinking { thinking: true, effort, ..Thinking::default() };
        assert_eq!(spinner_thinking_label(&live("High")), "thinking (high)");
        assert_eq!(spinner_thinking_label(&live("auto")), "thinking");
        assert_eq!(spinner_thinking_label(&Thinking { thinking_ms: 12_400.0, ..Thinking::default() }), "thought for 12s");
        assert_eq!(spinner_thinking_label(&Thinking { thinking_ms: 400.0, ..Thinking::default() }), "");
        assert_eq!(meta(340.0).tokens_text, "340 tokens");
        assert_eq!(meta(12_000.0).tokens_text, "12k tokens");
    }

    #[test]
    fn structured_parts_carry_kind_and_values_for_translating_surfaces() {
        let thinking = |effort| Thinking { thinking: true, effort, ..Thinking::default() };
        assert_eq!(spinner_thinking_parts(&thinking("medium")), Some(ThinkingParts::Thinking { effort: "medium".into() }));
        assert_eq!(spinner_thinking_parts(&thinking("")), Some(ThinkingParts::Thinking { effort: String::new() }));
        assert_eq!(
            spinner_thinking_parts(&Thinking { thinking_ms: 3000.0, ..Thinking::default() }),
            Some(ThinkingParts::Thought { seconds: 3 })
        );
        assert_eq!(spinner_thinking_parts(&Thinking::default()), None);
        let built = build_spinner_meta(&SpinnerMetaInput {
            output_tokens: 340.0,
            thinking: thinking("low"),
            ..SpinnerMetaInput::default()
        });
        assert_eq!(built.tokens_count, "340");
        assert_eq!(built.thinking_parts, Some(ThinkingParts::Thinking { effort: "low".into() }));
        assert_eq!(meta(0.0).tokens_count, "");
    }

    #[test]
    fn compact_counts_round_half_up_on_the_decimal_form_and_carry() {
        for (tokens, text) in [
            (1000.0, "1k"),
            (1049.0, "1k"),
            (1050.0, "1.1k"),
            (1250.0, "1.3k"),
            (9950.0, "10k"),
            (999_499.0, "999.5k"),
            (999_999.0, "1m"),
            (999_950_000.0, "1b"),
            (12_345_678_901_234.0, "12.3t"),
            (1e15, "1000t"),
            (123_456_789_012_345_680.0, "123,456.8t"),
            (1e21, "1,000,000,000t"),
        ] {
            assert_eq!(compact_number(tokens), text, "{tokens}");
        }
        assert_eq!(meta(999.5).tokens_count, "1000");
        assert_eq!(meta(0.4).tokens_count, "0");
        assert_eq!(meta(-5.0).tokens_count, "");
    }

    #[test]
    fn quiet_cue_appears_after_two_minutes_and_names_what_it_waits_on() {
        let now = 1_700_000_000_000.0;
        let quiet = |ago: f64, wait: &str, tool: Option<&str>, warn_ms: f64| Quiet {
            since: now - ago,
            wait: wait.into(),
            tool: tool.map(Into::into),
            warn_ms,
        };
        assert_eq!(quiet_progress_parts(Some(&quiet(119_999.0, "provider", None, 0.0)), now), None);
        let parts = quiet_progress_parts(Some(&quiet(125_000.0, "provider", None, 0.0)), now);
        assert_eq!(quiet_progress_label(parts.as_ref()), "quiet for 2m \u{b7} waiting on provider");
        let tool = quiet_progress_parts(Some(&quiet(240_000.0, "tool", Some("bash"), 0.0)), now);
        assert_eq!(quiet_progress_label(tool.as_ref()), "quiet for 4m \u{b7} running bash");
        let bare = quiet_progress_parts(Some(&quiet(240_000.0, "tool", None, 0.0)), now);
        assert_eq!(quiet_progress_label(bare.as_ref()), "quiet for 4m \u{b7} running a tool");
        let unknown = quiet_progress_parts(Some(&quiet(300_000.0, "weird", None, 0.0)), now);
        assert_eq!(quiet_progress_label(unknown.as_ref()), "quiet for 5m");
        assert!(quiet_progress_parts(Some(&quiet(300_000.0, "provider", None, 300_000.0)), now).is_some_and(|p| p.escalated));
        assert!(quiet_progress_parts(Some(&quiet(300_000.0, "provider", None, 0.0)), now).is_some_and(|p| !p.escalated));
        assert_eq!(quiet_progress_label(None), "");
    }

    #[test]
    fn reduced_motion_reads_the_documented_values() {
        for yes in ["1", "true", "TRUE", " on ", "yes", "\t1\n"] {
            assert!(is_reduced_motion(Some(yes)), "{yes:?}");
        }
        for no in ["", "0", "false", "off", "no", "x"] {
            assert!(!is_reduced_motion(Some(no)), "{no:?}");
        }
        assert!(!is_reduced_motion(None));
    }
}
