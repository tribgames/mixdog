//! The colour level Ink applies to every `<Text color>` and `<Box backgroundColor>`, and what it writes at each level.
//!
//! Ink paints through `node_modules/ink/build/colorize.js` on the default chalk 5.6.2 instance, whose level comes from
//! chalk's vendored `supports-color` ([`ColorEnvironment::level`]: `FORCE_COLOR`, the `--color` flags, `TERM=dumb`, a
//! stream that is not a terminal, the Windows build number, CI vendors, `COLORTERM`, `TERM_PROGRAM`, the `TERM` name)
//! and from the `ansi-styles` downgrade of a hex or RGB colour to the 256-colour and 16-colour palettes
//! ([`ink_colorize`]). The markdown and highlight path keeps level 3 (`new Chalk({ level: 3 })`) and the statusline
//! helpers keep their own rules ([`crate::color::Styler`]); this module is the single place that decides the level of
//! the widget painter.
//!
//! A level is the number chalk reports: 0 plain, 1 sixteen colours, 2 256 colours, 3 truecolor. `FORCE_COLOR=-1` makes
//! chalk report -1, which paints like 0, so the level is an `i32`.

use std::collections::BTreeMap;

use mixdog_js::math::round;
use mixdog_js::{is_js_space, js_trim_start, number_to_string, string_to_number};

use crate::color::chalk_wrap;

/// What `supports-color` reads: the environment variables, the process arguments, the Windows release string (`Some`
/// exactly when the platform is Windows: `os.release()`, such as `10.0.26300`) and whether the stream is a terminal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ColorEnvironment {
    pub vars: BTreeMap<String, String>,
    pub argv: Vec<String>,
    pub windows_release: Option<String>,
    pub stream_is_terminal: bool,
}

impl ColorEnvironment {
    /// The process's environment and arguments. Names are upper-cased on Windows, where `process.env` ignores case.
    /// The caller supplies what the standard library cannot: the Windows release string and whether stdout is a terminal.
    pub fn from_process(stream_is_terminal: bool, windows_release: Option<String>) -> Self {
        let vars = std::env::vars_os()
            .filter_map(|(name, value)| {
                let (name, value) = (name.into_string().ok()?, value.into_string().ok()?);
                Some((if cfg!(windows) { name.to_uppercase() } else { name }, value))
            })
            .collect();
        Self { vars, argv: std::env::args().collect(), windows_release, stream_is_terminal }
    }

    fn var(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    fn has(&self, name: &str) -> bool {
        self.vars.contains_key(name)
    }

    /// `hasFlag`: the flag is in the arguments before a `--` terminator.
    fn has_flag(&self, flag: &str) -> bool {
        let prefix = if flag.starts_with('-') {
            ""
        } else if flag.chars().count() == 1 {
            "-"
        } else {
            "--"
        };
        let wanted = format!("{prefix}{flag}");
        let position = self.argv.iter().position(|arg| *arg == wanted);
        let terminator = self.argv.iter().position(|arg| arg == "--");
        position.is_some_and(|at| terminator.is_none_or(|end| at < end))
    }

    /// `createSupportsColor(stream).level` (0 when colour is not supported).
    pub fn level(&self) -> i32 {
        let mut force = if ["no-color", "no-colors", "color=false", "color=never"].iter().any(|flag| self.has_flag(flag)) {
            Force::Level(0)
        } else if ["color", "colors", "color=true", "color=always"].iter().any(|flag| self.has_flag(flag)) {
            Force::Level(1)
        } else {
            Force::Unset
        };
        if let Some(value) = self.var("FORCE_COLOR") {
            force = match value {
                "true" => Force::Level(1),
                "false" => Force::Level(0),
                "" => Force::Level(1),
                other => parse_int(other).map_or(Force::Nan, |n| Force::Level(n.min(3))),
            };
        }

        if force == Force::Level(0) {
            return 0;
        }
        if ["color=16m", "color=full", "color=truecolor"].iter().any(|flag| self.has_flag(flag)) {
            return 3;
        }
        if self.has_flag("color=256") {
            return 2;
        }
        // Azure DevOps pipelines, above the terminal check.
        if self.has("TF_BUILD") && self.has("AGENT_NAME") {
            return 1;
        }
        if !self.stream_is_terminal && force == Force::Unset {
            return 0;
        }
        let min = match force {
            Force::Level(level) => level,
            Force::Nan | Force::Unset => 0,
        };

        let term = self.var("TERM");
        if term == Some("dumb") {
            return min;
        }
        if let Some(release) = &self.windows_release {
            // Build 10586 is the first Windows release with 256 colours, build 14931 the first with truecolor.
            let mut parts = release.split('.');
            let major = number_of(parts.next());
            let build = number_of(parts.nth(1));
            if major >= 10.0 && build >= 10_586.0 {
                return if build >= 14_931.0 { 3 } else { 2 };
            }
            return 1;
        }
        if self.has("CI") {
            if ["GITHUB_ACTIONS", "GITEA_ACTIONS", "CIRCLECI"].iter().any(|key| self.has(key)) {
                return 3;
            }
            if ["TRAVIS", "APPVEYOR", "GITLAB_CI", "BUILDKITE", "DRONE"].iter().any(|key| self.has(key))
                || self.var("CI_NAME") == Some("codeship")
            {
                return 1;
            }
            return min;
        }
        if let Some(version) = self.var("TEAMCITY_VERSION") {
            return i32::from(teamcity_supports_color(version));
        }
        if self.var("COLORTERM") == Some("truecolor") || matches!(term, Some("xterm-kitty" | "xterm-ghostty" | "wezterm")) {
            return 3;
        }
        if let Some(program) = self.var("TERM_PROGRAM") {
            let version = parse_int(self.var("TERM_PROGRAM_VERSION").unwrap_or("").split('.').next().unwrap_or(""));
            match program {
                "iTerm.app" => return if version.is_some_and(|v| v >= 3) { 3 } else { 2 },
                "Apple_Terminal" => return 2,
                _ => {}
            }
        }
        // `env.TERM` is tested as text: an unset variable reads "undefined", which matches neither pattern.
        let term_name = term.unwrap_or("undefined").to_lowercase();
        if term_name.ends_with("-256") || term_name.ends_with("-256color") {
            return 2;
        }
        let starts = ["screen", "xterm", "vt100", "vt220", "rxvt"].iter().any(|prefix| term_name.starts_with(prefix));
        if starts || ["color", "ansi", "cygwin", "linux"].iter().any(|word| term_name.contains(word)) {
            return 1;
        }
        if self.has("COLORTERM") {
            return 1;
        }
        min
    }
}

/// `forceColor` of `supports-color`: not given, given but not a number (`parseInt` NaN), or a level.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Force {
    Unset,
    Nan,
    Level(i32),
}

/// `Number(part)` of a split part that may be absent (`undefined`, NaN).
fn number_of(part: Option<&str>) -> f64 {
    part.map_or(f64::NAN, string_to_number)
}

/// `Number.parseInt(text, 10)` as an integer, `None` for NaN; a magnitude beyond `i32` saturates (it only ever feeds a
/// `min(.., 3)` or a `>= 3`).
fn parse_int(text: &str) -> Option<i32> {
    let text = js_trim_start(text);
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let run: &str = &digits[..digits.bytes().take_while(u8::is_ascii_digit).count()];
    if run.is_empty() {
        return None;
    }
    let magnitude = run.parse::<i64>().unwrap_or(i64::MAX).min(i64::from(i32::MAX)) as i32;
    Some(if negative { -magnitude } else { magnitude })
}

/// `/^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(version)`.
fn teamcity_supports_color(version: &str) -> bool {
    let digits = |text: &str| text.bytes().take_while(u8::is_ascii_digit).count();
    if let Some(rest) = version.strip_prefix("9.") {
        let run = digits(rest);
        if rest[..run].bytes().any(|c| c != b'0') && rest[run..].starts_with('.') {
            return true;
        }
    }
    let run = digits(version);
    run >= 2 && version[run..].starts_with('.')
}

// ---- what Ink writes ------------------------------------------------------------------------------------------------

/// `ansiStyles.rgbToAnsi256`: chalk's own quantiser (an extended grey ramp except for black and white, a 6x6x6 cube
/// otherwise); not the statusline's [`crate::color::rgb_to_ansi256`].
fn chalk_rgb_to_ansi256(red: f64, green: f64, blue: f64) -> f64 {
    if red == green && green == blue {
        if red < 8.0 {
            return 16.0;
        }
        if red > 248.0 {
            return 231.0;
        }
        return round(((red - 8.0) / 247.0) * 24.0) + 232.0;
    }
    16.0 + 36.0 * round(red / 255.0 * 5.0) + 6.0 * round(green / 255.0 * 5.0) + round(blue / 255.0 * 5.0)
}

/// `ansiStyles.ansi256ToAnsi`: the 16-colour SGR code nearest a 256-colour index.
fn ansi256_to_ansi(code: f64) -> f64 {
    if code < 8.0 {
        return 30.0 + code;
    }
    if code < 16.0 {
        return 90.0 + (code - 8.0);
    }
    let (red, green, blue) = if code >= 232.0 {
        let grey = (((code - 232.0) * 10.0) + 8.0) / 255.0;
        (grey, grey, grey)
    } else {
        let code = code - 16.0;
        let remainder = code % 36.0;
        ((code / 36.0).floor() / 5.0, (remainder / 6.0).floor() / 5.0, (remainder % 6.0) / 5.0)
    };
    let value = red.max(green).max(blue) * 2.0;
    if value == 0.0 {
        return 30.0;
    }
    let bits = ((round(blue) as i32) << 2) | ((round(green) as i32) << 1) | (round(red) as i32);
    let mut result = 30.0 + f64::from(bits);
    if value == 2.0 {
        result += 60.0;
    }
    result
}

/// `ansiStyles.hexToRgb(hex)`: the first run of six hexadecimal digits, or of three (doubled) when no six are there;
/// black when there is none.
fn hex_to_rgb(text: &str) -> [f64; 3] {
    let chars: Vec<char> = text.chars().collect();
    let hex_run = |at: usize, len: usize| at + len <= chars.len() && chars[at..at + len].iter().all(char::is_ascii_hexdigit);
    for at in 0..chars.len() {
        let digits: Option<String> = if hex_run(at, 6) {
            Some(chars[at..at + 6].iter().collect())
        } else if hex_run(at, 3) {
            Some(chars[at..at + 3].iter().flat_map(|c| [*c, *c]).collect())
        } else {
            None
        };
        if let Some(digits) = digits {
            let integer = u32::from_str_radix(&digits, 16).unwrap_or(0);
            return [f64::from((integer >> 16) & 0xff), f64::from((integer >> 8) & 0xff), f64::from(integer & 0xff)];
        }
    }
    [0.0, 0.0, 0.0]
}

/// Open and close codes of a named style, the foreground name or the `bg` name.
struct Named {
    open: u8,
    close: u8,
    background: bool,
}

/// Foreground and modifier names of `ansiStyles`, and the `bg` names (usable as a foreground name too).
fn named_style(name: &str) -> Option<Named> {
    let plain = |open, close| Some(Named { open, close, background: false });
    let colour = |code: u8| Some(Named { open: code, close: 39, background: false });
    let ground = |code: u8| Some(Named { open: code, close: 49, background: true });
    match name {
        "reset" => plain(0, 0),
        "bold" => plain(1, 22),
        "dim" => plain(2, 22),
        "italic" => plain(3, 23),
        "underline" => plain(4, 24),
        "overline" => plain(53, 55),
        "inverse" => plain(7, 27),
        "hidden" => plain(8, 28),
        "strikethrough" => plain(9, 29),
        "black" => colour(30),
        "red" => colour(31),
        "green" => colour(32),
        "yellow" => colour(33),
        "blue" => colour(34),
        "magenta" => colour(35),
        "cyan" => colour(36),
        "white" => colour(37),
        "blackBright" | "gray" | "grey" => colour(90),
        "redBright" => colour(91),
        "greenBright" => colour(92),
        "yellowBright" => colour(93),
        "blueBright" => colour(94),
        "magentaBright" => colour(95),
        "cyanBright" => colour(96),
        "whiteBright" => colour(97),
        "bgBlack" => ground(40),
        "bgRed" => ground(41),
        "bgGreen" => ground(42),
        "bgYellow" => ground(43),
        "bgBlue" => ground(44),
        "bgMagenta" => ground(45),
        "bgCyan" => ground(46),
        "bgWhite" => ground(47),
        "bgBlackBright" | "bgGray" | "bgGrey" => ground(100),
        "bgRedBright" => ground(101),
        "bgGreenBright" => ground(102),
        "bgYellowBright" => ground(103),
        "bgBlueBright" => ground(104),
        "bgMagentaBright" => ground(105),
        "bgCyanBright" => ground(106),
        "bgWhiteBright" => ground(107),
        _ => None,
    }
}

/// Names that are members of the chalk instance but not styles: `colorize` calls them and gets a builder function (or
/// fails on a missing `bg` method), never a string.
fn is_builder_name(name: &str) -> bool {
    matches!(name, "rgb" | "hex" | "ansi256" | "bgRgb" | "bgHex" | "bgAnsi256")
}

/// `^name\(\s?(\d+)(,\s?(\d+),\s?(\d+))?\s?\)$` of Ink: the numbers of `rgb(...)` (three) or `ansi256(...)` (one), each
/// as the `Number` of its digits.
fn call_numbers(color: &str, name: &str, count: usize) -> Option<Vec<f64>> {
    let rest = color.strip_prefix(name)?.strip_prefix('(')?;
    let mut chars = rest.chars().peekable();
    let skip_space = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
        if chars.peek().is_some_and(|c| is_js_space(*c)) {
            chars.next();
        }
    };
    let mut numbers = Vec::new();
    skip_space(&mut chars);
    for at in 0..count {
        if at > 0 {
            if chars.next() != Some(',') {
                return None;
            }
            skip_space(&mut chars);
        }
        let mut digits = String::new();
        while let Some(c) = chars.next_if(char::is_ascii_digit) {
            digits.push(c);
        }
        if digits.is_empty() {
            return None;
        }
        numbers.push(string_to_number(&digits));
    }
    skip_space(&mut chars);
    (chars.next() == Some(')') && chars.next().is_none()).then_some(numbers)
}

/// The SGR parameter string (`38;2;r;g;b`, `38;5;n` or a 16-colour code) of an RGB colour at a level.
fn rgb_parameters(red: f64, green: f64, blue: f64, background: bool, level: i32) -> String {
    let base = if background { 48 } else { 38 };
    if level >= 3 {
        return format!("{base};2;{};{};{}", number_to_string(red), number_to_string(green), number_to_string(blue));
    }
    let index = chalk_rgb_to_ansi256(red, green, blue);
    if level == 2 {
        return format!("{base};5;{}", number_to_string(index));
    }
    number_to_string(ansi256_to_ansi(index) + if background { 10.0 } else { 0.0 })
}

/// `colorize(text, color, type)` of Ink at a chalk level: the text for a `<Text color>` (`background` false) or a
/// `<Box backgroundColor>` (`background` true).
///
/// A colour is a style name of chalk (`red`, `bold`, `bgRed`, ...), `#rgb` / `#rrggbb`, `rgb(r,g,b)` or `ansi256(n)`;
/// anything else, and an `rgb(..)` / `ansi256(..)` that does not parse, leaves the text unchanged. At level 0 nothing
/// is written. `None` is the case where Ink's call does not return a string: the names `rgb`, `hex`, `ansi256` and their
/// `bg` forms return a builder function, a modifier name as a background has no method and throws. (The other members
/// of a JavaScript function, such as `call`, are not modelled.)
pub fn ink_colorize(text: &str, color: &str, background: bool, level: i32) -> Option<String> {
    if color.is_empty() {
        return Some(text.to_owned());
    }
    let closing = if background { "\x1b[49m" } else { "\x1b[39m" };
    let wrap = |parameters: &str| {
        if level <= 0 { text.to_owned() } else { chalk_wrap(text, &format!("\x1b[{parameters}m"), closing) }
    };

    if color == "visible" {
        // `chalk.visible` is a builder with no style: empty at level 0, the text unchanged otherwise.
        return if background { None } else { Some(if level <= 0 { String::new() } else { text.to_owned() }) };
    }
    if is_builder_name(color) {
        return None;
    }
    if let Some(named) = named_style(color) {
        if background {
            // `bg` + the capitalised name: only a plain colour name has one.
            return if named.background || named.close != 39 { None } else { Some(wrap(&(named.open + 10).to_string())) };
        }
        if level <= 0 {
            return Some(text.to_owned());
        }
        return Some(chalk_wrap(text, &format!("\x1b[{}m", named.open), &format!("\x1b[{}m", named.close)));
    }
    if color.starts_with('#') {
        let [red, green, blue] = hex_to_rgb(color);
        return Some(wrap(&rgb_parameters(red, green, blue, background, level)));
    }
    if color.starts_with("ansi256") {
        return Some(match call_numbers(color, "ansi256", 1) {
            Some(values) => wrap(&format!("{};5;{}", if background { 48 } else { 38 }, number_to_string(values[0]))),
            None => text.to_owned(),
        });
    }
    if color.starts_with("rgb") {
        return Some(match call_numbers(color, "rgb", 3) {
            Some(values) => wrap(&rgb_parameters(values[0], values[1], values[2], background, level)),
            None => text.to_owned(),
        });
    }
    Some(text.to_owned())
}
