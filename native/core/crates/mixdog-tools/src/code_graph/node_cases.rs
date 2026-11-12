//! Node's code_graph cases (`fixtures/code-graph-cases`, `record-code-graph-cases.mjs`): each recorded call through the
//! Rust code_graph tool on the workspace the case (or the call) names, its whole text against Node's, in order.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the replay builds real work trees with blocking filesystem calls"
)]

use std::path::Path;
use std::path::PathBuf;
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

use super::CodeGraphTool;
use super::GraphCache;
use super::TrustedRoots;

struct NoTrust;

#[async_trait::async_trait]
impl TrustedRoots for NoTrust {
    async fn registered(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    async fn selected(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

fn context(root: &AbsPath) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        tool: "code_graph".into(),
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

fn write_files(root: &Path, files: &JsonValue) {
    std::fs::create_dir_all(root).unwrap();
    for (rel, text) in files.as_object().into_iter().flatten() {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text.as_str().unwrap()).unwrap();
    }
}

/// Node's answer: the tool text, or `Error: <thrown>` for a call that threw.
fn want_of(call: &JsonValue) -> String {
    match call.get("text") {
        Some(text) => text.as_str().unwrap().to_owned(),
        None => format!("Error: {}", call["thrown"].as_str().unwrap()),
    }
}

async fn answer(root: &Path, input: &JsonValue) -> String {
    let shown = root.to_string_lossy().into_owned();
    let cache_dir = tempfile::tempdir().unwrap();
    let tool = CodeGraphTool::new(Arc::new(NoTrust), Arc::new(GraphCache::new(cache_dir.path().join("cache"))));
    let args: JsonValue = serde_json::from_str(&input.to_string().replace("<ROOT>", &shown.replace('\\', "\\\\"))).unwrap();
    let text = match tool.call(&context(&AbsPath::new(root).unwrap()), args).await {
        Ok(out) => match &out.parts[0] {
            ToolPart::Text(t) => t.clone(),
            _ => panic!("not text"),
        },
        Err(e) => e.message_for_model,
    };
    text.replace(&shown, "<ROOT>").replace(&shown.replace('\\', "/"), "<ROOT>")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_code_graph_call_answers_nodes_text() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/code-graph-cases/golden.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in golden["cases"].as_array().unwrap() {
        let title = case["case"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let case_root = dir.path().join("ws");
        if let Some(files) = case.get("files") {
            write_files(&case_root, files);
        }
        for (rel, bytes) in case["bytes"].as_object().into_iter().flatten() {
            let bytes: Vec<u8> = bytes.as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect();
            std::fs::write(case_root.join(rel), bytes).unwrap();
        }
        for (n, call) in case["calls"].as_array().unwrap().iter().enumerate() {
            // An ast-calls call carries its own workspace; a scenario's calls share the case's, edited between calls.
            let root = match call.get("files") {
                Some(files) => {
                    let root = dir.path().join(format!("call{n}"));
                    write_files(&root, files);
                    root
                }
                None => case_root.clone(),
            };
            if let Some(before) = call.get("before") {
                write_files(&root, before);
            }
            let got = answer(&root, &call["input"]).await;
            let want = want_of(call);
            if got != want {
                failures.push(format!("{title} call {n} {}:\n  want {want:?}\n  got  {got:?}", call["input"]));
            }
            compared += 1;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n").chars().take(40_000).collect::<String>());
    assert_eq!(compared, golden["cases"].as_array().unwrap().iter().map(|c| c["calls"].as_array().unwrap().len()).sum::<usize>());
}
