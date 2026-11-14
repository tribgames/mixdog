//! SGR colour helpers: the statusline styles of `src/runtime/shared/statusline/ansi.mjs` (re-exported by
//! `src/ui/ansi.mjs`), its colour quantiser, and the chalk 5 level-3 open/close codes the formatters of the other
//! crates write, so every crate emits the same bytes.

use std::io::IsTerminal;
use std::sync::OnceLock;

use mixdog_js::math::round;
use mixdog_js::{js_trim, number_to_string, utf16_len};

const ESC: &str = "\x1b[";
const RESET: &str = "\x1b[0m";

// ---- chalk 5, level 3 ---------------------------------------------------------------------------------------------

/// Closes a foreground colour.
pub const FG_CLOSE: &str = "\x1b[39m";
/// Closes a background colour.
pub const BG_CLOSE: &str = "\x1b[49m";
/// Bold on.
pub const BOLD_OPEN: &str = "\x1b[1m";
/// Bold off.
pub const BOLD_CLOSE: &str = "\x1b[22m";
/// Dim on.
pub const DIM_OPEN: &str = "\x1b[2m";
/// Dim off.
pub const DIM_CLOSE: &str = "\x1b[22m";
/// Italic on.
pub const ITALIC_OPEN: &str = "\x1b[3m";
/// Italic off.
pub const ITALIC_CLOSE: &str = "\x1b[23m";
/// Underline on.
pub const UNDERLINE_OPEN: &str = "\x1b[4m";
/// Underline off.
pub const UNDERLINE_CLOSE: &str = "\x1b[24m";
/// Inverse on.
pub const INVERSE_OPEN: &str = "\x1b[7m";
/// Inverse off.
pub const INVERSE_CLOSE: &str = "\x1b[27m";
/// Strikethrough on.
pub const STRIKE_OPEN: &str = "\x1b[9m";
/// Strikethrough off.
pub const STRIKE_CLOSE: &str = "\x1b[29m";

/// `chalk.rgb(r, g, b)`'s open code at level 3.
pub fn fg_rgb(r: u8, g: u8, b: u8) -> String {
    format!("\x1b[38;2;{r};{g};{b}m")
}

/// `chalk.bgRgb(r, g, b)`'s open code at level 3.
pub fn bg_rgb(r: u8, g: u8, b: u8) -> String {
    format!("\x1b[48;2;{r};{g};{b}m")
}

/// chalk's `applyStyle` for one style: an empty text stays empty; a text that already holds the close code is
/// re-opened after it (otherwise only the part up to that code would be coloured); every line break is wrapped in a
/// close and a re-open, a `\r\n` pair as a unit, so the colour does not bleed past the line end; then open + text +
/// close.
pub fn chalk_wrap(text: &str, open: &str, close: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut text = text.to_owned();
    if text.contains('\u{1b}') {
        text = text.replace(close, &format!("{close}{open}"));
    }
    if let Some(first) = text.find('\n') {
        let mut out = String::with_capacity(text.len() + 16);
        let mut end = 0;
        let mut at = Some(first);
        while let Some(index) = at {
            let carriage = index > 0 && text.as_bytes()[index - 1] == b'\r';
            out.push_str(&text[end..if carriage { index - 1 } else { index }]);
            out.push_str(close);
            out.push_str(if carriage { "\r\n" } else { "\n" });
            out.push_str(open);
            end = index + 1;
            at = text[end..].find('\n').map(|found| found + end);
        }
        out.push_str(&text[end..]);
        text = out;
    }
    format!("{open}{text}{close}")
}

// ---- the statusline helpers ---------------------------------------------------------------------------------------

const CUBE_LEVELS: [f64; 6] = [0.0, 95.0, 135.0, 175.0, 215.0, 255.0];

/// `colorByte`: a finite number rounded and clamped to 0-255, anything else 0.
fn color_byte(value: f64) -> f64 {
    if value.is_finite() { round(value).clamp(0.0, 255.0) } else { 0.0 }
}

fn nearest_cube_level(value: f64) -> usize {
    let mut best = 0;
    let mut best_distance = f64::INFINITY;
    for (at, level) in CUBE_LEVELS.iter().enumerate() {
        let distance = (value - level).abs();
        if distance < best_distance {
            best = at;
            best_distance = distance;
        }
    }
    best
}

/// `rgbToAnsi256`: the nearest entry of the stable xterm 256-colour palette (cube or grey ramp) for an RGB triplet.
/// Each channel is rounded and clamped like `colorByte`; a value that is not finite counts as 0.
pub fn rgb_to_ansi256(r: f64, g: f64, b: f64) -> u8 {
    let (red, green, blue) = (color_byte(r), color_byte(g), color_byte(b));
    let (red_level, green_level, blue_level) = (nearest_cube_level(red), nearest_cube_level(green), nearest_cube_level(blue));
    let (cube_red, cube_green, cube_blue) = (CUBE_LEVELS[red_level], CUBE_LEVELS[green_level], CUBE_LEVELS[blue_level]);
    let cube_distance = (red - cube_red).powi(2) + (green - cube_green).powi(2) + (blue - cube_blue).powi(2);

    let average = (red + green + blue) / 3.0;
    let gray_level = round((average - 8.0) / 10.0).clamp(0.0, 23.0);
    let gray_value = 8.0 + gray_level * 10.0;
    let gray_distance = (red - gray_value).powi(2) + (green - gray_value).powi(2) + (blue - gray_value).powi(2);

    if gray_distance < cube_distance {
        return 232 + gray_level as u8;
    }
    (16 + 36 * red_level + 6 * green_level + blue_level) as u8
}

/// A statusline style: one of the named helpers of `ansi.mjs`, or a foreground truecolor (`rgb(r, g, b)`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Style {
    Bold,
    Dim,
    Italic,
    Underline,
    Inverse,
    Strike,
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
    /// `gray` and `grey`.
    Gray,
    BrightGreen,
    Rgb(f64, f64, f64),
}

/// What a style opens with: a plain SGR parameter string, or a foreground truecolor that falls back to 256 colours.
enum Open {
    Plain(&'static str),
    Foreground(f64, f64, f64),
}

impl Style {
    fn open(self) -> Open {
        match self {
            Style::Bold => Open::Plain("1"),
            Style::Dim => Open::Foreground(136.0, 136.0, 136.0),
            Style::Italic => Open::Plain("3"),
            Style::Underline => Open::Plain("4"),
            Style::Inverse => Open::Plain("7"),
            Style::Strike => Open::Plain("9"),
            Style::Black => Open::Plain("30"),
            Style::Red => Open::Foreground(220.0, 70.0, 88.0),
            Style::Green => Open::Foreground(0.0, 170.0, 75.0),
            Style::Yellow => Open::Foreground(255.0, 193.0, 7.0),
            Style::Blue => Open::Foreground(77.0, 159.0, 255.0),
            Style::Magenta => Open::Foreground(177.0, 133.0, 219.0),
            Style::Cyan => Open::Foreground(136.0, 136.0, 136.0),
            Style::White | Style::Gray => Open::Foreground(198.0, 198.0, 198.0),
            Style::BrightGreen => Open::Foreground(0.0, 185.0, 88.0),
            Style::Rgb(r, g, b) => Open::Foreground(r, g, b),
        }
    }
}

/// The statusline helpers under one environment: whether styling is on, and whether the terminal renders 24-bit colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Styler {
    enabled: bool,
    truecolor: bool,
}

impl Styler {
    pub const fn new(enabled: bool, truecolor: bool) -> Self {
        Self { enabled, truecolor }
    }

    /// Reads the decisions `ansi.mjs` makes: styling is off when `NO_COLOR` is set and not empty; `FORCE_COLOR` set
    /// to anything but `0` or the empty string turns it on; otherwise it follows whether stdout is a terminal.
    /// Truecolor is assumed unless `TERM_PROGRAM` is Apple Terminal (it advertises xterm and has no 24-bit colour).
    pub fn from_environment(var: &dyn Fn(&str) -> Option<String>, stdout_is_terminal: bool) -> Self {
        let enabled = if var("NO_COLOR").is_some_and(|value| !value.is_empty()) {
            false
        } else if var("FORCE_COLOR").is_some_and(|value| value != "0" && !value.is_empty()) {
            true
        } else {
            stdout_is_terminal
        };
        let program = var("TERM_PROGRAM").unwrap_or_default();
        Self { enabled, truecolor: js_trim(&program).to_lowercase() != "apple_terminal" }
    }

    /// The process's own environment, read once (`ansi.mjs` decided at import).
    pub fn process() -> Self {
        static PROCESS: OnceLock<Styler> = OnceLock::new();
        *PROCESS.get_or_init(|| Self::from_environment(&|name| std::env::var(name).ok(), std::io::stdout().is_terminal()))
    }

    /// `colorEnabled()`.
    pub const fn enabled(self) -> bool {
        self.enabled
    }

    /// `supportsTruecolor()`.
    pub const fn truecolor(self) -> bool {
        self.truecolor
    }

    /// `rgbSgr(r, g, b, background)`: the raw RGB SGR prefix, downsampled to 256 colours without truecolor.
    pub fn rgb_sgr(self, r: f64, g: f64, b: f64, background: bool) -> String {
        let channel = if background { 48 } else { 38 };
        if self.truecolor {
            return format!("{ESC}{channel};2;{};{};{}m", number_to_string(r), number_to_string(g), number_to_string(b));
        }
        format!("{ESC}{channel};5;{}m", rgb_to_ansi256(r, g, b))
    }

    /// A style's helper applied to a text: unchanged when styling is off, otherwise wrapped in the open code and a
    /// reset, the open code repeated after every reset inside the text so composed styles survive concatenation.
    pub fn paint(self, style: Style, text: &str) -> String {
        if !self.enabled {
            return text.to_owned();
        }
        let open = match style.open() {
            Open::Plain(code) => format!("{ESC}{code}m"),
            Open::Foreground(r, g, b) if self.truecolor => {
                format!("{ESC}38;2;{};{};{}m", number_to_string(r), number_to_string(g), number_to_string(b))
            }
            Open::Foreground(r, g, b) => format!("{ESC}38;5;{}m", rgb_to_ansi256(r, g, b)),
        };
        format!("{open}{}{RESET}", text.replace(RESET, &format!("{RESET}{open}")))
    }

    /// `compose(a, b, ...)(text)`: the styles applied right to left, so `compose(bold, red)` is `bold(red(text))`.
    pub fn compose(self, styles: &[Style], text: &str) -> String {
        styles.iter().rev().fold(text.to_owned(), |acc, style| self.paint(*style, &acc))
    }
}

/// `stripAnsi`: every SGR escape removed.
pub fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == 0x1b && bytes.get(at + 1) == Some(&b'[') {
            let mut end = at + 2;
            while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b';') {
                end += 1;
            }
            if bytes.get(end) == Some(&b'm') {
                out.push_str(&text[copied..at]);
                at = end + 1;
                copied = at;
                continue;
            }
        }
        at += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// `visibleWidth`: the length in UTF-16 code units of the text without its SGR escapes (an approximation of one
/// column per code unit; the cell width of a glyph is `mixdog-termtext`'s business).
pub fn visible_width(text: &str) -> usize {
    utf16_len(&strip_ansi(text))
}
