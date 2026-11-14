//! Node-API module of the Electron main process, built and packaged on Windows, macOS and Linux alike (nothing in it is
//! platform specific). It serves the synchronous calls the main process cannot await; today the Browser Use URL and
//! redaction rules ([`browser_policy`]).

mod browser_policy;
