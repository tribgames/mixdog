//! How the terminal UI looks, ported from `src/tui/themes/*.mjs`, `theme.mjs`, `figures.mjs`,
//! `statusline-ansi-bridge.mjs`, `runtime/shared/statusline/ansi.mjs`, `spinner-verbs.mjs`, `spinner-meta.mjs` and
//! `time-format.mjs`, and from the colour decisions of `chalk` 5.6 and Ink's `colorize`.
//!
//! * [`palette`] and [`theme`]: the fifteen palettes (generated), the live theme, its version and the OSC 11 text.
//! * [`color`]: the statusline SGR helpers and the colour quantisers; [`color_level`]: the level chalk decides from the
//!   environment and the bytes Ink's `<Text color>` writes at each level.
//! * [`figures`], [`bridge`], [`spinner_verbs`], [`spinner_meta`], [`time_format`]: the rest of the Node modules.
//!
//! Reading and persisting `ui.theme` is not done here: the app reads it through the core (`config/getTheme`) and
//! writes it through `config/setTheme`, so the core stays the one owner of `mixdog-config.json`.

pub mod bridge;
pub mod color;
pub mod color_level;
pub mod figures;
pub mod palette;
pub mod spinner_meta;
pub mod spinner_verbs;
pub mod theme;
pub mod time_format;

pub use palette::Key;
pub use theme::{
    Color, Palette, ThemeEntry, ThemeInfo, ThemeSelection, get_theme_setting, get_theme_version, list_themes,
    osc_background_sequence, set_theme, terminal_background_sequence, current_palette, theme_color,
};
