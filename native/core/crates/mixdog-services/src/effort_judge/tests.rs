//! The effort judge against the outputs recorded from the Node product
//! (`fixtures/tools/effort-judge/golden.json`): step text, token ids,
//! probabilities and the effort each ladder picks. The model folder comes from
//! `MIXDOG_EFFORT_JUDGE_DIR`, the ONNX Runtime library from `MIXDOG_ORT_LIBRARY`.

use std::path::PathBuf;

use mixdog_agent::step_effort::StepResult;

use crate::effort_judge::ladder::StepLadder;
use crate::effort_judge::model::{JudgeModel, ModelConfig, OrtRuntime};
use crate::effort_judge::EffortJudgeModel;




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

fn lane() -> crate::effort_judge::JudgeLanes {
    crate::effort_judge::JudgeLanes::of(&mixdog_rt::testing::tokens())
}
#[tokio::test(flavor = "multi_thread")]
async fn step_support_follows_calibration_steps_one_and_is_read_once() {
    let judge_in = |dir: &std::path::Path| {
        EffortJudgeModel::new(ModelConfig { dir: dir.to_owned(), explicit: true, ort_library: OrtRuntime::Library(PathBuf::from("unused")) }, lane()).expect("model")
    };
    let dir = tempfile::tempdir().expect("dir");
    // Not installed: no steps.
    assert!(!judge_in(dir.path()).supports_steps().await);
    for (text, want) in [(r#"{"steps":1}"#, true), (r#"{"steps":1.0}"#, true), (r#"{"steps":0}"#, false), (r#"{"steps":"1"}"#, false), (r#"{"steps":true}"#, false), ("{}", false), ("not json", false)] {
        std::fs::write(dir.path().join("calibration.json"), text).expect("write");
        assert_eq!(judge_in(dir.path()).supports_steps().await, want, "{text}");
    }
    // Read once per instance, as Node does per directory.
    std::fs::write(dir.path().join("calibration.json"), r#"{"steps":1}"#).expect("write");
    let model = judge_in(dir.path());
    assert!(model.supports_steps().await);
    std::fs::write(dir.path().join("calibration.json"), r#"{"steps":0}"#).expect("write");
    assert!(model.supports_steps().await);
}
/// Node's `onnxRuntimeSupported()` false (macOS Intel, no binding): the judge answers as Node does there and
/// never tries to load a library.
#[tokio::test]
async fn a_platform_without_a_binding_answers_unsupported_and_never_loads() {
    let dir = tempfile::tempdir().unwrap();
    let config = ModelConfig { dir: dir.path().to_owned(), explicit: true, ort_library: OrtRuntime::NoBinding };
    assert!(!config.runtime_supported());
    assert!(matches!(JudgeModel::load(&config, lane().thread), Err(crate::effort_judge::error::JudgeError::Unsupported)));
    let judge = EffortJudgeModel::new(config, lane()).unwrap();
    assert!(!judge.is_available());
}
/// A known library on a platform that has a binding: the judge is supported and reaches the model files.
#[tokio::test]
async fn a_known_library_leaves_the_judge_to_the_installed_files() {
    let dir = tempfile::tempdir().unwrap();
    let config = ModelConfig { dir: dir.path().to_owned(), explicit: true, ort_library: OrtRuntime::Library(dir.path().join("ort")) };
    assert_eq!(config.runtime_supported(), crate::tool_state::onnx_runtime_supported());
    if config.runtime_supported() {
        assert!(matches!(JudgeModel::load(&config, lane().thread), Err(crate::effort_judge::error::JudgeError::NotInstalled(_))));
    }
}


