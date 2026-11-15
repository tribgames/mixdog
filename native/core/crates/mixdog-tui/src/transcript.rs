//! The transcript viewport state: [`window`] (which items are on screen, their heights and the row estimate) and [`scroll`]
//! (position, anchor lock, wheel and follow). The two are filled by `nr-tui-transcript-window` and
//! `nr-tui-transcript-scroll`; this file is not changed after the wave that created it.

pub mod scroll;
pub mod window;
