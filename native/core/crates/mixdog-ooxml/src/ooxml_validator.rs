//! The Open XML SDK schema validator: fetched once, cached, and run on a document. Ported from
//! `src/runtime/office/portable/ooxml-validator.mjs`.
//!
//! The validator is an external native binary, the npm package `@xarsh/ooxml-validator-<platform>` at one pinned version.
//! [`ensure_ooxml_validator`] finds it in the data directory's cache (`office/tools/ooxml-validator/<version>/<platform>`),
//! or downloads the package tarball from the npm registry (160 MB cap, the pinned sha512 integrity), unpacks the binary from
//! it and publishes it by a rename. [`validate_ooxml_schema`] runs it on a document (`<binary> <path> <officeVersion>`, 5 MB
//! of output kept, 120 seconds) and returns its issues in the shape Node returned: the errors Office is known to open anyway
//! are moved to `compatibilityWarnings`.
//!
//! `MIXDOG_OOXML_VALIDATOR_CLI` names a validator binary to use as it is; `MIXDOG_OOXML_VALIDATOR_DISABLED=1` turns
//! validation off; `MIXDOG_TEST_OOXML_CACHE_DIR` moves the cache to a directory test runs share (and then installs under a
//! lock, so parallel runs download once). Every function blocks: call it from a lane job (it takes the lane's proof) or a
//! thread of its own, never from an executor thread. An abort is an [`AtomicBool`] the caller sets.

use std::fmt;
use std::future::Future;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use mixdog_fsio::WriteProof;
use mixdog_js::{JsRegex, js_trim, value_to_string};
use mixdog_statefile::LockOpts;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256, Sha384, Sha512};
use tokio::io::{AsyncRead, AsyncReadExt};

/// The pinned validator package version.
pub const VERSION: &str = "0.3.0";
const MAX_ARCHIVE_BYTES: u64 = 160 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;
/// A cached binary of at most this size is a truncated or failed download, never the validator: the real executable is
/// tens of megabytes.
const MIN_BINARY_BYTES: u64 = 1024 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(120);
const INSTALL_LOCK_TIMEOUT: Duration = Duration::from_secs(120);
/// How often a wait looks at the abort flag.
const ABORT_POLL: Duration = Duration::from_millis(50);
/// The most issues of each kind a result carries.
const MAX_REPORTED: usize = 500;
pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";
pub const DEFAULT_OFFICE_VERSION: &str = "Microsoft365";

/// Why a validator could not be found or installed (Node threw).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatorError(pub String);

impl fmt::Display for ValidatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ValidatorError {}

type Result<T> = std::result::Result<T, ValidatorError>;

fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(ValidatorError(message.into()))
}

/// One platform's package: its npm name, the integrity of its tarball and the binary's file name in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformPackage {
    pub name: String,
    pub integrity: String,
    pub binary: String,
}

fn package(name: &str, integrity: &str, binary: &str) -> PlatformPackage {
    PlatformPackage { name: name.into(), integrity: integrity.into(), binary: binary.into() }
}

/// `PLATFORM_PACKAGES`, keyed `<process.platform>-<process.arch>`.
pub fn pinned_packages() -> Vec<(String, PlatformPackage)> {
    let windows = "ooxml-validator.exe";
    let unix = "ooxml-validator";
    [
        (
            "win32-x64",
            package(
                "@xarsh/ooxml-validator-win32-x64",
                "sha512-VflQjYjMfq6Up3sclSiVL5p2dVz17RrubZF+QqXhoWCiOPlMlaMN07hx99J6Ngh6TPboAK6TjcuG8DlGIhcp0w==",
                windows,
            ),
        ),
        (
            "win32-arm64",
            package(
                "@xarsh/ooxml-validator-win32-arm64",
                "sha512-mx7RqjopCZ3mNVlNyPar935FbMA61hOCyIA854L/3trLt4vmj62/spSfjkpgyKx6TKq5/HXTjMf+rNM/WKayaw==",
                windows,
            ),
        ),
        (
            "linux-x64",
            package(
                "@xarsh/ooxml-validator-linux-x64",
                "sha512-GltV9YzcOwLdxhTvw9MIw1kgMbsjnpUvYYaKovDUwMcvwIOlb72Lealp4mZRugLDS1XRDqHbjoChL6Ko+awLpw==",
                unix,
            ),
        ),
        (
            "linux-arm64",
            package(
                "@xarsh/ooxml-validator-linux-arm64",
                "sha512-5D8M0PF8J3eIrnUYNiHfOKyjiwnTkWRfcmUMrwMsqzSTBX0LmTRa1QjbIpAwTjKalkGq8nzutSO6eu/UmNothg==",
                unix,
            ),
        ),
        (
            "darwin-x64",
            package(
                "@xarsh/ooxml-validator-darwin-x64",
                "sha512-Mj0IEDx4lnDbz+cWqhbyQ3zrJTrtcOUhgU13qXgM4m1yS+SNhsojwfIw6NfPjeI6QTvh5rq9oocgewBe7W9LYw==",
                unix,
            ),
        ),
        (
            "darwin-arm64",
            package(
                "@xarsh/ooxml-validator-darwin-arm64",
                "sha512-hgxBf6YzMJCvgEKJN3wVmd4KhIkAx0eCl3ODMoi8a9m8o6N7xE0UKHJFjAku0WhAdbVrZN4w3K5oUVLCC6GnTA==",
                unix,
            ),
        ),
    ]
    .into_iter()
    .map(|(key, entry)| (key.to_owned(), entry))
    .collect()
}

/// `ooxmlValidatorManifest()`: the version, the platforms and each package's name and integrity.
pub fn ooxml_validator_manifest() -> Value {
    let packages = pinned_packages();
    let mut listed = Map::new();
    for (key, entry) in &packages {
        listed.insert(key.clone(), json!({ "name": entry.name, "integrity": entry.integrity }));
    }
    json!({
        "version": VERSION,
        "platforms": packages.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
        "packages": Value::Object(listed),
    })
}

/// `${process.platform}-${process.arch}` as Node names them.
pub fn node_platform() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    format!("{os}-{arch}")
}

/// What the lookup depends on besides the data directory: the three variables, the platform, the registry and the packages
/// known for it. [`Environment::from_process`] is the real one; a test builds its own.
#[derive(Debug, Clone)]
pub struct Environment {
    /// `MIXDOG_OOXML_VALIDATOR_CLI`, trimmed; `None` when empty.
    pub cli_override: Option<PathBuf>,
    /// `MIXDOG_OOXML_VALIDATOR_DISABLED === '1'`.
    pub disabled: bool,
    /// `MIXDOG_TEST_OOXML_CACHE_DIR`: where test runners share the immutable tool (and install it under a lock).
    pub shared_cache: Option<PathBuf>,
    pub platform: String,
    pub registry: String,
    pub packages: Vec<(String, PlatformPackage)>,
}

impl Environment {
    pub fn from_process() -> Self {
        let variable = |name: &str| std::env::var(name).ok();
        Environment {
            cli_override: variable("MIXDOG_OOXML_VALIDATOR_CLI")
                .map(|text| js_trim(&text).to_owned())
                .filter(|text| !text.is_empty())
                .map(PathBuf::from),
            disabled: variable("MIXDOG_OOXML_VALIDATOR_DISABLED").as_deref() == Some("1"),
            shared_cache: variable("MIXDOG_TEST_OOXML_CACHE_DIR").filter(|text| !text.is_empty()).map(PathBuf::from),
            platform: node_platform(),
            registry: DEFAULT_REGISTRY.to_owned(),
            packages: pinned_packages(),
        }
    }
}

/// What a lookup or a run is asked: the data directory that holds the cache, whether a missing validator may be downloaded,
/// the Office version the schema is checked against and the abort flag.
#[derive(Clone, Copy)]
pub struct Request<'a> {
    pub data_dir: &'a Path,
    pub download: bool,
    pub office_version: &'a str,
    pub cancel: Option<&'a AtomicBool>,
}

impl<'a> Request<'a> {
    /// Download allowed, `Microsoft365`, no abort flag.
    pub fn new(data_dir: &'a Path) -> Self {
        Request { data_dir, download: true, office_version: DEFAULT_OFFICE_VERSION, cancel: None }
    }
}

/// What `ensureOoxmlValidator` resolved to: the keys Node's result object had.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ValidatorRuntime {
    pub available: bool,
    pub cached: Option<bool>,
    pub disabled: Option<bool>,
    pub downloaded: bool,
    pub download_required: Option<bool>,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub bytes: Option<u64>,
    pub reason: Option<String>,
}

impl ValidatorRuntime {
    fn ready(path: PathBuf, cached: bool, version: &str) -> Self {
        ValidatorRuntime {
            available: true,
            cached: Some(cached),
            downloaded: !cached,
            path: Some(path),
            version: Some(version.to_owned()),
            ..Default::default()
        }
    }

    fn unavailable(reason: impl Into<String>) -> Self {
        ValidatorRuntime { available: false, reason: Some(reason.into()), ..Default::default() }
    }

    fn put(&self, into: &mut Map<String, Value>) {
        into.insert("available".into(), json!(self.available));
        if let Some(cached) = self.cached {
            into.insert("cached".into(), json!(cached));
        }
        if let Some(disabled) = self.disabled {
            into.insert("disabled".into(), json!(disabled));
        }
        into.insert("downloaded".into(), json!(self.downloaded));
        if let Some(required) = self.download_required {
            into.insert("downloadRequired".into(), json!(required));
        }
        if let Some(path) = &self.path {
            into.insert("path".into(), json!(path.to_string_lossy()));
        }
        if let Some(version) = &self.version {
            into.insert("version".into(), json!(version));
        }
        if let Some(bytes) = self.bytes {
            into.insert("bytes".into(), json!(bytes));
        }
        if let Some(reason) = &self.reason {
            into.insert("reason".into(), json!(reason));
        }
    }

    /// Node's result object.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        self.put(&mut object);
        Value::Object(object)
    }
}

/// What `validateOoxmlSchema` resolved to: the runtime's keys plus the verdict and the issues.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationResult {
    pub runtime: ValidatorRuntime,
    pub ok: bool,
    pub errors: Vec<Value>,
    /// Why the run gave no verdict (it did not start, was aborted, timed out, failed or printed no JSON). Node wrote it after
    /// `errors` (`{ ...runtime, ok: false, errors: [], reason }`); a runtime that is not available carries its own reason.
    pub reason: Option<String>,
    pub compatibility_warnings: Option<Vec<Value>>,
    pub omitted_errors: Option<usize>,
    pub raw_valid: Option<bool>,
    pub office_version: Option<String>,
    /// `open-xml-sdk` once the validator ran.
    pub validation: Option<&'static str>,
}

impl ValidationResult {
    /// `{ ...runtime, ok: false, errors: [], reason }` (`{ ...runtime, ok: false, errors: [] }` when the runtime carries the
    /// reason already).
    fn failed(runtime: ValidatorRuntime, reason: Option<String>) -> Self {
        ValidationResult {
            runtime,
            ok: false,
            errors: Vec::new(),
            reason,
            compatibility_warnings: None,
            omitted_errors: None,
            raw_valid: None,
            office_version: None,
            validation: None,
        }
    }

    /// Node's result object.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        self.runtime.put(&mut object);
        object.insert("ok".into(), json!(self.ok));
        object.insert("errors".into(), Value::Array(self.errors.clone()));
        if let Some(reason) = &self.reason {
            object.insert("reason".into(), json!(reason));
        }
        if let Some(warnings) = &self.compatibility_warnings {
            object.insert("compatibilityWarnings".into(), Value::Array(warnings.clone()));
        }
        if let Some(omitted) = self.omitted_errors {
            object.insert("omittedErrors".into(), json!(omitted));
        }
        if let Some(raw) = self.raw_valid {
            object.insert("rawValid".into(), json!(raw));
        }
        if let Some(version) = &self.office_version {
            object.insert("officeVersion".into(), json!(version));
        }
        if let Some(validation) = self.validation {
            object.insert("validation".into(), json!(validation));
        }
        Value::Object(object)
    }
}

// ---- Compatibility classification --------------------------------------------------------------------------------------

struct Patterns {
    chart_path: JsRegex,
    chart_ext_xpath: JsRegex,
    office_drawing_namespace: JsRegex,
    presentation_path: JsRegex,
    presentation_xpath: JsRegex,
    master_list_order: JsRegex,
    unexpected_content_id: JsRegex,
    chart_element_order: JsRegex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        chart_path: JsRegex::new_static(r"^\/(?:ppt|xl)\/charts\/", "i"),
        chart_ext_xpath: JsRegex::new_static(r"\/c:extLst\[\d+\](?:\/c:ext\[\d+\])?", "i"),
        office_drawing_namespace: JsRegex::new_static(r"schemas\.microsoft\.com\/office\/drawing\/20\d{2}\/", "i"),
        presentation_path: JsRegex::new_static(r"^\/ppt\/presentation\.xml$", "i"),
        presentation_xpath: JsRegex::new_static(r"^\/p:presentation\[1\]$", "i"),
        master_list_order: JsRegex::new_static(
            r"unexpected child element .*:(?:notesMasterIdLst|handoutMasterIdLst)'",
            "i",
        ),
        unexpected_content_id: JsRegex::new_static(r"^Sch_UnexpectedElementContent", "i"),
        chart_element_order: JsRegex::new_static(
            r"unexpected child element '[^']*drawingml\/2006\/chart:[A-Za-z]+'",
            "i",
        ),
    })
}

/// `String(error?.<key> || '')`.
fn field(error: &Value, key: &str) -> String {
    match error.get(key) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::String(text)) if text.is_empty() => String::new(),
        Some(Value::Number(number)) if number.as_f64().map_or(true, |n| n == 0.0 || n.is_nan()) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// An extension element of a chart part, or a Microsoft drawing namespace the schema does not know.
fn is_office_extension_compatibility_error(error: &Value) -> bool {
    let patterns = patterns();
    if !patterns.chart_path.is_match(&field(error, "path")) {
        return false;
    }
    patterns.chart_ext_xpath.is_match(&field(error, "xPath"))
        || patterns.office_drawing_namespace.is_match(&field(error, "description"))
}

/// Script generators write `<p:notesMasterIdLst>` after `<p:sldIdLst>`, which the schema rejects but every PowerPoint build
/// opens; reordering the children is what actually breaks the deck, so the order is tolerated as it is.
fn is_presentation_child_order_error(error: &Value) -> bool {
    let patterns = patterns();
    patterns.presentation_path.is_match(&field(error, "path"))
        && patterns.presentation_xpath.is_match(&field(error, "xPath"))
        && patterns.master_list_order.is_match(&field(error, "description"))
}

/// Chart generators also emit standard chart elements (`axId`, `gapWidth`, `overlap`) out of schema order; the element is
/// valid and Office reads it, so the order alone is a compatibility note. Unknown elements still fail.
fn is_chart_child_order_error(error: &Value) -> bool {
    let patterns = patterns();
    patterns.chart_path.is_match(&field(error, "path"))
        && patterns.unexpected_content_id.is_match(&field(error, "id"))
        && patterns.chart_element_order.is_match(&field(error, "description"))
}

fn is_compatibility_error(error: &Value) -> bool {
    is_office_extension_compatibility_error(error)
        || is_presentation_child_order_error(error)
        || is_chart_child_order_error(error)
}

/// `classifyOoxmlValidationErrors`.
#[derive(Debug, Clone, PartialEq)]
pub struct Classified {
    pub errors: Vec<Value>,
    pub compatibility_warnings: Vec<Value>,
}

pub fn classify_ooxml_validation_errors(errors: &[Value]) -> Classified {
    let (compatibility_warnings, errors) = errors.iter().cloned().partition(is_compatibility_error);
    Classified { errors, compatibility_warnings }
}

/// What the validator printed, as the result of a run that exited with 0 (`valid` is `isValid ?? valid ?? ok`).
pub fn parse_validator_output(stdout: &str, runtime: ValidatorRuntime, office_version: &str) -> ValidationResult {
    let invalid =
        |message: &str| ValidationResult::failed(runtime.clone(), Some(format!("Invalid OOXML schema validator output: {message}")));
    let trimmed = js_trim(stdout);
    let text = if trimmed.is_empty() { "{}" } else { trimmed };
    let Ok(result) = mixdog_js::json_parse(text) else {
        let message = mixdog_js::v8_json_parse_error(text).unwrap_or_else(|| "Unexpected end of JSON input".into());
        return invalid(&message);
    };
    if result.is_null() {
        return invalid("Cannot read properties of null (reading 'isValid')");
    }
    let valid = ["isValid", "valid", "ok"].iter().filter_map(|key| result.get(*key)).find(|value| !value.is_null());
    let raw_valid = valid == Some(&Value::Bool(true));
    let reported: Vec<Value> = result.get("errors").and_then(Value::as_array).cloned().unwrap_or_default();
    let classified = classify_ooxml_validation_errors(&reported);
    let ok = raw_valid || (!reported.is_empty() && classified.errors.is_empty());
    let omitted = classified.errors.len().saturating_sub(MAX_REPORTED);
    ValidationResult {
        runtime,
        ok,
        errors: classified.errors.into_iter().take(MAX_REPORTED).collect(),
        reason: None,
        compatibility_warnings: Some(classified.compatibility_warnings.into_iter().take(MAX_REPORTED).collect()),
        omitted_errors: Some(omitted),
        raw_valid: Some(raw_valid),
        office_version: Some(office_version.to_owned()),
        validation: Some("open-xml-sdk"),
    }
}

// ---- Download ----------------------------------------------------------------------------------------------------------

fn package_url(registry: &str, name: &str) -> String {
    let slug = &name[name.find('/').map_or(0, |at| at + 1)..];
    format!("{}/{name}/-/{slug}-{VERSION}.tgz", registry.trim_end_matches('/'))
}

fn aborted<T>() -> Result<T> {
    fail("This operation was aborted")
}

fn cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::Relaxed))
}

fn throw_if_aborted(cancel: Option<&AtomicBool>) -> Result<()> {
    if cancelled(cancel) { aborted() } else { Ok(()) }
}

/// `future`, or an abort error as soon as the flag is set.
async fn until_cancelled<F: Future + Unpin>(mut future: F, cancel: Option<&AtomicBool>) -> Result<F::Output> {
    if cancel.is_none() {
        return Ok(future.await);
    }
    loop {
        throw_if_aborted(cancel)?;
        if let Ok(value) = mixdog_rt::time::timeout(ABORT_POLL, &mut future).await {
            return Ok(value);
        }
    }
}

/// Runs `future` to its end on a runtime of its own, on a thread of its own (a caller that is already inside a runtime's
/// context cannot block on a second one).
fn on_runtime<T: Send, F: Future<Output = T> + Send>(future: F) -> Result<T> {
    std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map(|runtime| runtime.block_on(future))
                .map_err(|error| ValidatorError(format!("The OOXML validator runtime did not start: {error}")))
        });
        match worker.join() {
            Ok(outcome) => outcome,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}

/// Loopback hosts are reached directly, whatever proxy the environment names.
fn client_for(url: &str) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder();
    let local = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")))
        .unwrap_or(false);
    if local {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|error| ValidatorError(error.to_string()))
}

async fn fetch_archive(url: &str, cancel: Option<&AtomicBool>) -> Result<Vec<u8>> {
    let client = client_for(url)?;
    let sent = until_cancelled(Box::pin(client.get(url).send()), cancel).await?;
    let mut response = sent.map_err(|error| ValidatorError(format!("fetch failed: {error}")))?;
    if !response.status().is_success() {
        return fail(format!("OOXML validator download failed with HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|declared| declared > MAX_ARCHIVE_BYTES) {
        return fail("OOXML validator archive exceeds the download size limit");
    }
    let mut archive = Vec::new();
    loop {
        let chunk = until_cancelled(Box::pin(response.chunk()), cancel).await?;
        let Some(chunk) = chunk.map_err(|error| ValidatorError(error.to_string()))? else { break };
        if (archive.len() + chunk.len()) as u64 > MAX_ARCHIVE_BYTES {
            return fail("OOXML validator archive exceeds the download size limit");
        }
        archive.extend_from_slice(&chunk);
    }
    Ok(archive)
}

/// `verifyIntegrity`: `<algorithm>-<base64 digest>`.
fn verify_integrity(archive: &[u8], integrity: &str) -> Result<()> {
    let mut parts = integrity.split('-');
    let algorithm = parts.next().unwrap_or_default();
    let expected = parts.next().unwrap_or_default();
    let digest = match algorithm {
        "sha512" => Some(Sha512::digest(archive).to_vec()),
        "sha384" => Some(Sha384::digest(archive).to_vec()),
        "sha256" => Some(Sha256::digest(archive).to_vec()),
        _ => None,
    };
    let actual = digest.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
    if actual.as_deref() == Some(expected) { Ok(()) } else { fail("OOXML validator archive integrity check failed") }
}

/// The body of the tarball's entry named `wanted` (`package/<binary>`).
fn archive_entry(archive: &[u8], wanted: &str) -> Result<Vec<u8>> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    let entries = tar.entries().map_err(|error| ValidatorError(error.to_string()))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| ValidatorError(error.to_string()))?;
        if entry.path_bytes().as_ref() != wanted.as_bytes() {
            continue;
        }
        let mut body = Vec::new();
        entry.read_to_end(&mut body).map_err(|error| ValidatorError(error.to_string()))?;
        return Ok(body);
    }
    fail(format!("OOXML validator archive is missing {wanted}"))
}

// ---- The cache ---------------------------------------------------------------------------------------------------------

fn cache_root(base: &Path, platform: &str) -> PathBuf {
    base.join("office").join("tools").join("ooxml-validator").join(VERSION).join(platform)
}

fn usable_binary<P: WriteProof>(lane: &P, path: &Path) -> bool {
    mixdog_fsio::metadata(lane, path).is_ok_and(|details| details.is_file() && details.len() > MIN_BINARY_BYTES)
}

/// A name no other install of this process or another uses.
fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());
    let seed = format!("{}:{nanos}:{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    Sha256::digest(seed.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

fn io_error(error: io::Error) -> ValidatorError {
    ValidatorError(error.to_string())
}

fn install_validator<P: WriteProof>(
    lane: &P,
    root: &Path,
    entry: &PlatformPackage,
    registry: &str,
    cancel: Option<&AtomicBool>,
) -> Result<ValidatorRuntime> {
    let binary_path = root.join(&entry.binary);
    let temporary = root.join(format!("{}.mixdog-tmp-{}", entry.binary, unique_suffix()));
    let outcome = (|| -> Result<ValidatorRuntime> {
        let url = package_url(registry, &entry.name);
        let archive = on_runtime(fetch_archive(&url, cancel))??;
        verify_integrity(&archive, &entry.integrity)?;
        let binary = archive_entry(&archive, &format!("package/{}", entry.binary))?;
        mixdog_fsio::write(lane, &temporary, &binary).map_err(io_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            mixdog_fsio::set_permissions(lane, &temporary, std::fs::Permissions::from_mode(0o755)).map_err(io_error)?;
        }
        // `rm(binary, { force: true })`: a stale or truncated file makes room, a missing one is nothing.
        drop(mixdog_fsio::remove_file(lane, &binary_path));
        mixdog_fsio::rename(lane, &temporary, &binary_path).map_err(io_error)?;
        Ok(ValidatorRuntime {
            bytes: Some(binary.len() as u64),
            ..ValidatorRuntime::ready(binary_path.clone(), false, VERSION)
        })
    })();
    drop(mixdog_fsio::remove_file(lane, &temporary));
    outcome
}

/// `ensureOoxmlValidator` against the process environment.
pub fn ensure_ooxml_validator<P: WriteProof>(lane: &P, request: &Request<'_>) -> Result<ValidatorRuntime> {
    ensure_in(lane, &Environment::from_process(), request)
}

/// `ensureOoxmlValidator` against `env`: the explicit binary, the off switch, then the cache (installed from the registry
/// when `request.download` allows and the cache has no usable binary; under a lock when the cache is the shared one).
pub fn ensure_in<P: WriteProof>(lane: &P, env: &Environment, request: &Request<'_>) -> Result<ValidatorRuntime> {
    if let Some(path) = &env.cli_override {
        mixdog_fsio::metadata(lane, path).map_err(|error| {
            ValidatorError(match error.kind() {
                io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, access '{}'", path.display()),
                _ => error.to_string(),
            })
        })?;
        return Ok(ValidatorRuntime::ready(path.clone(), true, "override"));
    }
    if env.disabled {
        return Ok(ValidatorRuntime {
            disabled: Some(true),
            ..ValidatorRuntime::unavailable("OOXML schema validation is disabled.")
        });
    }
    let Some((_, entry)) = env.packages.iter().find(|(key, _)| *key == env.platform) else {
        return Ok(ValidatorRuntime::unavailable(format!(
            "OOXML schema validation is unavailable on {}.",
            env.platform
        )));
    };
    // Test runners share immutable tools, never session files or user data. Normal app calls keep their data-directory cache.
    let root = cache_root(env.shared_cache.as_deref().unwrap_or(request.data_dir), &env.platform);
    let binary = root.join(&entry.binary);
    if usable_binary(lane, &binary) {
        return Ok(ValidatorRuntime::ready(binary, true, VERSION));
    }
    if !request.download {
        return Ok(ValidatorRuntime {
            cached: Some(false),
            download_required: Some(true),
            ..ValidatorRuntime::unavailable("OOXML schema validator is not cached.")
        });
    }
    mixdog_fsio::create_dir_all(lane, &root).map_err(io_error)?;
    if env.shared_cache.is_none() {
        return install_validator(lane, &root, entry, &env.registry, request.cancel);
    }
    let options = LockOpts { timeout: Some(INSTALL_LOCK_TIMEOUT), ..LockOpts::default() };
    // `<root>/.install.lock`.
    let locked = mixdog_statefile::with_lock(lane, &root.join(".install"), &options, || {
        throw_if_aborted(request.cancel)?;
        if usable_binary(lane, &binary) {
            return Ok(ValidatorRuntime::ready(binary.clone(), true, VERSION));
        }
        install_validator(lane, &root, entry, &env.registry, request.cancel)
    })
    .map_err(|error| ValidatorError(error.to_string()))?;
    locked
}

// ---- Running -----------------------------------------------------------------------------------------------------------

/// A finished validator process.
struct Exit {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Everything `stream` yields, of which the first [`MAX_OUTPUT_BYTES`] are kept (the rest is read and dropped so the
/// process is never blocked on a full pipe).
async fn capture<R: AsyncRead + Unpin>(mut stream: R) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = vec![0_u8; 16 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return kept,
            Ok(read) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..read.min(room)]);
            }
        }
    }
}

/// The validator run on `document`; `Err` is the reason it did not finish (it did not start, was aborted or timed out).
async fn run_validator(
    program: &Path,
    document: &Path,
    office_version: &str,
    cancel: Option<&AtomicBool>,
) -> std::result::Result<Exit, String> {
    let mut command = tokio::process::Command::new(program);
    command
        .arg(document)
        .arg(office_version)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    // CREATE_NO_WINDOW (`windowsHide`).
    command.creation_flags(0x0800_0000);
    let start_failed = |error: io::Error| format!("Failed to start OOXML schema validator: {error}");
    let mut child = command.spawn().map_err(start_failed)?;
    let out = child.stdout.take().map(|stream| tokio::spawn(capture(stream)));
    let err = child.stderr.take().map(|stream| tokio::spawn(capture(stream)));
    let deadline = Instant::now() + RUN_TIMEOUT;
    let status = loop {
        if cancelled(cancel) {
            drop(child.kill().await);
            return Err("OOXML schema validation was cancelled.".into());
        }
        if Instant::now() >= deadline {
            drop(child.kill().await);
            return Err("OOXML schema validation timed out after 120 seconds.".into());
        }
        match mixdog_rt::time::timeout(ABORT_POLL, child.wait()).await {
            Ok(waited) => break waited.map_err(start_failed)?,
            Err(_) => continue,
        }
    };
    let collect = |task: Option<tokio::task::JoinHandle<Vec<u8>>>| async move {
        match task {
            Some(task) => task.await.unwrap_or_default(),
            None => Vec::new(),
        }
    };
    let stdout = collect(out).await;
    let stderr = collect(err).await;
    Ok(Exit {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// `validateOoxmlSchema` against the process environment.
pub fn validate_ooxml_schema<P: WriteProof>(lane: &P, path: &Path, request: &Request<'_>) -> Result<ValidationResult> {
    validate_in(lane, &Environment::from_process(), path, request)
}

/// `validateOoxmlSchema` against `env`: the validator found or installed, run on `path`, its output classified.
pub fn validate_in<P: WriteProof>(
    lane: &P,
    env: &Environment,
    path: &Path,
    request: &Request<'_>,
) -> Result<ValidationResult> {
    let runtime = ensure_in(lane, env, request)?;
    let Some(program) = runtime.path.clone().filter(|_| runtime.available) else {
        return Ok(ValidationResult::failed(runtime, None));
    };
    let ran = on_runtime(run_validator(&program, path, request.office_version, request.cancel))?;
    let exit = match ran {
        Ok(exit) => exit,
        Err(reason) => return Ok(ValidationResult::failed(runtime, Some(reason))),
    };
    if exit.code != Some(0) {
        let stderr = js_trim(&exit.stderr);
        let reason = if stderr.is_empty() {
            format!("OOXML schema validator exited with code {}.", exit.code.map_or("null".to_owned(), |code| code.to_string()))
        } else {
            stderr.to_owned()
        };
        return Ok(ValidationResult::failed(runtime, Some(reason)));
    }
    Ok(parse_validator_output(&exit.stdout, runtime, request.office_version))
}
