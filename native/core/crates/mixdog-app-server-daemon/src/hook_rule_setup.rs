//! The hook-rule setup actions (`add_hook_rule`, `set_hook_rule_enabled`, `delete_hook_rule`):
//! `extended-actions.mjs` over the legacy before-tool rule file (`hook-bus/rule-store.mjs`,
//! `rule-file.mjs`). The dispatcher of `SetupService` has already checked the caller and wraps the
//! answer in the receipt, so this only carries the call to the rule file and a failure's message back.
//!
//! Every action is one maintenance-lane job: read the rules (`loadRules`), check the index
//! (`hookRuleAt`), write under the file's lock with a `.bak` (`updateHookRules`).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_mcp::hook_bus::HookObserver;
use mixdog_mcp::hook_bus::config::Unreadable;
use mixdog_mcp::hook_bus::config::read_document;
use mixdog_mcp::hook_bus::rules::normalize_rules;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::compose_domains::EnvReader;
use crate::domain_seams::doctor::HooksStatus;
use crate::domain_seams::hook_status::summarize_rule;

const ACTIONS: &[&str] = &["add_hook_rule", "set_hook_rule_enabled", "delete_hook_rule"];
const RULE_ACTIONS: [&str; 6] = ["allow", "deny", "block", "modify", "rewrite", "ask"];
const RECOVERY: &str = "The rule is removed from the hook rules file; re-adding it with add_hook_rule restores it.";

/// `hookRulesPath(dataDir)`: `MIXDOG_HOOKS_FILE` resolved, else `<data>/hooks.json`.
pub fn hook_rules_path(env: &EnvReader, data_dir: &Path) -> PathBuf {
    match env("MIXDOG_HOOKS_FILE").filter(|file| !file.is_empty()) {
        Some(file) => {
            let path = PathBuf::from(file);
            std::path::absolute(&path).unwrap_or(path)
        }
        None => data_dir.join("hooks.json"),
    }
}

pub struct HookRuleSetup {
    rules_path: PathBuf,
    io: MaintenanceIo,
    /// `rt.hooksStatus()`: the status list a rule index is checked against; reading it records the
    /// parse problems of the hooks files.
    status: Arc<dyn HooksStatus>,
    /// The hook bus's observer (`emit` of the bus): the failure of a toggle's write lands in the
    /// event log the status shows.
    observer: Arc<dyn HookObserver>,
}

impl HookRuleSetup {
    pub fn new(rules_path: PathBuf, io: MaintenanceIo, status: Arc<dyn HooksStatus>, observer: Arc<dyn HookObserver>) -> Self {
        Self { rules_path, io, status, observer }
    }

    async fn on_lane<R: Send + 'static>(&self, job: impl FnOnce(&InLane<MaintenanceIo>) -> R + Send + 'static) -> Result<R, String> {
        let handle = self.io.submit_wait(&CancellationToken::new(), job).await.map_err(|e| e.to_string())?;
        handle.await.map_err(|e| e.to_string())
    }
}

/// JavaScript truthiness of a value that came through JSON.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b || …` over the fields of `rule`.
fn first_truthy<'a>(rule: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|key| rule.get(*key)).find(|value| truthy(value))
}

/// `loadRules()`: the objects of the file's rule list. A missing or damaged file holds none.
fn load_rules(lane: &InLane<MaintenanceIo>, path: &Path) -> Result<Vec<Value>, String> {
    match read_document(lane, path, true) {
        Ok(Some(document)) => Ok(normalize_rules(&document)),
        Ok(None) | Err(Unreadable::Damaged(_)) => Ok(Vec::new()),
        Err(Unreadable::Io(problem)) => Err(problem),
    }
}

fn summaries(rules: &[Value]) -> Vec<Value> {
    rules.iter().enumerate().map(|(index, rule)| summarize_rule(rule, index)).collect()
}

/// `publicHookRule`: rule metadata only. Argument edits may embed credentials, so setup reports
/// their presence, never their contents.
fn public_rule(summary: &Value) -> Value {
    let mut out = Map::new();
    for key in ["index", "enabled", "tool", "action", "match", "cwd", "reason"] {
        if let Some(value) = summary.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    out.insert("hasArgumentEdit".to_owned(), Value::Bool(summary.get("patch").is_some_and(|patch| !patch.is_null())));
    Value::Object(out)
}

fn public_rules(rules: &[Value]) -> Vec<Value> {
    summaries(rules).iter().map(public_rule).collect()
}

/// `hookRuleAt(rt, index)`: the public row whose `index` is `index` in the status list (read from
/// `hooksStatus()`, which records the parse problems of the hooks files as `hook:error` events).
fn rule_at(status: &Value, index: &Value) -> Result<(usize, Value), String> {
    let wanted = index.as_f64().filter(|n| *n >= 0.0 && n.fract() == 0.0);
    let row = status["rules"].as_array().and_then(|rows| rows.iter().find(|row| row["index"].as_f64() == wanted && wanted.is_some()));
    match (row, wanted) {
        (Some(row), Some(at)) => Ok((at as usize, public_rule(row))),
        _ => Err(format!("hook rule {} not found; read status hooks", value_to_string(index))),
    }
}

/// Why an action failed: a write of a toggle (`flushRules`) records a `hook:error` first.
enum Failed {
    Plain(String),
    Flush(String),
}

impl From<String> for Failed {
    fn from(message: String) -> Self {
        Self::Plain(message)
    }
}

/// `ruleFromInput`.
fn rule_from_input(rule: &Value) -> Result<Value, String> {
    let action = first_truthy(rule, &["action", "decision"]).map(value_to_string).unwrap_or_default();
    let action = js_trim(&action).to_lowercase();
    if action.is_empty() || !RULE_ACTIONS.contains(&action.as_str()) {
        return Err("hook rule action must be allow, deny, block, modify, rewrite, or ask".to_owned());
    }
    let mut next = Map::new();
    next.insert("tool".to_owned(), first_truthy(rule, &["tool", "name"]).cloned().unwrap_or_else(|| json!("*")));
    next.insert("action".to_owned(), Value::String(action));
    next.insert("enabled".to_owned(), Value::Bool(rule.get("enabled") != Some(&Value::Bool(false))));
    for field in ["match", "cwd", "reason"] {
        let Some(value) = rule.get(field).filter(|value| !value.is_null()) else { continue };
        let text = value_to_string(value);
        if !js_trim(&text).is_empty() {
            next.insert(field.to_owned(), Value::String(js_trim(&text).to_owned()));
        }
    }
    for field in ["patch", "args"] {
        if let Some(value) = rule.get(field).filter(|value| value.is_object()) {
            next.insert(field.to_owned(), value.clone());
        }
    }
    Ok(Value::Object(next))
}

/// `replaceRules`: the document with its rule list replaced, in the container
/// `normalizeRules` read it from.
fn replace_rules(document: Option<Value>, rules: Vec<Value>) -> Value {
    let rules = Value::Array(rules);
    match document {
        Some(Value::Array(_)) => rules,
        Some(Value::Object(mut map)) => {
            let is_list = |value: Option<&Value>| value.is_some_and(Value::is_array);
            let in_hooks = is_list(map.get("hooks").and_then(|hooks| hooks.get("toolBefore")));
            if is_list(map.get("toolBefore")) {
                map.insert("toolBefore".to_owned(), rules);
            } else if is_list(map.get("beforeTool")) {
                map.insert("beforeTool".to_owned(), rules);
            } else if in_hooks {
                if let Some(hooks) = map.get_mut("hooks").and_then(Value::as_object_mut) {
                    hooks.insert("toolBefore".to_owned(), rules);
                }
            } else {
                map.insert("toolBefore".to_owned(), rules);
            }
            Value::Object(map)
        }
        _ => json!({ "toolBefore": rules }),
    }
}

/// `saveRules(update)` (`updateHookRules`): under the file's lock, the rule objects of the file go
/// through `update` and come back written, the replaced file kept as `.bak`. Answers the new list.
fn save_rules(
    lane: &InLane<MaintenanceIo>,
    path: &Path,
    update: impl FnOnce(Vec<Value>) -> Result<Vec<Value>, String>,
) -> Result<Vec<Value>, String> {
    let mut saved = Vec::new();
    let opts = mixdog_statefile::Opts { backup: true, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::update_json(
        lane,
        path,
        |document| {
            let rules = document.as_ref().map(normalize_rules).unwrap_or_default();
            let next = update(rules)?;
            saved = next.clone();
            Ok::<_, String>(Some(replace_rules(document, next)))
        },
        &opts,
    )
    .map_err(|error| error.to_string())?;
    Ok(saved)
}

fn without_enabled(rule: &Value) -> Value {
    let mut rule = rule.clone();
    if let Some(map) = rule.as_object_mut() {
        map.shift_remove("enabled");
    }
    rule
}

/// `{ ...rule, enabled }`. A rule that is a JSON array spreads into an object keyed by its
/// positions, as in JavaScript.
fn with_enabled(rule: &Value, enabled: bool) -> Value {
    let mut map = match rule {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(position, item)| (position.to_string(), item.clone())).collect(),
        _ => Map::new(),
    };
    map.insert("enabled".to_owned(), Value::Bool(enabled));
    Value::Object(map)
}

fn add_rule(lane: &InLane<MaintenanceIo>, path: &Path, rule: &Value) -> Result<Value, String> {
    let rewrites = ["modify", "rewrite"].iter().any(|kind| rule.get("action").and_then(Value::as_str) == Some(*kind));
    let edits: Vec<&str> = ["patch", "args"].into_iter().filter(|key| rule.get(*key).is_some()).collect();
    if rewrites && edits.len() != 1 {
        return Err(format!("hookRule.{} requires exactly one of patch or args", value_to_string(&rule["action"])));
    }
    if !rewrites && !edits.is_empty() {
        return Err(format!("hookRule.{} applies only to modify or rewrite rules", edits[0]));
    }
    let next = rule_from_input(rule)?;
    let rules = save_rules(lane, path, |mut rules| {
        rules.push(next);
        Ok(rules)
    })?;
    Ok(json!({ "rules": public_rules(&rules) }))
}

/// `setHookRuleEnabled` then `flushHookRules`: the toggle is shown at once and written, against
/// the rule as it was read, before the receipt (the 400 ms debounce of the TUI path has no caller
/// here that does not flush).
fn set_enabled(lane: &InLane<MaintenanceIo>, path: &Path, at: usize, index: &Value, enabled: &Value) -> Result<Value, Failed> {
    let mut rules = load_rules(lane, path)?;
    if at >= rules.len() {
        return Err(Failed::Plain(format!("hook rule not found: {}", value_to_string(index))));
    }
    let enabled = *enabled != Value::Bool(false);
    let base = rules[at].clone();
    rules[at] = with_enabled(&base, enabled);
    let shown = public_rules(&rules);
    save_rules(lane, path, |mut current| {
        // `applyHookRulePatches`, strict: the rule must still be the one the toggle was made on.
        if !current.get(at).is_some_and(|rule| without_enabled(rule) == without_enabled(&base)) {
            return Err(format!("hook rule changed before its pending update could be saved: {at}"));
        }
        current[at] = with_enabled(&current[at], enabled);
        Ok(current)
    })
    .map_err(Failed::Flush)?;
    Ok(json!({ "rules": shown }))
}

fn delete_rule(lane: &InLane<MaintenanceIo>, path: &Path, at: usize, deleted: Value, index: &Value) -> Result<Value, Failed> {
    let rules = save_rules(lane, path, |current| {
        if at >= current.len() {
            return Err(format!("hook rule not found: {}", value_to_string(index)));
        }
        Ok(current.into_iter().enumerate().filter(|(position, _)| *position != at).map(|(_, rule)| rule).collect())
    })?;
    Ok(json!({ "deleted": deleted, "rules": public_rules(&rules), "recovery": RECOVERY }))
}

#[async_trait]
impl SetupActions for HookRuleSetup {
    fn actions(&self) -> &'static [&'static str] {
        ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let failed = |message: String| PortError::Failed { capability: "setup".into(), message };
        let path = self.rules_path.clone();
        let args = call.args.clone();
        // `hookRuleAt` reads the status first, for the actions that address a rule.
        let target = match call.action {
            "add_hook_rule" => None,
            _ => Some(rule_at(&self.status.status().await, &args["ruleIndex"]).map_err(failed)?),
        };
        let action = call.action.to_owned();
        let answer = self
            .on_lane(move |lane| match (action.as_str(), target) {
                ("set_hook_rule_enabled", Some((at, _))) => set_enabled(lane, &path, at, &args["ruleIndex"], &args["enabled"]),
                (_, Some((at, deleted))) => delete_rule(lane, &path, at, deleted, &args["ruleIndex"]),
                (_, None) => add_rule(lane, &path, &args["hookRule"]).map_err(Failed::Plain),
            })
            .await
            .map_err(failed)?;
        answer.map_err(|failure| match failure {
            Failed::Plain(message) => failed(message),
            Failed::Flush(message) => {
                self.observer.emit("hook:error", json!({ "error": format!("debounced hooks save failed: {message}") }));
                failed(message)
            }
        })
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test fixtures are written straight to a temp dir")]
mod tests {
    use mixdog_protocol::ThreadId;

    use super::*;
    use crate::domain_seams::hook_status::HookEventLog;
    use crate::domain_seams::hook_status::HookStatus;

    /// Every step of every recorded case: the receipt text (or the message of the error) and the
    /// hooks file afterwards, as Node's real setup executor over the real rule store produced them;
    /// then the `hook:error` rows the status shows. A case whose error text is the operating
    /// system's (`osText`) is compared by shape.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_hook_rule_actions_answer_as_node_does() {
        let golden: Value = serde_json::from_str(include_str!("../tests/golden/hook_rules.json")).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        for case in golden["cases"].as_array().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            let here = |text: &str| text.replace(&dir.path().to_string_lossy().into_owned(), "{data}");
            let path = dir.path().join("hooks.json");
            if let Some(file) = case["file"].as_str() {
                std::fs::write(&path, file).unwrap();
            }
            if case["bakDir"] == true {
                std::fs::create_dir(dir.path().join("hooks.json.bak")).unwrap();
            }
            std::fs::create_dir(dir.path().join("project")).unwrap();
            let log = HookEventLog::new(dir.path().join("project"));
            let status = HookStatus::new(dir.path().to_path_buf(), tokens.maintenance_io, log.clone(), log.clone());
            let setup = HookRuleSetup::new(path.clone(), tokens.maintenance_io, status.clone(), log.clone());
            let thread = ThreadId::from("t1");
            let mut write_failure = None;
            for step in case["steps"].as_array().unwrap() {
                let args = &step["args"];
                let name = format!("{}: {}", case["name"], args);
                let action = args["action"].as_str().unwrap();
                assert!(setup.actions().contains(&action));
                let answer = setup.run(&SetupCall { action, args, thread: &thread }).await;
                match (answer, step["error"].as_str()) {
                    (Err(PortError::Failed { message, .. }), Some(_)) if case["osText"] == true => write_failure = Some(message),
                    (Err(PortError::Failed { message, .. }), Some(expected)) => assert_eq!(here(&message), expected, "{name}"),
                    (Ok(result), None) => {
                        // The receipt `SetupService` wraps around the answer.
                        let mut receipt = Map::new();
                        receipt.insert("saved".into(), json!(true));
                        receipt.insert("scope".into(), json!("installation"));
                        receipt.insert("appliesTo".into(), json!("subsequent tool calls; no restart required"));
                        receipt.extend(result.as_object().unwrap().clone());
                        assert_eq!(serde_json::to_string_pretty(&Value::Object(receipt)).unwrap(), step["text"].as_str().unwrap(), "{name}");
                    }
                    (other, expected) => panic!("{name}: got {other:?}, wanted error {expected:?}"),
                }
                let file = std::fs::read_to_string(&path).ok();
                assert_eq!(file.as_deref(), step["file"].as_str(), "{name}: the hooks file");
            }
            // One status read, as the doctor or the hooks panel makes.
            let shown = status.status().await;
            let count = shown["counts"]["hook:error"].as_u64().unwrap_or(0);
            let recent: Vec<(String, String)> = shown["recent"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["name"] == "hook:error")
                .map(|entry| (here(entry["summary"].as_str().unwrap()), here(entry["payload"]["error"].as_str().unwrap())))
                .collect();
            let expected = &case["hookErrors"];
            assert_eq!(count, expected["count"].as_u64().unwrap(), "{}: hook:error count", case["name"]);
            if let Some(message) = write_failure {
                // `debounced hooks save failed: <the action's error>`, as the event log lists it.
                let error = format!("debounced hooks save failed: {}", here(&message));
                assert_eq!(recent.len(), 1, "{}", case["name"]);
                assert_eq!(recent[0].1, error, "{}", case["name"]);
                assert!(recent[0].0.starts_with("error=debounced hooks save failed: "), "{}", case["name"]);
                assert!(expected["recent"][0]["error"].as_str().unwrap().starts_with("debounced hooks save failed: "));
            } else {
                let recorded: Vec<(String, String)> = expected["recent"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|entry| (entry["summary"].as_str().unwrap().to_owned(), entry["error"].as_str().unwrap().to_owned()))
                    .collect();
                assert_eq!(recent, recorded, "{}: hook:error rows", case["name"]);
            }
        }
    }

    #[test]
    fn the_rules_file_is_the_environment_override_or_hooks_json() {
        let none: EnvReader = std::sync::Arc::new(|_| None);
        assert_eq!(hook_rules_path(&none, Path::new("/d")), Path::new("/d").join("hooks.json"));
        let blank: EnvReader = std::sync::Arc::new(|_| Some(String::new()));
        assert_eq!(hook_rules_path(&blank, Path::new("/d")), Path::new("/d").join("hooks.json"));
        let set: EnvReader = std::sync::Arc::new(|name| (name == "MIXDOG_HOOKS_FILE").then(|| "rules.json".to_owned()));
        assert!(hook_rules_path(&set, Path::new("/d")).is_absolute());
    }
}
