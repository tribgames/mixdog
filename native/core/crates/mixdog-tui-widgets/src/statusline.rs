//! The statusline band (`components/StatusLine.jsx`) and the instant local line (`components/status-line/local-line.mjs`)
//! shown before the full footer render arrives.
//!
//! The band paints the two footer rows (the footer text is produced by the footer, which also owns the debounce and the
//! boot schedule of the full render, and passed in as the line the hook holds: already toned, see
//! [`normalize_status_line`]) with the workflow label at the right of the first row. The local line is built from the
//! store's state alone; the clock, the terminal width and the shell-job status (a cache read the owner does) are
//! arguments, so nothing here reads the process.

use mixdog_js::{js_to_lowercase, js_trim, value_to_string};
use mixdog_term::frame::Rect;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_tui_style::bridge::{StatuslineColors, normalize_statusline_ansi};
use mixdog_tui_style::color::fg_rgb;
use mixdog_tui_style::theme::Color as ThemeColor;
use mixdog_tui_style::time_format::format_elapsed;
use mixdog_tui_style::{Key, theme_color};
use mixdog_view_model::display::context_measurement::{context_measurement_label, measured_context_usage};
use mixdog_view_model::display::model_display::{display_model_name, effort_display_label, shorten_model_name};
use mixdog_view_model::display::statusline_format::{context_pct_display_label, num, terminal_columns, time_ms};
use mixdog_view_model::display::statusline_segments::unconfirmed_shell_count;
use serde_json::{Value, json};

use crate::{text_width, themed};

const RESET: &str = "\x1b[0m";

/// The rows the band takes: the first and second line of the footer, tight under the prompt.
pub const STATUSLINE_BAND_ROWS: u16 = 2;
/// Left and right inset of the band: the prompt box's text column (one border and one padding).
const BAND_INSET: u16 = 2;

/// Paints the band into the `width` cells from `(x, y)` and returns its rows ([`STATUSLINE_BAND_ROWS`]). Each footer
/// line is truncated to the width it has; the workflow label sits at the right of the first row and keeps its width
/// (the line gives way to it). Without a footer both rows are blank.
pub fn paint_statusline_band(painter: &mut Painter, x: u16, y: u16, width: u16, footer: &str, workflow_label: &str) -> u16 {
    let band = Rect::new(x, y, width, STATUSLINE_BAND_ROWS).intersect(&painter.clip());
    let inner_x = i32::from(x) + i32::from(BAND_INSET);
    let inner_width = usize::from(width.saturating_sub(2 * BAND_INSET));
    let lines: Vec<&str> = if footer.is_empty() { vec![" ", " "] } else { footer.split('\n').take(2).collect() };
    let line = |index: usize| match lines.get(index) {
        Some(text) if !text.is_empty() => *text,
        _ => " ",
    };
    let previous = painter.push_clip(band);

    // The first row: the line takes what the label (never shrunk, one cell of margin before it) leaves.
    // The label keeps its width unless the band itself is narrower: Yoga then hands the text the cells left after the margin
    // and the text truncates in them.
    let label_width = text_width(workflow_label).min(inner_width.saturating_sub(1));
    let line_width = inner_width.saturating_sub(label_width + 1);
    let row = i32::from(y);
    let row_clip = Rect::new(inner_x.max(0) as u16, y, inner_width as u16, 1);
    let clip = painter.push_clip(row_clip);
    if line_width > 0 {
        painter.text(inner_x, row, line(0), Default::default(), line_width, TextWrap::TruncateEnd);
    }
    painter.text(inner_x + line_width as i32 + 1, row, workflow_label, themed(Key::StatusText), label_width, TextWrap::TruncateEnd);
    painter.pop_clip(clip);

    // The second row: the line alone.
    let clip = painter.push_clip(Rect::new(row_clip.x, y + 1, row_clip.width, 1));
    painter.text(inner_x, row + 1, line(1), Default::default(), inner_width, TextWrap::TruncateEnd);
    painter.pop_clip(clip);

    painter.pop_clip(previous);
    STATUSLINE_BAND_ROWS
}

/// `workflowModeLabel(workflow)`: `Default Mode` for none.
pub fn workflow_mode_label(workflow: Option<&Value>) -> String {
    let field = |key: &str| workflow.and_then(|value| value.get(key)).filter(|value| truthy(value));
    let name = field("name").or_else(|| field("id")).map(value_to_string).unwrap_or_default();
    let name = js_trim(&name);
    format!("{} Mode", if name.is_empty() { "Default" } else { name })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `String(a || b || '')` over the named fields.
fn first_text(value: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|key| value.get(key).filter(|v| truthy(v))).map(value_to_string).unwrap_or_default()
}

/// The SGR open code of a theme colour, or the fallback colour's (`ansiRgb(theme.key, rgbSgr(...))`).
fn sgr_of(key: Key, fallback: (u8, u8, u8)) -> String {
    let (r, g, b) = match theme_color(key) {
        ThemeColor::Rgb(r, g, b) => (r, g, b),
        ThemeColor::Transparent => fallback,
    };
    fg_rgb(r, g, b)
}

/// The SGR escapes derived from the active theme, resolved per call so a live `/theme` switch re-tones the statusline
/// on the next render.
fn status_colors() -> StatuslineColors {
    StatuslineColors {
        status: sgr_of(Key::StatusText, (198, 198, 198)),
        subtle: sgr_of(Key::StatusSubtle, (136, 136, 136)),
        success: sgr_of(Key::Success, (0, 170, 75)),
        warning: sgr_of(Key::Warning, (255, 193, 7)),
        error: sgr_of(Key::Error, (220, 70, 88)),
    }
}

/// `normalizeStatusLine(text)`: the shared statusline's ANSI rewritten into the active palette. The cached full line is
/// canonical truecolor, so it goes through this; the local line is built themed and must not.
pub fn normalize_status_line(text: &str) -> String {
    normalize_statusline_ansi(text, &status_colors(), Some(RESET))
}

/// What the local line is built from (the store state the status line hook passes).
#[derive(Clone, Copy, Debug, Default)]
pub struct LocalLineArgs<'a> {
    pub model: &'a str,
    pub effort: &'a str,
    pub fast: bool,
    pub ultra: bool,
    pub stats: Option<&'a Value>,
    pub context_window: f64,
    pub display_context_window: f64,
    pub raw_context_window: f64,
    pub agent_workers: &'a [Value],
    pub agent_jobs: &'a [Value],
    pub active_tools: Option<&'a Value>,
    /// What the session's shell-job cache says (`shellJobsStatus`: `count`, `elapsedLabel`, `jobs`); the owner reads it
    /// with the session scope of the footer. None for no jobs.
    pub shell_status: Option<&'a Value>,
    /// The terminal's width as it reports it (none when unknown: 120).
    pub terminal_columns: Option<f64>,
}

fn local_context_segment(ctx_pct: Option<f64>, source: &str, columns: f64) -> String {
    let colors = status_colors();
    let Some(raw) = ctx_pct else { return format!("{}{}{RESET}", colors.subtle, context_measurement_label(source)) };
    let cells: usize = if columns >= 80.0 { 14 } else { 0 };
    let pct = if raw.is_finite() { raw.max(0.0) } else { 0.0 };
    let bar_pct = pct.clamp(0.0, 100.0);
    let fill = if pct >= 90.0 {
        &colors.error
    } else if pct >= 70.0 {
        &colors.warning
    } else {
        &colors.success
    };
    let label = context_pct_display_label(Some(pct));
    if cells == 0 {
        return format!("{fill}{label}%{RESET}");
    }
    let mut filled = ((bar_pct * cells as f64) / 100.0).floor() as usize;
    if bar_pct >= 1.0 && filled == 0 {
        filled = 1;
    }
    let filled = filled.min(cells);
    format!("{fill}{}{RESET}{}{}{RESET} {label}%", "\u{2593}".repeat(filled), colors.subtle, "\u{2591}".repeat(cells - filled))
}

/// The L2 spinner steps through the worker's dot glyphs at 120 ms (the full render's `l2SpinnerFrame`), so the local
/// and the full line stay in step and do not flicker.
const WORKER_SPINNER_FRAMES: [&str; 10] =
    ["\u{280b}", "\u{2819}", "\u{2839}", "\u{2838}", "\u{283c}", "\u{2834}", "\u{2826}", "\u{2827}", "\u{2807}", "\u{280f}"];
const L2_SPINNER_FRAME_MS: f64 = 120.0;

fn l2_spinner_frame(now: f64) -> &'static str {
    WORKER_SPINNER_FRAMES[((now / L2_SPINNER_FRAME_MS).floor() % WORKER_SPINNER_FRAMES.len() as f64) as usize]
}

/// `isTerminalStatus(statusText)`: a worker in a finished state is not running.
fn is_terminal_status(status: &str) -> bool {
    let status = js_to_lowercase(status);
    ["idle", "done", "complete", "success", "closed", "error", "fail", "cancel", "killed", "timeout"].iter().any(|word| status.contains(word))
}

fn worker_is_running(worker: &Value) -> bool {
    !is_terminal_status(&first_text(worker, &["stage", "status"]))
}

fn job_is_running(job: &Value) -> bool {
    js_to_lowercase(&first_text(job, &["status", "stage"])).contains("running")
}

/// How many distinct agents run (a worker by its tag, a running job by its tag, type or task id).
fn running_worker_count(workers: &[Value], jobs: &[Value]) -> usize {
    let mut seen = std::collections::HashSet::new();
    for worker in workers {
        let tag = first_text(worker, &["tag", "agent", "name"]);
        let tag = js_trim(&tag);
        if !tag.is_empty() && worker_is_running(worker) {
            seen.insert(tag.to_owned());
        }
    }
    for job in jobs.iter().filter(|job| job_is_running(job)) {
        let tag = first_text(job, &["tag", "agent", "type", "task_id", "taskId"]);
        let tag = js_trim(&tag);
        if !tag.is_empty() {
            seen.insert(tag.to_owned());
        }
    }
    seen.len()
}

/// The oldest running worker or job start time, for the Agents segment's elapsed (0 for none).
fn oldest_worker_start_ms(workers: &[Value], jobs: &[Value]) -> f64 {
    let mut oldest = f64::INFINITY;
    for worker in workers.iter().filter(|worker| worker_is_running(worker)) {
        let started = ["startedAt", "startTime", "createdAt"].iter().find_map(|key| worker.get(key).filter(|v| truthy(v)));
        let t = time_ms(started);
        if t > 0.0 && t < oldest {
            oldest = t;
        }
    }
    for job in jobs.iter().filter(|job| job_is_running(job)) {
        let t = time_ms(job.get("startedAt"));
        if t > 0.0 && t < oldest {
            oldest = t;
        }
    }
    if oldest.is_finite() { oldest } else { 0.0 }
}

/// `localStatusLineL2(args, now)`: the second line, themed SGR already in the active palette (so it must not be passed
/// through [`normalize_status_line`]): Agents, Shells (a shell whose termination is unconfirmed is held, not running,
/// with `/shells` as the way to inspect or release it), Web Searching. Empty when no segment is active.
pub fn local_status_line_l2(args: &LocalLineArgs<'_>, now: f64) -> String {
    let colors = status_colors();
    let spin = format!("{}{}{RESET}", colors.success, l2_spinner_frame(now));
    let seg_sep = format!(" {}\u{2502}{RESET} ", colors.subtle);
    let elapsed_suffix = |label: &str| if label.is_empty() { String::new() } else { format!(" {}\u{b7}{RESET} {label}", colors.subtle) };
    let plural = |count: usize| if count == 1 { "" } else { "s" };
    let mut parts: Vec<String> = Vec::new();

    let running = running_worker_count(args.agent_workers, args.agent_jobs);
    if running > 0 {
        let label = format!("Running {running} Agent{}", plural(running));
        let oldest = oldest_worker_start_ms(args.agent_workers, args.agent_jobs);
        let elapsed = if oldest > 0.0 { format_elapsed(now - oldest) } else { String::new() };
        parts.push(format!("{spin} {}{label}{RESET}{}", colors.status, elapsed_suffix(&elapsed)));
    }

    let unconfirmed = args.shell_status.map_or(0, unconfirmed_shell_count);
    let count = args.shell_status.map_or(0.0, |status| num(status.get("count")));
    let shell_count = count - unconfirmed as f64;
    if shell_count > 0.0 {
        let label = format!("Running {shell_count} Shell{}", if shell_count == 1.0 { "" } else { "s" });
        let elapsed = args.shell_status.and_then(|status| status.get("elapsedLabel")).filter(|v| truthy(v)).map(value_to_string).unwrap_or_default();
        parts.push(format!("{spin} {}{label}{RESET}{}", colors.status, elapsed_suffix(&elapsed)));
    }
    if unconfirmed > 0 {
        let label = format!("\u{26a0} {unconfirmed} Shell{} termination unconfirmed", plural(unconfirmed));
        parts.push(format!("{}{label}{RESET} {}\u{b7}{RESET} /shells", colors.warning, colors.subtle));
    }

    // `web_search` is the key the producers publish; the full render reads the same one, so both light the segment on
    // the same snapshot.
    let search = args.active_tools.filter(|tools| tools.is_object()).and_then(|tools| tools.get("web_search")).filter(|v| truthy(v));
    if let Some(search) = search
        && num(search.get("count")) > 0.0
    {
        let started = num(search.get("startedAt"));
        let elapsed = if started > 0.0 { format_elapsed(now - started) } else { String::new() };
        parts.push(format!("{spin} {}Web Searching{RESET}{}", colors.status, elapsed_suffix(&elapsed)));
    }
    parts.join(&seg_sep)
}

/// `localBootStatusLine(args)`: the model, effort and speed, the context share, and the second line when it has one.
pub fn local_boot_status_line(args: &LocalLineArgs<'_>, now: f64) -> String {
    let colors = status_colors();
    let columns = terminal_columns(args.terminal_columns);
    let raw = js_trim(args.model);
    let display = shorten_model_name(&display_model_name(raw, ""), columns);
    let speed = if args.fast { if args.ultra { "Ultrafast" } else { "Fast" } } else { "" };
    let effort = if args.effort.is_empty() { String::new() } else { effort_display_label(args.effort) };
    let flags = [effort.as_str(), speed].into_iter().filter(|flag| !flag.is_empty());
    let model_bits = std::iter::once(display.as_str()).chain(flags).collect::<Vec<_>>().join(&format!(" {}\u{b7}{RESET} ", colors.subtle));
    let usage = measured_context_usage(&json!({
        "stats": args.stats,
        "contextWindow": args.context_window,
        "displayContextWindow": args.display_context_window,
        "rawContextWindow": args.raw_context_window,
    }));
    let source = args.stats.and_then(|stats| stats.get("currentContextSource")).map_or("pending", |value| value.as_str().unwrap_or(""));
    let l1 = format!(
        "{}{model_bits}{RESET} {}\u{2502}{RESET} {}",
        colors.status,
        colors.subtle,
        local_context_segment(usage.get("percent").and_then(Value::as_f64), source, columns)
    );
    let l2 = local_status_line_l2(args, now);
    if l2.is_empty() { l1 } else { format!("{l1}\n{l2}") }
}

/// `buildLocalSnapLine(args, cachedRawLine)`: the line shown while the full render is not yet applicable. It keeps the
/// cached full line's first row (the usage segment preserved, re-toned) and grafts a fresh second row from the current
/// state, so the agent count, elapsed time and web search are never stale. The cached line is canonical truecolor, so it
/// is re-toned; the fresh row is already themed and is not. Without a cached line (or when it normalizes to nothing)
/// the boot line is used: a blank line is never emitted.
pub fn build_local_snap_line(args: &LocalLineArgs<'_>, cached_raw_line: &str, now: f64) -> String {
    if !cached_raw_line.is_empty() {
        let cached = normalize_status_line(cached_raw_line);
        if !cached.is_empty() {
            let first = cached.split('\n').next().unwrap_or("");
            // One shared `now` so every L2 spinner shows the same frame even across a frame boundary. The local row
            // renders every segment itself, so the cached second row is discarded outright.
            let fresh = local_status_line_l2(args, now);
            return if fresh.is_empty() { first.to_owned() } else { format!("{first}\n{fresh}") };
        }
    }
    normalize_status_line(&local_boot_status_line(args, now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::Grid;

    fn plain(text: &str) -> String {
        mixdog_tui_style::color::strip_ansi(text)
    }

    fn band_rows(footer: &str, label: &str, width: u16) -> Vec<String> {
        let mut grid = Grid::new(width, 3);
        let rows = paint_statusline_band(&mut Painter::new(&mut grid), 0, 0, width, footer, label);
        assert_eq!(rows, STATUSLINE_BAND_ROWS);
        assert!(grid.row_text(2).trim().is_empty(), "nothing below the band");
        vec![grid.row_text(0), grid.row_text(1)]
    }

    #[test]
    fn the_band_puts_the_label_at_the_right_of_the_first_row() {
        let rows = band_rows("model - 40%\nsecond", "Default Mode", 40);
        assert_eq!(rows[0].trim_end(), format!("  model - 40%{}Default Mode", " ".repeat(13)));
        assert_eq!(rows[1].trim_end(), "  second");
    }

    #[test]
    fn the_band_truncates_the_line_and_keeps_the_label() {
        let rows = band_rows("0123456789012345678901234567890123456789", "Default Mode", 30);
        assert!(rows[0].trim_end().ends_with(" Default Mode"), "{:?}", rows[0]);
        assert!(rows[0].contains('\u{2026}'), "{:?}", rows[0]);
        let rows = band_rows("0123456789012345678901234567890123456789\n0123456789012345678901234567890123456789", "A Mode", 20);
        assert!(rows[1].trim_end().ends_with('\u{2026}'), "{:?}", rows[1]);
    }

    #[test]
    fn an_empty_footer_leaves_both_rows_blank() {
        let rows = band_rows("", "Default Mode", 30);
        assert_eq!(rows[1].trim(), "");
        assert!(rows[0].contains("Default Mode"));
    }

    #[test]
    fn the_workflow_label_names_the_mode() {
        assert_eq!(workflow_mode_label(None), "Default Mode");
        assert_eq!(workflow_mode_label(Some(&json!({ "name": " Plan ", "id": "x" }))), "Plan Mode");
        assert_eq!(workflow_mode_label(Some(&json!({ "id": "review" }))), "review Mode");
        assert_eq!(workflow_mode_label(Some(&json!({ "name": "  " }))), "Default Mode");
        assert_eq!(workflow_mode_label(Some(&json!({}))), "Default Mode");
    }

    #[test]
    fn a_held_shell_is_unconfirmed_not_running() {
        let status = json!({ "count": 3, "elapsedLabel": "2m", "jobs": [
            { "terminationUnconfirmed": true }, { "terminationUnconfirmed": true }, { "pid": 1 } ] });
        let args = LocalLineArgs { shell_status: Some(&status), ..LocalLineArgs::default() };
        let line = plain(&local_status_line_l2(&args, 0.0));
        assert!(line.contains("Running 1 Shell \u{b7} 2m"), "{line}");
        assert!(line.contains("\u{26a0} 2 Shells termination unconfirmed \u{b7} /shells"), "{line}");
    }

    #[test]
    fn the_second_line_names_agents_with_the_oldest_start_and_web_search() {
        let workers = [
            json!({ "tag": "a", "stage": "running", "startedAt": 1000 }),
            json!({ "tag": "b", "status": "idle", "startedAt": 1 }),
            json!({ "name": "a", "stage": "working", "startedAt": 5000 }),
        ];
        let jobs = [json!({ "tag": "j", "status": "Running", "startedAt": 500 }), json!({ "tag": "k", "status": "done" })];
        let tools = json!({ "web_search": { "count": 1, "startedAt": 61000 } });
        let args = LocalLineArgs { agent_workers: &workers, agent_jobs: &jobs, active_tools: Some(&tools), ..LocalLineArgs::default() };
        let line = plain(&local_status_line_l2(&args, 66000.0));
        let spin = l2_spinner_frame(66000.0);
        assert_eq!(line, format!("{spin} Running 2 Agents \u{b7} 1m 5s \u{2502} {spin} Web Searching \u{b7} 5s"));
        assert_eq!(local_status_line_l2(&LocalLineArgs::default(), 0.0), "");
    }

    #[test]
    fn the_boot_line_names_the_model_effort_speed_and_context() {
        let stats = json!({ "currentContextTokens": 500, "currentContextSource": "last_api_request" });
        let args = LocalLineArgs {
            model: "gpt-5",
            effort: "high",
            fast: true,
            ultra: true,
            stats: Some(&stats),
            context_window: 1000.0,
            terminal_columns: Some(120.0),
            ..LocalLineArgs::default()
        };
        let line = plain(&local_boot_status_line(&args, 0.0));
        assert!(line.contains("\u{b7} High \u{b7} Ultrafast \u{2502} "), "{line}");
        assert!(line.ends_with(" 50%"), "{line}");
        assert!(line.contains(&"\u{2593}".repeat(7)), "{line}");
        let narrow = plain(&local_boot_status_line(&LocalLineArgs { terminal_columns: Some(60.0), ..args }, 0.0));
        assert!(narrow.ends_with("50%") && !narrow.contains('\u{2593}'), "{narrow}");
        let unknown = plain(&local_boot_status_line(&LocalLineArgs::default(), 0.0));
        assert!(unknown.ends_with("Awaiting measurement"), "{unknown}");
    }

    #[test]
    fn the_snap_line_keeps_the_cached_first_row_and_a_fresh_second_row() {
        let tools = json!({ "web_search": { "count": 1, "startedAt": 1000 } });
        let args = LocalLineArgs { active_tools: Some(&tools), ..LocalLineArgs::default() };
        let line = plain(&build_local_snap_line(&args, "CACHED L1\nstale second", 4000.0));
        let rows: Vec<&str> = line.split('\n').collect();
        assert_eq!(rows[0], "CACHED L1");
        assert!(rows[1].ends_with("Web Searching \u{b7} 3s"), "{line}");
        assert_eq!(plain(&build_local_snap_line(&LocalLineArgs::default(), "CACHED L1\nstale", 0.0)), "CACHED L1");
        // No cached line: the boot line stands in.
        assert!(plain(&build_local_snap_line(&args, "", 0.0)).contains("model"));
    }

    #[test]
    fn a_finished_status_is_not_running() {
        for status in ["idle", "Done", "completed", "success", "closed", "error", "failed", "cancelled", "killed", "timeout"] {
            assert!(is_terminal_status(status), "{status}");
        }
        assert!(!is_terminal_status("running"));
        assert!(!is_terminal_status(""));
    }
}
