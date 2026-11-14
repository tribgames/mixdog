//! Terminal text measuring: how many cells a string occupies, the way the TUI's JavaScript measured it
//! (string-width 8.3.0 over get-east-asian-width 1.6.0, the Windows ambiguous-width policy of
//! `src/tui/display-width.mjs`, strip-ansi 7.2.0), plus the grapheme and UTF-16 offset helpers the editor and the
//! renderer need. `ansi`, `wrap`, `slice`, `truncate` and `spans` declare the interfaces the ANSI-aware wrapping
//! task fills in.

pub mod ansi;
pub mod grapheme;
pub mod policy;
pub mod slice;
pub mod spans;
pub mod strip;
pub mod truncate;
pub mod width;
pub mod width_tables;
pub mod wrap;

pub use policy::{display_width, display_width_with};
pub use strip::strip_ansi;
pub use width::{StringWidthOptions, string_width};
