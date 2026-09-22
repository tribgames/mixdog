// mixdog-graph engine library.
//
// The modules below carry language classification, the resident search
// server, and Windows USN journal support. `src/main.rs` is the crash-isolated
// executable front end used for graph builds and `--serve-search`.
pub mod calls;
pub mod lang;
pub mod outline;
pub mod scan;
pub mod scan_lang;
pub mod serve_search;
mod serve_search_lifecycle;
pub mod serve_search_usn;
pub mod spans;
pub mod tokens;

// A source file above this size is not indexed at all. The extraction walk,
// the `--files` path, the symbol search and the structural scan all apply the
// same cap, so a file is either in every mode's answer or in none of them.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
