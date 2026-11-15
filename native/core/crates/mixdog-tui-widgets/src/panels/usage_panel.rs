//! `components/UsagePanel.jsx`: the provider quota and balance dashboard, one row per provider with the quota windows
//! (or the credit balance) it reports, scrolled by the arrow keys when the rows do not fit the panel.
//!
//! The reset time of a window is written in the local time zone relative to now, so the owner gives the clock reading
//! (`now_ms`); nothing here reads a clock.

use mixdog_js::math::round;
use mixdog_js::time::local_fields;
use mixdog_js::{is_js_space, js_to_lowercase, js_trim, number_to_string, to_number_of, value_to_string};
use mixdog_term::input::KeyFlags;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_tui_style::Key;
use mixdog_view_model::display::usage_dashboard::{compact_number, money};
use serde_json::Value;

use crate::panel_cell_text::{cells, pad_panel_cells, truncate_panel_text};
use crate::panels::{field, items, paint_frame, put, rows_of, text_or_empty, truthy};
use crate::{Justify, paint_split, split_row, themed};

/// The widest a provider label is.
const PROVIDER_LABEL_WIDTH: usize = 28;
const CREDIT_LABEL: &str = "Credit";
const STATUS_SEPARATOR: &str = " \u{2502} ";
const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;

/// The props of the panel.
#[derive(Clone, Debug)]
pub struct UsagePanelProps<'a> {
    /// `{ title, subtitle, rows, loading, checking }` of the usage dashboard.
    pub dashboard: Option<&'a Value>,
    pub loading: bool,
    pub columns: usize,
    /// The height the panel fills (`fillHeight`: the rows of its parent), or none for its own height.
    pub fill_height: Option<u16>,
    /// The rows the owner measured for the panel (0 when it did not): the provider rows scroll within them.
    pub panel_rows: usize,
    /// The clock reading (milliseconds since the epoch) a reset time is written against.
    pub now_ms: f64,
}

impl<'a> UsagePanelProps<'a> {
    pub fn new(dashboard: Option<&'a Value>) -> Self {
        Self { dashboard, loading: false, columns: 80, fill_height: None, panel_rows: 0, now_ms: 0.0 }
    }

    fn is_loading(&self) -> bool {
        self.loading || field(self.dashboard, "loading") == Some(&Value::Bool(true))
    }

    fn is_checking(&self) -> bool {
        field(self.dashboard, "checking") == Some(&Value::Bool(true))
    }

    fn provider_rows(&self) -> &'a [Value] {
        items(field(self.dashboard, "rows"))
    }

    fn index_width(&self) -> usize {
        let count = self.provider_rows().len();
        if count > 0 { cells(&format!("{count}.")) } else { 0 }
    }

    fn label_width(&self) -> usize {
        PROVIDER_LABEL_WIDTH.min(12.max((self.columns as f64 * 0.45).floor() as usize))
    }

    fn status_width(&self) -> usize {
        self.columns.saturating_sub(self.index_width() + self.label_width() + 8)
    }

    /// The provider rows that fit the panel: all of them when the owner did not measure it.
    fn max_provider_rows(&self) -> usize {
        if self.panel_rows > 0 { 1.max(self.panel_rows.saturating_sub(6)) } else { self.provider_rows().len() }
    }

    fn max_scroll_offset(&self) -> usize {
        self.provider_rows().len().saturating_sub(self.max_provider_rows())
    }

    fn scrollable(&self) -> bool {
        self.provider_rows().len() > self.max_provider_rows()
    }
}

/// The scroll position of the provider rows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsagePanelState {
    scroll_offset: usize,
}

impl UsagePanelState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The first provider row shown, kept inside the rows the dashboard has now.
    pub fn scroll_offset(&self, props: &UsagePanelProps) -> usize {
        self.scroll_offset.min(props.max_scroll_offset())
    }

    /// One key (`useInput`): nothing scrolls while loading or when everything fits.
    pub fn handle_key(&mut self, key: &KeyFlags, props: &UsagePanelProps) {
        if props.is_loading() || !props.scrollable() {
            return;
        }
        let max = props.max_scroll_offset();
        let page = props.max_provider_rows();
        let offset = self.scroll_offset(props);
        if key.up_arrow {
            self.scroll_offset = offset.saturating_sub(1);
        } else if key.down_arrow {
            self.scroll_offset = (offset + 1).min(max);
        } else if key.page_up {
            self.scroll_offset = offset.saturating_sub(page);
        } else if key.page_down {
            self.scroll_offset = (offset + page).min(max);
        } else if key.home {
            self.scroll_offset = 0;
        } else if key.end {
            self.scroll_offset = max;
        }
    }
}

/// A piece of a status line: its text and the colour key it is drawn in.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Part {
    text: String,
    key: Key,
}

fn part(text: &str, key: Key) -> Part {
    Part { text: text.to_owned(), key }
}

/// `resetLabel(value)`: the local time of a reset, with the date when it is a day or more away.
fn reset_label(value: Option<&Value>, now_ms: f64) -> String {
    let at = to_number_of(value);
    if !at.is_finite() || at <= 0.0 {
        return String::new();
    }
    let Some(date) = local_fields(at) else { return String::new() };
    let time = format!("{:02}:{:02}", date.hour, date.minute);
    if at - now_ms < DAY_MS { time } else { format!("{:02}-{:02} {time}", date.month, date.day) }
}

/// `isLocalEstimateWindow(w)`: a window without a source, or from the local count or the configuration.
fn is_local_estimate_window(window: Option<&Value>) -> bool {
    let source = js_to_lowercase(js_trim(&text_or_empty(field(window, "source"))));
    source.is_empty() || source.contains("local") || source.contains("config")
}

/// `hasFiniteNumber(value)`.
fn has_finite_number(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) if text.is_empty() => false,
        value => to_number_of(value).is_finite(),
    }
}

fn pct_color(value: f64) -> Key {
    if !value.is_finite() {
        Key::Text
    } else if value >= 95.0 {
        Key::Error
    } else if value >= 80.0 {
        Key::Warning
    } else {
        Key::Success
    }
}

fn remaining_usd_color(value: f64) -> Key {
    if !value.is_finite() {
        Key::Text
    } else if value <= 1.0 {
        Key::Error
    } else if value <= 5.0 {
        Key::Warning
    } else {
        Key::Success
    }
}

fn credits_color(window: Option<&Value>) -> Key {
    let used_pct = field(window, "usedPct");
    if has_finite_number(used_pct) { pct_color(to_number_of(used_pct)) } else { Key::Success }
}

fn window_reset_text(window: Option<&Value>, now_ms: f64) -> String {
    if is_local_estimate_window(window) {
        return String::new();
    }
    let reset = reset_label(field(window, "resetAt"), now_ms);
    if reset.is_empty() { String::new() } else { format!("\u{21bb} {reset}") }
}

/// `windowValue(w)`: the figure of a window and its colour. Percent first, so the windows that carry one (the OAuth quotas)
/// read alike; dollars remaining, then dollars used, then credits are the fallbacks of billing-style windows.
fn window_value(window: Option<&Value>) -> (String, Key) {
    let estimated = is_local_estimate_window(window);
    let prefix = if estimated { "est " } else { "" };
    let colour = |key: Key| if estimated { Key::Warning } else { key };
    let get = |name: &str| field(window, name);
    if has_finite_number(get("usedPct")) {
        let used_pct = to_number_of(get("usedPct"));
        return (format!("{prefix}{}%", number_to_string(round(used_pct))), colour(pct_color(used_pct)));
    }
    if has_finite_number(get("remainingUsd")) {
        return (format!("{prefix}{}", money(get("remainingUsd"))), colour(remaining_usd_color(to_number_of(get("remainingUsd")))));
    }
    if has_finite_number(get("usedUsd")) && has_finite_number(get("limitUsd")) {
        return (format!("{prefix}{}/{}", money(get("usedUsd")), money(get("limitUsd"))), colour(Key::Success));
    }
    if has_finite_number(get("remainingCredits")) && has_finite_number(get("limitCredits")) {
        return (
            format!("{prefix}{}/{}", compact_number(get("remainingCredits")), compact_number(get("limitCredits"))),
            colour(credits_color(window)),
        );
    }
    if has_finite_number(get("remainingCredits")) {
        return (format!("{prefix}{}", compact_number(get("remainingCredits"))), colour(credits_color(window)));
    }
    if has_finite_number(get("usedCredits")) && has_finite_number(get("limitCredits")) {
        return (
            format!("{prefix}{}/{}", compact_number(get("usedCredits")), compact_number(get("limitCredits"))),
            colour(credits_color(window)),
        );
    }
    (String::new(), Key::Subtle)
}

fn push_status_separator(parts: &mut Vec<Part>) {
    if !parts.is_empty() {
        parts.push(part(STATUS_SEPARATOR, Key::Inactive));
    }
}

/// `windowSegmentParts(w)`: the label of a window, its figure and its reset.
fn window_segment_parts(window: Option<&Value>, now_ms: f64) -> Vec<Part> {
    let label = field(window, "label");
    let label = if truthy(label) { value_to_string(label.unwrap_or(&Value::Null)) } else { "USE".to_owned() };
    let (value, value_key) = window_value(window);
    let reset = window_reset_text(window, now_ms);
    let mut parts = vec![part(&label.to_uppercase(), Key::Subtle)];
    if !value.is_empty() {
        parts.push(part(" ", Key::Inactive));
        parts.push(Part { text: value, key: value_key });
    }
    if !reset.is_empty() {
        parts.push(part(&format!(" {reset}"), Key::Inactive));
    }
    parts
}

fn credit_segment_parts(value: Option<&Value>) -> Vec<Part> {
    let key = if to_number_of(value) == 0.0 { Key::Text } else { remaining_usd_color(to_number_of(value)) };
    vec![part(CREDIT_LABEL, Key::Subtle), part(" ", Key::Inactive), Part { text: money(value), key }]
}

/// `maxStatusWindows(columns, statusWidth, showCredit)`: how many windows a row shows.
fn max_status_windows(columns: usize, status_width: usize, show_credit: bool) -> usize {
    let available = status_width.saturating_sub(if show_credit { 16 } else { 0 });
    if columns >= 120 && available >= 44 {
        3
    } else if columns >= 80 && available >= 28 {
        2
    } else {
        1
    }
}

/// `rowStatusParts(row, columns, statusWidth)`: what a provider row says after its label.
fn row_status_parts(row: &Value, columns: usize, status_width: usize, now_ms: f64) -> Vec<Part> {
    let row = Some(row);
    let windows = items(field(row, "windows"));
    let has_credit = has_finite_number(field(row, "remainingUsd"));
    let show_credit = has_credit && (columns >= 80 || windows.is_empty());
    if !windows.is_empty() || show_credit {
        let max_windows = if windows.is_empty() { 0 } else { max_status_windows(columns, status_width, show_credit) };
        let mut visible: Vec<usize> = (0..windows.len().min(max_windows)).collect();
        if windows.len() > max_windows && max_windows > 0 {
            // An actively used window (a monthly one at 17%) must not be cut in favour of idle 0% ones: the windows with the
            // most use stay, in list order.
            let used = |index: usize| {
                let n = to_number_of(field(Some(&windows[index]), "usedPct"));
                if n.is_nan() { 0.0 } else { n }
            };
            let mut ranked: Vec<usize> = (0..windows.len()).collect();
            ranked.sort_by(|a, b| used(*b).partial_cmp(&used(*a)).unwrap_or(std::cmp::Ordering::Equal));
            ranked.truncate(max_windows);
            visible = (0..windows.len()).filter(|index| ranked.contains(index)).collect();
        }
        let mut parts = Vec::new();
        for index in visible {
            push_status_separator(&mut parts);
            parts.extend(window_segment_parts(Some(&windows[index]), now_ms));
        }
        if show_credit {
            push_status_separator(&mut parts);
            parts.extend(credit_segment_parts(field(row, "remainingUsd")));
        }
        return parts;
    }
    let primary = field(row, "primary");
    match field(row, "status").and_then(Value::as_str) {
        Some("checking") => vec![part("checking...", Key::Inactive)],
        // The balance cannot be refreshed accurately (no balance API, or it failed): an explicit placeholder, not a blank.
        Some("hidden") => vec![Part { text: if truthy(primary) { text_or_empty(primary) } else { "-".to_owned() }, key: Key::Inactive }],
        Some("missing" | "local" | "error") => Vec::new(),
        _ if truthy(primary) => vec![Part { text: text_or_empty(primary), key: Key::Text }],
        _ => Vec::new(),
    }
}

/// `fitParts(parts, width)`: the parts that fit `width` cells, the one that does not cut short (a run of blanks is padded
/// out instead).
fn fit_parts(parts: Vec<Part>, width: usize) -> Vec<Part> {
    let mut out = Vec::new();
    if width == 0 {
        return out;
    }
    let mut used = 0;
    for part in parts {
        if part.text.is_empty() {
            continue;
        }
        let Some(remaining) = width.checked_sub(used).filter(|remaining| *remaining > 0) else { break };
        let size = cells(&part.text);
        if size <= remaining {
            used += size;
            out.push(part);
            continue;
        }
        if part.text.chars().all(is_js_space) {
            out.push(Part { text: " ".repeat(remaining), key: part.key });
            break;
        }
        let clipped = truncate_panel_text(&part.text, remaining);
        if !clipped.is_empty() {
            out.push(Part { text: clipped, key: part.key });
        }
        break;
    }
    out
}

/// Paints the panel with its top-left cell at `(x, y)`. Returns the rows it took.
pub fn paint_usage_panel(painter: &mut Painter, x: i32, y: i32, props: &UsagePanelProps, state: &UsagePanelState) -> u16 {
    let columns = props.columns;
    let inner = columns.saturating_sub(4);
    let cx = x + 2;
    let rows = props.provider_rows();
    let index_width = props.index_width();
    let label_width = props.label_width();
    let status_width = props.status_width();
    let title = text_or_empty(field(props.dashboard, "title"));
    let title = if title.is_empty() { "Provider Quotas".to_owned() } else { title };
    let subtitle = text_or_empty(field(props.dashboard, "subtitle"));
    let subtitle = if subtitle.is_empty() { "Statusline-style provider quota windows.".to_owned() } else { subtitle };
    let description = truncate_panel_text(&subtitle, columns.saturating_sub(4));
    let scroll = state.scroll_offset(props);
    let visible: &[Value] = if props.panel_rows > 0 { &rows[scroll.min(rows.len())..(scroll + props.max_provider_rows()).min(rows.len())] } else { rows };
    let scroll_hint = if props.scrollable() || props.is_loading() || props.is_checking() { "\u{2191}/\u{2193} Scroll \u{b7} PgUp/PgDn Page \u{b7} " } else { "" };
    let help = format!("{scroll_hint}Esc Back \u{b7} /usage refresh");
    let modes = (TextWrap::Wrap, TextWrap::Wrap);
    let header = split_row(&title, &help, inner, modes, Justify::Between);
    let left = (title.clone(), themed(Key::PanelTitle));
    let right = (help.clone(), themed(Key::Subtle));
    let mut used: u16 = 1 + paint_split(painter, cx, y + 1, &header, &left, &right, modes);
    if (props.is_loading() || props.is_checking()) && rows.is_empty() {
        used += 1;
        used += put(painter, cx, y + i32::from(used), "Checking providers...", themed(Key::StatusSubtle), inner, TextWrap::Wrap);
        used += 1;
    } else {
        used += 1;
        used += put(painter, cx, y + i32::from(used), &description, themed(Key::Text), inner, TextWrap::Wrap);
        used += 1;
        for (offset, row) in visible.iter().enumerate() {
            let row_y = y + i32::from(used);
            let label = text_or_empty(field(Some(row), "label"));
            let label = if label.is_empty() { text_or_empty(field(Some(row), "id")) } else { label };
            let provider = pad_panel_cells(&truncate_panel_text(&label, label_width), label_width);
            let index = pad_panel_cells(&format!("{}.", scroll + offset + 1), index_width);
            let parts = fit_parts(row_status_parts(row, columns, status_width, props.now_ms), status_width);
            let mut at = cx;
            at += painter.line(at, row_y, &format!("{index}{}", if index_width > 0 { " " } else { "" }), themed(Key::Subtle)) as i32;
            at += painter.line(at, row_y, &provider, themed(Key::Text)) as i32;
            at += painter.line(at, row_y, " ", themed(Key::Inactive)) as i32;
            for part in &parts {
                at += painter.line(at, row_y, &part.text, themed(part.key)) as i32;
            }
            used += 1;
        }
        if rows.is_empty() {
            used += 1;
            used += put(painter, cx, y + i32::from(used), "No providers configured.", themed(Key::Inactive), inner, TextWrap::Wrap);
        }
    }
    let height = props.fill_height.unwrap_or(used + 1);
    paint_frame(painter, x, y, columns, height);
    height
}

/// The rows the panel takes.
pub fn usage_panel_rows(props: &UsagePanelProps, state: &UsagePanelState) -> u16 {
    rows_of(props.columns, |painter| paint_usage_panel(painter, 0, 0, props, state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_js::time::{Tz, with_local_zone};
    use mixdog_term::frame::Grid;
    use mixdog_term::input::decode_key;
    use serde_json::json;

    fn screen(props: &UsagePanelProps, state: &UsagePanelState, rows: u16) -> Vec<String> {
        let mut grid = Grid::new(props.columns as u16, rows);
        let mut painter = Painter::new(&mut grid);
        paint_usage_panel(&mut painter, 0, 0, props, state);
        (0..rows).map(|row| grid.row_text(row).trim_end().to_owned()).collect()
    }

    fn texts(parts: &[Part]) -> String {
        parts.iter().map(|part| part.text.as_str()).collect()
    }

    #[test]
    fn a_window_reads_percent_first_then_dollars_then_credits_and_marks_an_estimate() {
        let oauth = json!({ "label": "5h", "usedPct": 17.4, "source": "oauth" });
        assert_eq!(window_value(Some(&oauth)), ("17%".to_owned(), Key::Success));
        let hot = json!({ "usedPct": 96, "source": "api" });
        assert_eq!(window_value(Some(&hot)), ("96%".to_owned(), Key::Error));
        let billing = json!({ "remainingUsd": 4.5, "source": "api" });
        assert_eq!(window_value(Some(&billing)), ("$4.50".to_owned(), Key::Warning));
        let spent = json!({ "usedUsd": 1.5, "limitUsd": 20, "source": "api" });
        assert_eq!(window_value(Some(&spent)).0, "$1.50/$20");
        let credits = json!({ "remainingCredits": 1500, "limitCredits": 20000, "usedPct": "", "source": "api" });
        assert_eq!(window_value(Some(&credits)), ("1.5K/20K".to_owned(), Key::Success));
        let estimate = json!({ "usedPct": 50 });
        assert_eq!(window_value(Some(&estimate)), ("est 50%".to_owned(), Key::Warning));
        assert_eq!(window_value(Some(&json!({ "source": "api" }))), (String::new(), Key::Subtle));
    }

    #[test]
    fn a_reset_is_a_local_time_and_carries_the_date_from_a_day_away() {
        let now = 1_700_000_000_000.0;
        with_local_zone(Tz::UTC, || {
            assert_eq!(reset_label(Some(&json!(now + 3_600_000.0)), now), "23:13");
            assert_eq!(reset_label(Some(&json!(now + 2.0 * 86_400_000.0)), now), "11-16 22:13");
            assert_eq!(reset_label(Some(&json!(0)), now), "");
            assert_eq!(reset_label(Some(&json!("x")), now), "");
        });
        with_local_zone(Tz::Asia__Seoul, || {
            assert_eq!(reset_label(Some(&json!(now + 3_600_000.0)), now), "08:13");
        });
        let local = json!({ "usedPct": 5, "resetAt": now + 1000.0, "source": "local" });
        assert_eq!(window_reset_text(Some(&local), now), "");
        let api = json!({ "usedPct": 5, "resetAt": now + 1000.0, "source": "api" });
        with_local_zone(Tz::UTC, || assert!(window_reset_text(Some(&api), now).starts_with("\u{21bb} 22:")));
    }

    #[test]
    fn a_narrow_row_keeps_the_most_used_windows_in_list_order() {
        let row = json!({ "windows": [
            { "label": "5h", "usedPct": 0, "source": "api" },
            { "label": "week", "usedPct": 40, "source": "api" },
            { "label": "month", "usedPct": 17, "source": "api" },
        ] });
        let parts = row_status_parts(&row, 80, 40, 0.0);
        assert_eq!(texts(&parts), "WEEK 40% \u{2502} MONTH 17%");
        let narrow = row_status_parts(&row, 60, 20, 0.0);
        assert_eq!(texts(&narrow), "WEEK 40%");
        let wide = row_status_parts(&row, 120, 60, 0.0);
        assert_eq!(wide.len(), 3 * 3 + 2);
    }

    #[test]
    fn a_row_without_windows_says_its_state_or_its_credit() {
        assert_eq!(texts(&row_status_parts(&json!({ "status": "checking" }), 80, 40, 0.0)), "checking...");
        assert_eq!(texts(&row_status_parts(&json!({ "status": "hidden" }), 80, 40, 0.0)), "-");
        assert_eq!(texts(&row_status_parts(&json!({ "status": "hidden", "primary": "n/a" }), 80, 40, 0.0)), "n/a");
        assert_eq!(texts(&row_status_parts(&json!({ "status": "error", "primary": "x" }), 80, 40, 0.0)), "");
        assert_eq!(texts(&row_status_parts(&json!({ "status": "ok", "primary": "12 tokens" }), 80, 40, 0.0)), "12 tokens");
        assert_eq!(texts(&row_status_parts(&json!({ "remainingUsd": 12.5 }), 80, 40, 0.0)), "Credit $13");
        // Under 80 columns the credit is only shown when the row has no windows.
        assert_eq!(texts(&row_status_parts(&json!({ "remainingUsd": 12.5 }), 60, 40, 0.0)), "Credit $13");
        let with_window = json!({ "remainingUsd": 12.5, "windows": [{ "label": "w", "usedPct": 1, "source": "api" }] });
        assert_eq!(texts(&row_status_parts(&with_window, 60, 40, 0.0)), "W 1%");
        let zero = row_status_parts(&json!({ "remainingUsd": 0 }), 80, 40, 0.0);
        assert_eq!(zero[2], Part { text: "$0".to_owned(), key: Key::Text });
    }

    #[test]
    fn parts_are_fitted_cut_with_an_ellipsis_and_a_blank_run_is_padded() {
        let parts = vec![part("AB", Key::Text), part(" \u{2502} ", Key::Inactive), part("CDEFGH", Key::Text)];
        assert_eq!(texts(&fit_parts(parts.clone(), 20)), "AB \u{2502} CDEFGH");
        assert_eq!(texts(&fit_parts(parts.clone(), 8)), "AB \u{2502} CD\u{2026}");
        assert_eq!(texts(&fit_parts(vec![part("AB", Key::Text), part("   ", Key::Text)], 4)), "AB  ");
        assert_eq!(texts(&fit_parts(parts, 0)), "");
    }

    #[test]
    fn the_panel_lists_providers_loads_and_says_when_there_are_none() {
        let dashboard = json!({ "title": "Quotas", "subtitle": "Per provider", "rows": [
            { "id": "a", "label": "Anthropic", "windows": [{ "label": "5h", "usedPct": 12, "source": "api" }] },
            { "id": "b", "status": "checking" },
        ] });
        let mut props = UsagePanelProps::new(Some(&dashboard));
        props.columns = 80;
        let lines = screen(&props, &UsagePanelState::new(), 10);
        assert!(lines[1].contains("Quotas") && lines[1].contains("Esc Back \u{b7} /usage refresh"));
        assert!(lines[3].contains("Per provider"));
        assert!(lines[5].starts_with("\u{2502} 1. Anthropic") && lines[5].contains("5H 12%"), "{}", lines[5]);
        assert!(lines[6].contains("2. b") && lines[6].contains("checking..."), "{}", lines[6]);
        assert_eq!(usage_panel_rows(&props, &UsagePanelState::new()), 8);
        let empty = json!({ "rows": [] });
        let mut none = UsagePanelProps::new(Some(&empty));
        assert!(screen(&none, &UsagePanelState::new(), 8)[6].contains("No providers configured."));
        none.loading = true;
        let loading = screen(&none, &UsagePanelState::new(), 8);
        assert!(loading[3].contains("Checking providers...") && loading[1].contains("Scroll"));
    }

    #[test]
    fn the_rows_scroll_by_line_and_page_inside_the_measured_panel() {
        let rows: Vec<Value> = (0..10).map(|n| json!({ "id": format!("p{n}"), "status": "local" })).collect();
        let dashboard = json!({ "rows": rows });
        let mut props = UsagePanelProps::new(Some(&dashboard));
        props.panel_rows = 10;
        // Four provider rows fit; six hidden.
        assert_eq!(props.max_provider_rows(), 4);
        let mut state = UsagePanelState::new();
        let press = |state: &mut UsagePanelState, sequence: &str| {
            let (_, key) = decode_key(sequence);
            state.handle_key(&key, &props);
        };
        press(&mut state, "\x1b[B");
        assert_eq!(state.scroll_offset(&props), 1);
        press(&mut state, "\x1b[6~");
        assert_eq!(state.scroll_offset(&props), 5);
        press(&mut state, "\x1b[6~");
        assert_eq!(state.scroll_offset(&props), 6);
        press(&mut state, "\x1b[H");
        assert_eq!(state.scroll_offset(&props), 0);
        press(&mut state, "\x1b[F");
        assert_eq!(state.scroll_offset(&props), 6);
        press(&mut state, "\x1b[5~");
        assert_eq!(state.scroll_offset(&props), 2);
        let lines = screen(&props, &state, 12);
        assert!(lines[5].contains("3.") && lines[5].contains("p2"), "{}", lines[5]);
        let mut loading = props.clone();
        loading.loading = true;
        let mut other = UsagePanelState::new();
        other.handle_key(&decode_key("\x1b[B").1, &loading);
        assert_eq!(other.scroll_offset(&loading), 0);
    }
}
