//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so a test still runs alone in its program. The suites that need the
//! `test-support` feature were targets with `required-features`; they are its modules now.

#[path = "../image_methods.rs"]
mod image_methods;
#[cfg(feature = "test-support")]
#[path = "../office_journal.rs"]
mod office_journal;
#[path = "../office_run.rs"]
mod office_run;
#[path = "../office_turn_review.rs"]
mod office_turn_review;
#[cfg(feature = "test-support")]
#[path = "../pdf_render_ocr.rs"]
mod pdf_render_ocr;
#[cfg(feature = "test-support")]
#[path = "../pool_e2e.rs"]
mod pool_e2e;
#[path = "../protocol.rs"]
mod protocol;
#[path = "../skill_office_engine.rs"]
mod skill_office_engine;
