//! The `setup` tool's voice actions (`setVoice` and the `voice` entry of the features status),
//! on the same toggle the Built-in card uses.

use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::setup::VoiceSetup;

/// `publicVoice`: what a setup receipt shows of the voice status.
fn public_voice(status: &Value) -> Value {
    json!({
        "enabled": status["enabled"] == true,
        "installed": status["installed"] == true,
        "components": status["components"],
    })
}

/// `voiceFeatureStatus`: the `voice` member of `status domain:"features"`.
pub fn voice_feature_status(status: &Value) -> Value {
    let mut out = public_voice(status);
    out["installing"] = json!(status["busy"] == true);
    out
}

/// `setVoice`: toggles voice and reports it only when it reached the requested state (enabling
/// installs any missing whisper/ffmpeg component first).
pub async fn set_voice_enabled(setup: &VoiceSetup, enabled: bool) -> Result<Value, PortError> {
    let result = setup.toggle(Some(enabled)).await;
    let status = setup.status().await;
    if (status["enabled"] == true) != enabled || (enabled && status["installed"] != true) {
        let state = if enabled { "installed and enabled" } else { "disabled" };
        let reason = result.notice_error().map(|e| format!(": {e}")).unwrap_or_default();
        return Err(PortError::Failed {
            capability: "voice".into(),
            message: format!("Voice did not reach the requested {state} state{reason}"),
        });
    }
    Ok(json!({"voice": public_voice(&status), "appliesTo": "channel voice transcription and Desktop dictation now"}))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use tokio::sync::Notify;

    use super::super::pipeline::tests::{FakeEngine, FakeTools, install, manifest};
    use super::super::pipeline::{VoicePipeline, VoiceSettingsSource};
    use super::super::setup::{Missing, VoiceEnabledStore, VoiceInstaller};
    use super::*;

    /// `voice.enabled` as one flag the config store writes and the pipeline reads.
    struct Flag(Arc<AtomicBool>);
    impl VoiceSettingsSource for Flag {
        fn voice_section(&self) -> Value {
            json!({"enabled": self.0.load(Ordering::SeqCst)})
        }
    }

    struct Store {
        flag: Arc<AtomicBool>,
        fail_off: Option<&'static str>,
    }
    #[async_trait]
    impl VoiceEnabledStore for Store {
        async fn write_enabled(&self, enabled: bool, proceed: &(dyn Fn() -> bool + Send + Sync)) -> Result<bool, String> {
            if !enabled && let Some(error) = self.fail_off {
                return Err(error.to_owned());
            }
            if !proceed() {
                return Ok(false);
            }
            self.flag.store(enabled, Ordering::SeqCst);
            Ok(true)
        }
    }

    struct Installer {
        dir: std::path::PathBuf,
        fail: Option<&'static str>,
        gate: Option<Arc<Notify>>,
    }
    #[async_trait]
    impl VoiceInstaller for Installer {
        async fn install(&self, _: Missing) -> Result<(), String> {
            if let Some(gate) = &self.gate {
                gate.notified().await;
            }
            if let Some(error) = self.fail {
                return Err(error.to_owned());
            }
            install(&self.dir);
            Ok(())
        }
    }

    fn setup(dir: &std::path::Path, enabled: bool, fail_off: Option<&'static str>, installer: Installer) -> Arc<VoiceSetup> {
        let flag = Arc::new(AtomicBool::new(enabled));
        let pipeline = Arc::new(VoicePipeline::new(dir.to_owned(), manifest(), Arc::new(Flag(flag.clone())), Arc::new(FakeEngine::default()), Arc::new(FakeTools::default()), mixdog_rt::testing::tokens().durability_io));
        Arc::new(VoiceSetup::new(pipeline, Arc::new(Store { flag, fail_off }), Arc::new(installer)))
    }

    fn twin() -> Value {
        let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
        serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/setup-local-voice-twin.json")).unwrap()).unwrap()
    }

    /// Node's `setVoice` over each scripted toggle outcome: the receipt or the failure text.
    #[tokio::test]
    async fn the_voice_action_answers_what_node_recorded_for_each_toggle_outcome() {
        let mut checked = 0;
        for case in twin()["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "voice") {
            let scenario = case["scenario"].as_str().unwrap();
            let target = case["calls"][0]["args"][0].as_bool().unwrap();
            // `incomplete` scripts a state the real toggle never reports without a notice.
            let intended = match scenario {
                "enabled" | "busy" | "installFailed" => true,
                "disabled" | "offFailed" => false,
                _ => continue,
            };
            if target != intended {
                continue;
            }
            let dir = tempfile::tempdir().unwrap();
            let mut installer = Installer { dir: dir.path().to_owned(), fail: None, gate: None };
            let result = match scenario {
                "enabled" => set_voice_enabled(&setup(dir.path(), false, None, installer), true).await,
                "disabled" => {
                    install(dir.path());
                    set_voice_enabled(&setup(dir.path(), true, None, installer), false).await
                }
                "offFailed" => {
                    install(dir.path());
                    set_voice_enabled(&setup(dir.path(), true, Some("config is locked"), installer), false).await
                }
                "installFailed" => {
                    installer.fail = Some("sha256 mismatch");
                    set_voice_enabled(&setup(dir.path(), false, None, installer), true).await
                }
                _ => {
                    // A second request while the install runs.
                    let gate = Arc::new(Notify::new());
                    installer.gate = Some(gate.clone());
                    let voice = setup(dir.path(), false, None, installer);
                    let first = tokio::spawn({
                        let voice = voice.clone();
                        async move { set_voice_enabled(&voice, true).await }
                    });
                    while voice.status().await["busy"] != true {
                        tokio::task::yield_now().await;
                    }
                    let second = set_voice_enabled(&voice, true).await;
                    gate.notify_one();
                    first.await.unwrap().unwrap();
                    second
                }
            };
            match (case.get("error").and_then(Value::as_str), result) {
                (Some(expected), Err(PortError::Failed { message, .. })) => assert_eq!(message, expected, "{case}"),
                (None, Ok(value)) => {
                    assert_eq!(value["voice"], case["receipt"]["voice"], "{case}");
                    assert_eq!(value["appliesTo"], case["receipt"]["appliesTo"], "{case}");
                }
                (expected, got) => panic!("{case}: expected {expected:?}, got {got:?}"),
            }
            checked += 1;
        }
        assert_eq!(checked, 8, "enabled x2, disabled, busy x2, installFailed x2, offFailed");
    }

    #[test]
    fn feature_status_adds_installing_to_the_public_view() {
        let status = json!({"enabled": true, "installed": false, "busy": true, "modelId": "standard", "info": {}, "components": {"whisper": true, "model": false, "ffmpeg": true}});
        assert_eq!(
            voice_feature_status(&status),
            json!({"enabled": true, "installed": false, "components": {"whisper": true, "model": false, "ffmpeg": true}, "installing": true})
        );
    }
}
