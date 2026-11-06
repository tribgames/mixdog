use std::collections::HashMap;
use std::sync::Arc;

use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::providers::custom::Protocol;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use super::*;
use crate::config::ConfigLanes;

type EnvCell = Arc<Mutex<HashMap<String, String>>>;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/desktop/settings/turn-auto-effort-twin.json")).unwrap()
}

/// A config over one file the test rewrites per case, and an environment it sets per case.
struct Rig {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    config: Config,
    env: EnvCell,
    durability: DurabilityIo,
}

impl Rig {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixdog-config.json");
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(path.clone(), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        Self { _dir: dir, path, config, env: EnvCell::default(), durability: tokens.durability_io }
    }

    fn env_reader(&self) -> EnvReader {
        let cell = self.env.clone();
        Arc::new(move |name| cell.lock().unwrap().get(name).cloned())
    }

    /// The case's environment and saved `agent` section.
    async fn set(&self, env: &Value, agent: &Value) {
        *self.env.lock().unwrap() = env.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        std::fs::write(&self.path, serde_json::to_vec(&json!({ "agent": agent })).unwrap()).unwrap();
        self.config.reload().await.unwrap();
    }
}

#[tokio::test]
async fn the_source_answers_the_mode_base_and_steps_node_resolved() {
    let rig = Rig::new().await;
    let source = ConfigAutoEffort::new(rig.config.clone(), rig.env_reader());
    let cases = twin();
    for (index, case) in cases["sources"].as_array().unwrap().iter().enumerate() {
        rig.set(&case["env"], &case["agent"]).await;
        assert_eq!(source.mode(), case["mode"], "mode of case {index}: {case}");
        assert_eq!(source.mode_on(), case["mode"] == "on", "mode_on of case {index}");
        assert_eq!(source.base(), case["base"], "base of case {index}: {case}");
        assert_eq!(source.steps_enabled(), case["steps"], "steps of case {index}: {case}");
    }
}

#[test]
fn the_base_is_clamped_to_the_ladder_as_node_does() {
    let cases = twin();
    for case in cases["clamps"].as_array().unwrap() {
        let setting = (!case["absent"].as_bool().unwrap()).then(|| case["setting"].clone());
        let options: Vec<String> = case["options"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_owned()).collect();
        let got = clamp_base(auto_effort_base(setting.as_ref()), &options);
        assert_eq!(json!(got), case["result"], "{case}");
    }
}

// ---- the turn --------------------------------------------------------------------------------------

/// What the case decides, shared with the doubles.
#[derive(Default)]
struct Script {
    configured: bool,
    answer: Option<JudgeAnswer>,
    row: Option<Map<String, Value>>,
    anthropic: Vec<String>,
    judged: Vec<TurnJudgeInput>,
}

#[derive(Clone, Default)]
struct Doubles(Arc<Mutex<Script>>);

#[async_trait]
impl TurnJudge for Doubles {
    async fn judge(&self, input: TurnJudgeInput) -> JudgeAnswer {
        let mut script = self.0.lock().unwrap();
        script.judged.push(input);
        script.answer.clone().expect("the case scripts an answer")
    }
}

#[async_trait]
impl EffortConfiguration for Doubles {
    async fn configured(&self, _: &Header) -> bool {
        self.0.lock().unwrap().configured
    }
}

/// The real decision log, with the warnings captured (the process stderr cannot be).
struct Diagnostics {
    log: EffortDecisionLog,
    warnings: Mutex<Vec<String>>,
}

impl EffortDiagnostics for Diagnostics {
    fn record(&self, entry: Map<String, Value>) {
        self.log.record(entry);
    }
    fn warn(&self, line: &str) {
        self.warnings.lock().unwrap().push(line.to_owned());
    }
}

/// `new Date(ms).toISOString()`.
fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The environment a log mode sets, as `logEnv` in the recorder.
fn log_env(mode: &str, root: &std::path::Path) -> Map<String, Value> {
    let mut env = Map::new();
    let root_text = root.to_string_lossy().into_owned();
    match mode {
        "override" => {
            env.insert("MIXDOG_EFFORT_DECISIONS_LOG".into(), json!(root.join("redirected").join("log.jsonl").to_string_lossy()));
        }
        "data" => {
            env.insert("MIXDOG_DATA_DIR".into(), json!(root_text));
        }
        _ => {
            env.insert("MIXDOG_EFFORT_DECISIONS_LOG".into(), json!(""));
            env.insert("MIXDOG_DATA_DIR".into(), json!(root_text));
        }
    }
    env
}

/// The file once the lane job that writes it has run.
async fn settled(path: &std::path::Path, want: &str) -> Option<String> {
    for _ in 0..500 {
        if let Ok(bytes) = std::fs::read_to_string(path) {
            if bytes.len() >= want.len() {
                return Some(bytes);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    std::fs::read_to_string(path).ok()
}

#[async_trait]
impl LadderSources for Doubles {
    fn cached_row(&self, _: &str, _: &str) -> Option<Map<String, Value>> {
        self.0.lock().unwrap().row.clone()
    }
    async fn rejected(&self, _: &str, _: &str) -> Option<RejectionEntry> {
        None
    }
    fn custom_config(&self, _: &str) -> Option<(Protocol, String)> {
        None
    }
    fn anthropic_levels(&self, _: &str) -> Vec<String> {
        self.0.lock().unwrap().anthropic.clone()
    }
}

/// `promptContentText(content)` for a parsed value.
fn prompt_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                _ => match part.get("type").and_then(Value::as_str) {
                    Some("text") | None => part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    Some("image") => "[Image]".to_owned(),
                    Some(_) => part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
                },
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => value_to_string(other),
    }
}

fn decision_value(decision: &AutoEffortDecision) -> Value {
    json!({
        "base": decision.base, "effort": decision.effort, "step": decision.step, "level": decision.level,
        "confidence": mixdog_js::json_number(decision.confidence), "applied": decision.applied,
        "mode": decision.mode, "request": decision.request,
    })
}

#[tokio::test]
async fn the_first_request_is_judged_as_the_recorded_node_judged_it() {
    let rig = Rig::new().await;
    let doubles = Doubles::default();
    let auto = Arc::new(ConfigAutoEffort::new(rig.config.clone(), rig.env_reader()));
    let diagnostics = Arc::new(Diagnostics {
        log: EffortDecisionLog::new(rig.env_reader(), rig.path.parent().unwrap().join("unused-plugin-data"), rig.durability),
        warnings: Mutex::default(),
    });
    let clock_cell = Arc::new(Mutex::new(0_i64));
    let turn = TurnAutoEffort::new(
        auto,
        Arc::new(doubles.clone()),
        Arc::new(doubles.clone()),
        Arc::new(doubles.clone()),
        diagnostics.clone(),
        {
            let clock_cell = clock_cell.clone();
            Arc::new(move || iso(*clock_cell.lock().unwrap()))
        },
    );
    let cases = twin();
    let mut decided = 0;
    for (index, case) in cases["turns"].as_array().unwrap().iter().enumerate() {
        let root = tempfile::tempdir().unwrap();
        let mut env = case["env"].as_object().unwrap().clone();
        env.extend(log_env(case["log"]["mode"].as_str().unwrap(), root.path()));
        rig.set(&Value::Object(env), &case["agent"]).await;
        *clock_cell.lock().unwrap() = case["log"]["clock"].as_i64().unwrap();
        diagnostics.warnings.lock().unwrap().clear();
        let route = &case["route"];
        {
            let mut script = doubles.0.lock().unwrap();
            *script = Script {
                configured: !case["configured"].is_null(),
                answer: Some(match case["answer"].get("probs") {
                    Some(probs) => JudgeAnswer::Probs {
                        probs: probs.as_array().unwrap().iter().map(|p| p.as_f64().unwrap()).collect(),
                        ms: case["answer"]["ms"].as_u64().unwrap(),
                    },
                    None => JudgeAnswer::Skipped(case["answer"]["skipped"].as_str().unwrap().to_owned()),
                }),
                // A route without a provider object has no cached row (`providerImpl?.getCachedModelInfo?.()`).
                row: route["hasProvider"].as_bool().unwrap().then(|| route["row"].as_object().cloned()).flatten(),
                anthropic: route["anthropicLevels"].as_array().map(|l| l.iter().map(|v| v.as_str().unwrap().to_owned()).collect()).unwrap_or_default(),
                ..Script::default()
            };
        }
        let mut session = case["session"].as_object().unwrap().clone();
        let messages = session.remove("messages").unwrap_or(Value::Null);
        let messages = messages.as_array().cloned().unwrap_or_default();
        let prompt = prompt_content_text(&case["prompt"]);
        let input = TurnAutoEffortInput {
            session_id: &format!("s{index}"),
            header: &session,
            messages: &messages,
            prompt: &prompt,
            injected: case["promptSource"].as_str().is_some_and(|s| !s.is_empty()),
            content_text: &prompt_content_text,
        };
        let options = ladder_facts(&doubles, route["provider"].as_str().unwrap(), route["model"].as_str().unwrap()).await.options;
        assert_eq!(json!(options), case["options"], "options of case {index}: {case}");
        let got = turn.resolve(&input).await;
        let script = doubles.0.lock().unwrap();
        assert_eq!(got.as_ref().map(decision_value).unwrap_or(Value::Null), case["result"], "result of case {index}: {case}");
        let judged: Vec<Value> = script.judged.iter().map(|j| json!({ "request": j.request, "prev": j.prev, "prevRequest": j.prev_request })).collect();
        assert_eq!(json!(judged), case["judged"], "judge input of case {index}: {case}");
        let log_path = root.path().join(case["log"]["path"].as_str().unwrap());
        match case["log"]["bytes"].as_str() {
            Some(want) => assert_eq!(settled(&log_path, want).await.as_deref(), Some(want), "log bytes of case {index}: {case}"),
            None => assert!(!log_path.exists(), "no log of case {index}: {case}"),
        }
        assert_eq!(json!(*diagnostics.warnings.lock().unwrap()), case["warnings"], "warnings of case {index}: {case}");
        decided += usize::from(got.is_some());
    }
    assert!(decided > 300, "the golden decides enough turns: {decided}");
}

#[tokio::test]
async fn the_destination_is_read_at_each_append_as_node_reads_it() {
    let rig = Rig::new().await;
    let log = EffortDecisionLog::new(rig.env_reader(), rig.path.parent().unwrap().join("unused-plugin-data"), rig.durability);
    for (index, case) in twin()["appends"].as_array().unwrap().iter().enumerate() {
        let root = tempfile::tempdir().unwrap();
        let mut want = std::collections::BTreeMap::<String, String>::new();
        for step in case["steps"].as_array().unwrap() {
            let mode = step["mode"].as_str().unwrap();
            *rig.env.lock().unwrap() = log_env(mode, root.path()).into_iter().map(|(k, v)| (k, v.as_str().unwrap().to_owned())).collect();
            let entry: Map<String, Value> = serde_json::from_str(step["entry"].as_str().unwrap()).unwrap();
            let rel = if mode == "override" { "redirected/log.jsonl" } else { "effort-judge/decisions.jsonl" };
            let line = format!("{}\n", step["entry"].as_str().unwrap());
            log.record(entry);
            // Each append lands before the next one switches the destination.
            let so_far = want.entry(rel.to_owned()).or_default();
            so_far.push_str(&line);
            let got = settled(&root.path().join(rel), so_far).await;
            assert_eq!(got.as_deref(), Some(so_far.as_str()), "append sequence {index}");
        }
        for (rel, bytes) in case["files"].as_object().unwrap() {
            let got = std::fs::read_to_string(root.path().join(rel)).ok();
            assert_eq!(got.as_deref(), bytes.as_str(), "{rel} of append sequence {index}");
        }
    }
}