//! A stdio server that cannot be started, or that ends before it answers, fails its connection and its row says why: the server's own
//! words from its error output are kept as a tail, and a command that does not exist names itself.

use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::server::ServerState;
use serde_json::Value;
use serde_json::json;

/// A tiny child every platform has: the shell, told to run `script`.
fn shell_server(script: &str) -> Value {
    if cfg!(windows) { json!({"command": "cmd", "args": ["/d", "/c", script]}) } else { json!({"command": "sh", "args": ["-c", script]}) }
}

/// The error the connection fails with, and the cause the server's row then shows.
async fn failure_of(entry: Value) -> (String, String) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let config = McpServerConfig::from_entry("child", &entry, &std::env::vars().collect()).unwrap();
    let server = McpServer::new(config, io, Spiller::new(dir.path().to_path_buf(), io.durability), OutputPolicy::default(), None);
    let error = server.connect().await.expect_err("the connection fails").to_string();
    let mut states = server.subscribe();
    let state = states.wait_for(|state| matches!(**state, ServerState::Failed { .. })).await.unwrap().clone();
    let ServerState::Failed { cause } = &*state else { unreachable!() };
    let cause = cause.clone();
    server.close().await;
    (error, cause)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_ends_before_it_answers_fails_as_a_closed_connection() {
    let (error, cause) = failure_of(shell_server("exit 3")).await;
    assert!(error.contains("Connection closed"), "{error}");
    assert!(cause.contains("Connection closed"), "{cause}");
}

#[tokio::test(flavor = "multi_thread")]
async fn what_the_server_wrote_to_its_error_output_is_kept_in_the_failure() {
    let script = if cfg!(windows) { "echo boom-from-the-server 1>&2 & exit 1" } else { "echo boom-from-the-server >&2; exit 1" };
    let (error, cause) = failure_of(shell_server(script)).await;
    for text in [&error, &cause] {
        assert!(text.contains("--- server stderr (tail) ---") && text.contains("boom-from-the-server"), "{text}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_that_does_not_exist_fails_the_connection_and_names_itself() {
    let (error, cause) = failure_of(json!({"command": "mixdog-no-such-command-for-tests"})).await;
    assert!(error.contains("mixdog-no-such-command-for-tests"), "{error}");
    assert!(cause.contains("mixdog-no-such-command-for-tests"), "{cause}");
}