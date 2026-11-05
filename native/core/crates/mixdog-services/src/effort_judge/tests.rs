//! The effort judge against the outputs recorded from the Node product
//! (`fixtures/tools/effort-judge/golden.json`): step text, token ids,
//! probabilities and the effort each ladder picks. The model folder comes from
//! `MIXDOG_EFFORT_JUDGE_DIR`, the ONNX Runtime library from `MIXDOG_ORT_LIBRARY`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::step_effort::{StepCall, StepEffortJudge, StepInput, StepResult};
use serde_json::Value;

use crate::effort_judge::input::{step_judge_text, step_result_window};
use crate::effort_judge::ladder::{AutoLadder, StepLadder, resolve_auto_effort};
use crate::effort_judge::model::{JudgeModel, ModelConfig};
use crate::effort_judge::tokenizer::BpeTokenizer;
use crate::effort_judge::{EffortJudge, EffortJudgeModel};

const GOLDEN: &str = include_str!("../../../../fixtures/tools/effort-judge/golden.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden parses")
}

fn config() -> ModelConfig {
    ModelConfig {
        dir: PathBuf::from(std::env::var_os("MIXDOG_EFFORT_JUDGE_DIR").expect("MIXDOG_EFFORT_JUDGE_DIR")),
        explicit: true,
        ort_library: PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY")),
    }
}

fn lane() -> mixdog_rt::CpuBulk {
    mixdog_rt::testing::tokens().cpu_bulk
}

/// The input as the loop hands it over: raw results, not yet windowed.
fn input_of(case: &Value) -> StepInput {
    let i = &case["input"];
    StepInput {
        request: i["request"].as_str().unwrap_or_default().to_owned(),
        step: i["step"].as_u64().unwrap_or(0) as u32,
        plan: i["plan"].as_str().unwrap_or_default().to_owned(),
        calls: i["calls"]
            .as_array()
            .expect("calls")
            .iter()
            .map(|c| StepCall {
                name: c["name"].as_str().unwrap_or_default().to_owned(),
                args: c["args"].as_str().unwrap_or_default().to_owned(),
                result: c["result"].as_str().unwrap_or_default().to_owned(),
            })
            .collect(),
    }
}

fn options(v: &Value) -> Vec<String> {
    v.as_array().expect("options").iter().filter_map(|o| o.as_str().map(str::to_owned)).collect()
}

fn check_resolved(want: &Value, got: Option<crate::effort_judge::ladder::Resolved>, what: &str) {
    match (want.is_null(), got) {
        (true, None) => {}
        (false, Some(got)) => {
            assert_eq!(want["base"], got.base, "{what}: base");
            assert_eq!(want["effort"], got.effort, "{what}: effort");
            assert_eq!(want["step"].as_i64(), Some(i64::from(got.step)), "{what}: step");
            assert_eq!(want["level"].as_u64(), got.level.map(|l| l as u64), "{what}: label");
            let confidence = want["confidence"].as_f64().expect("confidence");
            assert!((confidence - (got.confidence * 1000.0).round() / 1000.0).abs() < 1e-9, "{what}: confidence");
        }
        (want_none, got) => panic!("{what}: want none={want_none}, got {got:?}"),
    }
}

#[test]
fn ladder_matches_recorded_efforts() {
    let g = golden();
    let ladders = g["ladders"].as_array().expect("ladders");
    let all: Vec<(&Value, Vec<f64>)> = g["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .chain(g["ladderCases"].as_array().expect("ladderCases"))
        .map(|c| (c, c["probs"].as_array().expect("probs").iter().filter_map(Value::as_f64).collect()))
        .collect();
    for (case, probs) in &all {
        for (index, ladder) in ladders.iter().enumerate() {
            let got = resolve_auto_effort(ladder["base"].as_str().expect("base"), &options(&ladder["options"]), probs);
            check_resolved(&case["resolved"][index], got, &format!("{probs:?} ladder {index}"));
        }
    }
    let auto = AutoLadder { base: "medium".into(), options: options(&ladders[0]["options"]) };
    assert_eq!(auto.resolve(&[0.9, 0.05, 0.03, 0.02]), Some(StepResult { level: None, effort: Some("low".into()) }));
    assert_eq!(auto.resolve(&[f64::NAN, 0.0, 0.0, 0.0]), Some(StepResult { level: None, effort: Some("medium".into()) }));
}

#[test]
fn step_text_matches_recorded_text() {
    for case in golden()["cases"].as_array().expect("cases") {
        let mut input = input_of(case);
        // Node windows each result before it reaches the judge.
        for call in &mut input.calls {
            call.result = step_result_window(&call.result);
        }
        assert_eq!(step_judge_text(&input), case["text"].as_str().expect("text"), "{}", case["name"]);
    }
}

#[test]
fn token_ids_match_recorded_ids() {
    let c = config();
    let tokenizer = BpeTokenizer::load(&c.dir.join("tokenizer.json")).expect("tokenizer loads");
    for case in golden()["cases"].as_array().expect("cases") {
        let text = case["text"].as_str().expect("text");
        let want: Vec<u32> = case["ids"].as_array().expect("ids").iter().filter_map(|v| v.as_u64().map(|v| v as u32)).collect();
        let room = 256 - tokenizer.prefix.len() - tokenizer.suffix.len();
        let got: Vec<u32> = tokenizer
            .prefix
            .iter()
            .copied()
            .chain(tokenizer.encode(text).into_iter().take(room))
            .chain(tokenizer.suffix.iter().copied())
            .collect();
        assert_eq!(got, want, "{}", case["name"]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn probabilities_and_efforts_match_the_node_judge() {
    let model = EffortJudgeModel::new(config(), lane()).expect("model");
    let g = golden();
    let ladders = g["ladders"].as_array().expect("ladders");
    for case in g["cases"].as_array().expect("cases") {
        let probs = model.probs(input_of(case)).await.expect("judges");
        let want: Vec<f64> = case["probs"].as_array().expect("probs").iter().filter_map(Value::as_f64).collect();
        assert_eq!(probs.len(), want.len());
        for (got, want) in probs.iter().zip(&want) {
            assert!((got - want).abs() < 1e-6, "{}: {probs:?} vs {want:?}", case["name"]);
        }
        for (index, ladder) in ladders.iter().enumerate() {
            let judge = EffortJudge::new(
                model.clone(),
                Arc::new(AutoLadder { base: ladder["base"].as_str().expect("base").into(), options: options(&ladder["options"]) }),
            );
            let judged = judge.judge(input_of(case)).await;
            let want = &case["resolved"][index];
            let want_effort = want.get("effort").and_then(Value::as_str).map(str::to_owned);
            assert_eq!(judged.and_then(|r| r.effort), want_effort, "{} ladder {index}", case["name"]);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_model_answers_none_without_hanging() {
    let dir = tempfile::tempdir().expect("dir");
    let model = EffortJudgeModel::new(
        ModelConfig { dir: dir.path().to_owned(), explicit: false, ort_library: PathBuf::from("unused") },
        lane(),
    ).expect("model");
    let judge = EffortJudge::new(model, Arc::new(AutoLadder { base: "medium".into(), options: vec!["low".into(), "medium".into()] }));
    let case = &golden()["cases"][0];
    let answer = tokio::time::timeout(Duration::from_secs(5), judge.judge(input_of(case))).await.expect("answers");
    assert_eq!(answer, None);
    // The failure is remembered: asking again answers at once.
    let again = tokio::time::timeout(Duration::from_secs(5), judge.judge(input_of(case))).await.expect("answers");
    assert_eq!(again, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_corrupt_model_answers_none() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(dir.path().join("model.onnx"), b"not an onnx model").expect("write");
    std::fs::write(dir.path().join("tokenizer.json"), b"{}").expect("write");
    let model = EffortJudgeModel::new(
        ModelConfig { dir: dir.path().to_owned(), explicit: true, ..config() },
        lane(),
    ).expect("model");
    let case = &golden()["cases"][0];
    let err = tokio::time::timeout(Duration::from_secs(10), model.probs(input_of(case))).await.expect("answers").expect_err("fails");
    assert!(matches!(err, crate::effort_judge::error::JudgeError::Load(_)), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_judgments_all_complete_and_dropping_one_does_not_block_the_rest() {
    let model = EffortJudgeModel::new(config(), lane()).expect("model");
    let g = golden();
    let cases = g["cases"].as_array().expect("cases");
    let mut tasks = Vec::new();
    for case in cases.iter().cycle().take(6) {
        let (model, input) = (model.clone(), input_of(case));
        tasks.push(tokio::spawn(async move { model.probs(input).await }));
    }
    // A judgment whose caller gives up (the run was cancelled) is dropped mid-wait.
    let dropped = tokio::spawn({
        let model = model.clone();
        let input = input_of(&cases[1]);
        async move { model.probs(input).await }
    });
    dropped.abort();
    for task in tasks {
        let probs = tokio::time::timeout(Duration::from_secs(60), task).await.expect("completes").expect("joins").expect("judges");
        assert_eq!(probs.len(), 4);
        assert!((probs.iter().sum::<f64>() - 1.0).abs() < 1e-9);
    }
}

#[test]
fn a_model_without_step_support_is_refused() {
    let dir = tempfile::tempdir().expect("dir");
    let c = config();
    for file in ["model.onnx", "tokenizer.json"] {
        std::fs::copy(c.dir.join(file), dir.path().join(file)).expect("copy");
    }
    std::fs::write(dir.path().join("calibration.json"), r#"{"temperature":1.55,"maxTokens":256}"#).expect("write");
    let model = JudgeModel::load(&ModelConfig { dir: dir.path().to_owned(), ..c }).expect("loads");
    let case = &golden()["cases"][0];
    let err = model.probs(&input_of(case)).expect_err("refused");
    assert!(matches!(err, crate::effort_judge::error::JudgeError::StepsUnsupported));
}

#[test]
fn a_custom_route_snaps_onto_its_own_levels() {
    use crate::effort_judge::ladder::CustomLadder;
    use mixdog_ai::providers::custom::Protocol;
    use mixdog_ai::providers::custom::reasoning::ReasoningRow;
    let row = |levels: Option<&[&str]>| ReasoningRow {
        reasoning_levels: levels.map(|l| l.iter().map(|s| (*s).to_owned()).collect()),
        ..ReasoningRow::default()
    };
    let ladder = |levels: Option<&[&str]>| CustomLadder {
        base: "medium".into(),
        row: row(levels),
        protocol: Protocol::OpenaiChat,
        base_url: "https://api.example.com/v1".into(),
    };
    let hard = [0.02, 0.1, 0.8, 0.08];
    let high = StepResult { level: Some("high".into()), effort: Some("high".into()) };
    assert_eq!(ladder(Some(&["low", "medium", "high"])).resolve(&hard), Some(high));
    // The route offers no high: the request is never promoted past what it supports.
    let capped = ladder(Some(&["low", "medium"])).resolve(&hard);
    assert_eq!(capped, Some(StepResult { level: Some("medium".into()), effort: Some("medium".into()) }));
    // A row that declares no levels cannot place a step.
    assert_eq!(ladder(None).resolve(&hard), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn status_follows_load_failure_and_ticks_on_each_change() {
    use crate::tool_state::StateTick;
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(dir.path().join("model.onnx"), b"not an onnx model").expect("write");
    std::fs::write(dir.path().join("tokenizer.json"), b"{}").expect("write");
    let tick = StateTick::default();
    let rx = tick.subscribe();
    let model = EffortJudgeModel::with_options(
        ModelConfig { dir: dir.path().to_owned(), explicit: true, ..config() },
        lane(),
        crate::effort_judge::judge::JudgeOptions { tick, ..Default::default() },
    )
    .expect("model");
    let before = model.status();
    assert!(before.available && !before.ready && !before.installing && before.last_error.is_empty());
    assert_eq!(before.info["model"], "EmbeddingGemma 2 (18 layers)");
    assert_eq!(before.info["modelBytes"], 17);
    let case = &golden()["cases"][0];
    model.probs(input_of(case)).await.expect_err("load fails");
    let after = model.status();
    assert!(!after.ready && after.last_error.starts_with("effort judge load failed"), "{}", after.last_error);
    assert_eq!(*rx.borrow(), 1);
}
