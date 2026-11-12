//! How a stdio server is started and what its row says when it cannot start, exits, never answers or dies, replayed against
//! what Node said on this platform (`fixtures/stdio-spawn/<platform>/golden.json`, recorded by `record-stdio-spawn.mjs`
//! through cross-spawn and the real client over the SDK's `StdioClientTransport`). A platform that has no recording yet
//! fails here until the recorder has been run on it.

use std::collections::BTreeMap;
use std::path::PathBuf;

use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::cross_spawn::Host;
use mixdog_mcp::cross_spawn::Launch;
use mixdog_mcp::cross_spawn::parse_host;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_rt::LaneToken;
use mixdog_mcp::server::ServerState;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    "linux"
};

async fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/stdio-spawn").join(PLATFORM).join("golden.json");
    let bytes = mixdog_rt::testing::tokens()
        .durability_io
        .submit(&CancellationToken::new(), move |_| mixdog_statefile::read_content(&path))
        .unwrap()
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// Writes the recorded fixture tree under `root`.
async fn lay_out(root: PathBuf, files: Vec<(String, String)>) {
    mixdog_rt::testing::tokens()
        .durability_io
        .submit(&CancellationToken::new(), move |lane| {
            for (path, text) in files {
                let full = root.join(path);
                mixdog_statefile::create_dir_all(lane, full.parent().unwrap()).unwrap();
                mixdog_statefile::write_file(lane, &full, text.as_bytes(), &mixdog_statefile::Opts::default()).unwrap();
            }
        })
        .unwrap()
        .await
        .unwrap();
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn every_recorded_command_resolves_and_escapes_as_cross_spawn_does() {
    let golden = golden().await;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let files = golden["files"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap().to_owned(), f["text"].as_str().unwrap().to_owned()));
    lay_out(dir.path().to_path_buf(), files.collect()).await;
    let expand = |text: &str| text.replace("<ROOT>", &root);
    let mask = |text: &str| text.replace(&root, "<ROOT>");
    let spawn = mixdog_rt::testing::tokens().spawn_io;
    for case in golden["parse"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let host = Host {
            process_cwd: PathBuf::from(expand(golden["host"]["processCwd"].as_str().unwrap())),
            path: case["processPath"].as_str().map(expand),
            pathext: golden["host"]["pathext"].as_str().map(str::to_owned),
            comspec: golden["host"]["comspec"].as_str().map(str::to_owned),
        };
        let env = BTreeMap::from([("PATH".to_owned(), expand(case["path"].as_str().unwrap()))]);
        let (command, args) = (expand(case["command"].as_str().unwrap()), strings(&case["args"]));
        let cwd = case["cwd"].as_str().map(expand);
        let launch = spawn
            .submit(&CancellationToken::new(), move |lane| parse_host(lane, &host, &command, &args, cwd.as_deref(), &env))
            .unwrap()
            .await
            .unwrap();
        let recorded = &case["launch"];
        let mut actual = match launch {
            Launch::Shell { file, args } => json!({ "kind": "shell", "file": mask(&file), "args": args.iter().map(|a| mask(a)).collect::<Vec<_>>() }),
            Launch::Direct { shown, program, args } => {
                json!({ "kind": "direct", "shown": mask(&shown), "args": args.iter().map(|a| mask(a)).collect::<Vec<_>>(), "program": mask(&program) })
            }
        };
        // Node's `file` of a script run through its shebang names the script, not what is started.
        if recorded.get("program").is_none() {
            actual.as_object_mut().unwrap().shift_remove("program");
        }
        assert_eq!(&actual, recorded, "{name}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stdio_server_that_fails_reads_as_nodes_row() {
    let golden = golden().await;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    for case in golden["connect"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let entry: Value = serde_json::from_str(&case["entry"].to_string().replace("<ROOT>", &root.replace('\\', "\\\\"))).unwrap();
        let config = McpServerConfig::from_entry(name, &entry, &std::env::vars().collect()).unwrap();
        let server = McpServer::new(config, io, Spiller::new(dir.path().to_path_buf(), io.durability), OutputPolicy::default(), None);
        let connected = server.connect().await;
        let published = if case["failure"].is_null() {
            connected.unwrap();
            case["status"]["error"].as_str().unwrap()
        } else {
            assert_eq!(connected.unwrap_err().to_string(), case["failure"].as_str().unwrap(), "{name}");
            case["failure"].as_str().unwrap()
        };
        let mut states = server.subscribe();
        let state = states.wait_for(|s| matches!(**s, ServerState::Failed { .. })).await.unwrap().clone();
        let ServerState::Failed { cause } = &*state else { unreachable!() };
        assert_eq!(cause, published, "{name}");
        server.close().await;
    }
}
