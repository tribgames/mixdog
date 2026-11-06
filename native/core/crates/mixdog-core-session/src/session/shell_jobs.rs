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

/// `workspaceSees(targetCwd, viewerCwd)`: whether a session working in `viewer` sees work done
/// in `target`.
#[async_trait]
pub trait WorkspaceSight: Send + Sync {
    async fn sees(&self, target: &str, viewer: &str) -> bool;
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
                        Some(viewer) => self.sight.sees(&hold.cwd, &viewer).await,
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
        for orphan in tasks.host_state().orphaned {
            let seen = match &cwd {
                Some(viewer) => self.sight.sees(&orphan.cwd, viewer).await,
                None => false,
            };
            if seen && !jobs.iter().any(|row| row.task_id == orphan.task_id) {
                jobs.push(orphan);
            }
        }
        json!({ "jobs": jobs.iter().map(row_json).collect::<Vec<_>>() })
    }
}

#[async_trait]
impl DomainService for ShellJobsService {
    fn methods(&self) -> &'static [&'static str] {
        &[TERMINATE, RELEASE, CLEAN, LIST, LIST_STOPPABLE]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        // The answers are a few bytes, so a duplicate op always finds the one the first stored.
        let reproduce = || async { Err(failed(DOMAIN, "the answer of this op was not stored")) };
        match req.method.as_str() {
            TERMINATE => {
                self.ops
                    .run(
                        &req,
                        None,
                        || async {
                            let params: ThreadBackgroundTerminalParams = decode(&req)?;
                            Ok(self.shells.stop_job(&params.thread_id, &params.task_id).await)
                        },
                        reproduce,
                    )
                    .await
            }
            RELEASE => {
                self.ops
                    .run(
                        &req,
                        None,
                        || async {
                            let params: ThreadBackgroundTerminalParams = decode(&req)?;
                            Ok(self.release_hold(&params.thread_id, &params.task_id).await)
                        },
                        reproduce,
                    )
                    .await
            }
            CLEAN => {
                self.ops
                    .run(
                        &req,
                        None,
                        || async {
                            let params: ThreadOpParams = decode(&req)?;
                            Ok(self.shells.stop_jobs(&params.thread_id).await)
                        },
                        reproduce,
                    )
                    .await
            }
            LIST => {
                let params: ThreadListShellJobsParams = decode(&req)?;
                Ok(Reply::Value(self.list_jobs(params.thread_id.as_ref()).await))
            }
            LIST_STOPPABLE => {
                let params: ThreadListStoppableShellJobsParams = decode(&req)?;
                let jobs: Vec<Value> = match &params.thread_id {
                    Some(thread) => self
                        .shells
                        .list_stoppable(thread)
                        .into_iter()
                        .map(|job| json!({ "taskId": job.task_id, "command": job.command }))
                        .collect(),
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
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::scopes;
    use mixdog_core_base::support::testing::value;
    use mixdog_core_base::support::testing::with_op;
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
    impl Folders {
        fn set(&self, thread: &str, cwd: &str) {
            self.0.lock().unwrap().insert(thread.to_owned(), cwd.to_owned());
        }
    }
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
        async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
            unreachable!()
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
            unreachable!()
        }
    }

    /// The folders a viewer sees: its own and the ones listed as shared with it.
    struct Sees(Vec<(&'static str, &'static str)>);
    #[async_trait]
    impl WorkspaceSight for Sees {
        async fn sees(&self, target: &str, viewer: &str) -> bool {
            self.0.iter().any(|(t, v)| *t == target && *v == viewer)
        }
    }

    async fn service(dir: &std::path::Path, sight: Arc<dyn WorkspaceSight>) -> (ShellJobsService, Arc<TaskRegistry>, Arc<Folders>) {
        let tokens = mixdog_rt::testing::tokens();
        let tasks = Arc::new(TaskRegistry::new(Arc::new(NoPublisher), || 1_767_323_045_678));
        let runtime = ExecRuntime::new(ExecConfig {
            tasks: tasks.clone(),
            lanes: IoLanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
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
            shell_path: "/bin/sh".into(),
            shell_name: "sh".into(),
            script_syntax: Arc::new(TopLevel),
            windows: false,
            powershell: false,
            now_ms: Arc::new(|| 1_767_323_045_678),
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

    fn call(method: &'static str, params: Value, op: u64) -> CoreRequest {
        request(method, with_op(params, op), Some(op))
    }

    /// Node's recording of the shell-job actions (`record-shell-job-actions.mjs`).
    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/shell-job-actions/shell-job-actions.json")).expect("golden")
    }

    /// `forceReleaseTerminationHold` (`shell-job-records.mjs:375`) as Node answered each step of
    /// the recording: the real `workspaceSees` over real folders decides who may release a closed
    /// owner's hold.
    #[tokio::test]
    async fn a_hold_is_released_as_node_answers() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("ws");
        for sub in ["a/sub", "far"] {
            let path = ws.join(sub);
            use mixdog_rt::LaneToken as _;
            let io = mixdog_rt::testing::tokens().maintenance_io;
            io.submit(&mixdog_rt::CancellationToken::new(), move |lane| mixdog_statefile::create_private_dir_all(lane, &path).unwrap()).unwrap().await.unwrap();
        }
        let folder = |rel: &str| ws.join(rel).to_string_lossy().into_owned();
        let sight = Arc::new(crate::session::workspace_sight::GitSight::new(mixdog_rt::testing::tokens().maintenance_io));
        let (service, tasks, folders) = service(dir.path(), sight).await;
        let golden = golden();
        let mut op = 0;
        for (index, step) in golden["releases"].as_array().unwrap().iter().enumerate() {
            let (name, id, caller) = (step["name"].as_str().unwrap(), step["jobId"].as_str().unwrap(), step["caller"].as_str().unwrap());
            // The scene Node's recorder set up before this step.
            match index {
                2 => start(&tasks, "job_h1", "shell", Some("sess_a"), "run", &folder("a"), true),
                3 => tasks.owner_closed("sess_a"),
                6 => start(&tasks, "job_h2", "shell", Some("sess_d"), "run", &folder("far"), true),
                7 => start(&tasks, "job_h3", "shell", None, "run", &folder("far"), true),
                _ => {}
            }
            if let Some(rel) = step["callerCwd"].as_str() {
                folders.set(caller, &folder(rel));
            }
            op += 1;
            let got = value(&service, call(RELEASE, json!({ "threadId": caller, "taskId": id }), op)).await.unwrap();
            assert_eq!(got, step["answer"], "{name}");
        }
    }

    /// `listStoppableShellJobs`, `stopBackgroundShellJob` and `stopBackgroundShellJobs` as Node
    /// answered them: the caller's own running shells only, the id trimmed, nothing to stop for a
    /// session without shells. (The recording's two shells without a command are Node's label
    /// fallback; every shell here has its command.)
    #[tokio::test]
    async fn the_stop_lists_and_answers_are_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let (service, tasks, _) = service(dir.path(), Arc::new(Sees(Vec::new()))).await;
        start(&tasks, "job_a1", "shell", Some("sess_a"), "  npm run dev ", "/ws/a", false);
        start(&tasks, "job_b1", "shell", Some("sess_b"), "tail -f log", "/ws/b", false);
        start(&tasks, "agent_x", "agent", Some("sess_a"), "not a shell", "/ws/a", false);
        let golden = golden();
        for (caller, want) in golden["stoppable"].as_object().unwrap() {
            let params = if caller == "null" { json!({}) } else { json!({ "threadId": caller }) };
            let got = value(&service, request(LIST_STOPPABLE, params, None)).await.unwrap();
            let want: Vec<&Value> = want.as_array().unwrap().iter().filter(|job| job["taskId"] != "job_a2" && job["taskId"] != "job_a3").collect();
            assert_eq!(got["jobs"].as_array().unwrap().iter().collect::<Vec<_>>(), want, "stoppable for {caller}");
        }
        for (op, step) in (1..).zip(golden["stops"].as_array().unwrap()) {
            let params = json!({ "threadId": step["caller"], "taskId": step["taskId"] });
            let got = value(&service, call(TERMINATE, params, op)).await.unwrap();
            assert_eq!(got, step["answer"], "stop {}", step["taskId"]);
        }
        for (op, step) in (100..).zip(golden["clean"].as_array().unwrap().iter().filter(|step| step["caller"].is_string())) {
            let got = value(&service, call(CLEAN, json!({ "threadId": step["caller"] }), op)).await.unwrap();
            assert_eq!(got, step["answer"], "clean for {}", step["caller"]);
        }
    }

    /// The rows of `listShellJobs` are `shellJobsStatusFresh`'s as Node recorded them: the text
    /// trimmed, the start in milliseconds, `terminationUnconfirmed` only on a held shell. Which
    /// jobs it lists is the engine golden (`mixdog-spawn/tests/fixtures/shell-jobs.json`).
    #[tokio::test]
    async fn the_list_rows_are_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let (service, tasks, folders) = service(dir.path(), Arc::new(Sees(vec![("/ws/sess_gone", "/ws/sess_b")]))).await;
        start(&tasks, "job_b", "shell", Some("sess_b"), "  run job_b ", "  /ws/sess_b ", false);
        start(&tasks, "job_gone", "shell", Some("sess_gone"), "  run job_gone ", "/ws/sess_gone", true);
        start(&tasks, "job_far", "shell", Some("sess_far"), "run job_far", "/ws/sess_far", true);
        tasks.owner_closed("sess_gone");
        tasks.owner_closed("sess_far");
        folders.set("sess_b", "/ws/sess_b");
        let got = value(&service, request(LIST, json!({ "threadId": "sess_b" }), None)).await.unwrap();
        let golden = golden();
        let (own, orphan) = (&golden["rows"]["own"][0], &golden["rows"]["orphaned"][0]);
        assert_eq!(got["jobs"], json!([own, orphan]), "its own shell, then the orphan whose folder it sees");
    }
}
