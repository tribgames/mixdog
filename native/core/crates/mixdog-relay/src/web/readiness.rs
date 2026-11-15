//! The `/readyz` report (`lib/renderer-readiness.mjs`): whether the renderer the relay serves, and every retained release,
//! is complete. A relay is ready only when the document names its build, every script, style, icon and imported worker the
//! document or the manifest points at exists, and each release of the registry passes the same check. A broken old release
//! would strand exactly the devices pinned to it, so any failure makes the whole relay not ready.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};

use mixdog_fsio::Unlaned;
use mixdog_js::{JsRegex, JsonSyntaxError, nodepath};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::releases::{Clock, ReleaseIndex, ReleaseIndexError, system_clock};
use crate::js;

/// `Content-Type` of the `/readyz` answer.
pub const READYZ_CONTENT_TYPE: &str = "application/json";
/// `Cache-Control` of the `/readyz` answer: a probe is never answered from a cache in between.
pub const READYZ_CACHE_CONTROL: &str = "no-store";
/// How long an inspection is reused, so a public probe cannot make the relay walk the tree again and again.
pub const READINESS_CACHE_MS: i64 = 2000;

const MAX_DOCUMENT_BYTES: u64 = 128 * 1024;
const MAX_ASSETS: usize = 128;

static VERSION_META: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"<meta name="mixdog-shell-version" content="([a-f0-9]{64})">"#, ""));
static ASSETS_META: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<meta name="mixdog-shell-assets" content="([^"]+)">"#, ""));
static DOCUMENT_REFERENCE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>"#, "gi"));
static IMPORT_SCRIPTS: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"\bimportScripts\(\s*["']([^"']+)["']\s*\)"#, "g"));
static HAS_EXTENSION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\.[a-z0-9]+$", "i"));

/// Why a renderer is not ready. The text is for the log: the public answer never carries it.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ReadinessError(String);

impl ReadinessError {
    fn new(message: &str) -> Self {
        Self(message.to_owned())
    }
}

impl From<io::Error> for ReadinessError {
    fn from(error: io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<ReleaseIndexError> for ReadinessError {
    fn from(error: ReleaseIndexError) -> Self {
        Self(error.to_string())
    }
}

impl From<JsonSyntaxError> for ReadinessError {
    fn from(error: JsonSyntaxError) -> Self {
        Self(error.to_string())
    }
}

/// The outcome of [`resolve_static_target`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaticResolution {
    /// A regular file inside the root, by its real path.
    Found(PathBuf),
    /// The path leaves the root, lexically or through a link.
    Forbidden,
    Missing,
}

/// `path.extname`: the last dot of the last path segment and what follows it; nothing for a dot at the start of the segment.
fn extname(path: &str) -> &str {
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let trimmed = path.trim_end_matches(separators);
    let base = trimmed.rsplit(separators).next().unwrap_or_default();
    match base.rfind('.') {
        Some(0) | None => "",
        Some(_) if base == ".." => "",
        Some(at) => &base[at..],
    }
}

/// `resolveStaticTarget`: resolves a request path inside `root_dir`. A request for a precompressed `.br` or `.gz` sibling is
/// missing (those answer through content negotiation on the asset's own URL), a path that escapes the root is forbidden,
/// before and after links are followed, and a path that names no file falls back to the root's `index.html` only when it
/// has no extension (or is `/index.html` itself): a missing file with an extension is missing, never the web app.
pub fn resolve_static_target(root_dir: &Path, pathname: &str) -> StaticResolution {
    if matches!(extname(pathname).to_ascii_lowercase().as_str(), ".br" | ".gz") {
        return StaticResolution::Missing;
    }
    let root_dir_text = root_dir.to_string_lossy();
    let root = PathBuf::from(nodepath::resolve_host(&[&*root_dir_text]));
    let Ok(real_root) = mixdog_fsio::canonicalize(&Unlaned, &root) else { return StaticResolution::Missing };
    let root_text = root.to_string_lossy();
    let relative = format!(".{pathname}");
    let mut target = PathBuf::from(nodepath::resolve_host(&[&*root_text, relative.as_str()]));
    if !target.starts_with(&root) {
        return StaticResolution::Forbidden;
    }
    let index = root.join("index.html");
    if target == root || !mixdog_fsio::is_file(&Unlaned, &target) {
        target = index.clone();
    }
    let fell_back = target == index;
    if fell_back && !extname(pathname).is_empty() && pathname != "/index.html" {
        return StaticResolution::Missing;
    }
    if !mixdog_fsio::exists(&Unlaned, &target).unwrap_or(false) {
        return StaticResolution::Missing;
    }
    let Ok(real_target) = mixdog_fsio::canonicalize(&Unlaned, &target) else { return StaticResolution::Missing };
    if !real_target.starts_with(&real_root) {
        return StaticResolution::Forbidden;
    }
    if mixdog_fsio::is_file(&Unlaned, &real_target) { StaticResolution::Found(real_target) } else { StaticResolution::Missing }
}

/// What one renderer tree reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspected {
    /// SHA-256 of `index.html`, lowercase hex.
    pub index_sha256: String,
    /// The `mixdog-shell-version` the document declares.
    pub version: String,
    /// How many distinct files the checks covered.
    pub assets: usize,
}

/// `assetPath`: a path of the tree as a rooted path; anything that could leave it, or is not a plain relative path, is
/// refused.
fn asset_path(value: &str) -> Result<String, ReadinessError> {
    let path = value.strip_prefix("./").unwrap_or(value);
    let path = path.strip_prefix('/').unwrap_or(path);
    if path.is_empty() || path.contains(['\\', '?', '#', ':']) || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(ReadinessError::new("invalid renderer asset path"));
    }
    Ok(format!("/{path}"))
}

/// `String(value || '')` of a parsed JSON value.
fn text_or_empty(value: Option<&Value>) -> String {
    let truthy = match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    };
    match value {
        Some(value) if truthy => mixdog_js::value_to_string(value),
        _ => String::new(),
    }
}

struct Walk<'a> {
    root: &'a Path,
    files: HashMap<String, PathBuf>,
}

impl Walk<'_> {
    /// `requireAsset`: the real path of a file the tree must hold. The static resolver owns escape protection; its SPA
    /// fallback is never accepted for an asset.
    fn require(&mut self, value: &str) -> Result<PathBuf, ReadinessError> {
        let path = asset_path(value)?;
        if let Some(target) = self.files.get(&path) {
            return Ok(target.clone());
        }
        if self.files.len() >= MAX_ASSETS {
            return Err(ReadinessError::new("renderer asset list exceeds limit"));
        }
        let StaticResolution::Found(target) = resolve_static_target(self.root, &path) else {
            return Err(ReadinessError::new("required renderer asset missing"));
        };
        if !HAS_EXTENSION.is_match(&path) {
            return Err(ReadinessError::new("required renderer asset missing"));
        }
        // The service account reads these files, not the installer.
        mixdog_fsio::File::open(&Unlaned, &target)?;
        self.files.insert(path, target.clone());
        Ok(target)
    }

    fn read_small(&mut self, value: &str) -> Result<String, ReadinessError> {
        let path = self.require(value)?;
        if mixdog_fsio::metadata(&Unlaned, &path)?.len() > MAX_DOCUMENT_BYTES {
            return Err(ReadinessError::new("renderer metadata exceeds limit"));
        }
        Ok(js::decode_utf8(&mixdog_fsio::read(&Unlaned, &path)?).into_owned())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// `inspectRenderer`: checks one renderer tree. The document must carry `mixdog-shell-version` (64 hex digits) and
/// `mixdog-shell-assets`; every asset the metadata lists, every script and link the document references, `boot.js` (the
/// CSP hashes the inlined script against it), the manifest with its icons and every `importScripts` of `sw.js` must exist.
pub fn inspect_renderer(renderer_dir: &Path) -> Result<Inspected, ReadinessError> {
    if renderer_dir.as_os_str().is_empty() {
        return Err(ReadinessError::new("renderer not configured"));
    }
    let mut walk = Walk { root: renderer_dir, files: HashMap::new() };
    let document = walk.read_small("index.html")?;
    let version = VERSION_META.captures(&document).and_then(|found| found.get(1)).map(str::to_owned);
    let declared = ASSETS_META.captures(&document).and_then(|found| found.get(1)).map(str::to_owned);
    let (Some(version), Some(declared)) = (version, declared) else {
        return Err(ReadinessError::new("renderer release metadata missing"));
    };
    for asset in declared.split(',') {
        walk.require(asset)?;
    }
    // Cover the actual entry, styles and install metadata too; a stale metadata list must not conceal a missing script
    // referenced by the document.
    for found in DOCUMENT_REFERENCE.captures_iter(&document) {
        walk.require(found.get(1).unwrap_or_default())?;
    }
    walk.require("boot.js")?;
    let manifest = js::parse(&walk.read_small("manifest.webmanifest")?)?;
    if !manifest.get("start_url").is_some_and(|start_url| !text_or_empty(Some(start_url)).is_empty()) {
        return Err(ReadinessError::new("renderer manifest invalid"));
    }
    match manifest.get("icons") {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) if text.is_empty() => {}
        Some(Value::Array(icons)) => {
            for icon in icons {
                walk.require(&text_or_empty(icon.get("src")))?;
            }
        }
        // Anything else is not iterable.
        Some(_) => return Err(ReadinessError::new("renderer manifest invalid")),
    }
    let worker = walk.read_small("sw.js")?;
    for found in IMPORT_SCRIPTS.captures_iter(&worker) {
        walk.require(found.get(1).unwrap_or_default())?;
    }
    Ok(Inspected { index_sha256: hex(&Sha256::digest(document.as_bytes())), version, assets: walk.files.len() })
}

/// One retained release in the `/readyz` body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseReport {
    pub id: String,
    pub desktop_version: String,
    pub legacy: bool,
    pub index_sha256: String,
    pub version: String,
    pub assets: usize,
}

/// The `/readyz` body of a ready relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyBody {
    pub status: &'static str,
    pub index_sha256: String,
    pub version: String,
    pub assets: usize,
    /// Present only when the relay has a registry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub releases: Option<Vec<ReleaseReport>>,
}

/// `inspectRendererReleases`: the current renderer plus every release of the registry in `releases_dir` (none when that is
/// empty or has no registry). A release whose tree is a different build than its entry says is not ready either.
pub fn inspect_renderer_releases(renderer_dir: &Path, releases_dir: &Path) -> Result<ReadyBody, ReadinessError> {
    let current = inspect_renderer(renderer_dir)?;
    let index = if releases_dir.as_os_str().is_empty() { None } else { ReleaseIndex::read(releases_dir)? };
    let mut body = ReadyBody { status: "ready", index_sha256: current.index_sha256, version: current.version, assets: current.assets, releases: None };
    let Some(index) = index else { return Ok(body) };
    let mut releases = Vec::with_capacity(index.releases.len());
    for entry in &index.releases {
        let inspected = inspect_renderer(&releases_dir.join(&entry.id))?;
        if !entry.shell_version.is_empty() && entry.shell_version != inspected.version {
            return Err(ReadinessError::new("renderer release does not match its registry entry"));
        }
        releases.push(ReleaseReport {
            id: entry.id.clone(),
            desktop_version: entry.desktop_version.clone(),
            legacy: entry.legacy,
            index_sha256: inspected.index_sha256,
            version: inspected.version,
            assets: inspected.assets,
        });
    }
    body.releases = Some(releases);
    Ok(body)
}

/// The answer to a `/readyz` probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    Ready(ReadyBody),
    NotReady,
}

impl Readiness {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Ready(_) => 200,
            Self::NotReady => 503,
        }
    }

    /// `JSON.stringify(body)`.
    pub fn body_json(&self) -> String {
        match self {
            Self::Ready(body) => serde_json::to_string(body).unwrap_or_default(),
            Self::NotReady => r#"{"status":"not-ready"}"#.to_owned(),
        }
    }
}

struct Cached {
    answer: Readiness,
    expires_at: i64,
}

/// `createRendererReadiness`: a bounded cache keeps a public probe from repeatedly walking the tree. A deployment restarts
/// the process, so the first check always sees the new release; later checks notice missing files without a restart. A
/// failure is answered as not ready and its reason (which would name a path) is not exposed.
pub struct RendererReadiness {
    renderer_dir: PathBuf,
    releases_dir: PathBuf,
    cache_ms: i64,
    clock: Clock,
    cached: Mutex<Option<Cached>>,
}

impl RendererReadiness {
    pub fn new(renderer_dir: impl Into<PathBuf>, releases_dir: impl Into<PathBuf>) -> Self {
        Self::with_clock(renderer_dir, releases_dir, READINESS_CACHE_MS, system_clock())
    }

    pub fn with_clock(renderer_dir: impl Into<PathBuf>, releases_dir: impl Into<PathBuf>, cache_ms: i64, clock: Clock) -> Self {
        Self { renderer_dir: renderer_dir.into(), releases_dir: releases_dir.into(), cache_ms, clock, cached: Mutex::new(None) }
    }

    pub fn check(&self) -> Readiness {
        let time = (self.clock)();
        // Held across the walk, so concurrent probes share one.
        let mut cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = cached.as_ref()
            && time < held.expires_at
        {
            return held.answer.clone();
        }
        let answer = match inspect_renderer_releases(&self.renderer_dir, &self.releases_dir) {
            Ok(body) => Readiness::Ready(body),
            Err(_) => Readiness::NotReady,
        };
        *cached = Some(Cached { answer: answer.clone(), expires_at: time + self.cache_ms });
        answer
    }
}
