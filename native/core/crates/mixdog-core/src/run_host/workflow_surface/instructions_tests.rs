//! The mode texts against the Node golden (`fixtures/workflow-surface/orchestration.json`,
//! `record-workflow-orchestration-text.mjs`): what `readInstructionFile` answers for the user's
//! and the shipped file of a mode, and what `orchestrationInstructions` returns.

use std::path::Path;

use mixdog_core_base::support::on_lane;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

use super::Instruction;
use super::OrchestrationTexts;
use super::read_instruction_file;
use crate::run_host::fixture_fs;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/workflow-surface/orchestration.json")).expect("the golden is JSON")
}

fn bytes_of(spec: &Value) -> Vec<u8> {
    match spec.get("hex").and_then(Value::as_str) {
        Some(hex) => (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex byte")).collect(),
        None => vec![spec["fill"].as_u64().expect("fill byte") as u8; spec["len"].as_u64().expect("length") as usize],
    }
}

/// The files a case lays in `folder`: byte specs, folders, or `parentIsFile` (the folder itself is a file).
fn lay(folder: &Path, files: &Value) {
    let Some(files) = files.as_object() else { return };
    if files.get("parentIsFile") == Some(&Value::Bool(true)) {
        fixture_fs::write(folder, b"not a folder");
        return;
    }
    fixture_fs::create_dir_all(folder);
    for (name, spec) in files {
        if spec.get("dir") == Some(&Value::Bool(true)) {
            fixture_fs::create_dir_all(folder.join(name));
        } else {
            fixture_fs::write(folder.join(name), bytes_of(spec));
        }
    }
}

/// A text, or (over 4096 characters) its UTF-16 length and the sha256 of its bytes.
fn expect_text(want: &Value, got: &str, case: &str) {
    match want.get("text").and_then(Value::as_str) {
        Some(text) => assert_eq!(got, text, "{case}"),
        None => {
            assert_eq!(want["len"], got.encode_utf16().count(), "{case}");
            let digest: String = Sha256::digest(got.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(want["sha256"], digest.as_str(), "{case}");
        }
    }
}

fn expect_read(want: &Value, got: Option<Instruction>, case: &str) {
    match (want, got) {
        (Value::Null, None) => {}
        (want, Some(Instruction::Problem(problem))) => assert_eq!(want["problem"], problem.name(), "{case}"),
        (want, Some(Instruction::Text(text))) => expect_text(want, &text, case),
        (want, got) => panic!("{case}: Node read {want}, got {got:?}"),
    }
}

#[tokio::test]
async fn the_mode_texts_and_the_file_decode_equal_nodes() {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let golden = golden();
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let dir = tempfile::tempdir().expect("sandbox");
        let (root, data) = (dir.path().join("root"), dir.path().join("data"));
        fixture_fs::create_dir_all(&root);
        fixture_fs::create_dir_all(&data);
        lay(&data.join("orchestration"), &case["user"]);
        lay(&root.join("orchestration"), &case["shipped"]);
        let mode_file = case["modeFile"].as_str().expect("mode file");
        for (folder, want) in [(&data, &case["readUser"]), (&root, &case["readShipped"])] {
            let path = folder.join("orchestration").join(mode_file);
            let got = on_lane(lane, &CancellationToken::new(), move |lane| read_instruction_file(lane, &path)).await.expect("the lane ran the read");
            expect_read(want, got, name);
        }
        let texts = OrchestrationTexts::new(lane, &root, &data);
        let got = texts.orchestration_instructions(case["mode"].as_str().expect("mode")).await.expect("the lane ran the read");
        expect_text(&case["instructions"], &got, name);
    }
}

/// A lane that cannot run the read is a typed failure, not an empty mode text.
#[tokio::test]
async fn a_refused_lane_read_is_a_typed_failure() {
    let lane = mixdog_rt::testing::tokens().interactive_io;
    let texts = OrchestrationTexts::new(lane, "root", "data");
    let _refusing = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let failure = texts.orchestration_instructions("swarm").await.expect_err("the lane refuses");
    assert!(failure.0.contains("could not be read"), "{failure}");
}
