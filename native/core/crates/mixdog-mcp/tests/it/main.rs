// Only the `#![cfg(windows)]` suites use it.
#[cfg(windows)]
mod support;
mod card_suite;
mod catalog_suite;
mod compact_suite;
mod connector_accounts_suite;
mod discovery_suite;
mod extension_suite;
mod golden_suite;
mod hookscope_suite;
mod http_suite;
mod login_feed_suite;
mod login_notice_suite;
mod mcp_suite;
mod mcpapi_suite;
mod mcpfault_suite;
mod mcpinput_suite;
mod mcpsecrets_suite;
mod oauth_callback_page_suite;
mod outputschema_suite;
mod oauth_mcp_lifecycle_suite;
mod oauth_suite;
mod permissions_suite;
mod plugin_json_errors_suite;
mod plugins_rows_suite;
mod plugins_suite;
mod posttool_suite;
mod pretool_suite;
mod scope_runtime_suite;
mod scope_suite;
mod setupmcp_suite;
mod skill_catalog_suite;
mod skillfm_suite;
mod skillport_suite;
mod skills_listed_suite;
mod skillsapi_suite;
mod stdio_spawn_suite;
mod transport_suite;
mod uv_error_suite;
mod watch_cache_suite;

/// The OAuth test seams (`mixdog_mcp::oauth::callback::seam`) are process-wide: the login deadline one test fires, the
/// clock it advances and the listener events it clears and reads reach every login running in the process. A test that
/// runs a login holds this for its whole run, so under `cargo test` (every test a thread of one process) those tests take
/// turns, as they do in nextest's process per test.
static OAUTH_SEAMS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn oauth_seams() -> tokio::sync::MutexGuard<'static, ()> {
    OAUTH_SEAMS.lock().await
}
