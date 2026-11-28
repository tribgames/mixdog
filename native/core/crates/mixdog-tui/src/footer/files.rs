//! The files the footer is built from, read and handed to the rules of `mixdog-core-files` (`statusline_status`,
//! `statusline_claude`, `statusline_limits`): the data directory's config, gateway session routes, quota cache, account credentials and usage log,
//! the config directory's `settings.json` and the two status files of the Claude-current route, and the shell-job and memory-cycle state the second row counts.
//! The rules are not repeated here; this reads what they decide on.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_files::gateway_routes;
use mixdog_core_files::gateway_usage::STORE_FILE as USAGE_FILE;
use mixdog_core_files::statusline_claude::AgedFile;
use mixdog_core_files::statusline_claude::ClaudeRoute;
use mixdog_core_files::statusline_claude::ClaudeSources;
use mixdog_core_files::statusline_claude::ClaudeWorld;
use mixdog_core_files::statusline_claude::PERSISTED_MAX_AGE_MS;
use mixdog_core_files::statusline_claude::read_claude_code_current_route;
use mixdog_core_files::statusline_limits::UsageView;
use mixdog_core_files::statusline_status::StatusInput;
use mixdog_core_files::statusline_status::StatusWorld;
use mixdog_core_files::statusline_status::load_gateway_status;
use mixdog_view_model::display::statusline_segments::SegmentSource;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::host::StatusHost;
use super::host::StatusPaths;
use super::io::StatusIo;

/// The quota cache of the provider windows (written by the OAuth usage service).
const QUOTA_CACHE_FILE: &str = "gateway-oauth-usage-cache.json";
/// The Claude-current route's status files: the model Claude Code runs now (in the data directory), and the last status line
/// it printed (in the config directory).
const CLAUDE_CURRENT_FILE: &str = "claude-current-model.json";
const CLAUDE_LAST_FILE: &str = "cc-statusline-last.json";
const SHELL_JOBS_DIR: &str = "shell-jobs";
const MEMORY_CYCLE_FILE: &str = "memory-cycle-state.json";

/// What `loadGatewayStatus` is asked: the route in hand and the context it measures.
#[derive(Clone, Debug)]
pub struct StatusRequest {
    pub session_id: String,
    pub client_host_pid: f64,
    pub active_context_tokens: Option<f64>,
    /// `{ provider, model, effort, fast, contextWindow, rawContextWindow, autoCompactTokenLimit }`.
    pub current_route: Value,
}

/// The reads of one footer.
pub struct StatusFiles {
    io: Arc<dyn StatusIo>,
    paths: StatusPaths,
}

impl StatusFiles {
    pub fn new(io: Arc<dyn StatusIo>, paths: StatusPaths) -> Self {
        Self { io, paths }
    }

    fn json(&self, path: &Path) -> Option<Value> {
        mixdog_js::json_parse(&self.io.read_text(path)?).ok()
    }

    /// A status file with its modification time (epoch ms).
    fn aged(&self, path: &Path) -> Option<(Value, f64)> {
        let value = self.json(path)?;
        Some((value, self.io.stat(path)?.mtime_ms))
    }

    /// `mixdog-config.json` of the data directory.
    pub fn config(&self) -> Option<Value> {
        self.json(&self.paths.data_dir.join(mixdog_core_files::CONFIG_FILE))
    }

    /// `loadGatewayStatus(request)`: the route the footer shows with its cached quota windows and context share.
    pub fn load_status(&self, host: &dyn StatusHost, request: &StatusRequest, process_started_at_ms: f64, now: f64) -> Option<Value> {
        let config = self.config();
        let settings = self.json(&self.paths.config_dir.join("settings.json"));
        let routes = self.json(&self.paths.data_dir.join(gateway_routes::STORE_FILE)).unwrap_or_else(|| json!({}));
        let quota_cache = self.json(&self.paths.data_dir.join(QUOTA_CACHE_FILE));
        let own = self.aged(&self.paths.data_dir.join(CLAUDE_CURRENT_FILE));
        let last = self.aged(&self.paths.config_dir.join(CLAUDE_LAST_FILE));
        fn borrowed(file: &Option<(Value, f64)>) -> Option<AgedFile<'_>> {
            file.as_ref().map(|(value, mtime_ms)| AgedFile { value, mtime_ms: *mtime_ms })
        }
        let world = World { host, io: &*self.io, settings: settings.as_ref(), own: borrowed(&own), last: borrowed(&last), now };
        let host_pid = Value::from(request.client_host_pid);
        let input = StatusInput {
            config: config.as_ref(),
            settings: settings.as_ref(),
            routes: &routes,
            quota_cache: quota_cache.as_ref(),
            session_id: &request.session_id,
            client_host_pid: Some(&host_pid),
            current_route: Some(&request.current_route),
            active_context_tokens: request.active_context_tokens,
            process_started_at_ms,
            data_dir: &self.paths.data_dir,
            now,
        };
        load_gateway_status(&world, &input)
    }

    /// `loadUsageEvents()` over the incremental view of the usage log: the file's identity is its path and creation time, so
    /// a replaced log is read from its start.
    pub fn usage_events(&self, view: &mut UsageView, now: f64) -> Vec<Value> {
        let path = self.paths.data_dir.join(USAGE_FILE);
        let Some(stat) = self.io.stat(&path) else {
            view.lost();
            return Vec::new();
        };
        let id = format!("{}#{}", path.display(), stat.created_ms);
        let io = &self.io;
        view.refresh(&id, stat.len, |offset, len| io.read_range(&path, offset, len));
        view.load(now)
    }
}

/// The catalog, the environment, Claude Code's files and the account credentials, as the status and the Claude route
/// resolution read them.
struct World<'a> {
    host: &'a dyn StatusHost,
    io: &'a dyn StatusIo,
    settings: Option<&'a Value>,
    own: Option<AgedFile<'a>>,
    last: Option<AgedFile<'a>>,
    now: f64,
}

impl ClaudeWorld for World<'_> {
    fn context_window(&self, model: &str) -> Option<f64> {
        self.host.catalog_meta(model, "anthropic-oauth")?.get("contextWindow").and_then(Value::as_f64)
    }

    fn roster(&self) -> Vec<Value> {
        self.host.cached_models("anthropic-oauth")
    }

    fn env(&self, name: &str) -> Option<String> {
        self.host.env(name)
    }
}

impl StatusWorld for World<'_> {
    fn catalog_meta(&self, model: &str, provider: &str) -> Option<Map<String, Value>> {
        self.host.catalog_meta(model, provider)
    }

    /// `loadCachedModel(provider, model)`: the row of the provider's cached roster.
    fn cached_model(&self, provider: &str, model: &str) -> Option<Value> {
        self.host.cached_models(provider).into_iter().find(|row| row.get("id").and_then(Value::as_str) == Some(model))
    }

    fn inherited_route(&self) -> ClaudeRoute {
        let sources = ClaudeSources {
            settings: self.settings,
            own: self.own,
            last: self.last,
            request: None,
            max_age_ms: PERSISTED_MAX_AGE_MS,
            for_boot: false,
            now: self.now,
        };
        read_claude_code_current_route(self, &sources)
    }

    fn credential_text(&self, path: &Path) -> Option<String> {
        self.io.read_text(path)
    }

    fn var(&self, name: &str) -> Option<String> {
        self.host.env(name)
    }
}

/// The shell-jobs directory and the memory-cycle state file of the data directory, for the second row's segments.
pub struct DataDirSegments {
    io: Arc<dyn StatusIo>,
    jobs_dir: PathBuf,
    memory_file: PathBuf,
}

impl DataDirSegments {
    pub fn new(io: Arc<dyn StatusIo>, data_dir: &Path) -> Self {
        Self { io, jobs_dir: data_dir.join(SHELL_JOBS_DIR), memory_file: data_dir.join(MEMORY_CYCLE_FILE) }
    }
}

impl SegmentSource for DataDirSegments {
    fn shell_job_names(&self) -> Option<Vec<String>> {
        self.io.list_dir(&self.jobs_dir)
    }

    fn shell_job_text(&self, name: &str) -> Option<String> {
        self.io.read_text(&self.jobs_dir.join(name))
    }

    fn shell_job_mtime_ms(&self, name: &str) -> Option<f64> {
        self.io.stat(&self.jobs_dir.join(name)).map(|stat| stat.mtime_ms)
    }

    fn shell_job_file_exists(&self, name: &str) -> bool {
        self.io.stat(&self.jobs_dir.join(name)).is_some()
    }

    fn memory_cycle_state_text(&self) -> Option<String> {
        self.io.read_text(&self.memory_file)
    }

    fn pid_alive(&self, pid: u64) -> bool {
        self.io.pid_alive(pid)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use mixdog_core_files::statusline_agents::RuntimeEntry;

    use super::super::io::FileStat;
    use super::*;

    /// The files in memory, by path.
    #[derive(Default)]
    struct Files(Mutex<HashMap<PathBuf, String>>);

    impl StatusIo for Files {
        fn read_text(&self, path: &Path) -> Option<String> {
            self.0.lock().unwrap().get(path).cloned()
        }
        fn stat(&self, path: &Path) -> Option<FileStat> {
            self.read_text(path).map(|text| FileStat { len: text.len() as u64, created_ms: 0, mtime_ms: 0.0 })
        }
        fn read_range(&self, _: &Path, _: u64, _: usize) -> Option<Vec<u8>> {
            None
        }
        fn list_dir(&self, _: &Path) -> Option<Vec<String>> {
            None
        }
        fn pid_alive(&self, _: u64) -> bool {
            false
        }
    }

    /// A process with no catalog, rosters or sessions, and no environment variables.
    struct Bare;

    impl StatusHost for Bare {
        fn catalog_meta(&self, _: &str, _: &str) -> Option<Map<String, Value>> {
            None
        }
        fn cached_models(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
        fn cached_oauth_usage(&self, _: &Value, _: bool) -> Option<Value> {
            None
        }
        fn agent_runtimes(&self) -> Vec<RuntimeEntry> {
            Vec::new()
        }
        fn hidden_agent_names(&self) -> Vec<String> {
            Vec::new()
        }
        fn env(&self, _: &str) -> Option<String> {
            None
        }
    }

    /// The footer shows the cached quota of the account signed in on the slot now: after another user signs in on it, or
    /// its credential file is deleted, the previous account's figures are not shown.
    #[test]
    fn the_footer_does_not_show_a_previous_accounts_quota_after_a_new_sign_in_or_a_deleted_credential() {
        let login = |user: &str| json!({ "claudeAiOauth": { "accessToken": format!("token-of-{user}"), "refreshToken": "r", "scopes": ["user:inference"], "identity": { "id": user } } });
        let stamp = mixdog_ai::service::oauth_usage::credential_stamp("anthropic-oauth", login("user-1")["claudeAiOauth"].as_object().unwrap()).unwrap();
        let data = PathBuf::from("data");
        let credential = data.join("anthropic-oauth-credentials.json");
        let files = Arc::new(Files::default());
        let cache = json!({ "routes": { "anthropic-oauth": {
            "provider": "anthropic-oauth", "accountId": "default", "cachedAt": 1500, "credentialStamp": stamp, "quotaWindows": [{ "label": "5h", "usedPct": 40 }]
        } } });
        files.0.lock().unwrap().insert(data.join(QUOTA_CACHE_FILE), cache.to_string());
        let status = StatusFiles::new(files.clone(), StatusPaths { data_dir: data, config_dir: PathBuf::from("config") });
        let request = StatusRequest {
            session_id: String::new(),
            client_host_pid: 0.0,
            active_context_tokens: None,
            current_route: json!({ "provider": "anthropic-oauth", "model": "claude-x" }),
        };
        let windows = || status.load_status(&Bare, &request, 1000.0, 2000.0).expect("the route")["quotaWindows"].clone();

        files.0.lock().unwrap().insert(credential.clone(), login("user-1").to_string());
        assert_eq!(windows(), json!([{ "label": "5h", "usedPct": 40 }]), "the account the reading was measured for");
        files.0.lock().unwrap().insert(credential.clone(), login("user-2").to_string());
        assert_eq!(windows(), json!([]), "another user signed in on the slot");
        files.0.lock().unwrap().remove(&credential);
        assert_eq!(windows(), json!([]), "a deleted credential file");
    }
}
