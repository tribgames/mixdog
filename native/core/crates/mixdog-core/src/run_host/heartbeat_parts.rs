//! The process services Mixy's heartbeat (`mixy-heartbeat.mjs`) reads, over the config, the
//! agent definitions, the session directory and the provider registry: its live settings, a
//! session's transcript tail, the live surface of the running threads, and the Maintainer model.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::one_shot::{CallShape, OneShot, OneShotCall, PromptCache};
use mixdog_agent::tools::ToolEnv;
use mixdog_app_protocol::v2::thread::ThreadItemsListResponse;
use mixdog_core_api::call::{CallContext, CoreRequest};
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::ids::{Method, OpId, ThreadId};
use mixdog_core_api::{Reply, ThreadDirectory, ThreadHandle};
use mixdog_core_config::config::Settings;
use mixdog_core_session::session::SessionDirectory;
use mixdog_protocol::{ThreadItem, TurnId};
use mixdog_services::bots::beat::digest::{SessionReader, TranscriptItem, TranscriptPage};
use mixdog_services::bots::beat::maintainer::{MaintainerModel, MaintainerRoute};
use mixdog_services::bots::beat::tick::HeartbeatSettings;
use mixdog_services::bots::live::{LiveSurface, WakeOptions, WakeTurn};
use mixdog_ai::retry::StandardRetryDecider;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::run_host::retry::{RandomJitter, TimerWait};
use crate::run_host::routine_host::RoutineAgents;
use crate::run_host::summary_host::{NoApprovals, SummaryDeps, maintainer_of};

/// `getConfigSnapshot().heartbeat`, `heartbeatIntervalMinutes` and the representative bot's
/// presence, read live at every tick.
pub struct ConfigHeartbeatSettings {
    settings: Settings,
    agents: Arc<dyn RoutineAgents>,
}

impl ConfigHeartbeatSettings {
    pub fn new(settings: Settings, agents: Arc<dyn RoutineAgents>) -> Arc<Self> {
        Arc::new(Self { settings, agents })
    }
}

#[async_trait]
impl HeartbeatSettings for ConfigHeartbeatSettings {
    async fn is_enabled(&self) -> Result<bool, String> {
        Ok(self.settings.heartbeat()["heartbeat"] == Value::Bool(true))
    }

    async fn mixy_exists(&self) -> Result<bool, String> {
        self.agents.mixy_exists(false).await
    }

    /// `normalizeHeartbeatIntervalMinutes(...) * 60_000`.
    async fn interval_ms(&self) -> Result<i64, String> {
        Ok(self.settings.heartbeat()["intervalMinutes"].as_i64().unwrap_or(60) * 60_000)
    }
}

/// A session's latest transcript items, from the thread directory's own item reads.
pub struct DirectorySessionReader {
    directory: Arc<SessionDirectory>,
}

impl DirectorySessionReader {
    pub fn new(directory: Arc<SessionDirectory>) -> Arc<Self> {
        Arc::new(Self { directory })
    }
}

/// A row as the heartbeat reads it: `user` and `assistant` messages carry their text, every
/// other row only its place in the order.
fn transcript_item(item: &ThreadItem) -> TranscriptItem {
    let id = Some(item.id().as_str().to_owned());
    match item {
        ThreadItem::UserMessage { display_text, .. } => TranscriptItem { id, kind: "user".into(), text: display_text.clone() },
        ThreadItem::AgentMessage { text: mixdog_protocol::MaybeBlob::Inline(text), .. } => {
            TranscriptItem { id, kind: "assistant".into(), text: text.clone() }
        }
        _ => TranscriptItem { id, kind: "other".into(), text: String::new() },
    }
}

#[async_trait]
impl SessionReader for DirectorySessionReader {
    /// `readSession({ transcriptRange: { offset: 0, limit } })`: the newest `limit` rows, oldest
    /// first; an unreadable (or absent) session is an `Err`.
    async fn read_tail(&self, session_id: &str, limit: usize) -> Result<TranscriptPage, String> {
        let thread = ThreadId::from(session_id);
        let op = OpId::from(format!("heartbeat-read:{session_id}"));
        let params = json!({ "threadId": thread, "opId": op, "limit": u32::try_from(limit).unwrap_or(u32::MAX), "sortDirection": "desc" });
        let reply = self
            .directory
            .request(CoreRequest { method: Method("thread/items/list"), params, op: Some(op), ctx: CallContext::internal("heartbeat-read") })
            .await
            .map_err(|error| format!("{error:?}"))?;
        let Reply::Value(value) = reply else { return Err("the session read answered no value".into()) };
        let page: ThreadItemsListResponse = serde_json::from_value(value).map_err(|error| error.to_string())?;
        Ok(TranscriptPage { items: page.data.iter().map(transcript_item).collect(), has_older: page.has_older })
    }
}

/// What the running threads show: busy, a live notice, and one hidden wake turn.
pub struct DirectoryLiveSurface {
    directory: Arc<SessionDirectory>,
}

impl DirectoryLiveSurface {
    pub fn new(directory: Arc<SessionDirectory>) -> Arc<Self> {
        Arc::new(Self { directory })
    }
}

#[async_trait]
impl LiveSurface for DirectoryLiveSurface {
    /// `liveSessionBusy`: the thread is loaded here and mid-turn or holds queued input.
    fn busy(&self, session_id: &str) -> bool {
        self.directory.thread_busy(&ThreadId::from(session_id))
    }

    /// `pushLiveSessionNotice`: false when no loaded thread hosts it.
    async fn notice(&self, session_id: &str, notice: Value) -> Result<bool, String> {
        let thread = ThreadId::from(session_id);
        let Some(handle) = self.directory.get(&thread) else { return Ok(false) };
        let text = notice.get("text").and_then(Value::as_str).unwrap_or_default();
        let tone = notice.get("tone").and_then(Value::as_str).unwrap_or("info");
        let op = OpId::from(format!("live-notice:{}", uuid::Uuid::new_v4()));
        let params = json!({ "threadId": thread, "opId": op, "text": text, "level": tone });
        let request = CoreRequest { method: Method("thread/pushNotice"), params, op: Some(op), ctx: CallContext::internal("live-notice") };
        handle.request(request).await.map(|_| true).map_err(|error| format!("{error:?}"))
    }

    async fn wake(&self, session_id: &str, prompt: &str, options: WakeOptions) -> Result<Option<WakeTurn>, String> {
        let settled = self.directory.wake_turn(&ThreadId::from(session_id), prompt, &options.id, options.hop).await;
        Ok(settled.map(|settled| WakeTurn { settled }))
    }
}

/// The Maintainer's route from the saved config, and its one-shot sends through the provider
/// registry (`heartbeat-completion.mjs` `createMaintainerCall`).
pub struct HeartbeatMaintainer {
    deps: Arc<SummaryDeps>,
}

impl HeartbeatMaintainer {
    pub fn new(deps: Arc<SummaryDeps>) -> Arc<Self> {
        Arc::new(Self { deps })
    }
}

#[async_trait]
impl MaintainerModel for HeartbeatMaintainer {
    async fn route(&self) -> Result<Option<MaintainerRoute>, String> {
        Ok(maintainer_of(&(self.deps.config)()).map(|route| MaintainerRoute {
            provider: route.provider,
            model: route.model,
            effort: route.effort,
            fast: route.fast,
        }))
    }

    async fn send(&self, route: &MaintainerRoute, system: &str, user: &str, max_output_tokens: u32) -> Result<String, String> {
        let deps = &self.deps;
        let providers = (deps.config)().get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        deps.registry.init_providers(&providers).await.map_err(|error| error.message)?;
        let Some(provider) = deps.registry.get(&route.provider).await else {
            return Err(format!("Heartbeat provider is unavailable: {}", route.provider));
        };
        let tool_env = ToolEnv {
            thread_id: ThreadId::from("heartbeat"),
            turn_id: TurnId::from("heartbeat"),
            cwd: deps.data_dir.clone(),
            surface: SurfaceKind::Lead,
            io: deps.io,
            approvals: Arc::new(NoApprovals(deps.clock.clone())),
            files: deps.files.clone(),
            processes: deps.processes.clone(),
            progress: deps.progress.clone(),
            deadline_of: None,
            notify: None,
        };
        let one_shot = OneShot::standalone(
            deps.clock.clone(),
            Arc::new(RandomJitter),
            Arc::new(TimerWait),
            Arc::new(StandardRetryDecider),
            tool_env,
            provider,
            CancellationToken::new(),
        );
        let effort = mixdog_js::js_trim(&route.effort);
        let call = OneShotCall {
            model: route.model.clone(),
            max_output_tokens,
            fast: route.fast,
            shape: CallShape {
                request_kind: None,
                effort: if effort.is_empty() { "low".into() } else { effort.to_owned() },
                retry_529: false,
                prompt_cache: PromptCache::Off,
            },
        };
        one_shot.call_prompt(&call, system, user).await.map(|out| out.text).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::{Config, ConfigLanes, NoEffects};
    use mixdog_core_session::session::testing::Rig;
    use mixdog_services::bots::ExecutorFacts;
    use mixdog_core_rooms::rooms::home::Presence;

    use super::*;

    struct Mixy(bool);

    #[async_trait]
    impl RoutineAgents for Mixy {
        async fn mixy_exists(&self, stored: bool) -> Result<bool, String> {
            assert!(!stored, "a heartbeat asks for the representative bot, never as a stored routine's evidence");
            Ok(self.0)
        }
        async fn presence(&self, _: &str) -> Result<Presence, String> {
            Ok(Presence::Unknown)
        }
        async fn archived(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
        async fn executor_facts(&self, _: &str) -> Result<ExecutorFacts, String> {
            Ok(ExecutorFacts::default())
        }
    }

    // Test files go through the durability lane and `mixdog_statefile`, as the tree's other tests do.
    fn write_file(path: &std::path::Path, body: &[u8]) {
        use futures::FutureExt as _;
        use mixdog_rt::LaneToken as _;
        let (path, body) = (path.to_owned(), body.to_vec());
        let job = move |lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default());
        tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&mixdog_rt::CancellationToken::new(), job).unwrap())
            .now_or_never()
            .expect("the test backend runs the job inline")
            .unwrap()
            .unwrap();
    }
    async fn settings(file: &str, mixy: bool) -> (tempfile::TempDir, Arc<ConfigHeartbeatSettings>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixdog-config.json");
        write_file(&path, file.as_bytes());
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        (dir, ConfigHeartbeatSettings::new(Settings::with_process_env(config, Arc::new(NoEffects)), Arc::new(Mixy(mixy))))
    }

    /// Off unless `heartbeat` is exactly true; the interval is one of the four choices, else an hour.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_settings_are_read_live_from_the_config_and_the_presence_rule() {
        let (_dir, on) = settings(r#"{"agent":{"heartbeat":true,"heartbeatIntervalMinutes":120}}"#, true).await;
        assert!(on.is_enabled().await.unwrap());
        assert_eq!(on.interval_ms().await.unwrap(), 120 * 60_000);
        assert!(on.mixy_exists().await.unwrap());
        let (_dir, off) = settings(r#"{"agent":{"heartbeat":"yes","heartbeatIntervalMinutes":45}}"#, false).await;
        assert!(!off.is_enabled().await.unwrap());
        assert_eq!(off.interval_ms().await.unwrap(), 60 * 60_000, "an unlisted interval is the default hour");
        assert!(!off.mixy_exists().await.unwrap());
    }

    /// The reader answers the newest rows oldest first with the user's text; a missing session
    /// is an error. The live surface is busy only while a turn runs, shows a notice only in a
    /// loaded thread and wakes it with one hidden turn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_live_surface_and_reader_follow_the_running_threads() {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let live = DirectoryLiveSurface::new(directory.clone());
        let reader = DirectorySessionReader::new(directory.clone());
        assert!(reader.read_tail("sess_none", 4).await.is_err());
        assert!(!live.busy("sess_none"));
        assert!(!live.notice("sess_none", json!({ "text": "hi", "tone": "warn" })).await.unwrap());
        assert!(live.wake("sess_none", "x", WakeOptions { id: "wake_0".into(), hop: 0 }).await.unwrap().is_none());

        let thread = ThreadId::from("sess_home_lead");
        directory.create_with_id(thread.clone(), serde_json::Map::new(), json!({})).await.unwrap();
        assert!(!live.busy(thread.as_str()));
        assert!(live.notice(thread.as_str(), json!({ "text": "Heartbeat paused", "tone": "warn" })).await.unwrap());
        let turn = live.wake(thread.as_str(), "A task reported back", WakeOptions { id: "wake_1".into(), hop: 1 }).await.unwrap().expect("accepted");
        assert_eq!(turn.settled.await.unwrap(), "done");
        let page = reader.read_tail(thread.as_str(), 8).await.unwrap();
        assert!(!page.has_older);
        assert!(
            page.items.iter().any(|item| item.kind == "user" && item.text == "A task reported back"),
            "{:?}",
            page.items
        );
        assert_eq!(reader.read_tail(thread.as_str(), 1).await.unwrap().items.len(), 1);
    }
}
