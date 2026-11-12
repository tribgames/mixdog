//! Node's file-tool cases (`fixtures/fs-other-cases`, `record-fs-other-cases.mjs`): each recorded call through the Rust
//! `list`, `read` or `apply_patch` tool on the case's workspace, whole, in order (and the patched file whole), and each
//! recorded marker call through the module's marker function of the same name.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the replay builds real work trees with blocking filesystem calls"
)]

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use tokio_util::sync::CancellationToken;

use super::common::cap_marker;
use super::common::format_cap_size;
use super::common::window_marker;
use super::*;

fn golden() -> JsonValue {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fs-other-cases/golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn context(root: &AbsPath) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        tool: "fs".into(),
        cwd: root.clone(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

fn tool(name: &str) -> Box<dyn Tool> {
    match name {
        "list" => Box::new(ListTool::new()),
        "read" => Box::new(ReadTool::new(None, None)),
        "apply_patch" => Box::new(ApplyPatchTool::new()),
        other => panic!("no tool {other}"),
    }
}

fn text_of(outcome: ToolOutcome) -> String {
    match outcome {
        Ok(out) => match &out.parts[0] {
            ToolPart::Text(t) => t.clone(),
            _ => panic!("not text"),
        },
        Err(e) => e.message_for_model,
    }
}

#[tokio::test]
async fn every_recorded_file_tool_call_answers_nodes_text() {
    let golden = golden();
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("ws");
        std::fs::create_dir_all(&root_path).unwrap();
        for (rel, text) in case["files"].as_object().into_iter().flatten() {
            std::fs::write(root_path.join(rel), text.as_str().unwrap()).unwrap();
        }
        for (rel, bytes) in case["bytes"].as_object().into_iter().flatten() {
            let bytes: Vec<u8> = bytes.as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect();
            std::fs::write(root_path.join(rel), bytes).unwrap();
        }
        let root = AbsPath::new(&root_path).unwrap();
        let ctx = context(&root);
        let tool = tool(case["tool"].as_str().unwrap());
        let shown = root_path.to_string_lossy().into_owned();
        for (n, call) in case["calls"].as_array().unwrap().iter().enumerate() {
            let args: JsonValue = serde_json::from_str(&call["args"].to_string().replace("<ROOT>", &shown.replace('\\', "/"))).unwrap();
            let text = text_of(tool.call(&ctx, args).await).replace(&shown, "<ROOT>").replace(&shown.replace('\\', "/"), "<ROOT>");
            if text != call["result"].as_str().unwrap() {
                failures.push(format!("{name} call {n}:\n  want {:?}\n  got  {text:?}", call["result"]));
            }
            compared += 1;
        }
        for (rel, want) in case["filesAfter"].as_object().into_iter().flatten() {
            let got = std::fs::read_to_string(root_path.join(rel)).unwrap();
            if got != want.as_str().unwrap() {
                failures.push(format!("{name} {rel} after:\n  want {want:?}\n  got  {got:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n").chars().take(20_000).collect::<String>());
    assert_eq!(compared, golden["cases"].as_array().unwrap().iter().map(|c| c["calls"].as_array().unwrap().len()).sum::<usize>());
}

#[test]
fn every_recorded_marker_is_the_modules_marker() {
    let golden = golden();
    for call in golden["markers"]["calls"].as_array().unwrap() {
        let input = &call["input"];
        let got = match call["fn"].as_str().unwrap() {
            "windowMarker" => window_marker(
                "lines",
                input["from"].as_u64().unwrap(),
                input["to"].as_u64().unwrap(),
                input["total"].as_u64(),
                input["nextOffset"].as_u64(),
                input["capBytes"].as_u64().map(|c| c as usize),
            ),
            "formatCapSize" => format_cap_size(input.as_u64().unwrap() as usize),
            "capMarker" => cap_marker(
                &format_cap_size(input["limit"].as_u64().unwrap() as usize),
                input["shown"].as_str().unwrap_or(""),
                input["nextOffset"].as_u64(),
                "",
            ),
            other => panic!("no marker {other}"),
        };
        assert_eq!(got, call["result"].as_str().unwrap(), "{} {input}", call["fn"]);
    }
}
