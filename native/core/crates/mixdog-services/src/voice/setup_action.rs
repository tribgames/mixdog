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

#[cfg(test)]
mod tests {


    use super::*;




    #[test]
    fn feature_status_adds_installing_to_the_public_view() {
        let status = json!({"enabled": true, "installed": false, "busy": true, "modelId": "standard", "info": {}, "components": {"whisper": true, "model": false, "ffmpeg": true}});
        assert_eq!(
            voice_feature_status(&status),
            json!({"enabled": true, "installed": false, "components": {"whisper": true, "model": false, "ffmpeg": true}, "installing": true})
        );
    }



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
/// `rt.setVoiceEnabled(enabled)` (`media-api.mjs`): the same toggle the Built-in card uses, then
/// the state read back. `error` is the last warning or failure the toggle reported (none: null);
/// whether the state is the one asked for is the setup dispatcher's to judge.
pub async fn voice_toggle_answer(setup: &VoiceSetup, enabled: bool) -> Value {
    let result = setup.toggle(Some(enabled)).await;
    json!({"status": setup.status().await, "error": result.notice_error()})
}
