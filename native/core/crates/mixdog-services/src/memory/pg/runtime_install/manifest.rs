//! The runtime manifest and which of its assets this host installs (`runtime-fetcher.mjs`
//! `isUsableAsset`, `selectRuntimeAsset`, `runtimeAssetUrlCandidates`; `native-asset.mjs`
//! `platformKeyCandidates`).

use std::sync::LazyLock;

use mixdog_js::{JsRegex, is_js_space, value_to_string};
use serde_json::Value;

use super::RuntimeInstallError;

/// The manifest shipped with this build: a copy of Node's `src/runtime/memory/data/runtime-manifest.json`.
const BUNDLED: &str = include_str!("runtime-manifest.json");

static GITHUB_RELEASE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^https://github\.com/([^/]+/[^/]+)/releases/download/", "i"));
static SHA256: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[0-9a-f]{64}$", ""));

/// `process.platform` and `process.arch` of the host the runtime is installed for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    pub os: String,
    pub arch: String,
}

impl Platform {
    pub fn new(os: &str, arch: &str) -> Self {
        Self { os: os.to_owned(), arch: arch.to_owned() }
    }

    /// This process's platform, spelled as Node spells it.
    pub fn current() -> Self {
        let os = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else if cfg!(target_arch = "x86_64") {
            "x64"
        } else if cfg!(target_arch = "x86") {
            "ia32"
        } else {
            "unknown"
        };
        Self::new(os, arch)
    }

    /// `platformKey()`.
    pub fn key(&self) -> String {
        format!("{}-{}", self.os, self.arch)
    }

    /// `platformKeyCandidates()`: the keys whose assets run here, best first. Windows on ARM
    /// runs x64 programs under its built-in emulation.
    pub fn candidates(&self) -> Vec<String> {
        let native = self.key();
        if self.os == "win32" && self.arch == "arm64" { vec![native, "win32-x64".to_owned()] } else { vec![native] }
    }
}

/// A usable manifest asset (`isUsableAsset`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct Manifest(Value);

impl Manifest {
    pub fn parse(text: &str) -> Result<Self, RuntimeInstallError> {
        serde_json::from_str(text).map(Self).map_err(|e| RuntimeInstallError::Text(format!("runtime manifest: {e}")))
    }

    pub fn bundled() -> Result<Self, RuntimeInstallError> {
        Self::parse(BUNDLED)
    }

    fn assets(&self) -> Option<&serde_json::Map<String, Value>> {
        self.0.get("assets").and_then(Value::as_object)
    }

    /// `pg<major>.<minor>+pgvector-<version>`; a missing field spells `undefined` as in Node.
    pub fn version(&self) -> String {
        let field = |outer: &str, inner: &str| match self.0.get(outer).and_then(|v| v.get(inner)) {
            None => "undefined".to_owned(),
            Some(value) => value_to_string(value),
        };
        format!("pg{}.{}+pgvector-{}", field("pg", "major"), field("pg", "minor"), field("pgvector", "version"))
    }

    /// `selectRuntimeAsset`: the first candidate key with a usable asset, with that key.
    pub fn select(&self, platform: &Platform) -> Result<(Asset, String), RuntimeInstallError> {
        for key in platform.candidates() {
            if let Some(asset) = self.assets().and_then(|assets| assets.get(&key)).and_then(usable) {
                return Ok((asset, key));
            }
        }
        let pkey = platform.key();
        let primary = self.assets().and_then(|assets| assets.get(&pkey));
        if !primary.is_some_and(truthy) {
            // The platform is absent from the manifest entirely.
            let supported: Vec<&str> =
                self.assets().into_iter().flatten().filter(|(_, asset)| usable(asset).is_some()).map(|(key, _)| key.as_str()).collect();
            let supported = if supported.is_empty() { "(none)".to_owned() } else { supported.join(", ") };
            return Err(RuntimeInstallError::Unavailable(format!(
                "[runtime-fetcher] memory runtime not available on {pkey}: no runtime asset for this platform/arch in the manifest. Supported: {supported}. Memory is disabled on this platform; the rest of mixdog continues to work."
            )));
        }
        Err(RuntimeInstallError::Unavailable(format!(
            "[runtime-fetcher] memory runtime not available on {pkey}: this platform/arch is marked unsupported (no validated runtime asset). Memory is disabled on this platform; the rest of mixdog continues to work."
        )))
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `isUsableAsset`, fail closed: not marked unsupported, a non-empty url, a lowercase 64-hex
/// sha256 and a positive integer size.
fn usable(asset: &Value) -> Option<Asset> {
    let map = asset.as_object()?;
    if map.get("unsupported") == Some(&Value::Bool(true)) {
        return None;
    }
    let url = map.get("url")?.as_str().filter(|url| !url.is_empty())?;
    let sha256 = map.get("sha256")?.as_str().filter(|sha| SHA256.is_match(sha))?;
    let size = map.get("size")?.as_f64().filter(|size| size.fract() == 0.0 && *size > 0.0)?;
    Some(Asset { url: url.to_owned(), sha256: sha256.to_owned(), size: size as u64 })
}

/// `MIXDOG_RUNTIME_RELEASE_REPOSITORY || RUNTIME_RELEASE_REPOSITORY || ''`, read through `read`.
pub fn repositories_env(read: impl Fn(&str) -> Option<String>) -> String {
    ["MIXDOG_RUNTIME_RELEASE_REPOSITORY", "RUNTIME_RELEASE_REPOSITORY"]
        .iter()
        .find_map(|name| read(name).filter(|value| !value.is_empty()))
        .unwrap_or_default()
}

/// `runtimeAssetUrlCandidates`: the manifest url, then the same release path under each
/// repository named in `repositories` (split on whitespace, `,` and `;`).
pub fn url_candidates(url: &str, repositories: &str) -> Vec<String> {
    let mut out = vec![url.to_owned()];
    let Some(release_repo) = GITHUB_RELEASE.captures(url).and_then(|caps| caps.get(1).map(str::to_owned)) else {
        return out;
    };
    for repo in repositories.split(|c: char| is_js_space(c) || c == ',' || c == ';').filter(|repo| !repo.is_empty()) {
        if repo != release_repo {
            let candidate = url.replacen(&format!("/github.com/{release_repo}/"), &format!("/github.com/{repo}/"), 1);
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}
