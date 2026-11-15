//! The office authoring runners. This crate holds, module by module, the ports of `src/runtime/office/authoring/`:
//! the composition brief a script or an HTML deck opens with (`brief`), read back as information (the slide plan,
//! the directions, the fact sheet) and held against the saved deck by the review and by the author gates; the review
//! artifacts (`review_artifacts`: the receipt and the labelled contact sheet of `contact_sheet`) and the note of which
//! HTML a session's file was built from (`source_drift`).

pub mod brief;
pub mod contact_sheet;
pub mod review_artifacts;
pub mod source_drift;
pub mod cdp;
pub mod geometry;
pub mod html_browser;
pub mod icons;
pub mod measure_deck;
pub mod page;
pub mod pptx_writer;
