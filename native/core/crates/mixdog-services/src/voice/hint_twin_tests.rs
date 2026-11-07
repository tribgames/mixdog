//! The voice install's hint line against the Node recording (`fixtures/services/voice-progress-twin.json`,
//! `record-voice-progress.mjs`): Node's real `toggleVoice` over scripted download progress on a
//! scripted clock.
//!
//! Two tests, so that no timing assertion shares a run with real file I/O (a paused tokio clock
//! may jump while a blocking read is in flight): the throttle and the text are replayed on the
//! paused clock through the sink alone, with nothing to wait for but `advance`; the toggle flow
//! (the answer, the hint cleared once at the end, whatever the outcome) runs on the real clock
//! and asserts nothing about time.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::pipeline::VoicePipeline;
use super::pipeline::tests::{FakeEngine, FakeTools, Fixed, install, manifest};
use super::setup::{Missing, ProgressHint, ToggleResult, VoiceEnabledStore, VoiceInstaller, VoiceSetup, throttled_hint};
use crate::model_install::{Progress, ProgressSink};

const GOLDEN: &str = include_str!("../../../../fixtures/services/voice-progress-twin.json");

fn cases() -> Vec<Value> {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden["cases"].as_array().unwrap().clone();
    assert!(cases.len() >= 9);
    cases
}

/// The progress events Node's fetcher emits in the scenario, in order: the install stops at the
/// download that fails.
fn events(case: &Value) -> Vec<&Value> {
    let mut all = Vec::new();
    for key in ["whisper", "model", "ffmpeg"] {
        all.extend(case["events"][key].as_array().unwrap());
        if case["fail"] == key {
            break;
        }
    }
    all
}

fn progress(event: &Value) -> Progress {
    Progress { label: event["phase"].as_str().unwrap().to_owned(), downloaded: event["downloaded"].as_u64().unwrap(), total: event["total"].as_u64().unwrap() }
}

#[derive(Default)]
struct Hints(Mutex<Vec<Value>>);

#[async_trait]
impl ProgressHint for Hints {
    fn show(&self, text: String, percent: Option<u8>) {
        self.0.lock().unwrap().push(json!([text, "info", percent]));
    }

    async fn clear(&self) {
        self.0.lock().unwrap().push(json!([""]));
    }
}

/// The text, the percent and the 500 ms throttle, on the paused clock with nothing else running.
#[tokio::test(start_paused = true)]
async fn the_hints_shown_match_the_node_recording() {
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        if case["hints"].as_array().unwrap().is_empty() {
            continue;
        }
        let hints = Arc::new(Hints::default());
        let sink = throttled_hint(hints.clone());
        let mut now = 0;
        for event in events(&case) {
            let at = event["at"].as_u64().unwrap();
            tokio::time::advance(Duration::from_millis(at - now)).await;
            now = at;
            sink(progress(event));
        }
        let mut want = case["hints"].as_array().unwrap().clone();
        assert_eq!(want.pop(), Some(json!([""])), "{name}: the recording ends with the clear");
        assert_eq!(Value::Array(hints.0.lock().unwrap().clone()), Value::Array(want), "{name}: hints shown");
    }
}

struct Store {
    fail: bool,
}

#[async_trait]
impl VoiceEnabledStore for Store {
    async fn write_enabled(&self, _: bool, proceed: &(dyn Fn() -> bool + Send + Sync)) -> Result<bool, String> {
        if self.fail {
            return Err("config locked".into());
        }
        Ok(proceed())
    }
}

/// The installer of a recorded scenario: reports its progress at once (no clock), then installs,
/// fails, is turned off, or stops short, as the scenario says.
struct Replay {
    dir: PathBuf,
    case: Value,
    setup: Mutex<Option<Arc<VoiceSetup>>>,
}

#[async_trait]
impl VoiceInstaller for Replay {
    async fn install(&self, _: Missing, progress_sink: Option<ProgressSink>) -> Result<(), String> {
        if let Some(sink) = &progress_sink {
            for event in events(&self.case) {
                sink(progress(event));
            }
        }
        if let Some(failed) = self.case["fail"].as_str() {
            return Err(format!("{failed} download failed"));
        }
        if self.case["offDuring"] == true {
            let setup = self.setup.lock().unwrap().clone().unwrap();
            setup.toggle(Some(false)).await;
        }
        if self.case["incomplete"] != true {
            install(&self.dir);
        }
        Ok(())
    }
}

/// The answer and the clear: the hint is removed once, last, on every outcome, and the setup path
/// (no hint line) shows nothing.
#[tokio::test]
async fn the_toggle_answers_and_clears_the_hint_as_node_does() {
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let pipeline = Arc::new(VoicePipeline::new(
            dir.path().to_owned(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            Arc::new(FakeEngine::default()),
            Arc::new(FakeTools::default()),
            mixdog_rt::testing::tokens().durability_io,
        ));
        let installer = Arc::new(Replay { dir: dir.path().to_owned(), case: case.clone(), setup: Mutex::default() });
        let setup = Arc::new(VoiceSetup::new(pipeline, Arc::new(Store { fail: case["writeFail"] == true }), installer.clone()));
        *installer.setup.lock().unwrap() = Some(setup.clone());
        let hints = Arc::new(Hints::default());
        let has_line = name != "setup-path-without-hint-line";
        let result = if has_line { setup.toggle_with_hint(Some(true), hints.clone()).await } else { setup.toggle(Some(true)).await };
        let answer = match result {
            ToggleResult::Enabled(enabled) => json!(enabled),
            ToggleResult::Failed(_) => Value::Null,
            other => panic!("{name}: {other:?}"),
        };
        assert_eq!(answer, case["result"], "{name}: answer");
        let shown = hints.0.lock().unwrap().clone();
        if has_line {
            assert_eq!(shown.last(), Some(&json!([""])), "{name}: cleared last");
            assert_eq!(shown.iter().filter(|hint| **hint == json!([""])).count(), 1, "{name}: cleared once");
        } else {
            assert!(shown.is_empty(), "{name}: the setup path shows no hint");
        }
    }
}