// Only the `#![cfg(windows)]` suites use it.
#[cfg(windows)]
#[cfg(node_twin)]
mod support;
#[cfg(node_twin)]
mod bundled_skills_suite;
mod card_suite;
#[cfg(node_twin)]
mod catalog_suite;
#[cfg(node_twin)]
mod compact_suite;
mod connector_accounts_suite;
mod cross_spawn_suite;
mod discovery_suite;
#[cfg(node_twin)]
mod extension_suite;
#[cfg(node_twin)]
mod global_extensions_suite;
mod golden_suite;
mod google_reserved_address_suite;
#[cfg(node_twin)]
mod google_mcp_suite;
mod hookscope_suite;
mod http_suite;
mod lifecycle_suite;
mod mcp_login_flow_suite;
mod mcp_login_notice_suite;
mod mail_reads_suite;
#[cfg(node_twin)]
mod login_feed_suite;
#[cfg(node_twin)]
mod login_notice_suite;
#[cfg(node_twin)]
mod mail_read_suite;
#[cfg(node_twin)]
mod mcp_oauth_control_session_suite;
mod mcp_suite;
#[cfg(node_twin)]
mod mcpapi_suite;
mod mcpfault_suite;
#[cfg(node_twin)]
mod mcpinput_suite;
#[cfg(node_twin)]
mod mcpsecrets_suite;
#[cfg(node_twin)]
mod oauth_callback_page_suite;
#[cfg(node_twin)]
mod outputschema_suite;
#[cfg(node_twin)]
mod oauth_mcp_lifecycle_suite;
mod oauth_protocol_suite;
mod oauth_suite;
mod output_schema_suite;
mod permissions_suite;
mod plugin_catalog_suite;
mod plugin_declarations_suite;
mod plugin_registry_suite;
#[cfg(node_twin)]
mod plugin_json_errors_suite;
#[cfg(node_twin)]
mod plugins_rows_suite;
#[cfg(node_twin)]
mod plugins_suite;
mod posttool_suite;
#[cfg(node_twin)]
mod pretool_suite;
mod scope_runtime_suite;
#[cfg(node_twin)]
mod scope_suite;
#[cfg(node_twin)]
mod scopes_node_cases_suite;
mod setupmcp_suite;
mod mcp_secrets_suite;
mod mcp_server_input_suite;
mod skill_document_suite;
mod stdio_failure_suite;
mod skill_lookup_suite;
mod skills_service_suite;
mod mcp_service_suite;
mod skills_collect_suite;
mod skill_catalog_suite;
#[cfg(node_twin)]
mod skillfm_suite;
#[cfg(node_twin)]
mod skillport_suite;
mod skills_listed_suite;
#[cfg(node_twin)]
mod skillsapi_suite;
#[cfg(node_twin)]
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

/// A connection to a loopback port as Node's client makes it. libuv asks Windows not to retransmit the SYN to a loopback
/// address (`SIO_TCP_INITIAL_RTO` with `TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS`), so a port nobody listens on refuses at
/// once; a plain connect is refused only after Windows' two retries, 2 s later (measured: 2.03 s, 0.2 ms with this).
#[cfg(node_twin)]
async fn connect_loopback(port: u16) -> std::io::Result<tokio::net::TcpStream> {
    let socket = tokio::net::TcpSocket::new_v4()?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        #[repr(C)]
        struct InitialRto {
            rtt: u16,
            max_syn_retransmissions: u8,
        }
        #[link(name = "ws2_32")]
        unsafe extern "system" {
            fn WSAIoctl(
                socket: usize,
                code: u32,
                input: *const InitialRto,
                input_len: u32,
                output: *mut u8,
                output_len: u32,
                returned: *mut u32,
                overlapped: *mut u8,
                routine: *mut u8,
            ) -> i32;
        }
        const SIO_TCP_INITIAL_RTO: u32 = 0x9800_0011;
        // `TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS` is `(USHORT)-2` in `Rtt` and `(UCHAR)-2` in `MaxSynRetransmissions`.
        let rto = InitialRto { rtt: 0xFFFE, max_syn_retransmissions: 0xFE };
        let mut returned = 0u32;
        // SAFETY: the socket is open and owned by `socket`; the input is an initialized TCP_INITIAL_RTO_PARAMETERS of the
        // size given; no output buffer, overlapped or completion routine. A failure leaves the plain connect, as libuv does.
        let _ = unsafe {
            WSAIoctl(
                socket.as_raw_socket() as usize,
                SIO_TCP_INITIAL_RTO,
                &rto,
                std::mem::size_of::<InitialRto>() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
    }
    socket.connect(std::net::SocketAddr::from(([127, 0, 0, 1], port))).await
}

mod stored_publisher_suite;
