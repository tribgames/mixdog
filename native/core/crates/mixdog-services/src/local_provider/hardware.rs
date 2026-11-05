//! GPU detection for the managed llama.cpp runtime: NVIDIA through `nvidia-smi` on Windows x64,
//! Apple Silicon (unified memory) on macOS arm64. The probe is cached for a few seconds.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::change::ChangeSignal;
use crate::media::store::now_ms;

const GPU_FIELDS: &str = "index,uuid,name,memory.total,memory.free";
const CACHE_MS: i64 = 5_000;
const MIB: i64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Gpu {
    pub index: i64,
    pub uuid: String,
    pub vendor: &'static str,
    pub name: String,
    pub memory_bytes: i64,
    pub free_memory_bytes: i64,
}

impl Gpu {
    pub fn to_json(&self) -> Value {
        json!({"index": self.index, "uuid": self.uuid, "vendor": self.vendor, "name": self.name,
               "memoryBytes": self.memory_bytes, "freeMemoryBytes": self.free_memory_bytes})
    }
}

/// The manifest runtime this host runs; empty where no llama.cpp build is pinned.
pub fn platform_key(os: &str, arch: &str) -> &'static str {
    match (os, arch) {
        ("windows", "x86_64") => "win32-x64-nvidia",
        ("macos", "aarch64") => "darwin-arm64-metal",
        _ => "",
    }
}

pub fn host_platform_key() -> &'static str {
    platform_key(std::env::consts::OS, std::env::consts::ARCH)
}

/// Metal wires the `iogpu.wired_limit_mb` override when set, else two thirds of RAM, and
/// reports that whole working set as free.
pub fn apple_silicon_gpu(name: &str, total_bytes: i64, wired_limit_mb: i64) -> Gpu {
    let memory = if wired_limit_mb > 0 { wired_limit_mb * MIB } else { total_bytes * 2 / 3 };
    Gpu { index: 0, uuid: "MTL0".into(), vendor: "Apple", name: name.into(), memory_bytes: memory, free_memory_bytes: memory }
}

pub fn parse_nvidia_gpus(output: &str) -> Vec<Gpu> {
    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(mixdog_js::js_trim).collect();
            if parts.len() < 5 {
                return None;
            }
            let index = mixdog_js::string_to_number(parts[0]);
            if !(index.is_finite() && index.fract() == 0.0 && index >= 0.0) {
                return None;
            }
            let index = index as i64;
            let uuid = parts[1];
            let uuid_ok = uuid.len() > 4 && uuid[..4].eq_ignore_ascii_case("GPU-") && uuid[4..].chars().all(|c| c.is_ascii_hexdigit() || c == '-');
            let memory = mixdog_js::string_to_number(parts[parts.len() - 2]) * MIB as f64;
            let free = mixdog_js::string_to_number(parts[parts.len() - 1]) * MIB as f64;
            if !uuid_ok || memory <= 0.0 || free < 0.0 || free > memory || memory.fract() != 0.0 || free.fract() != 0.0 {
                return None;
            }
            Some(Gpu { index, uuid: uuid.into(), vendor: "NVIDIA", name: parts[2..parts.len() - 2].join(", "), memory_bytes: memory as i64, free_memory_bytes: free as i64 })
        })
        .collect()
}

#[derive(Clone, Debug)]
pub struct Hardware {
    pub platform: String,
    pub arch: String,
    pub gpus: Vec<Gpu>,
    pub supported: bool,
    pub checking: bool,
    pub checked_at: Option<i64>,
    pub error: Option<String>,
}

impl Hardware {
    pub fn to_json(&self) -> Value {
        json!({"platform": self.platform, "arch": self.arch, "gpu": self.gpus.first().map(Gpu::to_json),
               "gpus": self.gpus.iter().map(Gpu::to_json).collect::<Vec<_>>(), "supported": self.supported,
               "checking": self.checking, "checkedAt": self.checked_at, "error": self.error})
    }
    pub fn max_gpu_memory(&self) -> i64 {
        self.gpus.iter().map(|g| g.memory_bytes).max().unwrap_or(0)
    }
}

/// What a probe query returns: the raw `nvidia-smi` text, or the Apple Silicon facts.
pub enum Query {
    Nvidia(String),
    Apple { name: String, total_bytes: i64, wired_limit_mb: i64 },
}

pub struct HardwareProbe {
    os: String,
    arch: String,
    supported_platform: bool,
    cache_ms: i64,
    value: Mutex<Hardware>,
    signal: ChangeSignal,
}

impl HardwareProbe {
    pub fn new(os: &str, arch: &str, cache_ms: Option<i64>) -> Arc<Self> {
        Self::with_signal(os, arch, cache_ms, ChangeSignal::default())
    }

    /// A probe that ticks `signal` when what it reports (not merely when it was checked) changes.
    pub fn with_signal(os: &str, arch: &str, cache_ms: Option<i64>, signal: ChangeSignal) -> Arc<Self> {
        let supported_platform = !platform_key(os, arch).is_empty();
        Arc::new(Self {
            signal,
            os: os.into(),
            arch: arch.into(),
            supported_platform,
            cache_ms: cache_ms.unwrap_or(CACHE_MS),
            value: Mutex::new(Hardware { platform: os.into(), arch: arch.into(), gpus: Vec::new(), supported: false, checking: supported_platform, checked_at: None, error: None }),
        })
    }

    /// The last answer; cheap and never waits.
    pub fn status(&self) -> Hardware {
        self.value.lock().unwrap().clone()
    }

    pub async fn refresh<F, Fut>(&self, force: bool, query: F) -> Hardware
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Query, String>>,
    {
        {
            let mut value = self.value.lock().unwrap();
            if !force && value.checked_at.is_some_and(|at| now_ms() - at < self.cache_ms) {
                return value.clone();
            }
            if !self.supported_platform {
                let was_checking = value.checking;
                value.checking = false;
                value.checked_at = Some(now_ms());
                if was_checking {
                    self.signal.notify();
                }
                return value.clone();
            }
            let was_checking = value.checking;
            value.checking = true;
            if !was_checking {
                self.signal.notify();
            }
        }
        let outcome = query().await;
        let (gpus, error) = match outcome {
            Ok(Query::Apple { name, total_bytes, wired_limit_mb }) => (vec![apple_silicon_gpu(&name, total_bytes, wired_limit_mb)], None),
            Ok(Query::Nvidia(text)) => {
                let mut gpus = parse_nvidia_gpus(&text);
                gpus.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes).then(b.free_memory_bytes.cmp(&a.free_memory_bytes)).then(a.index.cmp(&b.index)));
                let error = gpus.is_empty().then(|| "No compatible NVIDIA GPU detected.".to_owned());
                (gpus, error)
            }
            Err(message) => (Vec::new(), Some(message)),
        };
        let next = Hardware { platform: self.os.clone(), arch: self.arch.clone(), supported: !gpus.is_empty(), gpus, checking: false, checked_at: Some(now_ms()), error };
        let changed = {
            let mut value = self.value.lock().unwrap();
            let changed = value.gpus != next.gpus || value.supported != next.supported || value.checking != next.checking || value.error != next.error;
            *value = next.clone();
            changed
        };
        if changed {
            self.signal.notify();
        }
        next
    }

    /// The real probe: `nvidia-smi` or `sysctl`.
    pub async fn detect(&self, force: bool) -> Hardware {
        let apple = self.os == "macos";
        self.refresh(force, || async move { if apple { query_apple().await } else { query_nvidia().await } }).await
    }
}

async fn query_nvidia() -> Result<Query, String> {
    let mut cmd = tokio::process::Command::new("nvidia-smi");
    cmd.args([&format!("--query-gpu={GPU_FIELDS}"), "--format=csv,noheader,nounits"]).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await.map_err(|_| "nvidia-smi timed out".to_owned())?.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("nvidia-smi exited with {}", out.status));
    }
    Ok(Query::Nvidia(String::from_utf8_lossy(&out.stdout).into_owned()))
}

async fn query_apple() -> Result<Query, String> {
    // macOS before 14 has no such key.
    let limit = tokio::time::timeout(Duration::from_secs(5), tokio::process::Command::new("/usr/sbin/sysctl").args(["-n", "iogpu.wired_limit_mb"]).output())
        .await
        .ok()
        .and_then(Result::ok)
        .map(|o| mixdog_js::string_to_number(&String::from_utf8_lossy(&o.stdout)))
        .filter(|n| n.is_finite())
        .map_or(0, |n| n as i64);
    let total = tokio::process::Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output().await.ok().and_then(|o| mixdog_js::js_trim(&String::from_utf8_lossy(&o.stdout)).parse::<i64>().ok()).unwrap_or(0);
    let name = tokio::process::Command::new("/usr/sbin/sysctl").args(["-n", "machdep.cpu.brand_string"]).output().await.ok().map(|o| mixdog_js::js_trim(&String::from_utf8_lossy(&o.stdout)).to_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Apple Silicon".into());
    Ok(Query::Apple { name, total_bytes: total, wired_limit_mb: limit })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GpuSelectError {
    #[error("[local-provider] GPU detection failed: {0}")]
    Detection(String),
    #[error("[local-provider] model is missing a GPU memory estimate")]
    NoEstimate,
    #[error("[local-provider] insufficient available GPU memory: estimated requirement {required} bytes; best compatible GPU has {best_free} bytes free. Free GPU memory or choose a smaller compatible model.")]
    Insufficient { required: i64, best_free: i64 },
}

pub fn select_gpu(hardware: &Hardware, estimated_vram: i64, minimum_vram: i64) -> Result<Gpu, GpuSelectError> {
    if !hardware.supported {
        return Err(GpuSelectError::Detection(hardware.error.clone().unwrap_or_else(|| "unsupported hardware".into())));
    }
    if estimated_vram <= 0 {
        return Err(GpuSelectError::NoEstimate);
    }
    let mut candidates: Vec<&Gpu> = hardware.gpus.iter().filter(|g| g.memory_bytes >= minimum_vram).collect();
    candidates.sort_by(|a, b| b.free_memory_bytes.cmp(&a.free_memory_bytes).then(a.index.cmp(&b.index)));
    candidates
        .iter()
        .find(|g| g.free_memory_bytes >= estimated_vram)
        .map(|g| (*g).clone())
        .ok_or(GpuSelectError::Insufficient { required: estimated_vram, best_free: candidates.first().map_or(0, |g| g.free_memory_bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMI: &str = "0, GPU-aaaa-1111, NVIDIA RTX 4090, 24564, 20000\n1, GPU-bbbb-2222, NVIDIA RTX 3060, 12288, 12000\nbroken line\n2, not-a-uuid, X, 100, 50\n";

    #[test]
    fn nvidia_output_is_parsed_strictly() {
        let gpus = parse_nvidia_gpus(SMI);
        assert_eq!(gpus.len(), 2);
        assert_eq!((gpus[0].name.as_str(), gpus[0].memory_bytes, gpus[0].free_memory_bytes), ("NVIDIA RTX 4090", 24564 * MIB, 20000 * MIB));
        assert!(parse_nvidia_gpus("0, GPU-aa, n, 100, 200").is_empty(), "free above total is rejected");
    }

    #[test]
    fn platform_keys_and_apple_memory() {
        assert_eq!(platform_key("windows", "x86_64"), "win32-x64-nvidia");
        assert_eq!(platform_key("linux", "x86_64"), "");
        assert_eq!(apple_silicon_gpu("M4", 16 * 1024 * MIB, 0).memory_bytes, 16 * 1024 * MIB * 2 / 3);
        assert_eq!(apple_silicon_gpu("M4", 16 * 1024 * MIB, 8192).memory_bytes, 8192 * MIB);
    }

    #[tokio::test]
    async fn probe_sorts_gpus_caches_and_reports_failures() {
        let probe = HardwareProbe::new("windows", "x86_64", Some(60_000));
        assert!(probe.status().checking);
        let hw = probe.refresh(false, || async { Ok(Query::Nvidia(SMI.into())) }).await;
        assert!(hw.supported);
        assert_eq!(hw.gpus[0].index, 0);
        assert_eq!(hw.to_json()["gpu"]["uuid"], "GPU-aaaa-1111");
        // Cached: the failing query is not consulted.
        assert!(probe.refresh(false, || async { Err("boom".into()) }).await.supported);
        let failed = probe.refresh(true, || async { Err("boom".into()) }).await;
        assert_eq!((failed.supported, failed.error.as_deref()), (false, Some("boom")));
        let empty = probe.refresh(true, || async { Ok(Query::Nvidia(String::new())) }).await;
        assert_eq!(empty.error.as_deref(), Some("No compatible NVIDIA GPU detected."));
        let unsupported = HardwareProbe::new("linux", "x86_64", None).refresh(false, || async { Err("never".into()) }).await;
        assert!(!unsupported.supported && !unsupported.checking);
    }

    #[test]
    fn gpu_selection_prefers_the_most_free_memory_that_fits() {
        let hw = Hardware { platform: "windows".into(), arch: "x86_64".into(), gpus: parse_nvidia_gpus(SMI), supported: true, checking: false, checked_at: None, error: None };
        assert_eq!(select_gpu(&hw, 10_000 * MIB, 10_000 * MIB).unwrap().index, 0);
        assert_eq!(select_gpu(&hw, 30_000 * MIB, 1), Err(GpuSelectError::Insufficient { required: 30_000 * MIB, best_free: 20_000 * MIB }));
        assert_eq!(select_gpu(&hw, 0, 0), Err(GpuSelectError::NoEstimate));
        let mut none = hw.clone();
        none.supported = false;
        assert!(matches!(select_gpu(&none, 1, 1), Err(GpuSelectError::Detection(_))));
    }
}
