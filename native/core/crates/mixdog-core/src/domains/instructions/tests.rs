//! Replays the scenario of `goldens/instructions.json`, which
//! `tools/gen-instructions-golden.mjs` recorded from the 1.4.5 Node API over the same shipped
//! files (`goldens/instructions-shipped`).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::error::Precondition;
use mixdog_protocol::DomainErrorDetail;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::domains::support::testing::request;
use crate::domains::support::testing::scopes;
use crate::domains::support::testing::value;
use crate::domains::support::testing::with_op;

const GOLDEN: &str = include_str!("../goldens/instructions.json");

struct Modes(Mutex<String>);

#[async_trait]
impl InstructionFilesMode for Modes {
    async fn set(&self, mode: &str) -> Result<Value, ToolModulesError> {
        if !["all", "agents", "claude", "off"].contains(&mode) {
            return Err(ToolModulesError::InvalidArgument(
                "Instruction files must be one of all, agents, claude, off.".to_owned(),
            ));
        }
        *self.0.lock().unwrap() = mode.to_owned();
        Ok(json!({ "instructionFiles": mode }))
    }

    async fn current(&self) -> Value {
        json!({ "instructionFiles": *self.0.lock().unwrap() })
    }
}

#[derive(Default)]
struct Announced(Mutex<usize>);

#[async_trait]
impl InstructionsChanged for Announced {
    async fn changed(&self) {
        *self.0.lock().unwrap() += 1;
    }
}

struct Rig {
    service: Arc<InstructionsService>,
    announced: Arc<Announced>,
    modes: Arc<Modes>,
    data: tempfile::TempDir,
    next_op: u64,
}

async fn rig() -> Rig {
    let data = tempfile::tempdir().unwrap();
    let shipped = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/domains/goldens/instructions-shipped");
    let announced = Arc::new(Announced::default());
    let modes = Arc::new(Modes(Mutex::new("off".into())));
    let service = InstructionsService::new(
        InstructionPaths {
            shipped_orchestration: shipped.join("orchestration"),
            shipped_output_styles: shipped.join("output-styles"),
            data_dir: data.path().to_owned(),
        },
        modes.clone(),
        announced.clone(),
        scopes(data.path(), "instructions").await,
        &mixdog_rt::testing::tokens(),
    );
    Rig { service, announced, modes, data, next_op: 1 }
}

impl Rig {
    async fn call(&mut self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let mutating = !method.contains("list") && !method.contains("get");
        let (params, op) = if mutating {
            self.next_op += 1;
            (with_op(params, self.next_op), Some(self.next_op))
        } else {
            (params, None)
        };
        value(&*self.service, request(method, params, op)).await
    }

    fn user(&self, rel: &str, text: &str) {
        let path = self.data.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

/// The Node message of a refusal, or its code for the one carried as a precondition.
fn refusal(error: CoreError) -> String {
    match error {
        CoreError::DomainError { detail: Some(detail), .. } => match *detail {
            DomainErrorDetail::CommandFailed { message } => message,
            other => panic!("unexpected detail {other:?}"),
        },
        CoreError::PreconditionFailed { precondition: Precondition::Revision { .. } } => {
            "INSTRUCTION_FILE_CONFLICT".into()
        }
        other => panic!("unexpected error {other:?}"),
    }
}

/// `<DATA>` for the data dir and `/` separators, as the golden is written.
fn normal(value: Value, data: &std::path::Path) -> Value {
    let text = value.to_string().replace(&data.to_string_lossy().replace('\\', "\\\\"), "<DATA>").replace("\\\\", "/");
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn the_scenario_answers_what_the_node_api_answered() {
    let steps: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    let mut rig = rig().await;
    let shipped_balanced =
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "src/domains/goldens/instructions-shipped/orchestration/balanced.md",
        ))
        .unwrap();
    for step in &steps {
        let name = step["name"].as_str().unwrap();
        if name == "list with problems" {
            rig.user("orchestration/focused.md", " \n\t\n");
            rig.user("output-styles/minimal.md", "---\nname: other\n---\n\nBody\n");
            rig.user("output-styles/detailed.md", "---\nname: detailed\ntitle: Mine\n---\n\nMy detailed\r\nbody  \r\n");
        }
        let save = |group: &str, id: &str, body: &str| json!({ "input": { "group": group, "id": id, "body": body } });
        let result = match name {
            "list" | "list with problems" => rig.call("instructions/listInstructionFiles", json!({})).await,
            "get balanced" => {
                rig.call("instructions/getInstructionFile", json!({ "group": "delegation", "id": "balanced" })).await
            }
            "save crlf" => {
                rig.call("instructions/saveInstructionFile", save("delegation", "balanced", "  Hello\r\nWorld  \r\n"))
                    .await
            }
            "save style" => {
                rig.call("instructions/saveInstructionFile", save("outputStyle", "simple", "Short answers only."))
                    .await
            }
            "save equal to shipped" => {
                rig.call("instructions/saveInstructionFile", save("delegation", "balanced", &shipped_balanced)).await
            }
            "save stale revision" => {
                let mut params = save("delegation", "swarm", "x");
                params["input"]["expectedRevision"] = json!("nope");
                rig.call("instructions/saveInstructionFile", params).await
            }
            "save current revision" => {
                let current = rig
                    .call("instructions/getInstructionFile", json!({ "group": "delegation", "id": "swarm" }))
                    .await
                    .unwrap();
                let mut params = save("delegation", "swarm", "Swarm text");
                params["input"]["expectedRevision"] = current["revision"].clone();
                rig.call("instructions/saveInstructionFile", params).await
            }
            "save empty" => rig.call("instructions/saveInstructionFile", save("delegation", "none", " \r\n ")).await,
            "save nul" => rig.call("instructions/saveInstructionFile", save("delegation", "none", "a\0b")).await,
            "reset without override" => {
                rig.call("instructions/resetInstructionFile", json!({ "group": "delegation", "id": "none" })).await
            }
            "reset" => {
                rig.call("instructions/resetInstructionFile", json!({ "group": "delegation", "id": "swarm" })).await
            }
            "reset stale" => {
                rig.call(
                    "instructions/resetInstructionFile",
                    json!({ "group": "outputStyle", "id": "simple", "expectedRevision": "nope" }),
                )
                .await
            }
            "bad mode" => {
                rig.call("instructions/getInstructionFile", json!({ "group": "delegation", "id": "wild" })).await
            }
            "bad style" => {
                rig.call("instructions/getInstructionFile", json!({ "group": "outputStyle", "id": "loud" })).await
            }
            "bad group" => rig.call("instructions/getInstructionFile", json!({ "group": "prompts", "id": "x" })).await,
            "save too large" => {
                rig.call("instructions/saveInstructionFile", save("delegation", "none", &"a".repeat(262_144))).await
            }
            other => panic!("unknown step {other}"),
        };
        match (result, step.get("ok")) {
            (Ok(got), Some(want)) => {
                assert_eq!(normal(got, rig.data.path()), normal(want.clone(), std::path::Path::new("<none>")), "step {name}");
            }
            (Err(got), None) => {
                let want = step["error"].as_str().unwrap();
                let got = refusal(got);
                if step["code"].is_null() {
                    assert_eq!(got, want, "step {name}");
                } else {
                    assert_eq!(got, step["code"].as_str().unwrap(), "step {name}");
                }
            }
            (got, _) => panic!("step {name}: {got:?}"),
        }
    }
    // Every successful save and reset announced; reads and refusals did not.
    assert_eq!(*rig.announced.0.lock().unwrap(), 5);
}

#[tokio::test]
async fn a_repeated_op_changes_once_and_answers_the_same() {
    let mut rig = rig().await;
    let params = with_op(json!({ "input": { "group": "delegation", "id": "none", "body": "Once" } }), 9);
    let first = value(&*rig.service, request("instructions/saveInstructionFile", params.clone(), Some(9))).await.unwrap();
    let again = value(&*rig.service, request("instructions/saveInstructionFile", params, Some(9))).await.unwrap();
    assert_eq!(first, again);
    assert_eq!(*rig.announced.0.lock().unwrap(), 1);
    let _ = &mut rig;
}

#[tokio::test]
async fn the_mode_is_validated_and_stored_by_the_tool_modules() {
    let mut rig = rig().await;
    let set = rig.call("instructions/setInstructionFiles", json!({ "mode": "claude" })).await.unwrap();
    assert_eq!(set, json!({ "instructionFiles": "claude" }));
    assert_eq!(*rig.modes.0.lock().unwrap(), "claude");
    let refused = rig.call("instructions/setInstructionFiles", json!({ "mode": "everything" })).await.unwrap_err();
    assert_eq!(refusal(refused), "Instruction files must be one of all, agents, claude, off.");
}
