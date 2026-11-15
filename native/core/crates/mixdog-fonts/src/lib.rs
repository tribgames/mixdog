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
//! * [`provision`] finds the provisioned Noto faces and the Office-for-Mac faces and registers them in Node's order.
//!
//! File reads take a lane proof (`mixdog_fsio::ReadProof`): they run in a lane job. A [`registry::Registry`] is built,
//! then shared behind an `Arc` and never changed.

pub mod css_font;
pub mod discovery;
pub mod face;
pub mod matching;
pub mod measure;
pub mod provision;
pub mod registry;
pub mod shape;

pub use face::{Face, FontError, Slant};
pub use registry::{FaceId, Registry};
