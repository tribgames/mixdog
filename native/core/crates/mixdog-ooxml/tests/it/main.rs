//! Feature tests of the portable OOXML engine: a document is created and edited through the batch the tools call, and every
//! expectation comes from reading the saved package back (the crate's snapshot, or the XML element the format requires).

mod docx;
mod package;
mod pptx;
mod support;
mod xlsx;
