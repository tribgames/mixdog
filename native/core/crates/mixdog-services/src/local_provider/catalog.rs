//! The local-provider catalog: the pinned manifest (llama.cpp runtime per platform, bundled
//! models), registered models, on-disk layout and the public model rows the settings dialog
//! renders. Layout under `<data>/local-provider/`: `runtime/<version>`, `models/<filename>`,
//! `context/`, `registered-models.json`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::context::{ContextLimits, local_context_settings};
use super::hardware::{Hardware, HardwareProbe, host_platform_key};
use super::model_state::ModelState;
use super::registered_models::RegisteredModels;

const MANIFEST: &str = include_str!("../../data/local-provider-manifest.json");
const DISK_HEADROOM_BYTES: i64 = 1024 * 1024 * 1024;
pub const LOCAL_PROVIDER_ID: &str = "mixdog-local";
pub const LOCAL_PROVIDER_BUILTIN_ID: &str = "localProvider";

/// An install check for a downloaded binary or model: false when `path` is absent or its first
/// bytes hold no data (empty, or NUL-filled by a crash that committed the size but not the
/// bytes). A file that exists but cannot be read right now still counts as present.
pub fn file_has_data(path: &Path) -> bool {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return !matches!(e.kind(), std::io::ErrorKind::NotFound) && e.raw_os_error() != Some(20),
    };
    let mut head = [0u8; 4096];
    match file.read(&mut head) {
        Ok(n) => head[..n].iter().any(|b| *b != 0),
        Err(_) => true,
    }
}

pub fn exact_file(path: &Path, size: i64) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() as i64 == size) && file_has_data(path)
}

/// Free bytes on the volume that holds `path` (or its nearest existing parent).
pub fn available_bytes(path: &Path) -> Option<i64> {
    let mut candidate = path.to_path_buf();
    loop {
        if candidate.exists() {
            return free_space(&candidate);
        }
        if !candidate.pop() {
            return None;
        }
    }
}

#[cfg(unix)]
fn free_space(path: &Path) -> Option<i64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is NUL-terminated and `stat` is a valid out-pointer.
    (unsafe { libc::statvfs(c.as_ptr(), &mut stat) } == 0).then(|| (stat.f_bavail as i64).saturating_mul(stat.f_frsize as i64))
}

#[cfg(windows)]
fn free_space(path: &Path) -> Option<i64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and `free` is a valid out-pointer; the others may be null.
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free.min(i64::MAX as u64) as i64)
}

pub fn ensure_disk_space(path: &Path, required: i64) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    match available_bytes(path) {
        Some(available) if available < required + DISK_HEADROOM_BYTES => {
            Err(format!("[local-provider] not enough free disk space: requires {} bytes", required + DISK_HEADROOM_BYTES))
        }
        _ => Ok(()),
    }
}

pub fn partial_asset_bytes(destination: &Path, size: i64) -> i64 {
    let mut name = destination.as_os_str().to_owned();
    name.push(".part");
    fs::metadata(PathBuf::from(name)).ok().filter(|m| m.is_file() && m.len() as i64 <= size).map_or(0, |m| m.len() as i64)
}

pub struct Catalog {
    pub data_dir: PathBuf,
    manifest: Value,
    pub registry: RegisteredModels,
    pub hardware: Arc<HardwareProbe>,
    pub state: Arc<ModelState>,
}

impl Catalog {
    pub fn new(data_dir: &Path, hardware: Arc<HardwareProbe>, state: Arc<ModelState>) -> Self {
        Self {
            data_dir: data_dir.to_owned(),
            manifest: serde_json::from_str(MANIFEST).expect("the bundled manifest is valid JSON"),
            registry: RegisteredModels::new(data_dir),
            hardware,
            state,
        }
    }

    pub fn runtime_root(&self) -> PathBuf {
        self.data_dir.join("local-provider").join("runtime")
    }
    pub fn model_root(&self) -> PathBuf {
        self.data_dir.join("local-provider").join("models")
    }
    pub fn runtime_version(&self) -> &str {
        self.manifest["runtime"]["version"].as_str().unwrap_or("")
    }
    pub fn runtime_directory(&self) -> PathBuf {
        self.runtime_root().join(self.runtime_version())
    }

    /// `{key, executable, backend, downloadBytes, assets}` for this host, or `None`.
    pub fn runtime_platform_entry(&self, key: &str) -> Option<Value> {
        let mut entry = self.manifest["runtime"]["platforms"].get(key)?.clone();
        entry["key"] = json!(key);
        Some(entry)
    }

    pub fn runtime_executable(&self, key: &str) -> Option<PathBuf> {
        let entry = self.runtime_platform_entry(key)?;
        Some(self.runtime_directory().join(entry["executable"].as_str()?))
    }

    fn model_entries(&self) -> Vec<Value> {
        let mut all = self.manifest["models"].as_array().cloned().unwrap_or_default();
        all.extend(self.registry.list());
        all
    }

    pub fn model_entry(&self, id: &str) -> Option<Value> {
        self.model_entries().into_iter().find(|e| e["id"] == id)
    }

    pub fn model_path(&self, entry: &Value) -> PathBuf {
        self.model_root().join(entry["filename"].as_str().unwrap_or(""))
    }

    pub fn context_limits<'a>(entry: &'a Value) -> ContextLimits<'a> {
        ContextLimits {
            id: entry["id"].as_str().unwrap_or(""),
            context_window: entry["contextWindow"].as_i64().unwrap_or(0),
            max_context_window: entry["maxContextWindow"].as_i64(),
        }
    }

    fn recommendation(&self, hardware: &Hardware) -> Option<String> {
        let vram = hardware.gpus.first().map_or(0, |g| g.memory_bytes);
        self.manifest["models"]
            .as_array()?
            .iter()
            .filter(|e| e["recommended"] == true)
            .find(|e| vram >= e["minimumVramBytes"].as_i64().unwrap_or(0))
            .and_then(|e| e["id"].as_str().map(str::to_owned))
    }

    fn public_model(&self, entry: &Value, hardware: &Hardware) -> Value {
        let id = entry["id"].as_str().unwrap_or("");
        let state = self.state.get(id);
        let weights = self.model_path(entry);
        let size = entry["size"].as_i64().unwrap_or(0);
        let vram = hardware.gpus.first().map_or(0, |g| g.memory_bytes);
        let minimum = entry["minimumVramBytes"].as_i64().unwrap_or(0);
        let mut row = Map::new();
        let mut put = |k: &str, v: Value| {
            row.insert(k.to_owned(), v);
        };
        put("id", json!(id));
        put("name", entry["name"].clone());
        put("description", entry["description"].clone());
        put("sizeBytes", json!(size));
        put("remainingDownloadBytes", json!(size - partial_asset_bytes(&weights, size)));
        put("estimatedVramBytes", entry["estimatedVramBytes"].clone());
        put("minimumVramBytes", entry["minimumVramBytes"].clone());
        if let Ok(Value::Object(ctx)) = local_local_context(entry, &self.data_dir) {
            ctx.into_iter().for_each(|(k, v)| put(&k, v));
        }
        let tools = state.pointer("/capabilities/tools").filter(|v| !v.is_null()).cloned();
        put("supportsFunctionCalling", tools.unwrap_or_else(|| entry.get("supportsFunctionCalling").cloned().unwrap_or(Value::Null)));
        put("supportsReasoning", entry.get("supportsReasoning").cloned().unwrap_or(Value::Null));
        put("supportsImages", json!(false));
        put("supportsReasoningSettings", json!(false));
        put("architecture", entry.get("architecture").cloned().unwrap_or(Value::Null));
        put("compatibility", entry.get("compatibility").cloned().filter(|v| v != "").unwrap_or_else(|| json!("Bundled model")));
        put("revision", entry.get("revision").cloned().unwrap_or(Value::Null));
        if let Value::Object(s) = state {
            s.into_iter().for_each(|(k, v)| put(&k, v));
        }
        put("license", entry["license"].clone());
        put("source", entry["source"].clone());
        put("recommended", json!(self.recommendation(hardware).as_deref() == Some(id)));
        put("compatible", json!(vram >= minimum));
        put("installed", json!(exact_file(&weights, size)));
        put("present", json!(weights.exists()));
        Value::Object(row)
    }

    pub fn status(&self, platform_key: Option<&str>) -> Value {
        let key = platform_key.unwrap_or_else(|| host_platform_key());
        let hardware = self.hardware.status();
        let platform = self.runtime_platform_entry(key);
        let models: Vec<Value> = self.model_entries().iter().map(|e| self.public_model(e, &hardware)).collect();
        let executable = self.runtime_executable(key);
        let runtime = &self.manifest["runtime"];
        let recommendation = models.iter().find(|m| m["recommended"] == true).cloned().unwrap_or(Value::Null);
        json!({
            "platformSupported": platform.is_some(),
            "available": platform.is_some() && hardware.supported && models.iter().any(|m| m["compatible"] == true),
            "runtime": {
                "installed": executable.as_deref().is_some_and(file_has_data),
                "version": runtime["version"], "downloadBytes": platform.as_ref().map_or(json!(0), |p| p["downloadBytes"].clone()),
                "source": runtime["source"], "license": runtime["license"],
                "backend": platform.as_ref().map_or(json!(""), |p| p["backend"].clone()),
            },
            "hardware": hardware.to_json(),
            "disk": {"availableBytes": available_bytes(&self.data_dir)},
            "models": models,
            "recommendation": recommendation,
        })
    }

    /// The installed models in the shape the model picker lists.
    pub fn installed_models(&self) -> Vec<Value> {
        self.status(None)["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["installed"] == true)
            .map(|m| {
                let id = m["id"].as_str().unwrap_or("");
                json!({
                    "id": id, "name": m["name"], "display": m["name"], "description": m["description"],
                    "contextWindow": m["contextWindow"], "maxContextWindow": m["maxContextWindow"],
                    "runtimeContextWindow": m["runtimeContextWindow"],
                    "supportsFunctionCalling": m["supportsFunctionCalling"], "supportsReasoning": m["supportsReasoning"],
                    "mode": "chat",
                    "family": m["architecture"].as_str().map(str::to_owned).unwrap_or_else(|| if id.starts_with("qwen") { "qwen".into() } else { String::new() }),
                    "supportsImages": false, "supportsReasoningSettings": false, "latest": true,
                })
            })
            .collect()
    }
}

fn local_local_context(entry: &Value, data_dir: &Path) -> Result<Value, super::context::ContextError> {
    local_context_settings(&Catalog::context_limits(entry), data_dir)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn catalog(dir: &Path) -> Catalog {
        Catalog::new(dir, HardwareProbe::new("windows", "x86_64", None), Arc::new(ModelState::default()))
    }

    #[test]
    fn the_bundled_manifest_describes_runtime_and_models() {
        let dir = tempfile::tempdir().unwrap();
        let c = catalog(dir.path());
        assert_eq!(c.runtime_version(), "b10621");
        let win = c.runtime_platform_entry("win32-x64-nvidia").unwrap();
        assert_eq!(win["executable"], "llama-server.exe");
        assert!(c.runtime_platform_entry("").is_none());
        assert_eq!(c.runtime_executable("win32-x64-nvidia").unwrap(), dir.path().join("local-provider/runtime/b10621/llama-server.exe"));
        assert_eq!(c.model_entry("qwen3.8-27b-q4-k-m").unwrap()["contextWindow"], 32768);
        assert!(c.model_entry("nope").is_none());
    }

    #[test]
    fn status_reports_partial_downloads_and_install_state() {
        let dir = tempfile::tempdir().unwrap();
        let c = catalog(dir.path());
        let status = c.status(Some("win32-x64-nvidia"));
        assert_eq!(status["platformSupported"], true);
        assert_eq!(status["runtime"]["installed"], false);
        assert_eq!(status["runtime"]["backend"], "CUDA 12.4");
        let model = &status["models"][0];
        assert_eq!((model["installed"].clone(), model["present"].clone(), model["compatible"].clone()), (json!(false), json!(false), json!(false)));
        assert_eq!(model["remainingDownloadBytes"], model["sizeBytes"]);
        assert_eq!(model["contextWindow"], 32768);
        // A partial download shortens the remaining bytes.
        let weights = c.model_path(&c.model_entry("qwen3.8-27b-q4-k-m").unwrap());
        fs::create_dir_all(weights.parent().unwrap()).unwrap();
        fs::write(format!("{}.part", weights.display()), vec![1u8; 1000]).unwrap();
        assert_eq!(c.status(Some("win32-x64-nvidia"))["models"][0]["remainingDownloadBytes"], 18_973_870_432i64 - 1000);
    }

    #[test]
    fn nul_filled_files_are_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("w.gguf");
        fs::write(&p, vec![0u8; 100]).unwrap();
        assert!(!exact_file(&p, 100));
        fs::write(&p, vec![1u8; 100]).unwrap();
        assert!(exact_file(&p, 100) && !exact_file(&p, 99));
        assert!(!file_has_data(&dir.path().join("missing")));
        assert!(available_bytes(&dir.path().join("a/b/c")).is_some());
    }
}
