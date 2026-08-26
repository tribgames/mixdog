// mixdog-graph engine library.
//
// The modules below carry every piece of behaviour: language classification,
// the resident search server, and the Windows USN journal helpers. Two front
// ends consume them and neither owns any logic of its own:
//
//   - src/main.rs      — the standalone `mixdog-graph` executable (graph
//                        builds over argv/stdout plus `--serve-search`).
//   - ../mixdog-graph-addon — the Node-API addon that runs the same resident
//                        search server INSIDE the host process, so no separate
//                        OS process (and no separate Task Manager row) exists.
//
// Keeping both on one library is the invariant: a fix to the search engine
// cannot land for one transport and silently miss the other.
pub mod lang;
pub mod serve_search;
pub mod serve_search_usn;
