use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::agents::AgentEffects;
use crate::agents::AgentEvidence;
use crate::config::AgentRoutes;
use crate::config::Config;
use crate::config::ConfigLanes;
use crate::setup::CallerScope;

/// Nothing is said about the chats or the routines: the recorder ran with none.
struct NoEvidence;

#[async_trait]
impl AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

struct NoEffects;

#[async_trait]
impl AgentEffects for NoEffects {
    async fn agents_changed(&self) {}
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
}

/// The recorder's three sessions: Mixy's chat, a coding task and a contact's chat.
struct Callers;

#[async_trait]
impl SetupCallers for Callers {
    async fn scope(&self, _: &ThreadId) -> CallerScope {
        CallerScope::Human
    }
    async fn is_heartbeat(&self, _: &ThreadId) -> bool {
        false
    }
    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError> {
        Ok(match thread.as_str() {
            "sess_home_ada" => "ada".into(),
            _ => "lead".into(),
        })
    }
    async fn agent_mode(&self, thread: &ThreadId) -> bool {
        thread.as_str() != "sess_task_1"
    }
}

fn write_files(base: &Path, files: &Value) {
    for (rel, content) in files.as_object().unwrap() {
        let file = base.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content.as_str().unwrap()).unwrap();
    }
}

/// The data folder as text; a backup folder's timestamp is masked.
fn snapshot(dir: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
                continue;
            }
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let masked = match rel.find("defaults-separation-") {
                Some(at) => {
                    let end = rel[at..].find('/').map_or(rel.len(), |n| at + n);
                    format!("{}defaults-separation-<ts>{}", &rel[..at], &rel[end..])
                }
                None => rel,
            };
            out.insert(masked, String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned());
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// Paths in an answer are the sandbox's.
fn mask(value: Value, data: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace('\\', "/").replace(data, "<data>")),
        Value::Array(list) => Value::Array(list.into_iter().map(|v| mask(v, data)).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, mask(v, data))).collect()),
        other => other,
    }
}

#[tokio::test]
async fn the_actions_answer_and_write_what_the_recorded_node_handlers_did() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/agent-definition-actions-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let worlds = twin["worlds"].as_array().unwrap();
    assert_eq!(worlds.len(), 80);

    let (mut failures, mut calls) = (Vec::new(), 0);
    for world in worlds {
        let name = world["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (shipped, data) = (dir.path().join("shipped"), dir.path().join("data"));
        std::fs::create_dir_all(&shipped).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        write_files(&shipped, &world["shipped"]);
        write_files(&data, &world["data"]);
        let data_text = data.to_string_lossy().replace('\\', "/");

        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let config_path = dir.path().join("mixdog-config.json");
        std::fs::write(&config_path, serde_json::to_vec(&json!({ "agent": world["config"] })).unwrap()).unwrap();
        let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let routes = AgentRoutes::new(config.clone(), &data);
        let main = world["main"].clone();
        let agents = Arc::new(
            AgentDefinitions::new(&shipped, &data, tokens.interactive_io, routes.clone(), Arc::new(NoEvidence), Arc::new(move || main.clone()), dir.path().join("task"))
                .with_writes(tokens.durability_io, Arc::new(NoEffects), Arc::new(|| "2000-01-01T00:00:00.000Z".to_owned())),
        );
        let setup = DefinitionSetup::new(agents, Arc::new(Callers));

        for (index, step) in world["steps"].as_array().unwrap().iter().enumerate() {
            calls += 1;
            let thread = ThreadId::from(twin["callers"][step["caller"].as_str().unwrap()]["id"].as_str().unwrap());
            let action = step["args"]["action"].as_str().unwrap();
            let call = SetupCall { action, args: &step["args"], thread: &thread };
            let got = match setup.run(&call).await {
                Ok(value) => json!({ "ok": mask(value, &data_text) }),
                Err(PortError::Failed { message, .. } | PortError::Denied(message)) => json!({ "error": mask(Value::String(message), &data_text) }),
                Err(other) => panic!("{other:?}"),
            };
            let want = if step.get("ok").is_some() { json!({ "ok": step["ok"] }) } else { json!({ "error": step["error"] }) };
            let at = format!("{name} step {index} {action} {}", step["args"]);
            if got != want {
                failures.push(format!("{at}: answered {got}, Node {want}"));
                break;
            }
            let files = snapshot(&data);
            let recorded: BTreeMap<String, String> =
                step["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            if files != recorded {
                let differs: Vec<&String> = files.keys().chain(recorded.keys()).filter(|k| files.get(*k) != recorded.get(*k)).collect();
                failures.push(format!("{at}: files differ at {differs:?}"));
                break;
            }
            for (query, disabled) in step["disabled"].as_object().unwrap() {
                if routes.is_disabled(query) != disabled.as_bool().unwrap() {
                    failures.push(format!("{at}: disabled({query}) is {}", !disabled.as_bool().unwrap()));
                }
            }
            // The saved config keeps complete routes only; an unwritten one holds what the world gave.
            let complete = |route: &Value| ["provider", "model"].iter().all(|key| route.get(key).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty()));
            let mut kept: Vec<String> = config
                .agent()
                .get("agents")
                .and_then(Value::as_object)
                .map(|agents| agents.iter().filter(|(_, route)| complete(route)).map(|(id, _)| id.clone()).collect())
                .unwrap_or_default();
            kept.sort();
            if json!(kept) != step["routes"] {
                failures.push(format!("{at}: routes {kept:?}, Node {}", step["routes"]));
            }
        }
    }
    assert!(calls > 400);
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}
