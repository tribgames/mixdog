//! `runtime/shared/statusline/statusline-format.mjs`: the pure formatting primitives of the footer: the model and context
//! segments with their SGR colours, the context bar, and the small numeric helpers. Elapsed labels come from the shared
//! formatter, so the footer matches the cards of every surface.
//!
//! Node read the colour decision once at import; here a [`StatusStyle`] carries the [`Styler`] that decides it, so a caller
//! (and a test) says which environment it formats for. The model catalog is a lookup the caller supplies
//! ([`ModelMetadata`]), not a dependency of this crate.

use mixdog_js::math::round;
use mixdog_js::number_to_string;
use mixdog_js::time::date_parse;
use mixdog_js::time::local_fields;
use mixdog_js::to_number;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use mixdog_tui_style::color::Style;
use mixdog_tui_style::color::Styler;
use serde_json::Value;

use super::coerce::truthy;
use super::context_measurement::context_measurement_label;
pub use super::time_format::format_elapsed;
use super::model_display::display_model_name;
use super::model_display::effort_display_label;
use super::model_display::shorten_model_name;

/// The token window used to compute a fallback context share from our own session usage. The live gateway (when up)
/// overrides it with the real route's window; this is the last resort for unknown local models.
const FALLBACK_CONTEXT_WINDOW: f64 = 200_000.0;

/// What the model catalog knows of a model: its window and the names it is shown by (`displayName`, `display`, `name`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelMetadata {
    pub context_window: f64,
    pub display_name: String,
    pub display: String,
    pub name: String,
}

/// `getModelMetadataSync(model, provider)`: the caller's catalog, by model then provider.
pub type MetadataLookup<'a> = &'a dyn Fn(&str, &str) -> Option<ModelMetadata>;

/// The footer's styles under one colour environment: `R`, `B`, `D`, `GRN`, `YLW`, `RED`, `statusText` and
/// `statusSubtle`. With styling off every code is empty and every helper returns its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatusStyle {
    styler: Styler,
}

impl StatusStyle {
    pub const fn new(styler: Styler) -> Self {
        Self { styler }
    }

    fn sgr(self, code: &str) -> String {
        if self.styler.enabled() { format!("\u{1b}[{code}m") } else { String::new() }
    }

    fn rgb(self, r: f64, g: f64, b: f64) -> String {
        if self.styler.enabled() { self.styler.rgb_sgr(r, g, b, false) } else { String::new() }
    }

    /// `R`: reset.
    pub fn reset(self) -> String {
        self.sgr("0")
    }

    /// `B`: bold.
    pub fn bold(self) -> String {
        self.sgr("1")
    }

    /// `D`: the dim grey.
    pub fn dim(self) -> String {
        self.rgb(136.0, 136.0, 136.0)
    }

    /// `GRN`.
    pub fn green(self) -> String {
        self.rgb(0.0, 170.0, 75.0)
    }

    /// `YLW`.
    pub fn yellow(self) -> String {
        self.rgb(255.0, 193.0, 7.0)
    }

    /// `RED`.
    pub fn red(self) -> String {
        self.rgb(220.0, 70.0, 88.0)
    }

    /// `statusText(text)`.
    pub fn status_text(self, text: &str) -> String {
        self.styler.paint(Style::Rgb(198.0, 198.0, 198.0), text)
    }

    /// `statusSubtle(text)`.
    pub fn status_subtle(self, text: &str) -> String {
        self.styler.paint(Style::Rgb(136.0, 136.0, 136.0), text)
    }
}

/// `terminalColumns()` of a terminal that reports `columns` (NaN or absent: unknown): the width floored, else 120.
pub fn terminal_columns(columns: Option<f64>) -> f64 {
    match columns {
        Some(cols) if cols.is_finite() && cols > 0.0 => cols.floor(),
        _ => 120.0,
    }
}

/// `num(v)`: `Number(v)` when finite, else 0.
pub fn num(value: Option<&Value>) -> f64 {
    let n = to_number_of(value);
    if n.is_finite() { n } else { 0.0 }
}

fn finite(n: f64) -> f64 {
    if n.is_finite() { n } else { 0.0 }
}

/// `modelContextWindow(provider, model, explicitContextWindow)`: an explicit window, else the catalog's, else the fallback.
pub fn model_context_window(provider: &str, model: &str, explicit_context_window: f64, lookup: MetadataLookup<'_>) -> f64 {
    let explicit = finite(explicit_context_window);
    if explicit > 0.0 {
        return explicit;
    }
    let meta_window = lookup(model, provider).map_or(0.0, |meta| finite(meta.context_window));
    if meta_window > 0.0 {
        return meta_window;
    }
    FALLBACK_CONTEXT_WINDOW
}

/// The arguments of `formatModelSegment`.
#[derive(Clone, Copy, Debug, Default)]
pub struct ModelSegment<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub fast: bool,
    pub ultra: bool,
    pub cols: f64,
}

/// `formatModelSegment({ provider, model, effort, fast, ultra, cols })`: the model name (shortened for the width), its
/// effort and its speed tier, bold and joined by a dim dot.
pub fn format_model_segment(style: StatusStyle, segment: ModelSegment<'_>, lookup: MetadataLookup<'_>) -> String {
    let (reset, bold) = (style.reset(), style.bold());
    let raw = mixdog_js::js_trim(segment.model);
    let meta = lookup(raw, segment.provider).unwrap_or_default();
    let hint = [&meta.display_name, &meta.display, &meta.name].into_iter().find(|text| !text.is_empty()).map_or("", |text| mixdog_js::js_trim(text));
    let model_name = shorten_model_name(&display_model_name(raw, hint), segment.cols);
    let mut bits = vec![format!("{bold}{model_name}{reset}")];
    if !segment.effort.is_empty() {
        bits.push(format!("{bold}{}{reset}", effort_display_label(segment.effort)));
    }
    if segment.fast {
        bits.push(format!("{bold}{}{reset}", if segment.ultra { "Ultrafast" } else { "Fast" }));
    }
    bits.join(&format!(" {}\u{b7}{reset} ", style.dim()))
}

/// `contextPctDisplayLabel(ctxPct)`: the share for display, clamped to 100 (the raw one still drives the bar and the
/// colour thresholds); `—` for no reading.
pub fn context_pct_display_label(ctx_pct: Option<f64>) -> String {
    let Some(pct) = ctx_pct else { return "\u{2014}".to_owned() };
    if !pct.is_finite() || pct <= 0.0 {
        return "0".to_owned();
    }
    number_to_string(round(pct.min(100.0) * 10.0) / 10.0)
}

fn clamp_pct(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 100.0) } else { 0.0 }
}

fn make_bar(pct: f64, cells: usize) -> String {
    let base = if pct.is_nan() { 0.0 } else { pct };
    let scaled = (base * cells as f64 / 100.0).floor();
    let mut filled = scaled.clamp(0.0, cells as f64) as usize;
    if pct >= 1.0 && filled == 0 {
        filled = 1;
    }
    format!("{}{}", "\u{2593}".repeat(filled), "\u{2591}".repeat(cells - filled))
}

/// `formatContextSegment(ctxPct, cols, source)`: the context share as a coloured bar and label. Below 80 columns the bar
/// is dropped (label only) so the footer never overflows a narrow terminal; from 80 it stays a fixed 14 cells. With no
/// reading the segment says why (`contextMeasurementLabel(source)`).
pub fn format_context_segment(style: StatusStyle, ctx_pct: Option<f64>, cols: f64, source: &str) -> String {
    let Some(raw) = ctx_pct else { return style.status_subtle(context_measurement_label(source)) };
    let pct = if raw.is_finite() { raw.max(0.0) } else { 0.0 };
    let bar_pct = clamp_pct(pct);
    let fill = if pct >= 90.0 {
        style.red()
    } else if pct >= 70.0 {
        style.yellow()
    } else {
        style.green()
    };
    let label = context_pct_display_label(Some(pct));
    let (reset, dim) = (style.reset(), style.dim());
    if cols < 80.0 {
        return format!("{fill}{label}%{reset}");
    }
    let bar = make_bar(bar_pct, 14);
    let filled = bar.replace('\u{2591}', "");
    let empty = bar.replace('\u{2593}', "");
    format!("{fill}{filled}{reset}{dim}{empty}{reset} {label}%")
}

/// `colourPct(p)`: a percentage coloured by its size.
pub fn colour_pct(style: StatusStyle, p: f64) -> String {
    let colour = if p >= 90.0 {
        style.red()
    } else if p >= 70.0 {
        style.yellow()
    } else {
        style.green()
    };
    format!("{colour}{}%{}", number_to_string(p), style.reset())
}

/// `epochMsToHHMM(ms)`: the local `HH:MM` of an epoch time; empty for an invalid one.
pub fn epoch_ms_to_hhmm(ms: f64) -> String {
    match local_fields(ms) {
        Some(fields) => format!("{:02}:{:02}", fields.hour, fields.minute),
        None => String::new(),
    }
}

/// `timeMs(value)`: epoch ms from a number or a date string; 0 when neither parses.
pub fn time_ms(value: Option<&Value>) -> f64 {
    if let Some(Value::Number(n)) = value
        && let Some(n) = n.as_f64()
        && n.is_finite()
        && n > 0.0
    {
        return n;
    }
    let text = if truthy(value) { value.map(value_to_string).unwrap_or_default() } else { String::new() };
    let parsed = date_parse(&text);
    if parsed.is_finite() { parsed } else { 0.0 }
}

/// `fmt(n)`: a human-friendly token count: `1234` is `1.2k`.
pub fn fmt(n: f64) -> String {
    let v = if n.is_nan() { 0.0 } else { n };
    if v < 1000.0 {
        return number_to_string(round(v));
    }
    if v < 1_000_000.0 {
        let k = round(v / 1000.0);
        return if k >= 1000.0 { "1M".to_owned() } else { format!("{}k", number_to_string(k)) };
    }
    format!("{}M", mixdog_js::math::to_fixed(v / 1_000_000.0, 1))
}

/// `fmt(n)` of any value.
pub fn fmt_value(value: Option<&Value>) -> String {
    fmt(value.map_or(f64::NAN, to_number))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: StatusStyle = StatusStyle::new(Styler::new(true, true));
    const OFF: StatusStyle = StatusStyle::new(Styler::new(false, true));

    fn catalog(model: &str, _provider: &str) -> Option<ModelMetadata> {
        match model {
            "gpt-5" => Some(ModelMetadata { context_window: 400_000.0, display_name: "GPT Five".to_owned(), ..ModelMetadata::default() }),
            _ => None,
        }
    }

    #[test]
    fn the_codes_are_empty_without_styling() {
        assert_eq!((OFF.reset(), OFF.bold(), OFF.dim(), OFF.green(), OFF.yellow(), OFF.red()), (String::new(), String::new(), String::new(), String::new(), String::new(), String::new()));
        assert_eq!(OFF.status_text("x"), "x");
        assert_eq!(ON.reset(), "\u{1b}[0m");
        assert_eq!(ON.bold(), "\u{1b}[1m");
        assert_eq!(ON.green(), "\u{1b}[38;2;0;170;75m");
        assert_eq!(ON.dim(), "\u{1b}[38;2;136;136;136m");
        assert_eq!(ON.red(), "\u{1b}[38;2;220;70;88m");
        assert_eq!(ON.yellow(), "\u{1b}[38;2;255;193;7m");
        assert_eq!(ON.status_subtle("x"), "\u{1b}[38;2;136;136;136mx\u{1b}[0m");
    }

    #[test]
    fn the_window_is_explicit_then_catalog_then_fallback() {
        assert_eq!(model_context_window("p", "gpt-5", 123.0, &catalog), 123.0);
        assert_eq!(model_context_window("p", "gpt-5", 0.0, &catalog), 400_000.0);
        assert_eq!(model_context_window("p", "unknown", f64::NAN, &catalog), 200_000.0);
    }

    #[test]
    fn the_model_segment_joins_name_effort_and_speed() {
        let segment = ModelSegment { provider: "openai", model: "gpt-5", effort: "xhigh", fast: true, ultra: false, cols: 200.0 };
        assert_eq!(format_model_segment(OFF, segment, &catalog), "GPT Five \u{b7} XHigh \u{b7} Fast");
        let ultra = ModelSegment { ultra: true, effort: "", ..segment };
        assert_eq!(format_model_segment(OFF, ultra, &catalog), "GPT Five \u{b7} Ultrafast");
        let plain = ModelSegment { model: " claude-sonnet-4-5 ", effort: "", fast: false, ..segment };
        assert_eq!(format_model_segment(OFF, plain, &catalog), "Sonnet 4.5");
        let styled = format_model_segment(ON, ModelSegment { effort: "", fast: false, ..segment }, &catalog);
        assert_eq!(styled, "\u{1b}[1mGPT Five\u{1b}[0m");
    }

    #[test]
    fn the_context_label_clamps_for_display() {
        assert_eq!(context_pct_display_label(None), "\u{2014}");
        assert_eq!(context_pct_display_label(Some(0.0)), "0");
        assert_eq!(context_pct_display_label(Some(f64::NAN)), "0");
        assert_eq!(context_pct_display_label(Some(33.33)), "33.3");
        assert_eq!(context_pct_display_label(Some(250.0)), "100");
    }

    #[test]
    fn the_context_segment_drops_its_bar_when_narrow() {
        assert_eq!(format_context_segment(OFF, Some(50.0), 79.0, "last_api_request"), "50%");
        assert_eq!(format_context_segment(ON, Some(95.0), 40.0, "last_api_request"), "\u{1b}[38;2;220;70;88m95%\u{1b}[0m");
        assert_eq!(format_context_segment(OFF, Some(50.0), 80.0, "last_api_request"), "\u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591} 50%");
        assert_eq!(format_context_segment(OFF, None, 120.0, "unavailable"), "Usage unavailable");
        assert_eq!(format_context_segment(OFF, None, 120.0, "pending"), "Awaiting measurement");
    }

    #[test]
    fn the_context_colour_follows_the_thresholds() {
        let at = |pct: f64| format_context_segment(ON, Some(pct), 20.0, "x");
        assert!(at(69.9).starts_with(&ON.green()));
        assert!(at(70.0).starts_with(&ON.yellow()));
        assert!(at(89.9).starts_with(&ON.yellow()));
        assert!(at(90.0).starts_with(&ON.red()));
        assert_eq!(colour_pct(ON, 95.0), "\u{1b}[38;2;220;70;88m95%\u{1b}[0m");
        assert_eq!(colour_pct(OFF, 12.5), "12.5%");
    }

    #[test]
    fn a_small_share_still_shows_one_cell() {
        let bar = format_context_segment(OFF, Some(1.0), 100.0, "x");
        assert!(bar.starts_with("\u{2593}\u{2591}"));
        let empty = format_context_segment(OFF, Some(0.0), 100.0, "x");
        assert!(empty.starts_with("\u{2591}"));
        let full = format_context_segment(OFF, Some(100.0), 100.0, "x");
        assert!(full.ends_with(" 100%") && !full.contains('\u{2591}'));
    }

    #[test]
    fn numbers_and_columns_normalize() {
        assert_eq!(terminal_columns(Some(100.7)), 100.0);
        assert_eq!(terminal_columns(Some(0.0)), 120.0);
        assert_eq!(terminal_columns(None), 120.0);
        assert_eq!(num(Some(&serde_json::json!("4"))), 4.0);
        assert_eq!(num(Some(&serde_json::json!("x"))), 0.0);
        assert_eq!(num(None), 0.0);
    }

    #[test]
    fn token_counts_are_human_friendly() {
        assert_eq!(fmt(0.0), "0");
        assert_eq!(fmt(999.4), "999");
        assert_eq!(fmt(1234.0), "1k");
        assert_eq!(fmt(999_999.0), "1M");
        assert_eq!(fmt(1_234_567.0), "1.2M");
        assert_eq!(fmt(f64::NAN), "0");
        assert_eq!(fmt_value(Some(&serde_json::json!("2500"))), "3k");
    }

    #[test]
    fn times_parse_from_numbers_and_dates() {
        assert_eq!(time_ms(Some(&serde_json::json!(5))), 5.0);
        assert_eq!(time_ms(Some(&serde_json::json!(-5))), 0.0);
        assert_eq!(time_ms(Some(&serde_json::json!("1970-01-01T00:00:01.000Z"))), 1000.0);
        assert_eq!(time_ms(Some(&serde_json::json!("junk"))), 0.0);
        assert_eq!(time_ms(None), 0.0);
        assert_eq!(epoch_ms_to_hhmm(f64::NAN), "");
        assert_eq!(epoch_ms_to_hhmm(0.0).len(), 5);
    }
}
