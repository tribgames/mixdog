//! The model-facing Media Studio tool (`runtime/media/tool.mjs`): a thin client of the media graph
//! (lanes, jobs, store), so a generation started here shows up in the Studio gallery and a lane
//! added to the catalog is available here without a code change. [`MediaToolService`] is the
//! [`ToolService`] behind `ServiceTool::media`; the graph it talks to is the [`MediaGraph`] seam
//! (Node's injectable `deps`), [`StudioGraph`] over `MediaJobs` and `MediaStore` in production.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_base::support::{FsFailure, FsStep, io_failure};
use mixdog_js::{js_trim, json_number, number_to_string, to_number, value_to_string};
use mixdog_rt::DurabilityIo;
use mixdog_tools::orch::service::{ServiceCall, ToolService};
use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::jobs::{MediaFailure, MediaJobs};
use super::lanes::MEDIA_KINDS;
use super::store::MediaStore;
use crate::lane::{io_on_lane, on_lane};

pub const MEDIA_ACTIONS: [&str; 4] = ["list", "generate", "status", "cancel"];
const DEFAULT_LANE: &str = "openai-oauth";
const MAX_REFERENCE_BYTES: usize = 12 * 1024 * 1024;
const GATEWAY_IMAGE_LANES: [&str; 2] = ["openrouter", "nano-gpt"];

/// `OPENAI_SIZE`: the OpenAI image lane takes pixel sizes, the placement speaks in ratios.
fn openai_size(aspect: &str) -> Option<&'static str> {
    Some(match aspect {
        "16:9" | "4:3" | "3:2" => "1536x1024",
        "9:16" | "3:4" | "2:3" => "1024x1536",
        "1:1" => "1024x1024",
        _ => return None,
    })
}

fn image_mime(extension: &str) -> Option<&'static str> {
    Some(match extension {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        _ => return None,
    })
}

/// What the tool reads of the media graph: Node's `deps` (`lanes`, `jobs`, `store`, `defaults`,
/// `accounts`) as one seam.
#[async_trait]
pub trait MediaGraph: Send + Sync {
    /// `listMediaLanes()`, or under a provider account (withProviderAccount); a provider or
    /// account id that is refused is Node's thrown `TypeError` text.
    async fn lanes(&self, account: Option<(&str, &str)>) -> Result<Vec<Value>, String>;
    /// `mediaLaneAccountProvider(lane)`: the provider whose account a pin on `lane` names; empty
    /// when the lane has none.
    fn account_provider(&self, lane: &str) -> String;
    /// `startMediaJob(input)`: the job snapshot.
    async fn start(&self, input: &Value) -> Result<Value, MediaFailure>;
    /// `getMediaJob(id)`.
    fn get(&self, id: &str) -> Option<Value>;
    /// `cancelMediaJob(id)`: `{ id, canceled }`.
    fn cancel(&self, id: &str) -> Value;
    /// `resolveMediaFile(id, { variant: 'original' }).path`.
    async fn original_path(&self, asset_id: &str) -> Option<PathBuf>;
    /// `getMediaDefault(kind)`: the lane and model last chosen.
    async fn remembered(&self, kind: &str) -> Option<Value>;
    /// `getMediaPin(kind)`.
    async fn pin(&self, kind: &str) -> Option<Value>;
}

/// The provider-account scope of a pinned lane (`provider-auth-binding.mjs`
/// `withProviderAccount`), owed by the account layer.
#[async_trait]
pub trait PinnedAccounts: Send + Sync {
    fn provider_of(&self, lane: &str) -> String;
    /// The lane catalog as `account` of `provider` sees it.
    async fn lanes_as(&self, provider: &str, account: &str) -> Result<Vec<Value>, String>;
}

/// [`MediaGraph`] over the Studio's jobs and store.
pub struct StudioGraph {
    pub jobs: Arc<MediaJobs>,
    pub store: Arc<MediaStore>,
    /// `None`: a pinned account is not applied (Node's `mediaLaneAccountProvider?.()` absent).
    pub accounts: Option<Arc<dyn PinnedAccounts>>,
}

#[async_trait]
impl MediaGraph for StudioGraph {
    async fn lanes(&self, account: Option<(&str, &str)>) -> Result<Vec<Value>, String> {
        if let (Some((provider, name)), Some(accounts)) = (account, &self.accounts) {
            return accounts.lanes_as(provider, name).await;
        }
        Ok(self.jobs.lanes().await.as_array().cloned().unwrap_or_default())
    }

    fn account_provider(&self, lane: &str) -> String {
        self.accounts.as_ref().map(|accounts| accounts.provider_of(lane)).unwrap_or_default()
    }

    async fn start(&self, input: &Value) -> Result<Value, MediaFailure> {
        self.jobs.start(input).await
    }

    fn get(&self, id: &str) -> Option<Value> {
        self.jobs.get(id)
    }

    fn cancel(&self, id: &str) -> Value {
        self.jobs.cancel(id)
    }

    async fn original_path(&self, asset_id: &str) -> Option<PathBuf> {
        let id = asset_id.to_owned();
        let entry = self.store.run(move |store| store.resolve_file(&id)).await.ok()?.ok()??;
        entry.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()).map(PathBuf::from)
    }

    async fn remembered(&self, kind: &str) -> Option<Value> {
        let kind = json!(kind);
        let store = self.store.clone();
        store.run(move |store| store.get_default(Some(&kind))).await.ok().filter(|v| !v.is_null())
    }

    async fn pin(&self, kind: &str) -> Option<Value> {
        let store = self.store.clone();
        store.run(|store| store.get_pins()).await.ok()?.get(kind).filter(|v| !v.is_null()).cloned()
    }
}

// ── errors and small helpers ──────────────────────────────────────────────

/// `MediaToolError` and the coded errors of the graph: the message, a code a deeper layer set,
/// and the extra members the reply carries.
#[derive(Debug, Default)]
struct ToolFailure {
    message: String,
    code: Option<String>,
    extra: Map<String, Value>,
}

impl ToolFailure {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), ..Self::default() }
    }

    fn with(mut self, key: &str, value: Value) -> Self {
        self.extra.insert(key.to_owned(), value);
        self
    }
}

impl From<MediaFailure> for ToolFailure {
    fn from(failure: MediaFailure) -> Self {
        Self { message: failure.message, code: failure.code, extra: Map::new() }
    }
}

type Done<T> = Result<T, ToolFailure>;

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_trim(&value_to_string(other)).to_owned(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).filter(|v| !v.is_null()).map(value_to_string).unwrap_or_default()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_file(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

/// `mkdir(dirname(to), { recursive: true })` then `copyFile(from, to)`.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn copy_file(from: &Path, to: &Path) -> Result<(), FsFailure> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|error| FsFailure { error, step: FsStep::Mkdir(parent.to_owned()) })?;
    }
    std::fs::copy(from, to).map(drop).map_err(|error| FsFailure { error, step: FsStep::CopyFile(from.to_owned(), to.to_owned()) })
}

/// `path.extname`.
fn extname(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(at) if at > 0 => &name[at..],
        _ => "",
    }
}

fn full_path(path: &str, cwd: &Path) -> PathBuf {
    if Path::new(path).is_absolute() { PathBuf::from(path) } else { mixdog_workspace::pathguard::lexical(&cwd.join(path)) }
}

fn includes_kind(lane: &Value, kind: &str) -> bool {
    lane.get("kinds").and_then(Value::as_array).is_some_and(|kinds| kinds.iter().any(|k| k.as_str() == Some(kind)))
}

fn compact_lane(lane: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "label", "authType", "kinds"] {
        if let Some(value) = lane.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    for kind in MEDIA_KINDS {
        if truthy(lane.get(kind)) {
            if let Some(model) = lane[kind].get("defaultModel") {
                out.insert(kind.into(), model.clone());
            }
        }
    }
    Value::Object(out)
}

fn models_of<'a>(lane: &'a Value, kind: &str) -> &'a [Value] {
    lane.get(kind).and_then(|spec| spec.get("models")).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn model_controls(lane: &Value, kind: &str, model_id: &str) -> Option<Value> {
    let entry = models_of(lane, kind).iter().find(|model| model.get("id").and_then(Value::as_str) == Some(model_id))?;
    let mut out = Map::new();
    for key in ["id", "label", "controls"] {
        if let Some(value) = entry.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if truthy(entry.get("description")) {
        out.insert("description".into(), entry["description"].clone());
    }
    Some(Value::Object(out))
}

// ── list ──────────────────────────────────────────────────────────────────

/// `listMediaCatalog`: nothing gives the lanes; a kind the lanes with model ids (and the
/// remembered lane/model); a kind and a model that one model's controls.
fn list_media_catalog(lanes: &[Value], kind: &str, model: &str, remembered: Option<&Value>) -> Done<Value> {
    let signed_in: Vec<&Value> = lanes.iter().filter(|lane| truthy(lane.get("authenticated"))).collect();
    let signed_out: Vec<Value> = lanes.iter().filter(|lane| !truthy(lane.get("authenticated"))).map(|lane| lane["id"].clone()).collect();
    let mut diagnostics = Map::new();
    let errors: Vec<Value> = lanes
        .iter()
        .filter(|lane| truthy(lane.get("catalogError")))
        .map(|lane| {
            let mut row = Map::new();
            row.insert("lane".into(), lane["id"].clone());
            row.insert("error".into(), lane["catalogError"].clone());
            if let Some(code) = lane.get("catalogErrorCode") {
                row.insert("code".into(), code.clone());
            }
            Value::Object(row)
        })
        .collect();
    if !errors.is_empty() {
        diagnostics.insert("catalogErrors".into(), Value::Array(errors));
    }
    let warnings: Vec<Value> = lanes
        .iter()
        .filter(|lane| truthy(lane.get("catalogWarning")))
        .map(|lane| json!({ "lane": lane["id"], "warning": lane["catalogWarning"] }))
        .collect();
    if !warnings.is_empty() {
        diagnostics.insert("catalogWarnings".into(), Value::Array(warnings));
    }
    let mut out = Map::new();
    if kind.is_empty() {
        out.insert("lanes".into(), Value::Array(signed_in.iter().map(|lane| compact_lane(lane)).collect()));
        if !signed_out.is_empty() {
            out.insert("signedOut".into(), Value::Array(signed_out));
        }
        out.extend(diagnostics);
        return Ok(Value::Object(out));
    }
    if !MEDIA_KINDS.contains(&kind) {
        return Err(ToolFailure::new(format!("kind must be one of {}", MEDIA_KINDS.join(", "))));
    }
    let rows: Vec<&Value> = signed_in.into_iter().filter(|lane| includes_kind(lane, kind)).collect();
    if model.is_empty() {
        out.insert("kind".into(), json!(kind));
        let lanes_out: Vec<Value> = rows
            .iter()
            .map(|lane| {
                json!({
                    "id": lane["id"], "label": lane["label"], "defaultModel": lane[kind]["defaultModel"],
                    "models": models_of(lane, kind).iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>(),
                })
            })
            .collect();
        out.insert("lanes".into(), Value::Array(lanes_out));
        // What a generate without lane/model will run on.
        if let Some(chosen) = remembered.filter(|r| truthy(r.get("lane"))) {
            out.insert("remembered".into(), json!({ "lane": chosen["lane"], "model": if truthy(chosen.get("model")) { chosen["model"].clone() } else { json!("") } }));
        }
        if !signed_out.is_empty() {
            out.insert("signedOut".into(), Value::Array(signed_out));
        }
        out.extend(diagnostics);
        return Ok(Value::Object(out));
    }
    let mut matches = Vec::new();
    for lane in &rows {
        if let Some(Value::Object(controls)) = model_controls(lane, kind, model) {
            let mut row = Map::new();
            row.insert("lane".into(), lane["id"].clone());
            row.extend(controls);
            matches.push(Value::Object(row));
        }
    }
    if matches.is_empty() {
        let available: Vec<Value> = rows
            .iter()
            .flat_map(|lane| models_of(lane, kind).iter().map(move |entry| json!(format!("{}/{}", text(lane, "id"), text(entry, "id")))))
            .collect();
        return Err(ToolFailure::new(format!("model \"{model}\" is not available for {kind} on a signed-in lane")).with("available", Value::Array(available)));
    }
    Ok(json!({ "kind": kind, "models": matches }))
}

/// `pickLane`: the requested lane, else the one the user last chose for this kind, else the
/// signed-in ChatGPT-subscription lane, else the first signed-in lane.
fn pick_lane<'a>(lanes: &'a [Value], kind: &str, requested: &str, remembered: Option<&Value>) -> Done<(&'a Value, &'static str)> {
    let available: Vec<&Value> = lanes.iter().filter(|lane| truthy(lane.get("authenticated")) && includes_kind(lane, kind)).collect();
    let catalog = || Value::Array(available.iter().map(|lane| compact_lane(lane)).collect());
    if !requested.is_empty() {
        let lane = available.iter().copied().find(|entry| entry.get("id").and_then(Value::as_str) == Some(requested));
        if let Some(broken) = lanes.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(requested) && truthy(entry.get("catalogError"))) {
            return Err(ToolFailure::new(text(broken, "catalogError")).with("lanes", catalog()));
        }
        return match lane {
            Some(lane) => Ok((lane, "requested")),
            None => Err(ToolFailure::new(format!("lane \"{requested}\" is not signed in or does not generate {kind}")).with("lanes", catalog())),
        };
    }
    if available.is_empty() {
        let failures: Vec<String> = lanes.iter().filter(|lane| truthy(lane.get("catalogError"))).map(|lane| text(lane, "catalogError")).collect();
        if !failures.is_empty() {
            return Err(ToolFailure::new(failures.join("\n")).with("lanes", json!([])));
        }
        return Err(ToolFailure::new(format!("No signed-in lane generates {kind} (Settings → Providers). Use user-supplied files or continue without media.")).with("lanes", json!([])));
    }
    let remembered_lane = remembered
        .filter(|r| truthy(r.get("lane")))
        .and_then(|r| available.iter().copied().find(|entry| entry.get("id") == r.get("lane")));
    if let Some(lane) = remembered_lane {
        return Ok((lane, "remembered"));
    }
    let lane = available.iter().copied().find(|entry| entry.get("id").and_then(Value::as_str) == Some(DEFAULT_LANE)).or(available.first().copied());
    Ok((lane.expect("a lane is available"), "first"))
}

// ── generate ──────────────────────────────────────────────────────────────

fn allowed<'a>(controls: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    controls.get(key).and_then(Value::as_array).filter(|list| !list.is_empty())
}

fn includes_value(list: &[Value], value: &str) -> bool {
    list.iter().any(|entry| entry.as_str() == Some(value))
}

fn validate_choice(controls: &Value, key: &str, value: &str, label: &str) -> Done<()> {
    let list = allowed(controls, key);
    if value.is_empty() {
        return Ok(());
    }
    if list.is_some_and(|list| includes_value(list, value)) {
        return Ok(());
    }
    let hint = list.map(|list| format!("; use one of {}", list.iter().map(value_to_string).collect::<Vec<_>>().join(", "))).unwrap_or_default();
    Err(ToolFailure::new(format!("{label} \"{value}\" is not supported by this model{hint}")))
}

/// The tool's placement vocabulary (`aspect`, `resolution`, `duration`, `quality`,
/// `background`) as the lane's own options, validated against the model's controls.
struct Placement<'a> {
    aspect: &'a str,
    resolution: &'a str,
    duration: Option<&'a Value>,
    quality: &'a str,
    background: &'a str,
}

fn build_options(lane_id: &str, kind: &str, controls: &Value, p: &Placement<'_>) -> Done<Value> {
    let mut options = Map::new();
    if !p.background.is_empty() {
        validate_choice(controls, "background", p.background, "background")?;
        if p.background != "auto" {
            options.insert("background".into(), json!(p.background));
        }
    }
    if lane_id == DEFAULT_LANE {
        if allowed(controls, "size").is_none() {
            if [p.aspect, p.resolution, p.quality].iter().any(|value| !value.is_empty() && *value != "auto") {
                return Err(ToolFailure::new("ChatGPT selects image output settings; explicit size and quality are not supported on this connection."));
            }
            return Ok(Value::Object(options));
        }
        let size = if p.aspect.is_empty() { Some("auto") } else { openai_size(p.aspect) };
        if !p.aspect.is_empty() && size.is_none() {
            let known = ["16:9", "4:3", "3:2", "9:16", "3:4", "2:3", "1:1"];
            return Err(ToolFailure::new(format!("aspect \"{}\" has no size on {lane_id}; use one of {}", p.aspect, known.join(", "))));
        }
        validate_choice(controls, "size", size.unwrap_or_default(), "size")?;
        options.insert("size".into(), json!(size.filter(|s| !s.is_empty()).unwrap_or("auto")));
        if !p.quality.is_empty() {
            validate_choice(controls, "quality", p.quality, "quality")?;
        }
        if allowed(controls, "quality").is_some() {
            options.insert("quality".into(), json!(if p.quality.is_empty() { "auto" } else { p.quality }));
        }
    } else {
        if !p.aspect.is_empty() {
            validate_choice(controls, "aspectRatio", p.aspect, "aspect")?;
            options.insert("aspectRatio".into(), json!(p.aspect));
        }
        if !p.resolution.is_empty() {
            validate_choice(controls, "resolution", p.resolution, "resolution")?;
            options.insert("resolution".into(), json!(p.resolution));
        } else if kind == "image" && !GATEWAY_IMAGE_LANES.contains(&lane_id) && allowed(controls, "resolution").is_some_and(|list| includes_value(list, "2k")) {
            // Gateway models bill per resolution tier: an omitted resolution keeps the
            // provider's default there instead of silently upscaling.
            options.insert("resolution".into(), json!("2k"));
        }
        if !p.quality.is_empty() {
            validate_choice(controls, "quality", p.quality, "quality")?;
            options.insert("quality".into(), json!(p.quality));
        }
    }
    if kind == "video" {
        if let Some(duration) = p.duration.filter(|d| !d.is_null()) {
            let seconds = to_number(duration);
            let shown = number_to_string(seconds);
            if let Some(durations) = allowed(controls, "durations") {
                if !durations.iter().any(|entry| to_number(entry) == seconds && entry.is_number()) {
                    let list = durations.iter().map(value_to_string).collect::<Vec<_>>().join(", ");
                    return Err(ToolFailure::new(format!("duration {shown}s is not supported; use one of {list}")));
                }
            }
            let range = controls.get("durationRange").and_then(Value::as_array).filter(|r| r.len() == 2);
            if let Some(range) = range {
                let (low, high) = (to_number(&range[0]), to_number(&range[1]));
                if seconds < low || seconds > high {
                    return Err(ToolFailure::new(format!("duration {shown}s is outside {}-{}s", number_to_string(low), number_to_string(high))));
                }
            }
            options.insert("duration".into(), json_number(seconds));
        }
    }
    Ok(Value::Object(options))
}

/// `jobView`.
fn job_view(job: &Value, now: i64) -> Map<String, Value> {
    let stamp = |key: &str| {
        let value = to_number(job.get(key).unwrap_or(&Value::Null));
        if value == 0.0 || value.is_nan() { now as f64 } else { value }
    };
    let mut view = Map::new();
    for (name, key) in [("job", "id"), ("status", "status"), ("kind", "kind"), ("lane", "lane"), ("model", "model"), ("options", "options"), ("progress", "progress"), ("assetId", "assetId"), ("error", "error")] {
        if let Some(value) = job.get(key) {
            view.insert(name.into(), value.clone());
        }
    }
    view.insert("elapsedMs".into(), json_number((stamp("endedAt") - stamp("startedAt")).max(0.0)));
    view
}

/// The mime and bytes of each reference image (`readReferences`).
async fn read_references(paths: Option<&Value>, cwd: &Path, controls: &Value, io: DurabilityIo) -> Done<Vec<Value>> {
    let list: Vec<String> = paths.and_then(Value::as_array).map(|a| a.iter().map(|p| clean(Some(p))).filter(|p| !p.is_empty()).collect()).unwrap_or_default();
    if list.is_empty() {
        return Ok(Vec::new());
    }
    let cap = {
        let n = to_number(controls.get("maxReferences").unwrap_or(&Value::Null));
        if n.is_nan() { 0 } else { n as i64 }
    };
    if cap == 0 {
        return Err(ToolFailure::new("this model takes no reference images"));
    }
    if list.len() as i64 > cap {
        return Err(ToolFailure::new(format!("this model takes at most {cap} reference image(s); {} given", list.len())));
    }
    let mut references = Vec::new();
    for entry in list {
        let file = full_path(&entry, cwd);
        let Some(mime) = image_mime(&extname(&file.to_string_lossy()).to_lowercase()) else {
            return Err(ToolFailure::new(format!("reference \"{entry}\" is not a png/jpg/webp/gif image")));
        };
        let read = file.clone();
        // Node's `fs` on Windows reports the namespaced path, i.e. `path.resolve`d: `\` separators.
        let reported = mixdog_workspace::pathguard::lexical(&file);
        let bytes = io_on_lane(io, move || read_file(&read)).await.map_err(|e| io_tool_failure(&FsFailure { error: e, step: FsStep::Open(reported) }))?;
        if bytes.len() > MAX_REFERENCE_BYTES {
            return Err(ToolFailure::new(format!("reference \"{entry}\" exceeds {} MB", MAX_REFERENCE_BYTES / 1024 / 1024)));
        }
        references.push(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(&bytes), "mime": mime }));
    }
    Ok(references)
}

/// Node's text for a failed file operation (`ENOENT: no such file or directory, open '<path>'`),
/// from the shared translation.
fn io_tool_failure(failure: &FsFailure) -> ToolFailure {
    match io_failure("media", failure) {
        CoreError::DomainError { message: Some(message), code, .. } => ToolFailure { message: message.to_string(), code: code.map(|c| c.to_string()), extra: Map::new() },
        other => ToolFailure::new(other.to_string()),
    }
}
async fn copy_asset(graph: &dyn MediaGraph, asset_id: &str, target: PathBuf, io: DurabilityIo) -> Done<PathBuf> {
    let Some(source) = graph.original_path(asset_id).await else {
        return Err(ToolFailure::new("the generated asset is not readable from the media store"));
    };
    let output = if extname(&target.to_string_lossy()).is_empty() { PathBuf::from(format!("{}{}", target.display(), extname(&source.to_string_lossy()))) } else { target };
    let (from, to) = (source, output.clone());
    on_lane(io, move || copy_file(&from, &to))
        .await
        .map_err(|e| ToolFailure::new(e.to_string()))?
        .map_err(|failure| io_tool_failure(&failure))?;
    Ok(output)
}

// ── the service ───────────────────────────────────────────────────────────

pub struct MediaToolService {
    graph: Arc<dyn MediaGraph>,
    io: DurabilityIo,
    /// `getSession(sessionId)?.sourceType`: attributes generation spend in the usage ledger.
    source_type: Arc<dyn Fn(&str) -> String + Send + Sync>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    poll: Duration,
}

impl MediaToolService {
    pub fn new(graph: Arc<dyn MediaGraph>, io: DurabilityIo, source_type: Arc<dyn Fn(&str) -> String + Send + Sync>) -> Self {
        let now: Arc<dyn Fn() -> i64 + Send + Sync> =
            Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64));
        Self { graph, io, source_type, now, poll: Duration::from_millis(750) }
    }

    /// A clock and a polling interval of the caller's (the tests').
    pub fn with_timing(mut self, now: Arc<dyn Fn() -> i64 + Send + Sync>, poll: Duration) -> Self {
        self.now = now;
        self.poll = poll;
        self
    }

    /// `executeMediaTool(args, { cwd, signal, sessionId, sourceType })`: the reply envelope
    /// (`{ content: [{ type: 'text', text }], isError? }`) as a value.
    pub async fn execute(&self, args: &Value, cwd: &Path, session_id: &str, cancel: &CancellationToken) -> Value {
        let empty = json!({});
        let args = if args.is_object() { args } else { &empty };
        let action = clean(args.get("action")).to_lowercase();
        let outcome = self.run(&action, args, cwd, session_id, cancel).await;
        match outcome {
            Ok(value) => reply(&value, false),
            Err(failure) => {
                let mut body = Map::new();
                body.insert("ok".into(), json!(false));
                body.insert("action".into(), json!(action));
                body.insert("error".into(), json!(failure.message));
                if let Some(code) = failure.code.filter(|c| !c.is_empty()) {
                    body.insert("code".into(), json!(code));
                }
                body.extend(failure.extra);
                reply(&Value::Object(body), true)
            }
        }
    }

    async fn run(&self, action: &str, args: &Value, cwd: &Path, session_id: &str, cancel: &CancellationToken) -> Done<Value> {
        if !MEDIA_ACTIONS.contains(&action) {
            return Err(ToolFailure::new(format!("Unsupported media action \"{action}\"; use {}", MEDIA_ACTIONS.join(", "))));
        }
        match action {
            "list" => {
                let lanes = self.graph.lanes(None).await.map_err(ToolFailure::new)?;
                let kind = clean(args.get("kind"));
                let remembered = match self.graph.pin(&kind).await {
                    Some(pin) => Some(pin),
                    None => self.graph.remembered(&kind).await,
                };
                let listed = list_media_catalog(&lanes, &kind, &clean(args.get("model")), remembered.as_ref())?;
                let mut out = Map::new();
                out.insert("ok".into(), json!(true));
                out.extend(listed.as_object().cloned().unwrap_or_default());
                Ok(Value::Object(out))
            }
            "generate" => self.generate(args, cwd, session_id, cancel).await,
            "status" => self.status(args, cwd).await,
            _ => self.cancel(args),
        }
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    async fn generate(&self, args: &Value, cwd: &Path, session_id: &str, cancel: &CancellationToken) -> Done<Value> {
        let kind = clean(args.get("kind"));
        if !MEDIA_KINDS.contains(&kind.as_str()) {
            return Err(ToolFailure::new(format!("generate requires kind: {}", MEDIA_KINDS.join(" | "))));
        }
        let prompt = clean(args.get("prompt"));
        if prompt.is_empty() {
            return Err(ToolFailure::new("generate requires prompt: the subject, the treatment, the mood, the framing, and what must not appear"));
        }
        let requested_path = clean(args.get("path"));
        if requested_path.is_empty() {
            return Err(ToolFailure::new("generate requires path: where to write the file"));
        }
        let target = full_path(&requested_path, cwd);
        // A generator the chat names (lane or model) wins for this call; otherwise the pinned
        // default for the kind applies, and with none the remembered choice. A pin never falls
        // back: its lane, model and account errors surface as they are.
        let named = !clean(args.get("lane")).is_empty() || !clean(args.get("model")).is_empty();
        let pin = if named { None } else { self.graph.pin(&kind).await };
        let remembered = if pin.is_some() { None } else { self.graph.remembered(&kind).await };
        let pin_account = pin.as_ref().map(|p| text(p, "account")).filter(|a| !a.is_empty());
        let pin_lane = pin.as_ref().map(|p| text(p, "lane")).unwrap_or_default();
        let account_provider = if pin_account.is_some() { self.graph.account_provider(&pin_lane) } else { String::new() };
        let lanes = match (&pin_account, account_provider.is_empty()) {
            (Some(account), false) => self.graph.lanes(Some((&account_provider, account))).await,
            _ => self.graph.lanes(None).await,
        }
        .map_err(ToolFailure::new)?;
        let requested = if pin.is_some() { pin_lane.clone() } else { clean(args.get("lane")) };
        let (lane, source) = pick_lane(&lanes, &kind, &requested, remembered.as_ref())?;
        let lane_source = if pin.is_some() { "pinned" } else { source };
        let spec = &lane[kind.as_str()];
        // The remembered model only applies on the remembered lane and only while that lane lists it.
        let remembered_model = remembered
            .as_ref()
            .filter(|r| lane_source == "remembered" && truthy(r.get("model")))
            .map(|r| text(r, "model"))
            .filter(|model| models_of(lane, &kind).iter().any(|entry| entry.get("id").and_then(Value::as_str) == Some(model.as_str())))
            .unwrap_or_default();
        let model_id = [clean(args.get("model")), pin.as_ref().map(|p| text(p, "model")).unwrap_or_default(), remembered_model, text(spec, "defaultModel")]
            .into_iter()
            .find(|candidate| !candidate.is_empty())
            .unwrap_or_default();
        let lane_id = text(lane, "id");
        let Some(model) = model_controls(lane, &kind, &model_id) else {
            let available: Vec<Value> = models_of(lane, &kind).iter().map(|entry| entry["id"].clone()).collect();
            return Err(ToolFailure::new(format!("model \"{model_id}\" is not available on {lane_id} for {kind}")).with("available", Value::Array(available)));
        };
        let controls = model.get("controls").cloned().unwrap_or(Value::Null);
        let (aspect, resolution, quality, background) = (clean(args.get("aspect")), clean(args.get("resolution")), clean(args.get("quality")), clean(args.get("background")));
        let options = build_options(&lane_id, &kind, &controls, &Placement { aspect: &aspect, resolution: &resolution, duration: args.get("duration"), quality: &quality, background: &background })?;
        let references = read_references(args.get("references"), cwd, &controls, self.io).await?;
        let mut input = Map::new();
        for (key, value) in [("lane", json!(lane_id)), ("kind", json!(kind)), ("model", json!(model_id)), ("prompt", json!(prompt)), ("options", options.clone()), ("references", json!(references)), ("sessionId", json!(session_id)), ("sourceType", json!((self.source_type)(session_id)))] {
            input.insert(key.into(), value);
        }
        if let (Some(account), false) = (&pin_account, account_provider.is_empty()) {
            input.insert("account".into(), json!(account));
        }
        let started = self.graph.start(&Value::Object(input)).await?;
        let mut base = Map::new();
        for (key, value) in [("lane", json!(lane_id)), ("model", json!(model_id)), ("laneSource", json!(lane_source)), ("options", options), ("referenceCount", json!(references.len())), ("prompt", json!(prompt))] {
            base.insert(key.into(), value);
        }
        if args.get("wait") == Some(&Value::Bool(false)) {
            let mut out = Map::new();
            out.insert("ok".into(), json!(true));
            out.extend(job_view(&started, self.now()));
            out.extend(base);
            out.insert("nextAction".into(), json!(format!("Poll media status job:{} path:{requested_path}; the file is written when status is done.", text(&started, "id"))));
            return Ok(Value::Object(out));
        }
        let timeout_ms: i64 = if kind == "video" { 900_000 } else { 180_000 };
        let deadline = self.now() + timeout_ms;
        let mut job = started;
        let job_id = text(&job, "id");
        while job.get("status").and_then(Value::as_str) == Some("running") {
            if cancel.is_cancelled() {
                self.graph.cancel(&job_id);
                return Err(ToolFailure::new("generation canceled"));
            }
            if self.now() > deadline {
                return Err(ToolFailure::new(format!("generation is still running after {}s on {lane_id}; poll media status job:{job_id}", timeout_ms / 1000)).with("job", json!(job_id)));
            }
            tokio::time::sleep(self.poll).await;
            job = self.graph.get(&job_id).unwrap_or(job);
        }
        let asset_id = text(&job, "assetId");
        if job.get("status").and_then(Value::as_str) != Some("done") || !truthy(job.get("assetId")) {
            let why = if truthy(job.get("error")) { text(&job, "error") } else { text(&job, "status") };
            return Err(ToolFailure::new(format!("generation failed on {lane_id}/{model_id}: {why}")).with("job", json!(job_id)));
        }
        let output = copy_asset(self.graph.as_ref(), &asset_id, target, self.io).await?;
        let elapsed = job_view(&job, self.now()).remove("elapsedMs").unwrap_or(json!(0));
        let mut out = Map::new();
        out.insert("ok".into(), json!(true));
        out.insert("output".into(), json!(output.to_string_lossy()));
        out.extend(base);
        out.insert("assetId".into(), json!(asset_id));
        out.insert("elapsedMs".into(), elapsed);
        Ok(Value::Object(out))
    }

    async fn status(&self, args: &Value, cwd: &Path) -> Done<Value> {
        let id = clean(args.get("job"));
        if id.is_empty() {
            return Err(ToolFailure::new("status requires job"));
        }
        let Some(job) = self.graph.get(&id) else {
            return Err(ToolFailure::new(format!("job \"{id}\" is not known (finished jobs expire after 10 minutes)")));
        };
        let mut view = Map::new();
        view.insert("ok".into(), json!(job.get("status").and_then(Value::as_str) != Some("failed")));
        view.extend(job_view(&job, self.now()));
        let path = clean(args.get("path"));
        if job.get("status").and_then(Value::as_str) == Some("done") && truthy(job.get("assetId")) && !path.is_empty() {
            let output = copy_asset(self.graph.as_ref(), &text(&job, "assetId"), full_path(&path, cwd), self.io).await?;
            view.insert("output".into(), json!(output.to_string_lossy()));
        }
        Ok(Value::Object(view))
    }

    fn cancel(&self, args: &Value) -> Done<Value> {
        let id = clean(args.get("job"));
        if id.is_empty() {
            return Err(ToolFailure::new("cancel requires job"));
        }
        // The cancel answers `{ id, canceled }` even for an unknown id, so the job itself is
        // looked up for both the existence check and the view.
        if self.graph.get(&id).is_none() {
            return Err(ToolFailure::new(format!("job \"{id}\" is not known")));
        }
        let canceled = self.graph.cancel(&id)["canceled"] == json!(true);
        let job = self.graph.get(&id).unwrap_or(Value::Null);
        let mut out = Map::new();
        out.insert("ok".into(), json!(true));
        out.extend(job_view(&job, self.now()));
        out.insert("canceled".into(), json!(canceled));
        Ok(Value::Object(out))
    }
}

/// `mediaToolResult(value, isError)`.
fn reply(value: &Value, is_error: bool) -> Value {
    let mut envelope = Map::new();
    envelope.insert("content".into(), json!([{ "type": "text", "text": serde_json::to_string_pretty(value).unwrap_or_default() }]));
    if is_error {
        envelope.insert("isError".into(), json!(true));
    }
    Value::Object(envelope)
}

/// The text of a reply envelope, or the same text as a failure when it is flagged `isError`.
fn envelope_to_parts(envelope: &Value) -> Result<Vec<ToolPart>, PortError> {
    let text = envelope["content"][0]["text"].as_str().unwrap_or_default().to_owned();
    if envelope["isError"] == Value::Bool(true) {
        return Err(PortError::Failed { capability: "media".into(), message: text });
    }
    Ok(vec![ToolPart::Text(text)])
}

#[async_trait]
impl ToolService for MediaToolService {
    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
        let envelope = self.execute(call.args, call.cwd.as_path(), call.thread.as_str(), call.cancel).await;
        envelope_to_parts(&envelope)
    }
}
