//! `statusline/read` (client -> core): what a front end's footer shows of a thread's route (`loadGatewayStatus`: the route, its
//! cached quota windows and the context share) and of the limits of that route (`buildGatewayLimits`: quota windows, balance and
//! the route's spend). The readers and the rules are `mixdog_core_session::session::statusline_*`; this service reads the files
//! they work on (the data directory's config, session routes, quota cache, usage log and Claude Code's own status files) and
//! answers the two values, so every front end shows the same footer.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_app_protocol::v2::statusline::StatuslineReadParams;
use mixdog_app_protocol::v2::statusline::StatuslineReadResult;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use mixdog_core_session::session::gateway_routes;
use mixdog_core_session::session::gateway_usage::GatewayUsage;
use mixdog_core_session::session::gateway_usage::STORE_FILE as USAGE_FILE;
use mixdog_core_session::session::statusline_claude::AgedFile;
use mixdog_core_session::session::statusline_claude::ClaudeRoute;
use mixdog_core_session::session::statusline_claude::ClaudeSources;
use mixdog_core_session::session::statusline_claude::ClaudeWorld;
use mixdog_core_session::session::statusline_claude::PERSISTED_MAX_AGE_MS;
use mixdog_core_session::session::statusline_claude::read_claude_code_current_route;
use mixdog_core_session::session::statusline_limits::LimitsInput;
use mixdog_core_session::session::statusline_limits::UsageView;
use mixdog_core_session::session::statusline_limits::agent_config_section;
use mixdog_core_session::session::statusline_limits::build_gateway_limits;
use mixdog_core_session::session::statusline_status::StatusInput;
use mixdog_core_session::session::statusline_status::StatusWorld;
use mixdog_core_session::session::statusline_status::load_gateway_status;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

pub const STATUSLINE_READ: &str = "statusline/read";

/// The quota cache of the provider windows (written by `mixdog-ai`'s oauth usage service).
const QUOTA_CACHE_FILE: &str = "gateway-oauth-usage-cache.json";
/// Claude Code's own status files: the model it runs now (in the data directory), and the last status line it printed.
const CLAUDE_CURRENT_FILE: &str = "claude-current-model.json";
const CLAUDE_LAST_FILE: &str = "cc-statusline-last.json";

struct Inner {
    data_dir: PathBuf,
    claude_dir: PathBuf,
    catalog: Arc<CatalogService>,
    usage: GatewayUsage,
    /// When this process started (epoch ms): a cached quota older than it is a previous launch's.
    started_ms: f64,
    /// The incremental view of the usage log, kept between reads.
    events: Mutex<UsageView>,
}

pub struct StatuslineService {
    inner: Arc<Inner>,
}

impl StatuslineService {
    /// `data_dir`: the core's data directory; `claude_config_dir`: Claude Code's ([`Self::claude_config_dir`]); `usage`: the
    /// gateway usage writer whose route section the footer's route spend shares; `started_ms`: this process's start.
    pub fn new(data_dir: PathBuf, claude_config_dir: PathBuf, catalog: Arc<CatalogService>, usage: GatewayUsage, started_ms: f64) -> Self {
        Self { inner: Arc::new(Inner { data_dir, claude_dir: claude_config_dir, catalog, usage, started_ms, events: Mutex::new(UsageView::default()) }) }
    }

    /// Claude Code's configuration directory: `CLAUDE_CONFIG_DIR`, else `.claude` of the home directory.
    pub fn claude_config_dir(env: &dyn Fn(&str) -> Option<std::ffi::OsString>, home: Option<PathBuf>) -> PathBuf {
        env("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.unwrap_or_default().join(".claude"))
    }
}

fn read_json(path: &Path) -> Option<Value> {
    mixdog_js::json_parse(&std::fs::read_to_string(path).ok()?).ok()
}

/// A status file with its modification time (epoch ms).
fn read_aged(path: &Path) -> Option<(Value, f64)> {
    let value = read_json(path)?;
    let modified = std::fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((value, modified.as_millis() as f64))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// The catalog, the environment and Claude Code's files, as the status and the Claude route resolution read them.
struct World<'a> {
    catalog: &'a CatalogService,
    settings: Option<&'a Value>,
    own: Option<AgedFile<'a>>,
    last: Option<AgedFile<'a>>,
    now: f64,
}

impl ClaudeWorld for World<'_> {
    fn context_window(&self, model: &str) -> Option<f64> {
        self.catalog.sync_meta(model, "anthropic-oauth")?.get("contextWindow").and_then(Value::as_f64)
    }

    fn roster(&self) -> Vec<Value> {
        self.catalog.cached_models("anthropic-oauth")
    }

    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

impl StatusWorld for World<'_> {
    fn catalog_meta(&self, model: &str, provider: &str) -> Option<Map<String, Value>> {
        self.catalog.sync_meta(model, provider)
    }

    /// `loadCachedModel(provider, model)`: the row of the provider's cached roster (`<provider>-models.json`).
    fn cached_model(&self, provider: &str, model: &str) -> Option<Value> {
        self.catalog.cached_models(provider).into_iter().find(|row| row.get("id").and_then(Value::as_str) == Some(model))
    }

    fn inherited_route(&self) -> ClaudeRoute {
        let sources = ClaudeSources { settings: self.settings, own: self.own, last: self.last, request: None, max_age_ms: PERSISTED_MAX_AGE_MS, for_boot: false, now: self.now };
        read_claude_code_current_route(self, &sources)
    }
}

impl Inner {
    /// The usage log's events: the file's identity is its path and creation time, so a replaced log is read from its start.
    fn usage_events(&self, now: f64) -> Vec<Value> {
        let path = self.data_dir.join(USAGE_FILE);
        let mut view = self.events.lock().unwrap_or_else(PoisonError::into_inner);
        let Ok(meta) = std::fs::metadata(&path) else {
            view.lost();
            return Vec::new();
        };
        let created = meta.created().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0, |elapsed| elapsed.as_millis());
        let id = format!("{}#{created}", path.display());
        view.refresh(&id, meta.len(), |offset, len| {
            use std::io::Read;
            use std::io::Seek;
            let mut file = std::fs::File::open(&path).ok()?;
            file.seek(std::io::SeekFrom::Start(offset)).ok()?;
            let mut bytes = Vec::with_capacity(len.min(1 << 20));
            file.take(len as u64).read_to_end(&mut bytes).ok()?;
            Some(bytes)
        });
        view.load(now)
    }

    fn read(&self, params: &StatuslineReadParams) -> StatuslineReadResult {
        let now = now_ms();
        let config = read_json(&self.data_dir.join(mixdog_core_config::user_data::CONFIG_FILE));
        let settings = read_json(&self.claude_dir.join("settings.json"));
        let routes = read_json(&self.data_dir.join(gateway_routes::STORE_FILE)).unwrap_or_else(|| json!({}));
        let quota_cache = read_json(&self.data_dir.join(QUOTA_CACHE_FILE));
        let own = read_aged(&self.data_dir.join(CLAUDE_CURRENT_FILE));
        let last = read_aged(&self.claude_dir.join(CLAUDE_LAST_FILE));
        let aged = |file: &Option<(Value, f64)>| file.as_ref().map(|(value, mtime_ms)| AgedFile { value, mtime_ms: *mtime_ms });
        let world = World { catalog: &self.catalog, settings: settings.as_ref(), own: aged(&own), last: aged(&last), now };
        let host_pid = params.client_host_pid.map(Value::from);
        let input = StatusInput {
            config: config.as_ref(),
            settings: settings.as_ref(),
            routes: &routes,
            quota_cache: quota_cache.as_ref(),
            session_id: &params.session_id,
            client_host_pid: host_pid.as_ref(),
            current_route: params.current_route.as_ref(),
            active_context_tokens: params.active_context_tokens,
            process_started_at_ms: self.started_ms,
        };
        let Some(status) = load_gateway_status(&world, &input) else { return StatuslineReadResult::default() };
        let empty = json!({});
        let raw = config.as_ref().unwrap_or(&empty);
        let events = self.usage_events(now);
        let limits_input = LimitsInput { gateway: raw.get("gateway").unwrap_or(&empty), agent: agent_config_section(raw), events: &events, now };
        let limits = self.usage.with_route_section(|section| build_gateway_limits(&limits_input, section, &status, params.provider_out.as_ref(), params.usage_snapshot.as_ref()));
        StatuslineReadResult { status: Some(status), limits: Some(limits) }
    }
}

#[async_trait]
impl DomainService for StatuslineService {
    fn methods(&self) -> &'static [&'static str] {
        &[STATUSLINE_READ]
    }

    async fn call(&self, request: CoreRequest) -> Result<Reply, CoreError> {
        if request.method.as_str() != STATUSLINE_READ {
            return Err(wrong_method("statusline", request.method.as_str()));
        }
        let params: StatuslineReadParams = decode(&request)?;
        let inner = self.inner.clone();
        let answer = tokio::task::spawn_blocking(move || inner.read(&params)).await.map_err(|error| failed("statusline", format!("statusline/read failed: {error}")))?;
        Ok(Reply::Value(json!(answer)))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_config_is_the_variable_else_the_dot_claude_of_the_home() {
        let var = |value: Option<&'static str>| move |name: &str| if name == "CLAUDE_CONFIG_DIR" { value.map(std::ffi::OsString::from) } else { None };
        assert_eq!(StatuslineService::claude_config_dir(&var(Some("D:/cc")), Some("C:/home".into())), PathBuf::from("D:/cc"));
        assert_eq!(StatuslineService::claude_config_dir(&var(Some("")), Some("C:/home".into())), PathBuf::from("C:/home").join(".claude"));
        assert_eq!(StatuslineService::claude_config_dir(&var(None), Some("C:/home".into())), PathBuf::from("C:/home").join(".claude"));
    }
}
