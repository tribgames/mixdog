//! Mixy's identity through `LeadService`, the `agent/*Lead*` methods as a connection calls them,
//! against the recording of Node's real editor API
//! (`benchmarks/rust-core/recorders/record-lead-identity.mjs`): every answer (text, error code),
//! the files each call leaves (`.bak` copies, avatar images, set-aside `.corrupt-<ms>` copies) and
//! the number of profile-change publications must equal Node's. Node ran on a pinned data folder
//! and a fixed clock; the replay builds the same folders at the same place and holds the recovery
//! clock at the same instant.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: the folders are seeded and read on the test thread")]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;

use super::lead::LeadAppearance;
use super::lead_service::LeadService;
use super::*;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

struct Quiet;

#[async_trait]
impl AgentEvidence for Quiet {
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

#[derive(Default)]
struct Published(AtomicUsize);

#[async_trait]
impl AgentEffects for Published {
    async fn agents_changed(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
    async fn set_agent_route(&self, _: &str, _: &Value) -> Result<(), String> {
        Ok(())
    }
    async fn delete_owned_routines(&self, _: &str) -> Result<OwnedRoutines, String> {
        Ok(OwnedRoutines::default())
    }
}

fn twin() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/lead-identity-twin.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// The recorder keeps a long text as its size and digest.
fn big(text: String) -> String {
    if mixdog_js::utf16_len(&text) <= 4096 {
        return text;
    }
    format!("big:{}:{:x}", text.len(), sha2::Sha256::digest(text.as_bytes()))
}

fn masked(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(big(text)),
        Value::Array(items) => Value::Array(items.into_iter().map(masked).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| (key, masked(value))).collect()),
        other => other,
    }
}

/// The one thing that differs between two runs of the same code: the random 16 hex digits of
/// the temporary file a failed publication names (`agent.json.mixdog-tmp-<16 hex>`).
fn same_temp_name(text: &str) -> String {
    const MARK: &str = "mixdog-tmp-";
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(MARK) {
        let (head, tail) = rest.split_at(at + MARK.len());
        out.push_str(head);
        let digits = tail.chars().take_while(char::is_ascii_hexdigit).count().min(16);
        out.push_str("<16 hex>");
        rest = &tail[digits..];
    }
    out.push_str(rest);
    out
}

/// A key ending in `/` is a folder.
fn write_files(base: &Path, files: &Value) {
    for (rel, content) in files.as_object().unwrap() {
        let file = base.join(rel);
        if rel.ends_with('/') {
            std::fs::create_dir_all(file).unwrap();
            continue;
        }
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content.as_str().unwrap()).unwrap();
    }
}

fn part_of_identity(rel: &str) -> bool {
    let inside = |folder: &str| rel == folder || rel.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'));
    rel == "agents" || rel == "bots" || inside("agents/lead") || inside("bots/mixy")
}

/// Mixy's two identity folders as the recorder wrote them down.
fn snapshot(data: &Path) -> BTreeMap<String, String> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().path()).collect();
        names.sort();
        for path in names {
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                let inside = rel == "agents/lead" || rel == "bots/mixy" || rel.starts_with("agents/lead/") || rel.starts_with("bots/mixy/");
                if inside && std::fs::read_dir(&path).unwrap().next().is_none() {
                    out.insert(format!("{rel}/"), String::new());
                }
                walk(base, &path, out);
                continue;
            }
            if !part_of_identity(&rel) {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let image = rel.contains("/avatar/") || [".png", ".gif", ".webp"].iter().any(|ext| rel.ends_with(ext));
            let text = if image {
                format!("b64:{}", base64::engine::general_purpose::STANDARD.encode(&bytes))
            } else {
                big(String::from_utf8_lossy(&bytes).into_owned())
            };
            out.insert(rel, text);
        }
    }
    let mut out = BTreeMap::new();
    if data.exists() {
        walk(data, data, &mut out);
    }
    out
}

async fn open_config(path: &Path, text: &str) -> Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
    Config::open(path.to_owned(), Arc::new(MockStatePublisher::default()), lanes).await.unwrap().0
}

/// The service over folders `shipped` and `data`, the config `config`, and an op store in `state`.
async fn lead_service(shipped: &Path, data: &Path, config: Config, main: Value, state: &Path, published: Arc<Published>) -> LeadService {
    let tokens = mixdog_rt::testing::tokens();
    std::fs::create_dir_all(shipped).unwrap();
    std::fs::create_dir_all(data).unwrap();
    let agents = AgentDefinitions::new(
        shipped,
        data,
        tokens.interactive_io,
        AgentRoutes::new(config.clone(), data),
        Arc::new(Quiet),
        Arc::new(move || main.clone()),
        state.join("task"),
    )
    .with_writes(tokens.durability_io, published, Arc::new(String::new));
    std::fs::create_dir_all(state).unwrap();
    LeadService::new(Arc::new(agents), LeadAppearance::new(config), scopes(state, "agent").await)
}

fn method_of(call: &str) -> &'static str {
    match call {
        "getLeadPersona" => "agent/getLeadPersona",
        "getLeadAgentBody" => "agent/getLeadAgentBody",
        "getLeadStatus" => "agent/getLeadStatus",
        "getLeadHomeRoute" => "agent/getLeadHomeRoute",
        "getLeadAppearance" => "agent/getLeadAppearance",
        "saveLeadPersona" => "agent/saveLeadPersona",
        "saveLeadAgentBody" => "agent/saveLeadAgentBody",
        "setLeadCreated" => "agent/setLeadCreated",
        "saveLeadIdentity" => "agent/saveLeadIdentity",
        "setLeadAppearance" => "agent/setLeadAppearance",
        other => panic!("unknown call {other}"),
    }
}

/// The parameters a connection would send for Node's call `name(...args)`: an `undefined` argument
/// is a key that is not there.
fn params_of(name: &str, step: &Value) -> Value {
    let keys: &[&str] = match name {
        "saveLeadPersona" | "saveLeadAgentBody" => &["text"],
        "setLeadCreated" => &["created", "description"],
        "saveLeadIdentity" => &["payload"],
        "setLeadAppearance" => &["avatar"],
        _ => &[],
    };
    let mut params = serde_json::Map::new();
    for (key, arg) in keys.iter().zip(step["args"].as_array().unwrap()) {
        if arg.get("$undefined").is_none() {
            params.insert((*key).to_owned(), arg.clone());
        }
    }
    Value::Object(params)
}

/// What a refusal says, as the wire carries it: its text and its error code.
fn refusal(error: &CoreError) -> (String, Option<String>) {
    match error {
        CoreError::DomainError { message, code, .. } => (message.as_ref().map(ToString::to_string).unwrap_or_default(), code.as_ref().map(ToString::to_string)),
        other => (other.to_string(), None),
    }
}

/// One call through the service; `n` numbers the op of a mutation.
async fn call(service: &LeadService, name: &str, step: &Value, n: u64) -> Result<Value, CoreError> {
    let method = method_of(name);
    let params = params_of(name, step);
    let req = if name.starts_with("get") { request(method, params, None) } else { request(method, with_op(params, n), Some(n)) };
    value(service, req).await
}

fn check_answer(at: &str, answer: &Result<Value, CoreError>, step: &Value, failures: &mut Vec<String>) {
    match (answer, step.get("ok"), step.get("error")) {
        (Ok(got), Some(want), _) => {
            if &masked(got.clone()) != want {
                failures.push(format!("{at}: answered {got} != {want}"));
            }
        }
        (Err(got), _, Some(want)) => {
            let (text, code) = refusal(got);
            let want_code = step["code"].as_str().map(str::to_owned);
            if Value::String(same_temp_name(&text)) != Value::String(same_temp_name(want.as_str().unwrap())) || code != want_code {
                failures.push(format!("{at}: refused {text:?} ({code:?}) != {want} ({want_code:?})"));
            }
        }
        (got, ok, error) => failures.push(format!("{at}: {got:?} vs ok {ok:?} error {error:?}")),
    }
}

#[tokio::test]
async fn the_lead_service_answers_and_leaves_what_nodes_editor_does() {
    let twin = twin();
    // Node's recovery stamps came from this clock.
    let _clock = mixdog_statefile::fix_recovery_clock(twin["clock"].as_u64().unwrap().into());
    let mut failures = Vec::new();
    for world in twin["worlds"].as_array().unwrap() {
        let name = world["name"].as_str().unwrap();
        let (shipped, data) = (Path::new(world["shippedDir"].as_str().unwrap()).to_owned(), Path::new(world["dataDir"].as_str().unwrap()).to_owned());
        let root = data.parent().unwrap().to_owned();
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&shipped).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        write_files(&shipped, &world["shipped"]);
        write_files(&data, &world["data"]);
        let config = open_config(&root.join("mixdog-config.json"), &serde_json::to_string(&json!({ "agent": world["config"] })).unwrap()).await;
        let published = Arc::new(Published::default());
        let state = tempfile::tempdir().unwrap();
        let service = lead_service(&shipped, &data, config, world["main"].clone(), state.path(), published.clone()).await;
        for (index, step) in world["steps"].as_array().unwrap().iter().enumerate() {
            let call_name = step["name"].as_str().unwrap();
            let answer = call(&service, call_name, step, index as u64 + 1).await;
            let at = format!("{name} #{index} {call_name} {}", step["args"].to_string().chars().take(80).collect::<String>());
            check_answer(&at, &answer, step, &mut failures);
            let count = published.0.load(Ordering::SeqCst) as u64;
            if Some(count) != step["published"].as_u64() {
                failures.push(format!("{at}: {count} publications != {}", step["published"]));
            }
            let want: BTreeMap<String, String> =
                step["files"].as_object().unwrap().iter().map(|(key, text)| (key.clone(), text.as_str().unwrap().to_owned())).collect();
            let got = snapshot(&data);
            if got != want {
                let clip = |text: Option<&String>| text.map(|t| t.chars().take(60).collect::<String>());
                let differ: Vec<String> = got.keys().chain(want.keys()).filter(|key| got.get(*key) != want.get(*key)).map(|key| format!("{key}: {:?} != {:?}", clip(got.get(key)), clip(want.get(key)))).collect();
                failures.push(format!("{at}: files differ: {}", differ.join("; ")));
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}

#[tokio::test]
#[allow(clippy::permissions_set_readonly_false, reason = "the config file is the test's own, on Windows where only the read-only attribute is toggled")]
async fn the_lead_appearance_answers_and_persists_what_nodes_settings_do() {
    let twin = twin();
    let mut failures = Vec::new();
    for (run, recorded) in twin["appearances"].as_array().unwrap().iter().enumerate() {
        let file = Path::new(recorded["configFile"].as_str().unwrap()).to_owned();
        let home = file.parent().unwrap().to_owned();
        let _ = std::fs::remove_dir_all(&home);
        let config = open_config(&file, recorded["seed"].as_str().unwrap()).await;
        let unwritable = recorded["steps"].as_array().unwrap().iter().any(|step| step["name"] == "$makeConfigFileReadOnly");
        let scratch = tempfile::tempdir().unwrap();
        let service = lead_service(&scratch.path().join("shipped"), &scratch.path().join("data"), config, Value::Null, &scratch.path().join("state"), Arc::default()).await;
        for (index, step) in recorded["steps"].as_array().unwrap().iter().enumerate() {
            let call_name = step["name"].as_str().unwrap();
            let at = format!("appearance {run} #{index} {call_name} {}", step["args"]);
            if let Some(read_only) = match call_name {
                "$makeConfigFileReadOnly" => Some(true),
                "$makeConfigFileWritable" => Some(false),
                _ => None,
            } {
                let mut permissions = std::fs::metadata(&file).unwrap().permissions();
                permissions.set_readonly(read_only);
                std::fs::set_permissions(&file, permissions).unwrap();
            } else {
                let answer = call(&service, call_name, step, index as u64 + 1).await;
                if step["error"].is_null() || !unwritable {
                    check_answer(&at, &answer, step, &mut failures);
                } else if answer.is_ok() {
                    // The config store words its own write failure (and Node's temp file name carries
                    // random bytes), so only the refusal and what stays on disk are compared.
                    failures.push(format!("{at}: answered, Node refused with {}", step["error"]));
                }
            }
            let stored = match std::fs::metadata(&file) {
                Err(_) => Value::Null,
                Ok(meta) if meta.is_dir() => json!({ "folder": true }),
                Ok(_) => Value::String(std::fs::read_to_string(&file).unwrap()),
            };
            if stored != step["file"] {
                failures.push(format!("{at}: config file {stored} != {}", step["file"]));
            }
        }
        if file.exists() {
            let mut permissions = std::fs::metadata(&file).unwrap().permissions();
            permissions.set_readonly(false);
            std::fs::set_permissions(&file, permissions).unwrap();
        }
        let _ = std::fs::remove_dir_all(&home);
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}

/// Node's functions take what the caller sent: a number is a persona, a string is not a boolean.
#[tokio::test]
async fn the_service_hands_node_the_arguments_as_sent() {
    let dir = tempfile::tempdir().unwrap();
    let config = open_config(&dir.path().join("mixdog-config.json"), "{}").await;
    let data = dir.path().join("data");
    let service = lead_service(&dir.path().join("shipped"), &data, config, Value::Null, &dir.path().join("state"), Arc::default()).await;
    let lead = data.join("agents/lead");
    let send = |method: &'static str, params: Value, n: u64| value(&service, request(method, with_op(params, n), Some(n)));

    assert_eq!(send("agent/saveLeadPersona", json!({ "text": 42 }), 1).await.unwrap(), json!("42"));
    assert_eq!(std::fs::read_to_string(lead.join("PERSONA.md")).unwrap(), "42\n");
    assert_eq!(send("agent/saveLeadAgentBody", json!({ "text": ["a", 2] }), 2).await.unwrap(), json!("a,2"));
    assert_eq!(send("agent/saveLeadPersona", json!({}), 3).await.unwrap(), json!(""));
    assert!(!lead.join("PERSONA.md").exists());

    for (at, created) in [json!("true"), json!(1), Value::Null].into_iter().enumerate() {
        let refused = send("agent/setLeadCreated", json!({ "created": created }), 10 + at as u64).await.unwrap_err();
        assert_eq!(refusal(&refused).0, "created must be a boolean");
    }
    let refused = send("agent/setLeadCreated", json!({}), 5).await.unwrap_err();
    assert_eq!(refusal(&refused).0, "created must be a boolean");
    assert!(!lead.join("agent.json").exists());

    send("agent/setLeadCreated", json!({ "created": true, "description": 7 }), 6).await.unwrap();
    let manifest: Value = serde_json::from_slice(&std::fs::read(lead.join("agent.json")).unwrap()).unwrap();
    assert_eq!(manifest, json!({ "created": true, "description": "7" }));
}
