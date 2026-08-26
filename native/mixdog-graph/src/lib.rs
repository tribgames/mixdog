// mixdog-graph engine library.
//
// The modules below carry language classification, the resident search
// server, and Windows USN journal support. `src/main.rs` is the crash-isolated
// executable front end used for graph builds and `--serve-search`.
pub mod lang;
pub mod serve_search;
pub mod serve_search_usn;
