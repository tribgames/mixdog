//! The managed voice runtime on disk: whisper.cpp (with its server), the model weight and
//! ffmpeg. Resolution is read-only; installing is the [`super::VoiceInstaller`]'s job.
//!
//! Layout under the data dir: `voice-runtime/active-version` names `whisper-<version>-<variant>`;
//! `voice/models/<filename>`; `ffmpeg-runtime/active-version` names `ffmpeg-<version>`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use mixdog_js::JsRegex;
use serde::Serialize;
use serde_json::Value;

pub const SERVER_NAME: &str = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };

/// The parts of the bundled `voice-runtime-manifest.json` that resolution needs, for this host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeManifest {
    pub version: String,
    /// `(variant id, executable relative to the version dir)`.
    pub variants: Vec<(String, String)>,
    pub model_id: String,
    pub model_filename: String,
    pub model_size: u64,
    pub ffmpeg_executable: Option<String>,
}

impl RuntimeManifest {
    /// `platform_key` is `<os>-<arch>` in the manifest's vocabulary (`win32-x64`, `linux-x64`).
    pub fn from_json(manifest: &Value, platform_key: &str, model: &str) -> Option<Self> {
        let model_entry = manifest
            .pointer(&format!("/models/{model}"))
            .or_else(|| manifest.get("model"))?;
        let variants = manifest
            .pointer(&format!("/platforms/{platform_key}/variants"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|v| Some((v.get("id")?.as_str()?.to_owned(), v.get("executable")?.as_str()?.to_owned())))
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            version: manifest.get("version")?.as_str()?.to_owned(),
            variants,
            model_id: model_entry.get("id")?.as_str()?.to_owned(),
            model_filename: model_entry.get("filename")?.as_str()?.to_owned(),
            model_size: model_entry.get("size").and_then(Value::as_u64).unwrap_or(0),
            ffmpeg_executable: manifest
                .pointer(&format!("/ffmpeg/platforms/{platform_key}/executable"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceRuntime {
    pub installed: bool,
    /// Installed from an older manifest version: usable now, upgradeable by the install path.
    pub stale: bool,
    pub binary: bool,
    pub model: bool,
    pub ffmpeg: bool,
    pub whisper_cmd: Option<PathBuf>,
    pub server_cmd: Option<PathBuf>,
    pub model_path: Option<PathBuf>,
    pub model_id: String,
    pub model_name: String,
    pub ffmpeg_path: Option<PathBuf>,
}

impl VoiceRuntime {
    /// Nothing installed: what a runtime that could not be read resolves to.
    pub fn absent(manifest: &RuntimeManifest) -> Self {
        Self {
            installed: false,
            stale: false,
            binary: false,
            model: false,
            ffmpeg: false,
            whisper_cmd: None,
            server_cmd: None,
            model_path: None,
            model_id: manifest.model_id.clone(),
            model_name: String::new(),
            ffmpeg_path: None,
        }
    }
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
pub(super) fn has_data(path: &Path) -> bool {
    use std::io::Read;
    // `fileHasData`: false when the file is absent or its first 4096 bytes hold nothing but NUL
    // and whitespace; a file that exists but cannot be read right now still counts as present.
    let mut head = [0u8; 4096];
    match std::fs::File::open(path).and_then(|mut file| file.read(&mut head)) {
        Ok(read) => !head[..read].iter().all(|byte| matches!(byte, 0 | b' ' | b'\t' | b'\n' | b'\r')),
        Err(error) => !matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory),
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn active_name(root: &Path) -> Option<String> {
    let name = std::fs::read_to_string(root.join("active-version")).ok()?;
    let name = mixdog_js::js_trim(&name);
    (!name.is_empty()).then(|| name.to_owned())
}

pub fn resolve_voice_runtime(data_dir: &Path, manifest: &RuntimeManifest) -> VoiceRuntime {
    let whisper_root = data_dir.join("voice-runtime");
    let active = active_name(&whisper_root);
    let prefix = format!("whisper-{}-", manifest.version);
    let stale = active.as_deref().is_some_and(|name| !name.starts_with(&prefix));
    let whisper_cmd = active.as_deref().and_then(|name| {
        let variant = name.strip_prefix(&prefix)?;
        let executable = &manifest.variants.iter().find(|(id, _)| id == variant)?.1;
        let path = whisper_root.join(name).join(executable);
        has_data(&path).then_some(path)
    });
    let model_path = Some(data_dir.join("voice").join("models").join(&manifest.model_filename))
        .filter(|path| has_data(path));
    let ffmpeg_root = data_dir.join("ffmpeg-runtime");
    let ffmpeg_path = active_name(&ffmpeg_root).and_then(|name| {
        let path = ffmpeg_root.join(name).join(manifest.ffmpeg_executable.as_deref()?);
        has_data(&path).then_some(path)
    });
    let server_cmd = whisper_cmd
        .as_ref()
        .and_then(|cmd| cmd.parent().map(|dir| dir.join(SERVER_NAME)))
        .filter(|path| has_data(path));
    VoiceRuntime {
        installed: whisper_cmd.is_some() && server_cmd.is_some() && model_path.is_some() && ffmpeg_path.is_some(),
        stale,
        binary: whisper_cmd.is_some(),
        model: model_path.is_some(),
        ffmpeg: ffmpeg_path.is_some(),
        model_name: model_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        whisper_cmd,
        server_cmd,
        model_path,
        model_id: manifest.model_id.clone(),
        ffmpeg_path,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRuntimeInfo {
    pub engine: &'static str,
    pub runtime_version: String,
    pub acceleration: String,
    pub model: String,
    pub model_bytes: u64,
    pub ffmpeg_version: String,
}

/// Describes the resolved files, not the latest manifest: an older installed runtime may still
/// be in use after an app update.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub fn voice_runtime_info(runtime: &VoiceRuntime, manifest: &RuntimeManifest) -> VoiceRuntimeInfo {
    static WHISPER: OnceLock<JsRegex> = OnceLock::new();
    static FFMPEG: OnceLock<JsRegex> = OnceLock::new();
    let whisper = WHISPER.get_or_init(|| JsRegex::new_static(r"[\\/]whisper-([^-\\/]+)-([^\\/]+)[\\/]", ""));
    let ffmpeg = FFMPEG.get_or_init(|| JsRegex::new_static(r"[\\/]ffmpeg-runtime[\\/]ffmpeg-([^\\/]+)[\\/]", ""));
    let cmd = runtime.whisper_cmd.as_deref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let ffmpeg_path = runtime.ffmpeg_path.as_deref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let model_bytes = match &runtime.model_path {
        Some(path) => std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        None => manifest.model_size,
    };
    VoiceRuntimeInfo {
        engine: "whisper.cpp",
        runtime_version: whisper.captures(&cmd).and_then(|c| c.get(1).map(str::to_owned)).unwrap_or_default(),
        acceleration: whisper.captures(&cmd).and_then(|c| c.get(2).map(str::to_owned)).unwrap_or_default(),
        model: if runtime.model_name.is_empty() { manifest.model_id.clone() } else { runtime.model_name.clone() },
        model_bytes,
        ffmpeg_version: ffmpeg.captures(&ffmpeg_path).and_then(|c| c.get(1).map(str::to_owned)).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn manifest() -> RuntimeManifest {
        RuntimeManifest {
            version: "1.10.1".into(),
            variants: vec![("vulkan".into(), "Release/whisper-cli".into())],
            model_id: "large-v3-turbo-q8_0".into(),
            model_filename: "ggml.bin".into(),
            model_size: 9,
            ffmpeg_executable: Some("ffmpeg".into()),
        }
    }

    fn put(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn empty_data_dir_reports_nothing_installed() {
        let dir = tempfile::tempdir().unwrap();
        let rt = resolve_voice_runtime(dir.path(), &manifest());
        assert!(!rt.installed && !rt.binary && !rt.model && !rt.ffmpeg && !rt.stale);
    }

    #[test]
    fn full_layout_is_installed_and_described() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        put(&d.join("voice-runtime/active-version"), b"whisper-1.10.1-vulkan\n");
        put(&d.join("voice-runtime/whisper-1.10.1-vulkan/Release/whisper-cli"), b"x");
        put(&d.join("voice-runtime/whisper-1.10.1-vulkan/Release").join(SERVER_NAME), b"x");
        put(&d.join("voice/models/ggml.bin"), b"123456");
        put(&d.join("ffmpeg-runtime/active-version"), b"ffmpeg-6.1.1-mixdog.1");
        put(&d.join("ffmpeg-runtime/ffmpeg-6.1.1-mixdog.1/ffmpeg"), b"x");
        let rt = resolve_voice_runtime(d, &manifest());
        assert!(rt.installed && !rt.stale);
        let info = voice_runtime_info(&rt, &manifest());
        assert_eq!(info.runtime_version, "1.10.1");
        assert_eq!(info.acceleration, "vulkan");
        assert_eq!(info.model, "ggml.bin");
        assert_eq!(info.model_bytes, 6);
        assert_eq!(info.ffmpeg_version, "6.1.1-mixdog.1");
    }

    #[test]
    fn older_version_is_stale_but_a_zero_byte_file_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        put(&d.join("voice-runtime/active-version"), b"whisper-1.9.0-vulkan");
        put(&d.join("voice/models/ggml.bin"), b"");
        let rt = resolve_voice_runtime(d, &manifest());
        assert!(rt.stale && !rt.binary && !rt.model);
    }
}
