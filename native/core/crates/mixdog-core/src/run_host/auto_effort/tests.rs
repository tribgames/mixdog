use std::collections::HashMap;
use std::sync::Arc;

use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::providers::custom::Protocol;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use crate::run_host::auto_effort::*;
use crate::run_host::fixture_fs;
use mixdog_core_config::config::ConfigLanes;

type EnvCell = Arc<Mutex<HashMap<String, String>>>;

fn twin() -> Value {
    let text = mixdog_testkit::fixture!("../../fixtures/desktop/settings/turn-auto-effort-twin.json");
    serde_json::from_str(&text).unwrap()
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
        fixture_fs::write_unsynced(&self.path, serde_json::to_vec(&json!({ "agent": agent })).unwrap());
        self.config.reload().await.unwrap();
    }
}

/// Cases per test: each recorded case rewrites the config file and reloads it, so the replay is split into chunks nextest runs in parallel.
const SOURCE_CHUNK: usize = 25;

async fn sources_chunk(chunk: usize) {
    let rig = Rig::new().await;
    let source = ConfigAutoEffort::new(rig.config.clone(), rig.env_reader());
    let cases = twin();
    let cases = cases["sources"].as_array().unwrap();
    let mut ran = 0;
    for (index, case) in cases.iter().enumerate().skip(chunk * SOURCE_CHUNK).take(SOURCE_CHUNK) {
        rig.set(&case["env"], &case["agent"]).await;
        assert_eq!(source.mode(), case["mode"], "mode of case {index}: {case}");
        assert_eq!(source.mode_on(), case["mode"] == "on", "mode_on of case {index}");
        assert_eq!(source.base(), case["base"], "base of case {index}: {case}");
        assert_eq!(source.steps_enabled(), case["steps"], "steps of case {index}: {case}");
        ran += 1;
    }
    assert!(ran > 0, "source chunk {chunk} has no recorded case");
}


mixdog_rt::replay_chunks!(SOURCE_TESTS, #[tokio::test] async sources_chunk; [
    the_source_answers_chunk_00 = 0,
    the_source_answers_chunk_01 = 1,
    the_source_answers_chunk_02 = 2,
    the_source_answers_chunk_03 = 3,
    the_source_answers_chunk_04 = 4,
    the_source_answers_chunk_05 = 5,
    the_source_answers_chunk_06 = 6,
    the_source_answers_chunk_07 = 7,
    the_source_answers_chunk_08 = 8,
    the_source_answers_chunk_09 = 9,
    the_source_answers_chunk_10 = 10,
    the_source_answers_chunk_11 = 11,
    the_source_answers_chunk_12 = 12,
    the_source_answers_chunk_13 = 13,
    the_source_answers_chunk_14 = 14,
    the_source_answers_chunk_15 = 15,
    the_source_answers_chunk_16 = 16,
    the_source_answers_chunk_17 = 17,
    the_source_answers_chunk_18 = 18,
    the_source_answers_chunk_19 = 19,
    the_source_answers_chunk_20 = 20,
    the_source_answers_chunk_21 = 21,
    the_source_answers_chunk_22 = 22,
    the_source_answers_chunk_23 = 23,
    the_source_answers_chunk_24 = 24,
    the_source_answers_chunk_25 = 25,
    the_source_answers_chunk_26 = 26,
    the_source_answers_chunk_27 = 27,
    the_source_answers_chunk_28 = 28,
    the_source_answers_chunk_29 = 29,
    the_source_answers_chunk_30 = 30,
    the_source_answers_chunk_31 = 31,
    the_source_answers_chunk_32 = 32,
    the_source_answers_chunk_33 = 33,
    the_source_answers_chunk_34 = 34,
    the_source_answers_chunk_35 = 35,
    the_source_answers_chunk_36 = 36,
    the_source_answers_chunk_37 = 37,
    the_source_answers_chunk_38 = 38,
]);

/// Every recorded case belongs to one chunk test and every chunk test has recorded cases.
#[test]
fn every_recorded_source_case_has_its_chunk_test() {
    mixdog_rt::testing::assert_chunks_registered(SOURCE_TESTS, twin()["sources"].as_array().unwrap().len(), SOURCE_CHUNK);
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

/// Cases per test: a turn writes its decision log through the durability lane, so the replay is split into chunks nextest runs in parallel.
const TURN_CHUNK: usize = 40;

async fn turns_chunk(chunk: usize) {
    let rig = Rig::new().await;
    let doubles = Doubles::default();
    let auto = Arc::new(ConfigAutoEffort::new(rig.config.clone(), rig.env_reader()));
    let diagnostics = Arc::new(Diagnostics {
        log: EffortDecisionLog::new(rig.env_reader(), rig.path.parent().unwrap().join("unused-plugin-data"), rig.durability, mixdog_rt::testing::tokens().maintenance_io),
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
    // The empty-ladder warning is once per provider/model per process, so a chunk starts with the routes the
    // earlier recorded turns already warned about.
    for earlier in cases["turns"].as_array().unwrap().iter().take(chunk * TURN_CHUNK) {
        for warning in earlier["warnings"].as_array().unwrap() {
            let key = warning.as_str().unwrap().strip_prefix("[auto-effort] no effort ladder for ").unwrap().strip_suffix("; judge skipped\n").unwrap();
            turn.warned.lock().unwrap().insert(key.to_owned());
        }
    }
    let mut ran = 0;
    for (index, case) in cases["turns"].as_array().unwrap().iter().enumerate().skip(chunk * TURN_CHUNK).take(TURN_CHUNK) {
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
        let messages = session.shift_remove("messages").unwrap_or(Value::Null);
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
        assert_eq!(got.as_ref().map(decision_value).unwrap_or(Value::Null), case["result"], "result of case {index}: {case}");
        let judged: Vec<Value> = doubles.0.lock().unwrap().judged.iter().map(|j| json!({ "request": j.request, "prev": j.prev, "prevRequest": j.prev_request })).collect();
        assert_eq!(json!(judged), case["judged"], "judge input of case {index}: {case}");
        diagnostics.log.appended().await;
        let log_path = root.path().join(case["log"]["path"].as_str().unwrap());
        match case["log"]["bytes"].as_str() {
            Some(want) => assert_eq!(fixture_fs::read_to_string(&log_path).ok().as_deref(), Some(want), "log bytes of case {index}: {case}"),
            None => assert!(!fixture_fs::exists(&log_path).unwrap(), "no log of case {index}: {case}"),
        }
        assert_eq!(json!(*diagnostics.warnings.lock().unwrap()), case["warnings"], "warnings of case {index}: {case}");
        ran += 1;
    }
    assert!(ran > 0, "turn chunk {chunk} has no recorded case");
}

mixdog_rt::replay_chunks!(TURN_TESTS, #[tokio::test] async turns_chunk; [
    the_first_request_is_judged_chunk_00 = 0,
    the_first_request_is_judged_chunk_01 = 1,
    the_first_request_is_judged_chunk_02 = 2,
    the_first_request_is_judged_chunk_03 = 3,
    the_first_request_is_judged_chunk_04 = 4,
    the_first_request_is_judged_chunk_05 = 5,
    the_first_request_is_judged_chunk_06 = 6,
    the_first_request_is_judged_chunk_07 = 7,
    the_first_request_is_judged_chunk_08 = 8,
    the_first_request_is_judged_chunk_09 = 9,
    the_first_request_is_judged_chunk_10 = 10,
    the_first_request_is_judged_chunk_11 = 11,
    the_first_request_is_judged_chunk_12 = 12,
    the_first_request_is_judged_chunk_13 = 13,
    the_first_request_is_judged_chunk_14 = 14,
    the_first_request_is_judged_chunk_15 = 15,
    the_first_request_is_judged_chunk_16 = 16,
    the_first_request_is_judged_chunk_17 = 17,
    the_first_request_is_judged_chunk_18 = 18,
    the_first_request_is_judged_chunk_19 = 19,
    the_first_request_is_judged_chunk_20 = 20,
    the_first_request_is_judged_chunk_21 = 21,
    the_first_request_is_judged_chunk_22 = 22,
    the_first_request_is_judged_chunk_23 = 23,
    the_first_request_is_judged_chunk_24 = 24,
    the_first_request_is_judged_chunk_25 = 25,
    the_first_request_is_judged_chunk_26 = 26,
    the_first_request_is_judged_chunk_27 = 27,
    the_first_request_is_judged_chunk_28 = 28,
    the_first_request_is_judged_chunk_29 = 29,
    the_first_request_is_judged_chunk_30 = 30,
    the_first_request_is_judged_chunk_31 = 31,
    the_first_request_is_judged_chunk_32 = 32,
    the_first_request_is_judged_chunk_33 = 33,
    the_first_request_is_judged_chunk_34 = 34,
    the_first_request_is_judged_chunk_35 = 35,
    the_first_request_is_judged_chunk_36 = 36,
    the_first_request_is_judged_chunk_37 = 37,
    the_first_request_is_judged_chunk_38 = 38,
    the_first_request_is_judged_chunk_39 = 39,
    the_first_request_is_judged_chunk_40 = 40,
    the_first_request_is_judged_chunk_41 = 41,
    the_first_request_is_judged_chunk_42 = 42,
    the_first_request_is_judged_chunk_43 = 43,
    the_first_request_is_judged_chunk_44 = 44,
    the_first_request_is_judged_chunk_45 = 45,
    the_first_request_is_judged_chunk_46 = 46,
    the_first_request_is_judged_chunk_47 = 47,
    the_first_request_is_judged_chunk_48 = 48,
    the_first_request_is_judged_chunk_49 = 49,
    the_first_request_is_judged_chunk_50 = 50,
    the_first_request_is_judged_chunk_51 = 51,
    the_first_request_is_judged_chunk_52 = 52,
    the_first_request_is_judged_chunk_53 = 53,
    the_first_request_is_judged_chunk_54 = 54,
    the_first_request_is_judged_chunk_55 = 55,
    the_first_request_is_judged_chunk_56 = 56,
    the_first_request_is_judged_chunk_57 = 57,
    the_first_request_is_judged_chunk_58 = 58,
    the_first_request_is_judged_chunk_59 = 59,
    the_first_request_is_judged_chunk_60 = 60,
    the_first_request_is_judged_chunk_61 = 61,
    the_first_request_is_judged_chunk_62 = 62,
    the_first_request_is_judged_chunk_63 = 63,
    the_first_request_is_judged_chunk_64 = 64,
]);

/// Every recorded turn belongs to one chunk test and every chunk test has recorded turns; the golden decides enough turns.
#[test]
fn every_recorded_turn_has_its_chunk_test() {
    let cases = twin();
    let turns = cases["turns"].as_array().unwrap();
    mixdog_rt::testing::assert_chunks_registered(TURN_TESTS, turns.len(), TURN_CHUNK);
    let decided = turns.iter().filter(|case| !case["result"].is_null()).count();
    assert!(decided > 300, "the golden decides enough turns: {decided}");
}

#[tokio::test]
async fn the_destination_is_read_at_each_append_as_node_reads_it() {
    let rig = Rig::new().await;
    let log = EffortDecisionLog::new(rig.env_reader(), rig.path.parent().unwrap().join("unused-plugin-data"), rig.durability, mixdog_rt::testing::tokens().maintenance_io);
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
            log.appended().await;
            let got = fixture_fs::read_to_string(root.path().join(rel)).ok();
            assert_eq!(got.as_deref(), Some(so_far.as_str()), "append sequence {index}");
        }
        for (rel, bytes) in case["files"].as_object().unwrap() {
            let got = fixture_fs::read_to_string(root.path().join(rel)).ok();
            assert_eq!(got.as_deref(), bytes.as_str(), "{rel} of append sequence {index}");
        }
    }
}

/// The decision log against Node's `decision-log.mjs` (`fixtures/effort-decision-log`): per scenario the
/// files the log found, the entries recorded one by one with a small segment (each record's rotation
/// finished before the next), and every file under the directory afterwards, byte for byte. The data
/// directory's log keeps two segments and counts older lines into the summary; a log redirected by
/// `MIXDOG_EFFORT_DECISIONS_LOG` stays one plain file past the segment.
#[tokio::test]
async fn the_decision_log_keeps_two_segments_and_counts_older_lines_as_node_does() {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let golden: Value = serde_json::from_str(&mixdog_testkit::fixture!("../../fixtures/effort-decision-log/golden.json")).unwrap();
    let rig = Rig::new().await;
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        for (rel, bytes) in scenario["before"].as_object().unwrap() {
            fixture_fs::write_unsynced(root.path().join(rel), b64.decode(bytes.as_str().unwrap()).unwrap());
        }
        *rig.env.lock().unwrap() = log_env(scenario["log"].as_str().unwrap(), root.path()).into_iter().map(|(k, v)| (k, v.as_str().unwrap().to_owned())).collect();
        let log = EffortDecisionLog::new(rig.env_reader(), root.path().join("unused-plugin-data"), rig.durability, mixdog_rt::testing::tokens().maintenance_io)
            .with_segment_bytes(scenario["segmentBytes"].as_u64().unwrap());
        for line in scenario["entries"].as_array().unwrap() {
            log.record(serde_json::from_str(line.as_str().unwrap()).unwrap());
            log.appended().await;
        }
        let want: std::collections::BTreeMap<String, Vec<u8>> =
            scenario["after"].as_object().unwrap().iter().map(|(rel, bytes)| (rel.clone(), b64.decode(bytes.as_str().unwrap()).unwrap())).collect();
        let got = fixture_fs::files_under(root.path());
        let text = |files: &std::collections::BTreeMap<String, Vec<u8>>| files.iter().map(|(rel, bytes)| (rel.clone(), String::from_utf8_lossy(bytes).into_owned())).collect::<Vec<_>>();
        assert_eq!(text(&got), text(&want), "files of scenario {name}");
        assert_eq!(got, want, "bytes of scenario {name}");
    }
}