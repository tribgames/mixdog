#![allow(clippy::disallowed_methods, reason = "test setup: makes the folders the switches go to")]

use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::*;

/// A composition brings up a Postgres cluster and a stop shuts it down: minutes on a loaded disk, never unbounded.
const LIMIT: std::time::Duration = std::time::Duration::from_secs(180);

/// The `session` tool's answer (its text, or its error's message) to `input` from `thread` on `surface`.
async fn session(core: &ComposedCore, thread: &str, surface: SurfaceKind, cwd: &Path, input: Value) -> Result<String, String> {
    let tool = core.real.tool_pool.iter().find(|candidate| candidate.spec().name == "session").expect("the composed core has the session tool");
    let tokens = mixdog_rt::testing::tokens();
    let ctx = ToolContext {
        call_id: mixdog_protocol::ToolCallId::from("call-1"),
        thread_id: ThreadId::from(thread),
        turn_id: mixdog_protocol::TurnId::from("t"),
        tool: "session".into(),
        cwd: mixdog_core_api::domain::common::AbsPath::new(cwd.to_owned()).unwrap(),
        surface,
        cancel: mixdog_rt::CancellationToken::new(),
        deadline: None,
        progress: std::sync::Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: std::sync::Arc::new(MockApprovalGate::default()),
        files: core.file_service.clone(),
        processes: std::sync::Arc::new(core.local_processes().clone()),
        options: Default::default(),
        review: Some(core.real.turn_review.clone()),
    };
    match tool.call(&ctx, input).await {
        Ok(output) => Ok(output.parts.iter().filter_map(|part| if let ToolPart::Text(text) = part { Some(text.as_str()) } else { None }).collect()),
        Err(error) => Err(error.message_for_model),
    }
}

async fn header(core: &ComposedCore, thread: &str) -> serde_json::Map<String, Value> {
    core.real.directory.stored_header(&ThreadId::from(thread)).await.expect("a stored header")
}

fn runtime() -> tokio::runtime::Builder {
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    runtime.worker_threads(4);
    runtime
}

/// The core composed in `dir`, with the threads `lead` and `worker` stored in the folder `first`; `second` exists too.
async fn composed_with_two_threads(dir: PathBuf) -> (ComposedCore, PathBuf, PathBuf) {
    let (first, second) = (dir.join("first"), dir.join("second"));
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    crate::compose_test_support::install(&data);
    let tokens = mixdog_rt::testing::tokens();
    let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new());
    let config = tests::config_in(&data, &dir, log, mixdog_rt::CancellationToken::new());
    let core = mixdog_core_session::session::testing::awaiting_for(LIMIT, || "the core to compose".to_owned(), compose(&tokens, config))
        .await
        .expect("the core composes");
    let first_text = first.to_string_lossy().into_owned();
    for id in ["lead", "worker"] {
        let header = json!({ "cwd": first_text }).as_object().cloned().unwrap();
        core.real.directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("the thread");
    }
    (core, first, second)
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn the_lead_switches_its_own_project_through_the_session_tool() {
    crate::compose_test_support::in_child(module_path!(), "the_lead_switches_its_own_project_through_the_session_tool", runtime(), |dir| async move {
        let (core, first, second) = composed_with_two_threads(dir).await;
        let answer =
            session(&core, "lead", SurfaceKind::Lead, &first, json!({ "action": "set-project", "path": second.to_string_lossy() })).await.expect("the switch");
        let answered: Value = serde_json::from_str(&answer).expect("the answer is JSON");
        assert_eq!(answered["sessionId"], "lead");
        let stored = header(&core, "lead").await;
        assert_eq!(answered["cwd"], stored["cwd"], "the answer is the stored folder");
        assert_eq!(stored["cwd"], json!(second.to_string_lossy()), "{stored:?}");
        core.stop("test").await;
    });
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn an_agent_session_may_not_switch_its_project_through_the_session_tool() {
    crate::compose_test_support::in_child(
        module_path!(),
        "an_agent_session_may_not_switch_its_project_through_the_session_tool",
        runtime(),
        |dir| async move {
            let (core, first, second) = composed_with_two_threads(dir).await;
            let refused = session(&core, "worker", SurfaceKind::Agent, &first, json!({ "action": "set-project", "path": second.to_string_lossy() }))
                .await
                .expect_err("an agent may not switch");
            assert_eq!(refused, "session: set-project belongs to the Lead session");
            assert_eq!(header(&core, "worker").await["cwd"], json!(first.to_string_lossy()), "the refused call stored nothing");
            core.stop("test").await;
        },
    );
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn the_session_tool_flags_a_thread_through_the_thread_settings_service() {
    crate::compose_test_support::in_child(module_path!(), "the_session_tool_flags_a_thread_through_the_thread_settings_service", runtime(), |dir| async move {
        let (core, _first, second) = composed_with_two_threads(dir).await;
        session(&core, "lead", SurfaceKind::Lead, &second, json!({ "action": "favorite", "value": true })).await.expect("favorite");
        assert!(header(&core, "lead").await.contains_key("favoriteAt"), "the flag is stored");
        core.stop("test").await;
    });
}
