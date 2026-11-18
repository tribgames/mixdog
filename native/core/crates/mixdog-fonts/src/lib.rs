//! Integration status: metadata and immutable registration are verified independently.
//! Measurement still awaits the exact text kernel and strict all-metric reference replay;
//! the historical relaxed twin is not activation evidence.
//!
//! The font half of `@napi-rs/canvas` (`GlobalFonts` and `measureText`) and of fontkit, in Rust.
//!
//! * [`face`] reads a ttf, otf or ttc face: names, the weight/width/slant a font manager files it under, metrics,
//!   variation axes and named instances, glyph coverage.
//! * [`registry`] holds the registered faces in registration order, grouped by family name as `GlobalFonts` does.
//! * [`discovery`] finds the font files of the machine (the places `GlobalFonts` scans at start-up).
//! * [`css_font`] parses the canvas `ctx.font` shorthand.
//! * [`matching`] resolves a parsed font to faces the way Skia's paragraph does: exact family, CSS style matching,
//!   one face per character from the family list.
//! * [`shape`] shapes a run with rustybuzz (HarfBuzz's default features).
//! * [`measure`] answers `measureText`.
//! * [`install`] downloads the Noto faces into the user font folder and registers them with the OS (`prepareOfficeFonts`).
//! * [`provision`] finds the provisioned Noto faces and the Office-for-Mac faces and registers them in Node's order.
//!
//! File reads take a lane proof (`mixdog_fsio::ReadProof`): they run in a lane job. A [`registry::Registry`] is built,
//! then shared behind an `Arc` and never changed.

pub mod autohint;
pub mod css_font;
pub mod discovery;
pub mod face;
pub mod install;
pub mod matching;
pub mod measure;
pub mod provision;
pub mod registry;
pub mod shape;

pub use face::{Face, FontError, Slant};

/// What measuring or drawing text answers when the process has no font at all. It reaches the model through the office and
/// canvas tools, so it names the two ways a font gets there: one installed in a system font folder, or the Noto faces the app
/// provisions once after the LibreOffice install (`document.installLibreOffice`, `mixdog_fonts::install`).
pub const NO_FONT_REGISTERED: &str = "no font is registered: none was found in the system font folders, and the Office fonts the app provisions have not been installed. Install a system font (for example Noto Sans) or run the LibreOffice install (document.installLibreOffice), which also provisions the Office fonts, then retry.";
pub use registry::{FaceId, Registry};
