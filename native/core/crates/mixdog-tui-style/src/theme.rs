//! The active-theme runtime (`src/tui/theme.mjs`): the live palette, the switch with Node's id normalisation, the
//! monotonic theme version that caches key on, and the OSC 11 text that paints the terminal background.
//!
//! The palette type and the registry are in [`crate::palette`] (generated); the glyph constants of `theme.mjs` are here.
//! `theme.mjs` also wrote OSC 11 on every switch when stdout was a terminal and persisted `ui.theme`; here
//! [`set_theme`] only switches, the app writes [`terminal_background_sequence`] when it owns a terminal and stores the
//! setting through the core.

use std::ops::Index;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, PoisonError, RwLock};

use mixdog_js::{is_js_space, js_trim, string_to_number};
use serde::Serialize;

use crate::figures::{BLACK_CIRCLE, LEFT_ARROW, RIGHT_ARROW};
use crate::palette::{DEFAULT_THEME_ID, KEY_COUNT, Key, THEME_ALIASES, THEMES};

/// A palette value: the `rgb(r,g,b)` strings of the Node palettes and `transparent`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Color {
    Rgb(u8, u8, u8),
    Transparent,
}

impl Color {
    /// The string Ink takes on `color` / `backgroundColor`: `rgb(r,g,b)` or `transparent`.
    pub fn css(self) -> String {
        match self {
            Color::Rgb(r, g, b) => format!("rgb({r},{g},{b})"),
            Color::Transparent => "transparent".to_owned(),
        }
    }
}

/// One complete palette: every key of the base (One Dark) carries a value, so no key leaks across a switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette(pub [Color; KEY_COUNT]);

impl Index<Key> for Palette {
    type Output = Color;

    fn index(&self, key: Key) -> &Color {
        &self.0[key as usize]
    }
}

/// A registry entry: `{ id, label, description, palette }`.
#[derive(Clone, Copy, Debug)]
pub struct ThemeEntry {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub palette: Palette,
}

/// Picker-ready metadata of one theme (`listThemes`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ThemeInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub current: bool,
}

/// What a switch applied (`setThemeSetting`'s return).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ThemeSelection {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

/// The index in [`THEMES`] of the live theme. Seeded with the default theme (`basicPalette`).
static ACTIVE: LazyLock<RwLock<usize>> = LazyLock::new(|| RwLock::new(index_of(DEFAULT_THEME_ID).unwrap_or(0)));

/// Bumped on every switch: the cache key of the markdown and highlight caches.
static VERSION: AtomicU64 = AtomicU64::new(0);

fn index_of(id: &str) -> Option<usize> {
    THEMES.iter().position(|entry| entry.id == id)
}

/// `resolveThemeId`: trims the text, follows an alias, and falls back to the default for an unknown id.
fn resolve_index(id: &str) -> usize {
    let key = js_trim(id);
    let aliased = THEME_ALIASES.iter().find(|(alias, _)| *alias == key).and_then(|(_, target)| index_of(target));
    aliased.or_else(|| index_of(key)).or_else(|| index_of(DEFAULT_THEME_ID)).unwrap_or(0)
}

/// The theme version: a monotonic counter bumped on every switch (`getThemeVersion`).
pub fn get_theme_version() -> u64 {
    VERSION.load(Ordering::SeqCst)
}

/// The active theme id (`getThemeSetting`).
pub fn get_theme_setting() -> &'static str {
    THEMES[*ACTIVE.read().unwrap_or_else(PoisonError::into_inner)].id
}

/// The live palette (the Node `theme` object): a copy, so a switch while it is held changes nothing under the reader.
pub fn current_palette() -> Palette {
    THEMES[*ACTIVE.read().unwrap_or_else(PoisonError::into_inner)].palette
}

/// One key of the live palette (`theme.statusText`).
pub fn theme_color(key: Key) -> Color {
    current_palette()[key]
}

/// Every theme in display order, with the live one marked (`listThemes`).
pub fn list_themes() -> Vec<ThemeInfo> {
    let active = *ACTIVE.read().unwrap_or_else(PoisonError::into_inner);
    THEMES
        .iter()
        .enumerate()
        .map(|(at, entry)| ThemeInfo { id: entry.id, label: entry.label, description: entry.description, current: at == active })
        .collect()
}

/// Applies a theme by id (`setThemeSetting` without persistence). An unknown id falls back to the default without an
/// error. Every call bumps the version, also when the theme does not change, as `applyPalette` did.
pub fn set_theme(id: &str) -> ThemeSelection {
    let index = resolve_index(id);
    let mut active = ACTIVE.write().unwrap_or_else(PoisonError::into_inner);
    *active = index;
    VERSION.fetch_add(1, Ordering::SeqCst);
    let entry = &THEMES[index];
    ThemeSelection { id: entry.id, label: entry.label, description: entry.description }
}

/// `emitTerminalBackground`'s text for a palette value in the Node string form: OSC 11 with the colour for
/// `rgb(r,g,b)` (white space anywhere is ignored, each channel clamped to 0-255 and doubled to 16 bits), OSC 111
/// (reset to the terminal's own background) for anything else, `transparent` included.
pub fn osc_background_sequence(value: &str) -> String {
    let compact: String = value.chars().filter(|c| !is_js_space(*c)).collect();
    let channels = compact.strip_prefix("rgb(").and_then(|rest| rest.strip_suffix(')')).and_then(|inner| {
        let mut parts = inner.split(',');
        let (r, g, b) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || ![r, g, b].iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())) {
            return None;
        }
        Some([r, g, b].map(|p| string_to_number(p).clamp(0.0, 255.0) as u8))
    });
    match channels {
        Some([r, g, b]) => format!("\x1b]11;rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}\x07"),
        None => "\x1b]111\x07".to_owned(),
    }
}

/// The text `emitTerminalBackground(theme.background)` writes for a palette: OSC 11 with the palette's background, or
/// OSC 111 when the theme leaves the background transparent. The caller writes it when it owns a terminal.
pub fn terminal_background_sequence(palette: &Palette) -> String {
    osc_background_sequence(&palette[Key::Background].css())
}

/// Turn marker: `BLACK_CIRCLE`.
pub const TURN_MARKER: &str = BLACK_CIRCLE;
/// Agent call marker: `←` (a request going out to a sub-agent).
pub const AGENT_CALL_MARKER: &str = LEFT_ARROW;
/// Agent response marker: `→` (a result coming back into the transcript).
pub const AGENT_RESPONSE_MARKER: &str = RIGHT_ARROW;
/// Result-tree gutter: `└` with a two-column hanging indent.
pub const RESULT_GUTTER: &str = "  \u{2514}  ";
/// Continuation rail of every result row after the first: `│` at the same hanging indent.
pub const RESULT_GUTTER_CONT: &str = "  \u{2502}  ";
