//! The background-shell methods of a thread: `thread/backgroundTerminals/terminate` (today's
//! `stopShellJob`), `/clean` (`stopShellJobs`), `/release` (`releaseShellJob`),
//! `thread/listShellJobs` and `thread/listStoppableShellJobs` (`session-runtime/turn/agent-ops.mjs`).
//! The stop is the `task` tool's own cancel (`ShellControl`); the release is the user's
//! "Release anyway" of a shell whose termination is unconfirmed
//! (`forceReleaseTerminationHold`, `shell-job-records.mjs:375`). The app-server hands these to
//! this service instead of the thread's actor: they act on the shell runtime, and read the
//! thread only for its working folder.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::ThreadListShellJobsParams;
use mixdog_app_protocol::v2::params::ThreadListStoppableShellJobsParams;
use mixdog_app_protocol::v2::thread::ThreadBackgroundTerminalParams;
use mixdog_app_protocol::v2::thread::ThreadOpParams;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_spawn::tasks::ShellJobRow;
use mixdog_tools::exec::ShellControl;
use serde_json::Value;
use serde_json::json;

pub const TERMINATE: &str = "thread/backgroundTerminals/terminate";
pub const RELEASE: &str = "thread/backgroundTerminals/release";
pub const CLEAN: &str = "thread/backgroundTerminals/clean";
pub const LIST: &str = "thread/listShellJobs";
pub const LIST_STOPPABLE: &str = "thread/listStoppableShellJobs";

const DOMAIN: &str = "shell jobs";

/// What a closing session does to the shells it owns (`cancelOwnedShellProcesses`).
pub trait OwnedShells: Send + Sync {
    fn cancel_owned(&self, owner: &ThreadId);
}

impl OwnedShells for ShellControl {
    fn cancel_owned(&self, owner: &ThreadId) {
        ShellControl::cancel_owned(self, owner);
    }
}

/// A thread's strip as it stands when its session loads: Node's host holds every session's `shellJobs` from the poller, so a session
/// shown (or shown again after it was let go with a job running) carries its pane at once; the core's strip publisher only sends
/// changes. `None`: no shell runtime behind the session.
pub trait ShellStrips: Send + Sync {
    fn strip(&self, thread: &ThreadId) -> Option<Value>;
}

impl ShellStrips for ShellControl {
    fn strip(&self, thread: &ThreadId) -> Option<Value> {
        Some(thread_strip(&self.tasks().thread_state(thread.as_str())))
    }
}

/// `workspaceSees(targetCwd, viewerCwd)`: whether a session working in `viewer` sees work done
/// in `target`.
#[async_trait]
pub trait WorkspaceSight: Send + Sync {
    /// `Err` when the check could not run (its lane job was refused or dropped): Node has no such
    /// outcome, and answering "does not see" would release or hide a shell wrongly.
    async fn sees(&self, target: &str, viewer: &str) -> Result<bool, CoreError>;
}

pub struct ShellJobsService {
    shells: Arc<ShellControl>,
    threads: Arc<dyn ThreadState>,
    sight: Arc<dyn WorkspaceSight>,
    ops: OpScopes,
}

/// A row of `shellJobsStatusFresh` (`refreshShellJobsStatus`): its text fields trimmed, the start
/// in milliseconds, `terminationUnconfirmed` only when set.
fn row_json(row: &ShellJobRow) -> Value {
    let mut job = serde_json::Map::new();
    job.insert("taskId".into(), json!(row.task_id));
    job.insert("command".into(), json!(mixdog_js::js_trim(&row.command)));
    job.insert("cwd".into(), json!(mixdog_js::js_trim(&row.cwd)));
    job.insert("startedAt".into(), json!(row.started_at_ms));
    if row.termination_unconfirmed {
        job.insert("terminationUnconfirmed".into(), Value::Bool(true));
    }
    Value::Object(job)
}

/// A finished row of a thread's strip: the running fields plus the outcome (`normalizedJobs(.., finished)` of the shell-jobs poller).
fn finished_row_json(row: &ShellJobRow) -> Value {
    let mut job = row_json(row);
    job["status"] = json!(row.status.map_or("", mixdog_spawn::tasks::TaskStatus::as_str));
    job["exitCode"] = json!(row.exit_code);
    job["finishedAt"] = json!(row.finished_at_ms);
    job
}

/// One thread's strip as the `shellJobs` section carries it (`normalizedStatus`): `elapsedLabel` travels only for jobs the list does not carry, and the
/// registry lists every running job, so it is always empty.
pub fn thread_strip(state: &mixdog_spawn::tasks::ShellJobsState) -> Value {
    json!({
        "count": state.count,
        "elapsedLabel": "",
        "jobs": state.jobs.iter().map(row_json).collect::<Vec<_>>(),
        "finished": state.finished.iter().map(finished_row_json).collect::<Vec<_>>(),
    })
}

/// The host's strip as the `hostShellJobs` section carries it: every running background shell, and the held shells whose owner thread closed.
pub fn host_strip(state: &mixdog_spawn::tasks::HostShellJobs) -> Value {
    json!({
        "count": state.count,
        "elapsedLabel": "",
        "jobs": state.jobs.iter().map(row_json).collect::<Vec<_>>(),
        "orphaned": state.orphaned.iter().map(row_json).collect::<Vec<_>>(),
    })
}

impl ShellJobsService {
    pub fn new(shells: Arc<ShellControl>, threads: Arc<dyn ThreadState>, sight: Arc<dyn WorkspaceSight>, ops: OpScopes) -> Self {
        Self { shells, threads, sight, ops }
    }

    /// `getCurrentCwd()`: the thread's working folder, `None` when it has none.
    async fn cwd_of(&self, thread: &ThreadId) -> Option<String> {
        let header = self.threads.header(thread).await.ok()?;
        header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()).map(str::to_owned)
    }

    /// `forceReleaseTerminationHold`: the owner may release its hold; once the owner has closed,
    /// any session whose folder sees the hold's may.
    async fn release_hold(&self, caller: &ThreadId, task_id: &str) -> Value {
        let key = mixdog_js::js_trim(task_id);
        let refused = json!({ "released": false, "error": format!("no unconfirmed termination hold: {key}") });
        let Some(hold) = self.shells.hold(key) else { return refused };
        let owner = hold.owner.as_deref().filter(|owner| !owner.is_empty());
        let may = match owner {
            None => true,
            Some(owner) if owner == caller.as_str() => true,
            Some(_) => {
                hold.owner_closed
                    && match self.cwd_of(caller).await {
                        Some(viewer) => match self.sight.sees(&hold.cwd, &viewer).await {
                            Ok(seen) => seen,
                            // Not "may not": the check did not run, so say so and let the caller retry.
                            Err(_) => return json!({ "released": false, "error": "workspace check unavailable: the lane did not run it" }),
                        },
                        None => false,
                    }
            }
        };
        if !may {
            return refused;
        }
        self.shells.release(key);
        json!({ "released": true })
    }

    async fn run_once<E, EF>(&self, req: &CoreRequest, execute: E) -> Result<Reply, CoreError>
    where
        E: FnOnce() -> EF,
        EF: std::future::Future<Output = Result<Value, CoreError>>,
    {
        self.ops.run(req, None, execute, || async { Err(failed(DOMAIN, "the answer of this op was not stored")) }).await
    }

    /// `listShellJobs`: this session's live shells, plus held shells a closed session left in a
    /// folder this session sees. Without a session, the host's.
    async fn list_jobs(&self, thread: Option<&ThreadId>) -> Value {
        let tasks = self.shells.tasks();
        let mut jobs: Vec<ShellJobRow> = match thread {
            Some(thread) => tasks.thread_state(thread.as_str()).jobs,
            None => tasks.host_state().jobs,
        };
        let cwd = match thread {
            Some(thread) => self.cwd_of(thread).await,
            None => None,
        };
        let mut unavailable = false;
        for orphan in tasks.host_state().orphaned {
            let seen = match &cwd {
                Some(viewer) => match self.sight.sees(&orphan.cwd, viewer).await {
                    Ok(seen) => seen,
                    Err(_) => {
                        unavailable = true;
                        false
                    }
                },
                None => false,
            };
            if seen && !jobs.iter().any(|row| row.task_id == orphan.task_id) {
                jobs.push(orphan);
            }
        }
        let mut list = json!({ "jobs": jobs.iter().map(row_json).collect::<Vec<_>>() });
        // The held shells of other folders could not be judged: the list is incomplete, not final.
        if unavailable {
            list["error"] = json!("workspace check unavailable: the lane did not run it");
        }
        list
    }
}

#[async_trait]
impl DomainService for ShellJobsService {
    fn methods(&self) -> &'static [&'static str] {
        &[TERMINATE, RELEASE, CLEAN, LIST, LIST_STOPPABLE]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            TERMINATE => {
                self.run_once(&req, || async {
                    let params: ThreadBackgroundTerminalParams = decode(&req)?;
                    Ok(self.shells.stop_job(&params.thread_id, &params.task_id).await)
                })
                .await
            }
            RELEASE => {
                self.run_once(&req, || async {
                    let params: ThreadBackgroundTerminalParams = decode(&req)?;
                    Ok(self.release_hold(&params.thread_id, &params.task_id).await)
                })
                .await
            }
            CLEAN => {
                self.run_once(&req, || async {
                    let params: ThreadOpParams = decode(&req)?;
                    Ok(self.shells.stop_jobs(&params.thread_id).await)
                })
                .await
            }
            LIST => {
                let params: ThreadListShellJobsParams = decode(&req)?;
                Ok(Reply::Value(self.list_jobs(params.thread_id.as_ref()).await))
            }
            LIST_STOPPABLE => {
                let params: ThreadListStoppableShellJobsParams = decode(&req)?;
                let jobs: Vec<Value> = match &params.thread_id {
                    Some(thread) => {
                        self.shells.list_stoppable(thread).into_iter().map(|job| json!({ "taskId": job.task_id, "command": job.command })).collect()
                    }
                    None => Vec::new(),
                };
                Ok(Reply::Value(json!({ "jobs": jobs })))
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::domain::ext::ExtError;
    use mixdog_core_base::support::testing::scopes;
    use mixdog_core_ports::ports::threads::Section;
    use mixdog_spawn::LocalProcessManager;
    use mixdog_spawn::ProcessConfig;
    use mixdog_spawn::tasks::HostShellJobs;
    use mixdog_spawn::tasks::ShellJobsState;
    use mixdog_spawn::tasks::TaskPublisher;
    use mixdog_spawn::tasks::TaskRegistry;
    use mixdog_spawn::tasks::TaskSpec;
    use mixdog_store::schema::record::Header;
    use mixdog_tools::exec::ExecConfig;
    use mixdog_tools::exec::ExecRuntime;
    use mixdog_tools::exec::IoLanes;
    use mixdog_tools::exec::OsPromptElevation;
    use mixdog_tools::exec::ScriptSyntax;
    use mixdog_tools::exec::WakeHub;
    use mixdog_tools::orch::util::PortError;
    use serde_json::Map;

    use super::*;

    struct NoPublisher;
    impl TaskPublisher for NoPublisher {
        fn thread_updated(&self, _: &str, _: &ShellJobsState) {}
        fn host_updated(&self, _: &HostShellJobs) {}
        fn schedule_expiry(&self, _: u64) {}
    }

    struct TopLevel;
    #[async_trait]
    impl ScriptSyntax for TopLevel {
        async fn compiles_as_commonjs(&self, _: &ThreadId, _: &str) -> Result<bool, ExtError> {
            Ok(false)
        }
    }

    /// Every thread works in the folder set for it (none until set).
    #[derive(Default)]
    struct Folders(Mutex<std::collections::HashMap<String, String>>);
    impl Folders {}
    #[async_trait]
    impl ThreadState for Folders {
        async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
            let mut header = Map::new();
            if let Some(cwd) = self.0.lock().unwrap().get(thread.as_str()) {
                header.insert("cwd".into(), json!(cwd));
            }
            Ok(header)
        }
        async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            unreachable!()
        }
        async fn patch_header_if(
            &self,
            _: &ThreadId,
            _: Map<String, Value>,
            _: Map<String, Value>,
            _: Vec<String>,
        ) -> Result<Option<Map<String, Value>>, PortError> {
            unreachable!()
        }
        async fn store_header(
            &self,
            thread: &ThreadId,
            write: mixdog_core_ports::ports::threads::HeaderWrite,
        ) -> mixdog_core_ports::ports::threads::HeaderStored {
            mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
        }
        fn log_identity(&self, _: &ThreadId) -> Option<String> {
            None
        }
        /// This fake holds nothing but the header it answers.
        async fn held_fields(
            &self,
            thread: &ThreadId,
            keys: &'static [&'static str],
        ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
            Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
            unreachable!()
        }
    }

    /// The folders a viewer sees: its own and the ones listed as shared with it.
    struct Sees(Vec<(&'static str, &'static str)>);
    #[async_trait]
    impl WorkspaceSight for Sees {
        async fn sees(&self, target: &str, viewer: &str) -> Result<bool, CoreError> {
            Ok(self.0.iter().any(|(t, v)| *t == target && *v == viewer))
        }
    }

    /// [`service`] on a clock the test moves.
    async fn service_at(
        dir: &std::path::Path,
        sight: Arc<dyn WorkspaceSight>,
        now: Arc<std::sync::atomic::AtomicU64>,
    ) -> (ShellJobsService, Arc<TaskRegistry>, Arc<Folders>) {
        let tokens = mixdog_rt::testing::tokens();
        let clock = now.clone();
        let tasks = Arc::new(TaskRegistry::new(Arc::new(NoPublisher), move || clock.load(std::sync::atomic::Ordering::SeqCst)));
        let runtime = ExecRuntime::new(ExecConfig {
            tasks: tasks.clone(),
            lanes: IoLanes {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
                spawn: tokens.spawn_io,
                pty: tokens.pty_io,
            },
            spill_dir: dir.join("jobs"),
            data_dir: None,
            skill_launcher_dir: None,
            notifier: None,
            survivors: None,
            wake: WakeHub::new(),
            policy: Arc::new(mixdog_tools::policy::exec::NodeCommandPolicy),
            elevation: Arc::new(OsPromptElevation),
            oem: None,
            skill_runtime: None,
            shell: Arc::new(mixdog_tools::exec::FixedShell("/bin/sh".into())),
            script_syntax: Arc::new(TopLevel),
            windows: false,
            powershell: false,
            warm_standby: false,
            now_ms: Arc::new(move || now.load(std::sync::atomic::Ordering::SeqCst)),
        });
        let processes = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
        let shells = Arc::new(ShellControl::new(runtime, processes));
        let folders = Arc::new(Folders::default());
        (ShellJobsService::new(shells, folders.clone(), sight, scopes(dir, "shell-jobs").await), tasks, folders)
    }

    /// A background shell of `owner` in `cwd`, held with its termination unconfirmed when `held`.
    fn start(tasks: &TaskRegistry, id: &str, surface: &str, owner: Option<&str>, command: &str, cwd: &str, held: bool) {
        tasks
            .start(TaskSpec {
                task_id: id.into(),
                surface: surface.into(),
                op: "shell".into(),
                command: command.into(),
                cwd: cwd.into(),
                owner: owner.map(str::to_owned),
                foreground: false,
                process: None,
                started_at_ms: 1_767_323_000_000,
            })
            .unwrap();
        if held {
            tasks.set_termination_unconfirmed(id, true).unwrap();
        }
    }

    #[tokio::test]
    async fn a_strip_at_load_keeps_a_finished_job_within_its_retention_and_drops_it_after() {
        use mixdog_spawn::tasks::FINISHED_RETENTION_MS;
        use mixdog_spawn::tasks::TaskOutcome;
        use mixdog_spawn::tasks::TaskStatus;
        let dir = tempfile::tempdir().unwrap();
        let ended_at = 1_767_323_045_678;
        let now = Arc::new(std::sync::atomic::AtomicU64::new(ended_at));
        let (service, tasks, _) = service_at(dir.path(), Arc::new(Sees(Vec::new())), now.clone()).await;
        let thread = ThreadId::from("closed-session");
        start(&tasks, "ended", "shell", Some("closed-session"), "build", "/w", false);
        start(&tasks, "running", "shell", Some("closed-session"), "serve", "/w", false);
        tasks.finish("ended", TaskOutcome { status: TaskStatus::Completed, exit_code: Some(0) }).unwrap();
        let ids = |strip: &Value, key: &str| strip[key].as_array().unwrap().iter().map(|row| row["taskId"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        let at = |ms: u64| {
            now.store(ended_at + ms, std::sync::atomic::Ordering::SeqCst);
            service.shells.strip(&thread).expect("a shell runtime")
        };
        let within = at(FINISHED_RETENTION_MS);
        assert_eq!(
            (ids(&within, "jobs"), ids(&within, "finished"), within["count"].clone()),
            (vec!["running".to_owned()], vec!["ended".to_owned()], json!(1)),
            "a finished job exactly the retention old is still shown"
        );
        let after = at(FINISHED_RETENTION_MS + 1);
        assert_eq!(
            (ids(&after, "jobs"), ids(&after, "finished")),
            (vec!["running".to_owned()], Vec::<String>::new()),
            "past the retention the finished job leaves the strip, the running one stays"
        );
        assert_eq!(after["finished"], json!([]), "an empty list, as Node's empty bucket");
    }

    /// The same boundary through the session's own open path: a session opened again (a directory over the same store, as after an
    /// unload) after the retention shows no stale strip, and one opened at the boundary shows the finished job.
    #[tokio::test]
    async fn a_session_opened_after_the_retention_shows_no_stale_strip() {
        use mixdog_spawn::tasks::FINISHED_RETENTION_MS;
        use mixdog_spawn::tasks::TaskOutcome;
        use mixdog_spawn::tasks::TaskStatus;
        let dir = tempfile::tempdir().unwrap();
        let ended_at = 1_767_323_045_678;
        let now = Arc::new(std::sync::atomic::AtomicU64::new(ended_at));
        let (service, tasks, _) = service_at(dir.path(), Arc::new(Sees(Vec::new())), now.clone()).await;
        let rig = crate::session::testing::Rig::new();
        let opened = || {
            let mut deps = rig.deps_parts(rig.store.clone());
            deps.shell_strips = service.shells.clone();
            crate::session::SessionDirectory::new(Arc::new(deps))
        };
        let thread = ThreadId::from("closed-session");
        opened().create_with_id(thread.clone(), Header::new(), json!({})).await.unwrap();
        start(&tasks, "ended", "shell", Some("closed-session"), "build", "/w", false);
        tasks.finish("ended", TaskOutcome { status: TaskStatus::Completed, exit_code: Some(0) }).unwrap();
        let finished_at = |ms: u64| {
            let (directory, now) = (opened(), now.clone());
            let thread = thread.clone();
            async move {
                now.store(ended_at + ms, std::sync::atomic::Ordering::SeqCst);
                let handle = directory.open_handle(&thread, &mixdog_core_api::call::CallContext::internal("test")).await.unwrap();
                let strip = handle.cell.view.load_full().state.shell_jobs.clone().expect("the strip the session loaded with");
                strip["finished"].as_array().unwrap().iter().map(|row| row["taskId"].as_str().unwrap().to_owned()).collect::<Vec<_>>()
            }
        };
        assert_eq!(finished_at(FINISHED_RETENTION_MS).await, vec!["ended".to_owned()], "a session opened exactly the retention after the end shows the job");
        assert_eq!(finished_at(FINISHED_RETENTION_MS + 1).await, Vec::<String>::new(), "a session opened after it shows no stale strip");
    }
}
