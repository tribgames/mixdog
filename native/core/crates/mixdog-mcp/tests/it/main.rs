mod card_suite;
mod connector_accounts_suite;
mod cross_spawn_suite;
mod discovery_suite;
mod golden_suite;
mod google_reserved_address_suite;
mod hookscope_suite;
mod http_suite;
mod lifecycle_suite;
mod mail_reads_suite;
mod mcp_login_flow_suite;
mod mcp_login_notice_suite;
mod mcp_secrets_suite;
mod mcp_server_input_suite;
mod mcp_service_suite;
mod mcp_suite;
mod mcpfault_suite;
mod oauth_protocol_suite;
mod oauth_suite;
mod output_schema_suite;
mod permissions_suite;
mod plugin_catalog_suite;
mod plugin_declarations_suite;
mod plugin_registry_suite;
mod posttool_suite;
mod scope_runtime_suite;
mod setupmcp_suite;
mod skill_catalog_suite;
mod skill_document_suite;
mod skill_lookup_suite;
mod skills_collect_suite;
mod skills_listed_suite;
mod skills_service_suite;
mod stdio_failure_suite;
mod transport_suite;
mod uv_error_suite;
mod watch_cache_suite;

static OAUTH_SEAMS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn oauth_seams() -> tokio::sync::MutexGuard<'static, ()> {
    OAUTH_SEAMS.lock().await
}

mod stored_publisher_suite;

#[path = "../output_schema_lane.rs"]
mod output_schema_lane;
