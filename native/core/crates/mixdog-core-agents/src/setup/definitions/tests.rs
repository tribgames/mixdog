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
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_ports::ports::setup_actions::CallerScope;

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

/// The agent golden never names the workflow or skill kinds.
struct Unused;

#[async_trait]
impl mixdog_core_api::service::DomainService for Unused {
    fn methods(&self) -> &'static [&'static str] {
        &[]
    }
    async fn call(&self, _: mixdog_core_api::CoreRequest) -> Result<mixdog_core_api::Reply, CoreError> {
        panic!("a workflow or skill service was called by the agent golden")
    }
    fn notify(&self, _: mixdog_core_api::ids::Method, _: Value, _: mixdog_core_api::ids::ConnectionId) -> mixdog_core_api::service::Admit {
        unreachable!("no notifications")
    }
}

/// Remembers the routes a save sent to the route setter.
#[derive(Default)]
struct NoEffects(std::sync::Mutex<Vec<Value>>);

#[async_trait]
impl AgentEffects for NoEffects {
    async fn agents_changed(&self) {}
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
    async fn set_agent_route(&self, id: &str, route: &Value) -> Result<(), String> {
        self.0.lock().unwrap().push(json!({ "id": id, "route": route }));
        Ok(())
    }
    async fn delete_owned_routines(&self, _: &str) -> Result<crate::agents::OwnedRoutines, String> {
        Ok(crate::agents::OwnedRoutines::default())
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
            // Images are bytes; everything else is text.
            let bytes = std::fs::read(&path).unwrap();
            let is_image = (masked.starts_with("bots/") || masked.starts_with("agents/")) && (masked.contains("/avatar/") || masked.ends_with(".png"));
            let text = if is_image {
                use base64::Engine as _;
                format!("b64:{}", base64::engine::general_purpose::STANDARD.encode(&bytes))
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            };
            out.insert(masked, text);
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// Paths in an answer are the sandbox's.
fn mask(value: Value, data: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(data, "<data>")),
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
        let data_text = data.to_string_lossy().into_owned();

        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let config_path = dir.path().join("mixdog-config.json");
        std::fs::write(&config_path, serde_json::to_vec(&json!({ "agent": world["config"] })).unwrap()).unwrap();
        let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let routes = AgentRoutes::new(config.clone(), &data);
        let main = world["main"].clone();
        let effects = Arc::new(NoEffects::default());
        let agents = Arc::new(
            AgentDefinitions::new(&shipped, &data, tokens.interactive_io, routes.clone(), Arc::new(NoEvidence), Arc::new(move || main.clone()), dir.path().join("task"))
                .with_writes(tokens.durability_io, effects.clone(), Arc::new(|| "2000-01-01T00:00:00.000Z".to_owned())),
        );
        let setup = DefinitionSetup::new(agents.clone(), Arc::new(Callers), Arc::new(Unused), Arc::new(Unused));

        for (index, step) in world["steps"].as_array().unwrap().iter().enumerate() {
            calls += 1;
            let thread = ThreadId::from(twin["callers"][step["caller"].as_str().unwrap()]["id"].as_str().unwrap());
            let action = step["args"]["action"].as_str().unwrap();
            let call = SetupCall { action, args: &step["args"], thread: &thread };
            let got = if let Some(editor) = step.get("editor") {
                // A save that goes to the editor itself; `$current` is the revision the caller loaded.
                let mut payload = editor["payload"].as_object().unwrap().clone();
                if payload.get("expectedRevision") == Some(&json!("$current")) {
                    let id = payload.get("id").map(mixdog_core_config::workflow::ids::js_string).unwrap_or_default();
                    let revision = agents.get(&id).await.ok().map(|view| view["revision"].clone()).unwrap_or(json!("missing"));
                    payload.insert("expectedRevision".into(), revision);
                }
                let options = crate::agents::SaveOptions { no_widen: editor["options"]["noWiden"] == true, approved: None };
                match agents.save_with(&payload, options).await {
                    Ok(value) => json!({ "ok": mask(value, &data_text) }),
                    Err(error) => json!({ "error": mask(Value::String(error.to_string()), &data_text) }),
                }
            } else {
                match setup.run(&call).await {
                    Ok(value) => json!({ "ok": mask(value, &data_text) }),
                    Err(PortError::Failed { message, .. } | PortError::Denied(message)) => json!({ "error": mask(Value::String(message), &data_text) }),
                    Err(other) => panic!("{other:?}"),
                }
            };
            let want = if step.get("ok").is_some() { json!({ "ok": step["ok"] }) } else { json!({ "error": step["error"] }) };
            let at = format!("{name} step {index} {action} {}", step["args"]);
            let files = snapshot(&data);
            let recorded: BTreeMap<String, String> =
                step["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            if files != recorded {
                let differs: Vec<String> = files
                    .keys()
                    .chain(recorded.keys())
                    .filter(|k| files.get(*k) != recorded.get(*k))
                    .map(|k| format!("{k}: {:?} / Node {:?}", files.get(k), recorded.get(k)))
                    .collect();
                failures.push(format!("{at}: files differ at {differs:?}"));
                break;
            }
            if got != want {
                failures.push(format!("{at}: answered {got}, Node {want}"));
                break;
            }
            if Value::Array(effects.0.lock().unwrap().clone()) != step["routeCalls"] {
                failures.push(format!("{at}: route calls {:?}, Node {}", effects.0.lock().unwrap(), step["routeCalls"]));
            }
            for (query, disabled) in step["disabled"].as_object().unwrap() {
                if routes.is_disabled(query) != disabled.as_bool().unwrap() {
                    failures.push(format!("{at}: disabled({query}) is {}", !disabled.as_bool().unwrap()));
                }
            }
            let mut kept: Vec<String> = config
                .agent()
                .get("agents")
                .and_then(Value::as_object)
                .map(|agents| agents.keys().cloned().collect())
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

#[tokio::test]
async fn a_route_sent_with_a_save_goes_to_the_route_setter_after_the_files() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let effects = Arc::new(NoEffects::default());
    let agents = AgentDefinitions::new(dir.path(), dir.path(), tokens.interactive_io, AgentRoutes::new(config, dir.path()), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.path().join("task"))
        .with_writes(tokens.durability_io, effects.clone(), Arc::new(String::new));
    let route = json!({ "provider": "openai", "model": "gpt-6" });
    let payload = json!({ "name": "Routed", "body": "Body", "route": route }).as_object().unwrap().clone();
    let view = agents.save(&payload).await.unwrap();
    assert_eq!(view["id"], "routed");
    assert_eq!(*effects.0.lock().unwrap(), vec![json!({ "id": "routed", "route": route })]);
    // A falsy route is no route.
    let payload = json!({ "id": "routed", "body": "Body", "route": null }).as_object().unwrap().clone();
    agents.save(&payload).await.unwrap();
    assert_eq!(effects.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_name_that_is_no_text_is_an_unknown_agent_not_the_id_undefined() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = Arc::new(
        AgentDefinitions::new(dir.path(), dir.path(), tokens.interactive_io, AgentRoutes::new(config, dir.path()), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.path().join("task"))
            .with_writes(tokens.durability_io, Arc::new(NoEffects::default()), Arc::new(String::new)),
    );
    // An agent that really is called "undefined" and one called "null" exist.
    for id in ["undefined", "null"] {
        agents.save(json!({ "id": id, "body": "Body" }).as_object().unwrap()).await.unwrap();
    }
    let setup = DefinitionSetup::new(agents, Arc::new(Callers), Arc::new(Unused), Arc::new(Unused));
    let thread = ThreadId::from("sess_task_1");
    for (action, args, text) in [
        ("read_definition", json!({ "definitionKind": "agent" }), "undefined"),
        ("read_definition", json!({ "definitionKind": "agent", "name": null }), "null"),
        ("delete_definition", json!({ "definitionKind": "agent" }), "undefined"),
        ("delete_definition", json!({ "definitionKind": "agent", "name": null }), "null"),
    ] {
        let call = SetupCall { action, args: &args, thread: &thread };
        match setup.run(&call).await {
            Err(PortError::Failed { message, .. }) => assert_eq!(message, format!("unknown agent \"{text}\""), "{action} {args}"),
            other => panic!("{action} {args}: {other:?}"),
        }
    }
}
