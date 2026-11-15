//! The spinner row of a running turn (`components/Spinner.jsx`, `SpinnerByline.jsx`, `use-spinner-progress.mjs`) and the
//! rule that decides when its byline is on screen (`app/live-spinner-visibility.mjs`).
//!
//! The Node component re-renders off a shared tick and reads `Date.now()`; here the clock is an argument: the owner
//! calls [`render_spinner`] at the tick it wants ([`FRAME_MS`], or [`REDUCED_MOTION_TICK_MS`] under reduced motion) with
//! the time of that tick, and keeps one [`SpinnerProgress`] for as long as the row is mounted. The progress holds what
//! the hook keeps in refs: the pause accounting, the stall smoothing and the animated token counter. Whether motion is
//! reduced (`MIXDOG_REDUCED_MOTION`, read through `mixdog_tui_style::spinner_meta::is_reduced_motion`) is the owner's
//! to read once, like the clock.

use mixdog_js::math::round;
use mixdog_js::{js_trim, utf16_len};
use mixdog_term::frame::{Color, Rgb, Style};
use mixdog_termtext::display_width;
use mixdog_tui_style::figures::{DOWN_ARROW, UP_ARROW};
use mixdog_tui_style::spinner_meta::{Quiet, SpinnerMetaInput, Thinking, build_spinner_meta};
use mixdog_tui_style::spinner_verbs::{SPINNER_FRAMES, mode_override_verb, spinner_verb_for};
use mixdog_tui_style::theme::Color as ThemeColor;
use mixdog_tui_style::time_format::{DurationOptions, format_duration};
use mixdog_tui_style::{Key, theme_color};

use crate::{Line, Run, runs_to_ansi, themed};

/// The glyph advances one frame per this many milliseconds of the turn's wall time.
pub const FRAME_MS: f64 = 130.0;
/// Under reduced motion the glyph freezes, the shimmer stops and the tick drops to one second so only the timer moves.
pub const REDUCED_MOTION_TICK_MS: f64 = 1000.0;

/// The sweep forward and back without its closing frame (it equals the first, and repeating it held the glyph for two
/// ticks at every wrap).
const FRAME_COUNT: usize = SPINNER_FRAMES.len() - 1;

/// A running turn always states how to stop it.
const INTERRUPT_HINT: &str = "esc to interrupt";
/// The thinking shimmer starts after this delay.
const THINKING_DELAY_MS: f64 = 3000.0;
/// A wider trail turns the highlight into a wipe travelling across the phrase instead of one bright character.
const GLIMMER_TRAIL: f64 = 6.0;
const THINKING_GLIMMER_SPEED_MS: f64 = 120.0;
const THINKING_GLIMMER_TRAIL: f64 = 4.0;
const STATUS_SEP: &str = " \u{b7} ";
const SEP_WIDTH: f64 = 3.0;

/// The response must grow within this window or the glyph reddens.
const STALL_TIMEOUT_MS: f64 = 3000.0;
/// The red fades in over this long.
const STALL_FADE_MS: f64 = 2000.0;

/// The props of the spinner row (the props `Spinner.jsx` receives). Times are milliseconds since the epoch, 0 for none.
#[derive(Clone, Debug, PartialEq)]
pub struct SpinnerProps {
    /// The text of a `reconnecting` turn (the engine authors it: the retry countdown).
    pub verb: String,
    pub started_at: f64,
    pub output_tokens: f64,
    pub tokens: f64,
    pub thinking: bool,
    pub thinking_active_since: f64,
    pub thinking_ms: f64,
    pub effort: String,
    /// The turn's quiet state (`spinner.quiet`), shown as the quiet-time cue.
    pub quiet: Option<Quiet>,
    pub has_active_tools: bool,
    pub paused: bool,
    pub interruptible: bool,
    /// `responding`, `thinking`, `tool-use`, `tool-input`, `requesting`, `model-thinking`, `reconnecting`,
    /// `compacting`, `auto-clear`, `resuming` or `task-wait`.
    pub mode: String,
    pub columns: f64,
    /// The blank rows above the row.
    pub margin_top: usize,
}

impl Default for SpinnerProps {
    fn default() -> Self {
        Self {
            verb: "Working".to_owned(),
            started_at: 0.0,
            output_tokens: 0.0,
            tokens: 0.0,
            thinking: false,
            thinking_active_since: 0.0,
            thinking_ms: 0.0,
            effort: String::new(),
            quiet: None,
            has_active_tools: false,
            paused: false,
            interruptible: false,
            mode: "responding".to_owned(),
            columns: 80.0,
            margin_top: 1,
        }
    }
}

/// What one tick gives `useSpinnerProgress`.
#[derive(Clone, Debug, PartialEq)]
pub struct ProgressInput<'a> {
    pub now: f64,
    pub started_at: f64,
    /// The animation clock: wall time since the turn began. It never pauses.
    pub raw_elapsed_ms: f64,
    pub frame: f64,
    pub output_tokens: f64,
    pub tokens: f64,
    pub paused: bool,
    pub has_active_tools: bool,
    pub mode: &'a str,
    pub reduced_motion: bool,
}

/// What the hook returns for one tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProgressDisplay {
    /// The turn's time without the time spent waiting on the user.
    pub elapsed_ms: f64,
    pub stalled_intensity: f64,
    pub displayed_output_tokens: f64,
}

/// The time and token bookkeeping of one mounted spinner (the refs of `useSpinnerProgress`): pause accounting, stall
/// smoothing and the animated token counter. Everything is derived from the clock of the tick.
#[derive(Clone, Debug, PartialEq)]
pub struct SpinnerProgress {
    last_grow: f64,
    last_tokens: f64,
    displayed_output: f64,
    // Time spent waiting on the user (a tool approval prompt) is not turn time: without this the reported duration
    // counts however long the prompt sat unanswered.
    turn_anchor: f64,
    paused_total: f64,
    pause_start: f64,
    stall_smooth: f64,
    last_stall_tick: f64,
}

/// `Number(x) || 0` for a count that may be NaN.
fn or_zero(value: f64) -> f64 {
    if value.is_nan() { 0.0 } else { value }
}

impl SpinnerProgress {
    /// The state at mount: the stall clock starts at `now`, the turn anchor at `started_at`.
    pub fn new(now: f64, started_at: f64) -> Self {
        Self {
            last_grow: now,
            last_tokens: 0.0,
            displayed_output: 0.0,
            turn_anchor: started_at,
            paused_total: 0.0,
            pause_start: 0.0,
            stall_smooth: 0.0,
            last_stall_tick: 0.0,
        }
    }

    /// `useSpinnerProgress` for one tick.
    pub fn advance(&mut self, input: &ProgressInput<'_>) -> ProgressDisplay {
        let now = input.now;
        if self.turn_anchor != input.started_at {
            self.turn_anchor = input.started_at;
            self.paused_total = 0.0;
            self.pause_start = 0.0;
        }
        if input.paused && self.pause_start == 0.0 {
            self.pause_start = now;
        } else if !input.paused && self.pause_start != 0.0 {
            self.paused_total += (now - self.pause_start).max(0.0);
            self.pause_start = 0.0;
        }
        let paused_ms = self.paused_total + if self.pause_start != 0.0 { (now - self.pause_start).max(0.0) } else { 0.0 };
        let elapsed_ms = (input.raw_elapsed_ms - paused_ms).max(0.0);

        let output = or_zero(input.output_tokens);
        let target = or_zero(if output != 0.0 { output } else { input.tokens }).max(0.0);

        // Stall detection tracks output growth, because input usually arrives as one usage update while the
        // assistant or tool response is what should keep moving.
        if target > self.last_tokens {
            self.last_tokens = target;
            self.last_grow = now;
        }
        // Waiting is not stalling: while a tool runs (no tokens can arrive) or while the user owns an approval
        // prompt, the stall clock is held at zero.
        let work_blocked = input.paused || input.has_active_tools || input.mode == "tool-use" || input.mode == "tool-input";
        if work_blocked {
            self.last_grow = now;
        }
        let stall_ms = now - self.last_grow;
        let is_stalled = !input.reduced_motion && target > 0.0 && stall_ms > STALL_TIMEOUT_MS;
        let raw_intensity = if is_stalled { ((stall_ms - STALL_TIMEOUT_MS) / STALL_FADE_MS).min(1.0) } else { 0.0 };
        // Exponential fade toward the target, one step per frame.
        if raw_intensity > 0.0 || self.stall_smooth > 0.0 {
            let dt = input.frame - self.last_stall_tick;
            if dt > 0.0 {
                let mut current = self.stall_smooth;
                let mut step = 0.0;
                while step < dt {
                    let diff = raw_intensity - current;
                    if diff.abs() < 0.01 {
                        current = raw_intensity;
                        break;
                    }
                    current += diff * 0.1;
                    step += 1.0;
                }
                self.stall_smooth = current;
            }
        }
        self.last_stall_tick = input.frame;

        // The token counter moves smoothly toward the current turn's output token count; input totals are not shown.
        let displayed = self.advance_counter(target, input.reduced_motion);
        ProgressDisplay { elapsed_ms, stalled_intensity: self.stall_smooth, displayed_output_tokens: displayed }
    }

    fn advance_counter(&mut self, target: f64, reduced_motion: bool) -> f64 {
        if reduced_motion {
            self.displayed_output = target;
            return round(target);
        }
        if self.displayed_output > target {
            self.displayed_output = target;
        } else if self.displayed_output < target {
            let gap = target - self.displayed_output;
            let increment = if gap < 70.0 {
                3.0
            } else if gap < 200.0 {
                8.0_f64.max((gap * 0.15).ceil())
            } else {
                50.0
            };
            self.displayed_output = (self.displayed_output + increment).min(target);
        }
        round(self.displayed_output)
    }
}

/// `interpolateColor(a, b, t)`.
fn interpolate(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let channel = |from: u8, to: u8| round(f64::from(from) + (f64::from(to) - f64::from(from)) * t) as u8;
    Rgb::new(channel(a.r, b.r), channel(a.g, b.g), channel(a.b, b.b))
}

fn rgb_style(color: Rgb) -> Style {
    Style { fg: Color::Rgb(color), ..Style::default() }
}

/// `parseRgb(theme.key)`: the theme value as a colour, none for `transparent`.
fn parse_rgb(key: Key) -> Option<Rgb> {
    match theme_color(key) {
        ThemeColor::Rgb(r, g, b) => Some(Rgb::new(r, g, b)),
        ThemeColor::Transparent => None,
    }
}

/// The colours of the shimmer, resolved per render so a live `/theme` switch is picked up.
struct SpinnerRgb {
    text: Option<Rgb>,
    shimmer: Option<Rgb>,
    glyph: Rgb,
    thinking_inactive: Rgb,
    thinking_shimmer: Rgb,
    stall: Rgb,
}

fn spinner_rgb() -> SpinnerRgb {
    SpinnerRgb {
        text: parse_rgb(Key::SpinnerText).or_else(|| parse_rgb(Key::Text)),
        shimmer: parse_rgb(Key::SpinnerShimmer).or_else(|| parse_rgb(Key::ClaudeShimmer)),
        glyph: parse_rgb(Key::SpinnerGlyph).unwrap_or(Rgb::new(240, 240, 240)),
        thinking_inactive: parse_rgb(Key::ThinkingBase).or_else(|| parse_rgb(Key::ThinkingAccent)).unwrap_or(Rgb::new(153, 153, 153)),
        thinking_shimmer: parse_rgb(Key::ThinkingGlow).unwrap_or(Rgb::new(255, 205, 175)),
        stall: parse_rgb(Key::Error).unwrap_or(Rgb::new(171, 43, 63)),
    }
}

/// `renderShimmerText`: a one-way highlight that loops over `span` cells. Without both colours the text is one run in
/// the base colour.
fn shimmer_runs(text: &str, head: f64, trail: f64, base: Option<Rgb>, shimmer: Option<Rgb>, base_style: Style, span: f64) -> Vec<Run> {
    if text.is_empty() {
        return Vec::new();
    }
    let (Some(base), Some(shimmer)) = (base, shimmer) else { return vec![(text.to_owned(), base_style)] };
    let cycle = if span != 0.0 { span } else { utf16_len(text) as f64 + trail };
    text.chars()
        .enumerate()
        .map(|(index, ch)| {
            let mut distance = head - index as f64;
            // The sweep is a loop: when the head wraps past the end, the tail of the previous pass is the head of the next.
            if distance < 0.0 {
                distance += cycle;
            }
            let intensity = if distance >= 0.0 && distance < trail { 1.0 - distance / trail } else { 0.0 };
            let style = if intensity > 0.0 { rgb_style(interpolate(base, shimmer, 0.35 + intensity * 0.65)) } else { base_style };
            (ch.to_string(), style)
        })
        .collect()
}

/// The shimmer speed of a mode in milliseconds per cell.
fn glimmer_speed_ms(mode: &str) -> f64 {
    match mode {
        "requesting" | "model-thinking" | "reconnecting" => 70.0,
        "compacting" | "auto-clear" | "resuming" | "tool-use" | "responding" | "thinking" | "tool-input" => 120.0,
        _ => 200.0,
    }
}

/// The token-direction glyph of a mode: down while receiving a response, up while the request is out and nothing has
/// come back, none for the modes where the direction would be meaningless.
fn token_mode_glyph(mode: &str) -> &'static str {
    match mode {
        "tool-input" | "tool-use" | "responding" | "thinking" => DOWN_ARROW,
        "requesting" | "model-thinking" => UP_ARROW,
        _ => "",
    }
}

/// The inputs of the byline (`SpinnerByline.jsx`): what the row derived from its tick.
#[derive(Clone, Debug)]
pub struct BylineProps<'a> {
    pub display_verb: &'a str,
    pub mode: &'a str,
    pub raw_elapsed_ms: f64,
    pub elapsed_ms: f64,
    pub displayed_output_tokens: f64,
    pub thinking: bool,
    pub thinking_active_since: f64,
    pub thinking_ms: f64,
    pub effort: &'a str,
    pub quiet: Option<Quiet>,
    pub now: f64,
    pub interruptible: bool,
    pub columns: f64,
    pub reduced_motion: bool,
}

/// The runs of the byline: the verb and `(timer · tokens · thinking · quiet · hint)`. Status parts are shown left to
/// right, each only if it fits after the previous ones; the interrupt hint, the quiet cue and the thinking status win
/// the width race (they render later but are gated first), then the timer, then the tokens.
pub fn byline_runs(props: &BylineProps<'_>) -> Vec<Run> {
    let colors = spinner_rgb();
    let message_len = utf16_len(props.display_verb) as f64;

    let glimmer_speed = glimmer_speed_ms(props.mode);
    let shimmer_span = (message_len + GLIMMER_TRAIL).max(1.0);
    let shimmer_head = (props.raw_elapsed_ms / glimmer_speed).floor() % shimmer_span;

    // The verb shimmer keeps moving through stalls and tool waits: the stall tint is limited to the glyph.
    let mut runs: Vec<Run> = Vec::new();
    if message_len > 0.0 {
        if !props.reduced_motion && colors.text.is_some() && colors.shimmer.is_some() {
            runs.extend(shimmer_runs(props.display_verb, shimmer_head, GLIMMER_TRAIL, colors.text, colors.shimmer, themed(Key::SpinnerText), shimmer_span));
        } else {
            runs.push((props.display_verb.to_owned(), themed(Key::SpinnerText)));
        }
    }

    let thinking = Thinking { thinking: props.thinking, thinking_since: props.thinking_active_since, thinking_ms: props.thinking_ms, effort: props.effort };
    let meta = build_spinner_meta(&SpinnerMetaInput {
        output_tokens: props.displayed_output_tokens,
        thinking,
        quiet: props.quiet.clone(),
        now: props.now,
    });
    let token_glyph = token_mode_glyph(props.mode);
    let token_text = if meta.tokens_text.is_empty() {
        String::new()
    } else if token_glyph.is_empty() {
        meta.tokens_text.clone()
    } else {
        format!("{token_glyph} {}", meta.tokens_text)
    };
    let token_w = utf16_len(&token_text) as f64;

    // Glyph (2) + ' (' + ')'.
    let avail = props.columns - message_len - 5.0;

    let timer_label = format_duration(props.elapsed_ms, DurationOptions::default());
    let timer_w = utf16_len(&timer_label) as f64;
    let thinking_status_text = meta.thinking_text.clone();
    let thinking_status_w = utf16_len(&thinking_status_text) as f64;

    let interrupt_text = if props.interruptible { INTERRUPT_HINT } else { "" };
    let interrupt_w = utf16_len(interrupt_text) as f64;
    let show_interrupt = !interrupt_text.is_empty() && avail > interrupt_w;
    let used_after_interrupt = if show_interrupt { interrupt_w + SEP_WIDTH } else { 0.0 };
    // A quiet turn says so before any other stat: it explains a long silence.
    let quiet_text = meta.quiet_text.clone();
    let quiet_w = utf16_len(&quiet_text) as f64;
    let show_quiet = !quiet_text.is_empty() && avail > used_after_interrupt + quiet_w;
    let used_after_quiet = used_after_interrupt + if show_quiet { quiet_w + SEP_WIDTH } else { 0.0 };
    let show_thinking = !thinking_status_text.is_empty() && avail > used_after_quiet + thinking_status_w;
    let used_after_thinking = used_after_quiet + if show_thinking { thinking_status_w + SEP_WIDTH } else { 0.0 };
    let show_timer = !timer_label.is_empty() && avail > used_after_thinking + timer_w;
    let used_after_timer = used_after_thinking + if show_timer { timer_w + SEP_WIDTH } else { 0.0 };
    // Tokens keep a short-turn gate: they only appear once the turn counted one.
    let show_tokens = meta.show_tokens && !token_text.is_empty() && avail > used_after_timer + token_w;

    let mut segments: Vec<Vec<Run>> = Vec::new();
    if show_timer {
        segments.push(vec![(timer_label, themed(Key::TimerText))]);
    }
    if show_tokens {
        segments.push(vec![(token_text, themed(Key::StatusSubtle))]);
    }
    if show_thinking {
        let span = (thinking_status_w + THINKING_GLIMMER_TRAIL).max(1.0);
        let head = ((props.raw_elapsed_ms - THINKING_DELAY_MS).max(0.0) / THINKING_GLIMMER_SPEED_MS).floor() % span;
        segments.push(if meta.thinking_active && !props.reduced_motion {
            shimmer_runs(&thinking_status_text, head, THINKING_GLIMMER_TRAIL, Some(colors.thinking_inactive), Some(colors.thinking_shimmer), themed(Key::ThinkingBase), span)
        } else {
            vec![(thinking_status_text, themed(Key::StatusSubtle))]
        });
    }
    if show_quiet {
        let escalated = meta.quiet_parts.as_ref().is_some_and(|parts| parts.escalated);
        segments.push(vec![(quiet_text, themed(if escalated { Key::Warning } else { Key::StatusSubtle }))]);
    }
    if show_interrupt {
        segments.push(vec![(interrupt_text.to_owned(), themed(Key::StatusSubtle))]);
    }
    if !segments.is_empty() {
        runs.push((" (".to_owned(), themed(Key::Inactive)));
        for (index, segment) in segments.into_iter().enumerate() {
            if index > 0 {
                runs.push((STATUS_SEP.to_owned(), themed(Key::StatusSubtle)));
            }
            runs.extend(segment);
        }
        runs.push((")".to_owned(), themed(Key::Inactive)));
    }
    runs
}

/// The runs of the spinner row at the tick of time `now`: the glyph (in a two-cell box) and the byline. `progress` is
/// the state of the mounted row.
pub fn spinner_runs(progress: &mut SpinnerProgress, props: &SpinnerProps, now: f64, reduced_motion: bool) -> Vec<Run> {
    let colors = spinner_rgb();
    // The animation clock: raw wall time since the turn began. It never pauses, so a frozen timer still animates.
    let raw_elapsed_ms = if props.started_at != 0.0 { (now - props.started_at).max(0.0) } else { 0.0 };
    let frame = if reduced_motion { 0.0 } else { (raw_elapsed_ms / FRAME_MS).floor() };
    let display = progress.advance(&ProgressInput {
        now,
        started_at: props.started_at,
        raw_elapsed_ms,
        frame,
        output_tokens: props.output_tokens,
        tokens: props.tokens,
        paused: props.paused,
        has_active_tools: props.has_active_tools,
        mode: &props.mode,
        reduced_motion,
    });
    let glyph = SPINNER_FRAMES[(frame % FRAME_COUNT as f64) as usize];
    // The glyph colour reddens toward the error colour when stalled.
    let glyph_style = if display.stalled_intensity > 0.0 {
        rgb_style(interpolate(colors.glyph, colors.stall, display.stalled_intensity))
    } else {
        themed(Key::SpinnerGlyph)
    };

    // One common pool, one phrase per 30 s window, anchored to the turn's start so a mode flip cannot rewrite the label
    // and the desktop shows the same word at the same second.
    let display_verb = match mode_override_verb(&props.mode) {
        Some(verb) => verb.to_owned(),
        None if props.mode == "reconnecting" => {
            let text = js_trim(&props.verb);
            if text.is_empty() { "Reconnecting".to_owned() } else { text.to_owned() }
        }
        None => spinner_verb_for(props.started_at, now).to_owned(),
    };

    let mut runs: Vec<Run> = vec![(glyph.to_owned(), glyph_style)];
    // The glyph sits in a box two cells wide.
    let pad = 2usize.saturating_sub(display_width(glyph));
    if pad > 0 {
        runs.push((" ".repeat(pad), Style::default()));
    }
    runs.extend(byline_runs(&BylineProps {
        display_verb: &display_verb,
        mode: &props.mode,
        raw_elapsed_ms,
        elapsed_ms: display.elapsed_ms,
        displayed_output_tokens: display.displayed_output_tokens,
        thinking: props.thinking,
        thinking_active_since: props.thinking_active_since,
        thinking_ms: props.thinking_ms,
        effort: &props.effort,
        quiet: props.quiet.clone(),
        now,
        interruptible: props.interruptible,
        columns: props.columns,
        reduced_motion,
    }));
    runs
}

/// The rows of the spinner at the tick of time `now`: `margin_top` blank rows and the row itself (SGR text, no line
/// break).
pub fn render_spinner(progress: &mut SpinnerProgress, props: &SpinnerProps, now: f64, reduced_motion: bool) -> Vec<Line> {
    let runs = spinner_runs(progress, props, now, reduced_motion);
    let mut rows = vec![Line::default(); props.margin_top];
    rows.push(Line(runs_to_ansi(&runs)));
    rows
}

/// The rows [`render_spinner`] returns.
pub fn spinner_rows(props: &SpinnerProps) -> usize {
    props.margin_top + 1
}

/// The latest transcript item as the visibility rule reads it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TranscriptTail<'a> {
    pub kind: &'a str,
    pub id: Option<&'a str>,
}

/// The streaming tail item of the transcript.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StreamingTail<'a> {
    pub kind: &'a str,
    pub streaming: bool,
    pub text: &'a str,
}

/// The inputs of [`is_live_spinner_meta_visible`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpinnerVisibility<'a> {
    pub input_box_hidden: bool,
    pub slash_palette_open: bool,
    pub live_spinner: bool,
    pub live_spinner_is_command: bool,
    pub latest_transcript_item: Option<TranscriptTail<'a>>,
    pub streaming_tail: Option<StreamingTail<'a>>,
    pub transcript_view_active: bool,
}

fn is_completed_transcript_tail(item: Option<TranscriptTail<'_>>) -> bool {
    item.is_some_and(|item| item.kind == "turndone" || item.kind == "statusdone")
}

/// `isCompletedTranscriptTailAppendedThisCommit(latestTranscriptItem, previousTailId)`.
pub fn is_completed_transcript_tail_appended_this_commit(latest: Option<TranscriptTail<'_>>, previous_tail_id: Option<&str>) -> bool {
    is_completed_transcript_tail(latest) && latest.and_then(|item| item.id) != previous_tail_id
}

/// `isLiveSpinnerMetaVisible(...)`: whether the live spinner row shows. A command spinner shows through a finished turn
/// and through a streaming answer; a turn's own spinner gives way to both.
pub fn is_live_spinner_meta_visible(input: &SpinnerVisibility<'_>) -> bool {
    let visible_streaming_assistant = !input.transcript_view_active
        && input.streaming_tail.is_some_and(|tail| tail.kind == "assistant" && tail.streaming && !js_trim(tail.text).is_empty());
    !input.input_box_hidden
        && !input.slash_palette_open
        && input.live_spinner
        && (input.live_spinner_is_command || input.latest_transcript_item.is_none_or(|item| item.kind != "turndone"))
        && (input.live_spinner_is_command || !visible_streaming_assistant)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(now: f64, raw: f64, frame: f64, tokens: f64) -> ProgressInput<'static> {
        ProgressInput {
            now,
            started_at: 1000.0,
            raw_elapsed_ms: raw,
            frame,
            output_tokens: tokens,
            tokens: 0.0,
            paused: false,
            has_active_tools: false,
            mode: "responding",
            reduced_motion: false,
        }
    }

    fn tick(progress: &mut SpinnerProgress, now: f64, tokens: f64) -> ProgressDisplay {
        let raw = now - 1000.0;
        progress.advance(&input(now, raw, (raw / FRAME_MS).floor(), tokens))
    }

    #[test]
    fn the_token_counter_walks_toward_the_target_and_snaps_down() {
        let mut progress = SpinnerProgress::new(10000.0, 1000.0);
        let counts: Vec<f64> = [100.0, 100.0, 40.0, 1000.0, 20.0].iter().map(|tokens| tick(&mut progress, 10000.0, *tokens).displayed_output_tokens).collect();
        // A gap under 200 steps by max(8, ceil(15% of the gap)), a larger one by 50, a lower target snaps.
        assert_eq!(counts, [15.0, 28.0, 31.0, 81.0, 20.0]);
    }

    #[test]
    fn a_stall_reddens_after_three_seconds_and_a_tool_wait_holds_it_at_zero() {
        let mut progress = SpinnerProgress::new(10000.0, 1000.0);
        assert_eq!(tick(&mut progress, 10000.0, 10.0).stalled_intensity, 0.0);
        assert_eq!(tick(&mut progress, 13000.0, 10.0).stalled_intensity, 0.0);
        let fading = tick(&mut progress, 14000.0, 10.0).stalled_intensity;
        assert!(fading > 0.0 && fading < 1.0, "{fading}");
        let mut blocked = SpinnerProgress::new(10000.0, 1000.0);
        for (now, mode) in [(10000.0, "tool-use"), (16000.0, "tool-use"), (20000.0, "tool-input")] {
            let raw = now - 1000.0;
            let display = blocked.advance(&ProgressInput { mode, ..input(now, raw, (raw / FRAME_MS).floor(), 10.0) });
            assert_eq!(display.stalled_intensity, 0.0);
        }
    }

    #[test]
    fn a_stall_does_not_start_before_the_first_token() {
        let mut progress = SpinnerProgress::new(10000.0, 1000.0);
        assert_eq!(tick(&mut progress, 30000.0, 0.0).stalled_intensity, 0.0);
    }

    #[test]
    fn the_time_waiting_on_the_user_is_not_turn_time() {
        let mut progress = SpinnerProgress::new(10000.0, 1000.0);
        let at = |now: f64, started: f64, paused: bool| ProgressInput { paused, started_at: started, ..input(now, now - started, 0.0, 0.0) };
        assert_eq!(progress.advance(&at(10000.0, 1000.0, true)).elapsed_ms, 9000.0);
        assert_eq!(progress.advance(&at(15000.0, 1000.0, true)).elapsed_ms, 9000.0);
        assert_eq!(progress.advance(&at(15000.0, 1000.0, false)).elapsed_ms, 9000.0);
        assert_eq!(progress.advance(&at(16000.0, 1000.0, false)).elapsed_ms, 10000.0);
        // A new turn starts the accounting over.
        assert_eq!(progress.advance(&at(15000.0, 14000.0, true)).elapsed_ms, 1000.0);
    }

    #[test]
    fn reduced_motion_shows_the_target_at_once() {
        let mut progress = SpinnerProgress::new(10000.0, 1000.0);
        let display = progress.advance(&ProgressInput { reduced_motion: true, ..input(10000.0, 9000.0, 0.0, 400.0) });
        assert_eq!(display.displayed_output_tokens, 400.0);
    }

    #[test]
    fn the_byline_drops_what_does_not_fit_and_the_hint_wins() {
        let byline = |columns: f64, mode: &'static str| {
            let runs = byline_runs(&BylineProps {
                display_verb: "Working",
                mode,
                raw_elapsed_ms: 9000.0,
                elapsed_ms: 9000.0,
                displayed_output_tokens: 12.0,
                thinking: true,
                thinking_active_since: 0.0,
                thinking_ms: 0.0,
                effort: "high",
                quiet: None,
                now: 10000.0,
                interruptible: true,
                columns,
                reduced_motion: true,
            });
            runs.into_iter().map(|(text, _)| text).collect::<String>()
        };
        assert_eq!(byline(160.0, "requesting"), "Working (9s \u{b7} \u{2191} 12 tokens \u{b7} thinking (high) \u{b7} esc to interrupt)");
        assert_eq!(byline(160.0, "responding"), "Working (9s \u{b7} \u{2193} 12 tokens \u{b7} thinking (high) \u{b7} esc to interrupt)");
        assert_eq!(byline(40.0, "compacting"), "Working (9s \u{b7} esc to interrupt)");
        assert_eq!(byline(30.0, "responding"), "Working (esc to interrupt)");
        assert_eq!(byline(12.0, "responding"), "Working");
    }

    #[test]
    fn a_mode_with_no_direction_has_no_token_glyph() {
        assert_eq!(token_mode_glyph("compacting"), "");
        assert_eq!(token_mode_glyph("requesting"), UP_ARROW);
        assert_eq!(token_mode_glyph("tool-input"), DOWN_ARROW);
    }

    #[test]
    fn the_verb_of_a_state_mode_replaces_the_pool_phrase() {
        let mut progress = SpinnerProgress::new(10000.0, 1000.0);
        let props = SpinnerProps { started_at: 1000.0, mode: "compacting".to_owned(), margin_top: 0, ..SpinnerProps::default() };
        let rows = render_spinner(&mut progress, &props, 10000.0, true);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].0.contains("Compacting conversation"));
        let props = SpinnerProps { mode: "reconnecting".to_owned(), verb: "  Retry in 3s ".to_owned(), ..props };
        assert!(render_spinner(&mut progress, &props, 10000.0, true)[0].0.contains("Retry in 3s"));
        let props = SpinnerProps { verb: " ".to_owned(), ..props };
        assert!(render_spinner(&mut progress, &props, 10000.0, true)[0].0.contains("Reconnecting"));
    }

    #[test]
    fn the_row_keeps_its_margin() {
        let mut progress = SpinnerProgress::new(10000.0, 1000.0);
        let props = SpinnerProps { started_at: 1000.0, ..SpinnerProps::default() };
        assert_eq!(render_spinner(&mut progress, &props, 10000.0, false).len(), spinner_rows(&props));
        assert_eq!(spinner_rows(&props), 2);
    }

    #[test]
    fn the_spinner_row_gives_way_to_a_finished_turn_and_a_streaming_answer() {
        let visible = SpinnerVisibility { live_spinner: true, ..SpinnerVisibility::default() };
        assert!(is_live_spinner_meta_visible(&visible));
        assert!(!is_live_spinner_meta_visible(&SpinnerVisibility { live_spinner: false, ..visible }));
        assert!(!is_live_spinner_meta_visible(&SpinnerVisibility { input_box_hidden: true, ..visible }));
        assert!(!is_live_spinner_meta_visible(&SpinnerVisibility { slash_palette_open: true, ..visible }));
        let done = Some(TranscriptTail { kind: "turndone", id: Some("a") });
        assert!(!is_live_spinner_meta_visible(&SpinnerVisibility { latest_transcript_item: done, ..visible }));
        assert!(is_live_spinner_meta_visible(&SpinnerVisibility { latest_transcript_item: done, live_spinner_is_command: true, ..visible }));
        let streaming = Some(StreamingTail { kind: "assistant", streaming: true, text: " hi " });
        assert!(!is_live_spinner_meta_visible(&SpinnerVisibility { streaming_tail: streaming, ..visible }));
        assert!(is_live_spinner_meta_visible(&SpinnerVisibility { streaming_tail: streaming, transcript_view_active: true, ..visible }));
        assert!(is_live_spinner_meta_visible(&SpinnerVisibility { streaming_tail: streaming, live_spinner_is_command: true, ..visible }));
        let blank = Some(StreamingTail { kind: "assistant", streaming: true, text: "  " });
        assert!(is_live_spinner_meta_visible(&SpinnerVisibility { streaming_tail: blank, ..visible }));
    }

    #[test]
    fn a_completed_tail_is_new_only_when_its_id_changed() {
        let done = |id| Some(TranscriptTail { kind: "statusdone", id });
        assert!(is_completed_transcript_tail_appended_this_commit(done(Some("b")), Some("a")));
        assert!(!is_completed_transcript_tail_appended_this_commit(done(Some("a")), Some("a")));
        assert!(is_completed_transcript_tail_appended_this_commit(done(None), Some("a")));
        assert!(!is_completed_transcript_tail_appended_this_commit(done(None), None));
        assert!(!is_completed_transcript_tail_appended_this_commit(Some(TranscriptTail { kind: "assistant", id: Some("b") }), Some("a")));
        assert!(!is_completed_transcript_tail_appended_this_commit(None, None));
    }
}
