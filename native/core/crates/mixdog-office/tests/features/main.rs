//! Feature tests of the Office tool through `Engine::execute`, the call a process makes: whole call sequences over delimited
//! files, which need no Microsoft Office, no LibreOffice and no browser.

mod author;
mod author_routes;
mod contracts;
mod documents;
mod errors;
mod flows;
mod render;
mod support;

// The suites that were binaries of their own; one binary is one link of the dependency graph instead of four. The live
// suites (Microsoft Office over COM) are compiled on Windows only and ignored; run them with `--run-ignored only` there.
#[path = "../com_registry.rs"]
mod com_registry;
#[path = "../live_com/main.rs"]
mod live_com;
#[path = "../pptx_script.rs"]
mod pptx_script;
