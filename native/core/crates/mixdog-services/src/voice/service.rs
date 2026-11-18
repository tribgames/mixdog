//! The `voice/` namespace: `getVoiceStatus`, `toggleVoice`, `transcribeAudio`,
//! `prepareTranscription`. `transcribeAudio` is scoped `global("voice")` by the method table,
//! which is the one transcription queue (length one).

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply, service::Admit};
use mixdog_core_api::ids::{ConnectionId, Method, ThreadId};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::pipeline::VoicePipeline;
use super::setup::{ProgressHint, VoiceSetup};
use crate::lane::{io_on_lane, on_lane};

const MAX_PAYLOAD_CHARS: usize = 40_000_000;

/// The hint line of a thread (Node's `setProgressHint` of that session): the client shows the
/// voice install's progress there. Production: the daemon's `ThreadProgressHints`.
pub trait ProgressHints: Send + Sync {
    fn hint_for(&self, thread: &ThreadId) -> Arc<dyn ProgressHint>;
}

pub struct VoiceService {
    pipeline: Arc<VoicePipeline>,
    setup: Arc<VoiceSetup>,
    hints: Arc<dyn ProgressHints>,
}

/// `Buffer.from(data, 'base64')` (`media.mjs`), as probed on Node: the string is read as UTF-16 code units cut to their low
/// byte (so U+013D is `=` and U+0141 is `A`); both alphabets, padding optional, characters outside the alphabet skipped, and
/// everything from the first `=` ignored; never an error.
pub(crate) fn node_base64(data: &str) -> Vec<u8> {
    let mut symbols: Vec<u8> = data
        .encode_utf16()
        .map(|unit| (unit & 0xff) as u8)
        .take_while(|byte| *byte != b'=')
        .filter_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect();
    // One leftover symbol carries no whole byte.
    if symbols.len() % 4 == 1 {
        symbols.pop();
    }
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(symbols).unwrap_or_default()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_recording(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// Removes the recording and the wav converted from it.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn remove_recording(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("wav"));
}

pub(crate) fn audio_extension(mime: &str) -> &'static str {
    let mime = mime.to_lowercase();
    if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("wav") {
        "wav"
    } else if mime.contains("mp4") || mime.contains("m4a") {
        "m4a"
    } else {
        "webm"
    }
}

fn voice_error(detail: impl Into<String>) -> CoreError {
    CoreError::CapabilityUnavailable {
        capability: "voice".into(),
        detail: detail.into().into(),
    }
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams {
        path: path.into(),
        expected: expected.into(),
    }
}

#[async_trait]
impl DomainService for VoiceService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let value = match req.method.as_str() {
            "voice/getVoiceStatus" => self.setup.status().await,
            "voice/toggleVoice" => {
                let enabled = req.params.get("enabled").and_then(Value::as_bool);
                // Without a thread there is no hint line to show the progress on.
                let result = match req.params.get("threadId").and_then(Value::as_str) {
                    Some(thread) => self.setup.toggle_with_hint(enabled, self.hints.hint_for(&ThreadId(thread.to_owned()))).await,
                    None => self.setup.toggle(enabled).await,
                };
                let mut status = self.setup.status().await;
                status["result"] = result.to_json();
                status
            }
            "voice/transcribeAudio" => self.transcribe_audio(req.params.get("input").unwrap_or(&Value::Null), &req.ctx.cancel).await?,
            "voice/prepareTranscription" if !self.pipeline.settings().enabled => {
                serde_json::json!({"ready": false, "reason": VOICE_DISABLED})
            }
            "voice/prepareTranscription" => self.pipeline.prepare_transcription().await,
            _ => return Err(invalid("method", "voice/*")),
        };
        Ok(Reply::Value(value))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "voice/getVoiceStatus",
            "voice/toggleVoice",
            "voice/transcribeAudio",
            "voice/prepareTranscription",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Buffer.from(data, 'base64')`: unpadded, URL-safe and whitespace-broken input decodes like the padded standard form.
    #[test]
    fn base64_is_read_as_nodes_buffer_reads_it() {
        // Every case below was run through `Buffer.from(s, 'base64').toString('hex')` on Node.
        let recorded: [(&str, &str); 28] = [
            ("aGk=", "6869"),
            ("aGk", "6869"),
            ("aGk==", "6869"),
            ("aGk=====", "6869"),
            ("aGk=garbage", "6869"),
            ("aGk=aGk=", "6869"),
            ("aG k=", "6869"),
            ("aG\nk=", "6869"),
            ("aG\u{2028}k", "6869"),
            ("aGk\0", "6869"),
            ("-_-_", "fbffbf"),
            ("+/+/", "fbffbf"),
            ("a", ""),
            ("Y", ""),
            ("aG", "68"),
            ("aG=k", "68"),
            ("a=Gk", ""),
            ("=aGk", ""),
            ("aGhp=bw", "686869"),
            ("aGhpb", "686869"),
            ("aGhpbG", "6868696c"),
            ("YQ=a", "61"),
            ("aG\u{13d}k=", "68"),
            ("aG\u{141}\u{142}k=", "686001"),
            ("\u{100}aGk", "6869"),
            ("aGk\u{e9}\u{e9}", "6869"),
            ("\u{1f600}aGk", ""),
            ("aG\u{100}\u{13d}k", "68"),
        ];
        for (text, hex) in recorded {
            let got: String = node_base64(text).iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(got, hex, "{text:?}");
        }
    }

    #[test]
    fn extension_follows_the_mime_type() {
        assert_eq!(audio_extension("audio/ogg; codecs=opus"), "ogg");
        assert_eq!(audio_extension("audio/x-wav"), "wav");
        assert_eq!(audio_extension("audio/mp4"), "m4a");
        assert_eq!(audio_extension("audio/webm"), "webm");
    }
}


impl VoiceService {
    pub fn new(pipeline: Arc<VoicePipeline>, setup: Arc<VoiceSetup>, hints: Arc<dyn ProgressHints>) -> Self {
        Self { pipeline, setup, hints }
    }

    async fn transcribe_audio(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, CoreError> {
        let generation = self.setup.off_generation();
        self.require_dictation_enabled(generation)?;
        let data = input.get("data").and_then(Value::as_str).unwrap_or("");
        if data.is_empty() {
            return Err(voice_error("transcribeAudio: audio payload is required"));
        }
        if data.len() > MAX_PAYLOAD_CHARS {
            return Err(voice_error("transcribeAudio: recording too large"));
        }
        let mime = input.get("mimeType").and_then(Value::as_str).unwrap_or("audio/webm");
        let bytes = node_base64(data);
        let path = std::env::temp_dir().join(format!(
            "mixdog-dictation-{}-{}.{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple(),
            audio_extension(mime)
        ));
        let lane = self.pipeline.lane();
        let target = path.clone();
        io_on_lane(lane, move || write_recording(&target, &bytes)).await.map_err(|e| voice_error(e.to_string()))?;
        let attachment = format!("dictation-{}", uuid::Uuid::new_v4());
        let result = match self.require_dictation_enabled(generation) {
            Ok(()) => self.pipeline.transcribe(&path, Some(&attachment), cancel).await.map_err(|e| voice_error(e.0)),
            Err(error) => Err(error),
        };
        let _ = on_lane(lane, move || remove_recording(&path)).await;
        let text = result?;
        self.require_dictation_enabled(generation)?;
        Ok(Value::String(text.unwrap_or_default()))
    }

    fn require_dictation_enabled(&self, generation: u64) -> Result<(), CoreError> {
        if self.pipeline.settings().enabled && self.setup.off_generation() == generation {
            Ok(())
        } else {
            Err(voice_error(VOICE_DISABLED))
        }
    }
}

const VOICE_DISABLED: &str = "Voice transcription is turned off. Turn it on in Extensions to dictate.";
