//! Feature tests of the portable OOXML engine: a document is created and edited through the batch the tools call, and every
//! expectation comes from reading the saved package back (the crate's snapshot, or the XML element the format requires).

mod docx;
mod package;
mod pptx;
mod support;
mod xlsx;

// The suites that were binaries of their own; one binary is one link of the dependency graph instead of four. The fake
// LibreOffice of soffice_lifecycle is this executable, started on its `soffice_lifecycle::fake_*` tests.
#[path = "../audit_features.rs"]
mod audit_features;
#[path = "../ooxml_validator_cache.rs"]
mod ooxml_validator_cache;
#[path = "../soffice_lifecycle.rs"]
mod soffice_lifecycle;
