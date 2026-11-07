//! The production `IndexProjector` of `mixdogd migrate`: the one the daemon's own startup migration runs
//! (`mixdog_app_server_daemon::boot`), the store's `project_index`.

pub use mixdog_app_server_daemon::boot::StoreProjector;
