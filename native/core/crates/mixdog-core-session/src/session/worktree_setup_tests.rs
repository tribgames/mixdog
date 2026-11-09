//! The worktree setup runner, its notes and the maintenance callers: texts equal Node's byte for
//! byte (`worktree_goldens/setup_goldens.json`, recorded by `record_setup.mjs`), commands run
//! through the real process manager, and a session's first turn in a real temporary git repo.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_scm::worktree::dependencies::SetupCommand;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::maintenance::ShellJob;
use mixdog_scm::worktree::manager::Retention;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;
use serde_json::Value;

use super::worktree_maintenance::LiveSessions;
use super::worktree_maintenance::WorktreeMaintenance;
use super::worktree_maintenance::cleanup_summary;
use super::worktree_maintenance::startup_summary;
use super::worktree_setup::WorktreeSetup;
use super::worktree_setup_note::PreparationReport;
use super::worktree_setup_note::worktree_preparation_note;
use super::worktree_setup_run::OutputWindow;
use super::worktree_setup_run::RunOptions;
use super::worktree_setup_run::SetupEvent;
use super::worktree_setup_run::SetupReport;
use super::worktree_setup_run::SetupRunner;
use super::worktree_setup_run::SetupStatus;
use super::worktree_setup_run::SetupStep;
use super::worktree_setup_run::output_tail;
use super::worktree_tests::enter;
use super::worktree_tests::rig;
use super::worktree_tests::run;
use super::*;

const GOLDENS: &str = include_str!("worktree_goldens/setup_goldens.json");

fn goldens() -> Value {
    serde_json::from_str(GOLDENS).unwrap()
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().to_owned()
}

#[test]
fn output_tails_equal_nodes() {
    for case in goldens()["tail"].as_array().unwrap() {
        assert_eq!(output_tail(case["input"].as_str().unwrap()), text(case, "output"), "{}", case["input"]);
    }
}

#[test]
fn output_windows_equal_nodes() {
    for case in goldens()["windows"].as_array().unwrap() {
        let mut window = OutputWindow::new(case["limit"].as_u64().unwrap() as usize);
        for chunk in case["chunks"].as_array().unwrap() {
            window.append(chunk.as_str().unwrap().as_bytes());
        }
        assert_eq!(window.text(), text(case, "text"), "{}", case["limit"]);
        assert_eq!(window.truncated(), case["truncated"].as_bool().unwrap());
    }
}

fn status_of(value: &Value) -> SetupStatus {
    match value.as_str().unwrap() {
        "completed" => SetupStatus::Completed,
        "failed" => SetupStatus::Failed,
        "timed-out" => SetupStatus::TimedOut,
        _ => SetupStatus::Cancelled,
    }
}

fn command_of(value: &Value) -> SetupCommand {
    SetupCommand {
        command: text(value, "command"),
        file: text(value, "file"),
        args: Vec::new(),
        cwd: PathBuf::from(text(value, "cwd")),
        label: value["label"].as_str().unwrap_or("").to_owned(),
        env: None,
    }
}

fn report_of(value: &Value) -> SetupReport {
    SetupReport {
        status: status_of(&value["status"]),
        total: value["total"].as_u64().unwrap() as usize,
        steps: value["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| SetupStep {
                command: text(step, "command"),
                label: step["label"].as_str().map(str::to_owned),
                status: status_of(&step["status"]),
                exit_code: step["exitCode"].as_i64().map(|code| code as i32),
                duration_ms: step["durationMs"].as_u64().unwrap(),
                output: text(step, "output"),
                truncated: step["truncated"].as_bool().unwrap(),
            })
            .collect(),
        pending: value["pending"].as_array().unwrap().iter().map(command_of).collect(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().map(|s| s.as_str().unwrap().to_owned()).collect()).unwrap_or_default()
}

#[test]
fn preparation_notes_equal_nodes() {
    for case in goldens()["notes"].as_array().unwrap() {
        let report = &case["report"];
        let installs = report.get("installs").map(report_of);
        let (dependency_notes, notes) = (strings(&report["dependencyNotes"]), strings(&report["notes"]));
        let note = worktree_preparation_note(&PreparationReport {
            root: report["root"].as_str().unwrap_or(""),
            prepared: report.get("prepared"),
            dependency_notes: &dependency_notes,
            installs: installs.as_ref(),
            notes: &notes,
        });
        assert_eq!(note, text(case, "note"), "{}", case["name"]);
    }
}

fn runner() -> SetupRunner {
    let tokens = mixdog_rt::testing::tokens();
    SetupRunner::new(Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())))
}

fn command(file: &str, args: &[&str], cwd: &Path) -> SetupCommand {
    let shown = format!("{file} {}", args.join(" "));
    SetupCommand {
        command: shown,
        file: file.to_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        cwd: cwd.to_path_buf(),
        label: format!("{file} (root)"),
        env: None,
    }
}

fn sleeper(cwd: &Path) -> SetupCommand {
    if cfg!(windows) { command("ping", &["-n", "30", "127.0.0.1"], cwd) } else { command("sleep", &["30"], cwd) }
}

async fn run_all(commands: Vec<SetupCommand>, cancel: &CancellationToken, options: RunOptions) -> (SetupReport, Vec<SetupEvent>) {
    let mut events = Vec::new();
    let report = runner().run(commands, cancel, &options, &mut |event| events.push(event)).await;
    (report, events)
}

#[tokio::test]
async fn commands_run_in_order_and_the_first_that_fails_ends_the_run() {
    let dir = tempfile::tempdir().unwrap();
    let commands = vec![
        command("git", &["--version"], dir.path()),
        command("git", &["no-such-subcommand"], dir.path()),
        command("git", &["--version"], dir.path()),
    ];
    let (report, events) = run_all(commands, &CancellationToken::new(), RunOptions::default()).await;
    assert_eq!(report.status, SetupStatus::Failed);
    assert_eq!(report.total, 3);
    assert_eq!(report.steps.len(), 2);
    assert_eq!(report.steps[0].status, SetupStatus::Completed);
    assert_eq!(report.steps[0].exit_code, Some(0));
    assert!(report.steps[0].output.starts_with("git version"), "{}", report.steps[0].output);
    assert_eq!(report.steps[1].status, SetupStatus::Failed);
    assert_eq!(report.steps[1].exit_code, Some(1));
    assert!(report.steps[1].output.contains("no-such-subcommand"), "{}", report.steps[1].output);
    assert_eq!(report.pending.len(), 1);
    // A start per command that ran, then the report.
    let starts: Vec<usize> = events.iter().filter_map(|e| if let SetupEvent::Running { index, output, .. } = e { output.is_empty().then_some(*index) } else { None }).collect();
    assert_eq!(starts, [0, 1]);
    let Some(SetupEvent::Final(last)) = events.last() else { panic!("no final event") };
    assert_eq!(last, &report);
    assert_eq!(events.last().unwrap().to_value()["final"], true);
}

#[tokio::test]
async fn a_program_that_does_not_exist_fails_the_step_with_its_spawn_text() {
    let dir = tempfile::tempdir().unwrap();
    let (report, _) = run_all(vec![command("no-such-program-xyz", &[], dir.path())], &CancellationToken::new(), RunOptions::default()).await;
    assert_eq!(report.status, SetupStatus::Failed);
    assert_eq!(report.steps[0].exit_code, None);
    assert!(report.steps[0].output.contains("ENOENT"), "{}", report.steps[0].output);
}

// The limit is the process manager's own: an OS thread enforces it, so no tokio clock (paused or not) moves it. The run
// waits on the process's exit event.
#[tokio::test]
async fn a_command_over_its_time_limit_is_killed_and_reported_timed_out() {
    let dir = tempfile::tempdir().unwrap();
    let options = RunOptions { timeout: Duration::from_millis(300), ..RunOptions::default() };
    let (report, _) = run_all(vec![sleeper(dir.path()), command("git", &["--version"], dir.path())], &CancellationToken::new(), options).await;
    assert_eq!(report.status, SetupStatus::TimedOut);
    assert_eq!(report.steps[0].status, SetupStatus::TimedOut);
    assert_eq!(report.pending.len(), 1);
}

#[tokio::test]
async fn a_cancel_kills_the_running_command_and_leaves_the_rest_pending() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    // The cancel lands as the sleeper's step begins: the run kills the process it just started.
    let report = runner()
        .run(vec![sleeper(dir.path()), command("git", &["--version"], dir.path())], &cancel, &RunOptions::default(), &mut |event| {
            if matches!(event, SetupEvent::Running { .. }) {
                cancel.cancel();
            }
        })
        .await;
    assert_eq!(report.status, SetupStatus::Cancelled);
    assert_eq!(report.steps[0].status, SetupStatus::Cancelled);
    assert_eq!(report.pending.len(), 1);
    // Cancelled before the next command: nothing runs.
    let (after, _) = run_all(vec![command("git", &["--version"], dir.path())], &cancel, RunOptions::default()).await;
    assert_eq!((after.status, after.steps.len(), after.pending.len()), (SetupStatus::Cancelled, 0, 1));
}

#[tokio::test]
async fn the_first_turn_in_a_new_worktree_is_prepared_once_and_noted() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
    let setup = WorktreeSetup::new(rig.worktrees.clone(), processes);
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = seen.clone();
    let _subscription = setup.on_worktree_setup(Arc::new(move |event| sink.lock().unwrap().push(event)));
    let cancel = CancellationToken::new();
    let first = setup.run_pending("lead", Some(&entered["workspace"]), &cancel).await.unwrap();
    let notice = first.notice.expect("a new worktree is prepared at its first turn");
    assert!(!first.cancelled);
    assert!(notice.content.starts_with("<system-reminder>\n# Worktree Preparation\nThis worktree was made from the main checkout at "), "{}", notice.content);
    assert!(notice.content.contains("No lockfile or dependency manifest found; nothing was installed."), "{}", notice.content);
    // The preparation is claimed before it runs: a second turn there has nothing to do.
    let second = setup.run_pending("lead", Some(&entered["workspace"]), &cancel).await.unwrap();
    assert!(second.notice.is_none());
    // A session in the project folder has no worktree to prepare.
    let project = Workspace::project(rig.repo.to_str().unwrap(), rig.repo.to_str().unwrap()).to_value();
    assert!(setup.run_pending("lead", Some(&project), &cancel).await.unwrap().notice.is_none());
    assert!(seen.lock().unwrap().is_empty(), "no command was planned, so no progress");
}

/// The listing only counts rows; nobody keeps or owns them.
struct KeepNone;

impl Retention for KeepNone {
    fn owner_live(&self, _record: &WorktreeRecord) -> bool {
        false
    }

    fn retained(&self, _record: &WorktreeRecord) -> bool {
        false
    }
}

/// A directory link `link` -> `target`: a junction on Windows (no privilege needed), else a symlink.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(link).arg(target).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[tokio::test]
async fn a_link_an_install_could_reach_through_blocks_the_installs_until_it_is_recorded_as_asked_for() {
    let rig = rig();
    std::fs::write(rig.repo.join("package.json"), "{}\n").unwrap();
    super::worktree_tests::git(&rig.repo, &["add", "."]);
    super::worktree_tests::git(&rig.repo, &["commit", "-q", "-m", "manifest"]);
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    let worktree_id = entered["workspace"]["worktreeId"].as_str().unwrap().to_owned();
    let cwd = PathBuf::from(entered["workspace"]["cwd"].as_str().unwrap());
    let shared_target = tempfile::tempdir().unwrap();
    std::fs::write(shared_target.path().join("keep.txt"), "keep").unwrap();
    link_dir(&cwd.join("node_modules"), shared_target.path());

    let tokens = mixdog_rt::testing::tokens();
    let setup = WorktreeSetup::new(rig.worktrees.clone(), Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())));
    let cancel = CancellationToken::new();
    // Written before the link was made (`pending`), as creation does: not yet a link the user
    // asked for, so an install through it could empty the folder it points at.
    rig.worktrees.record_link(&worktree_id, "node_modules", shared_target.path(), "pending", &cancel).await.unwrap();
    let blocked = setup.run_pending("lead", Some(&entered["workspace"]), &cancel).await.unwrap();
    let content = blocked.notice.expect("the preparation is reported").content;
    assert!(
        content.contains("Dependencies were not installed: node_modules is a link, and any install here could empty the folder it points at (such as the main checkout's) through it. Remove the link (never its target); the next turn installs."),
        "{content}"
    );
    assert!(shared_target.path().join("keep.txt").exists(), "nothing was emptied through the link");

    // Still pending: once the link is recorded as created (asked for), the next turn goes on.
    rig.worktrees.record_link(&worktree_id, "node_modules", shared_target.path(), "created", &cancel).await.unwrap();
    let next = setup.run_pending("lead", Some(&entered["workspace"]), &cancel).await.unwrap();
    let content = next.notice.expect("the pending preparation runs on the next turn").content;
    assert!(!content.contains("Dependencies were not installed"), "{content}");
    assert!(shared_target.path().join("keep.txt").exists());
}

#[derive(Default)]
struct Sessions {
    stored: Mutex<HashSet<String>>,
}

#[async_trait]
impl SessionSource for Sessions {
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
        Ok(self.stored.lock().unwrap().clone())
    }

    async fn favorites(&self) -> Option<HashSet<String>> {
        Some(HashSet::new())
    }

    async fn archived(&self) -> Option<HashSet<String>> {
        Some(HashSet::new())
    }

    async fn activity(&self, _ids: &[String]) -> HashMap<String, SessionActivity> {
        HashMap::new()
    }

    async fn running_jobs(&self) -> Result<Vec<ShellJob>, ScmFailure> {
        Ok(Vec::new())
    }
}

fn maintenance(rig: &super::worktree_tests::Rig, sessions: Arc<Sessions>, live: &[&str], cancelled: Arc<Mutex<Vec<Option<String>>>>) -> WorktreeMaintenance {
    let live_ids: HashSet<String> = live.iter().map(|s| (*s).to_owned()).collect();
    let live: LiveSessions = Arc::new(move || live_ids.clone());
    WorktreeMaintenance::new(rig.worktrees.clone(), sessions, live, Arc::new(move |id| cancelled.lock().unwrap().push(id.map(str::to_owned))))
}

#[tokio::test]
async fn the_startup_reconcile_keeps_what_a_session_keeps_and_a_deleted_session_cleans_up() {
    let rig = rig();
    run(&rig, enter("feat", "c1")).await.unwrap();
    let sessions = Arc::new(Sessions::default());
    sessions.stored.lock().unwrap().insert("lead".into());
    let cancelled = Arc::new(Mutex::new(Vec::new()));
    let maintenance = maintenance(&rig, sessions.clone(), &[], cancelled.clone());
    let cancel = CancellationToken::new();
    // The store keeps the Lead: its worktree stays.
    let kept = maintenance.reconcile_at_startup(&cancel).await.unwrap();
    assert_eq!(kept["removed"], json!([]), "{kept}");
    assert!(startup_summary(&kept).is_none());
    assert_eq!(rig.worktrees.list(None, &KeepNone, &cancel).await.unwrap().len(), 1);
    // The session is deleted: it has left its worktree (the deletion releases the session's
    // work first), and autoCleanup removes its clean, merged worktree; its snapshot cleanups
    // stop first.
    run(&rig, SessionOp::Return { session_id: None, tx_id: "c2:return".into() }).await.unwrap();
    sessions.stored.lock().unwrap().clear();
    let cleaned = maintenance.cleanup_deleted_session("lead", &cancel).await.unwrap().expect("it had a worktree");
    assert_eq!(cleaned["removed"], true, "{cleaned}");
    assert_eq!(*cancelled.lock().unwrap(), [Some("lead".to_owned())]);
    assert!(rig.worktrees.list(None, &KeepNone, &cancel).await.unwrap().is_empty());
    assert!(maintenance.cleanup_deleted_session("lead", &cancel).await.unwrap().is_none());
}

fn open_maintenance(rig: &super::worktree_tests::Rig, cancelled: Arc<Mutex<Vec<Option<String>>>>) -> WorktreeMaintenance {
    maintenance(rig, Arc::new(Sessions::default()), &[], cancelled)
}

#[tokio::test]
async fn a_deleted_sessions_snapshots_go_with_it_whatever_it_owns() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let head = super::worktree_tests::git(&rig.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let snapshot = rig.worktrees.snapshot(&rig.repo, "holder", &head, "tx1", false, &cancel).await.unwrap();
    assert!(Path::new(&snapshot.path).exists());
    let cancelled = Arc::new(Mutex::new(Vec::new()));
    let maintenance = open_maintenance(&rig, cancelled.clone());
    // The holder owns no worktree: nothing to report, yet its snapshot is removed (autoCleanup
    // is not consulted for snapshots) and its retrying cleanups are stopped first.
    rig.auto_cleanup.store(false, Ordering::SeqCst);
    assert!(maintenance.cleanup_deleted_session("holder", &cancel).await.unwrap().is_none());
    assert_eq!(*cancelled.lock().unwrap(), [Some("holder".to_owned())]);
    assert!(rig.worktrees.record(&cancel, &snapshot.id).await.unwrap().is_none());
    assert!(!Path::new(&snapshot.path).exists());
}

#[tokio::test]
async fn a_deleted_sessions_shared_reference_is_forgotten_and_the_owner_keeps_the_worktree() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    let id = entered["workspace"]["worktreeId"].as_str().unwrap().to_owned();
    let cancel = CancellationToken::new();
    let other = mixdog_scm::worktree::ownership::Owner { session_id: "other".into(), runtime_token: "rt-other".into(), pid: None };
    rig.worktrees.claim_owner(&id, other, &cancel).await.unwrap();
    let shared = rig.worktrees.record(&cancel, &id).await.unwrap().unwrap();
    assert_eq!(shared.shared_session_ids, ["other"]);
    let maintenance = open_maintenance(&rig, Arc::default());
    // It shared the worktree and owned none: the reference goes, the owner's folder stays.
    assert!(maintenance.cleanup_deleted_session("other", &cancel).await.unwrap().is_none());
    let after = rig.worktrees.record(&cancel, &id).await.unwrap().unwrap();
    assert!(after.shared_session_ids.is_empty());
    assert_eq!(after.owner_session_id.as_deref(), Some("lead"));
    assert!(Path::new(&after.path).exists());
}

#[tokio::test]
async fn a_deleted_session_with_nothing_reports_nothing_and_still_stops_its_cleanups() {
    let rig = rig();
    let cancelled = Arc::new(Mutex::new(Vec::new()));
    let maintenance = open_maintenance(&rig, cancelled.clone());
    assert!(maintenance.cleanup_deleted_session("ghost", &CancellationToken::new()).await.unwrap().is_none());
    assert_eq!(*cancelled.lock().unwrap(), [Some("ghost".to_owned())]);
}

struct BoardClock;
impl mixdog_agent::env::Clock for BoardClock {
    fn now_ms(&self) -> i64 {
        1
    }
}

/// `deleteSession`'s outside world over the real services, in Node's calls: the session's own
/// background work is cancelled silently (not another session's), its gateway route goes (not
/// another session's), the app feed hears `thread/deleted`, and its worktree cleanups stop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_reaches_the_board_the_routes_the_app_feed_and_the_worktrees() {
    use mixdog_agent::agent_tool::board::JobBoard;
    use mixdog_agent::agent_tool::board::JobMeta;
    use mixdog_agent::agent_tool::board::NewJob;
    use mixdog_core_api::feed::FeedSource;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockFeed;
    use mixdog_core_api::mock::MockLimits;

    use crate::session::delete::DeleteSeams;

    let board = JobBoard::new(Arc::new(BoardClock), None, None);
    let stopped: Arc<Mutex<Vec<String>>> = Arc::default();
    for session in ["sess_gone", "sess_kept"] {
        let seen = stopped.clone();
        let job = NewJob {
            operation: "shell".into(),
            meta: JobMeta { session_id: Some(session.into()), ..JobMeta::default() },
            cancel: Some(Arc::new(move || seen.lock().unwrap().push(session.to_owned()))),
            ..NewJob::default()
        };
        board.register(job).unwrap();
    }
    let limits = MockLimits::default();
    let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
    let conn = MockConnection::new(mixdog_core_api::ids::ConnectionId(1), limits);
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &conn).unwrap();
    mixdog_core_api::sink::ConnectionSink::send_control_release(&conn, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
    struct Epoch;
    impl crate::session::Clock for Epoch {
        fn now_ms(&self) -> i64 {
            0
        }
    }
    struct NoScopes;
    #[async_trait::async_trait]
    impl mixdog_mcp::mcp_glue::McpScopes for NoScopes {
        async fn open(&self, _: &str, _: &str, _: &std::path::Path) -> Result<(), mixdog_mcp::hub::ScopeReleased> {
            Ok(())
        }
        fn release(&self, _: &str) {}
        async fn open_runtime(&self, _: &std::path::Path) -> Result<String, mixdog_mcp::hub::ScopeReleased> {
            Ok(String::new())
        }
    }
    #[derive(Default)]
    struct Shells(Mutex<Vec<String>>);
    impl crate::session::shell_jobs::OwnedShells for Shells {
        fn cancel_owned(&self, owner: &mixdog_core_api::ids::ThreadId) {
            self.0.lock().unwrap().push(owner.as_str().to_owned());
        }
    }
    let shells = Arc::new(Shells::default());
    let rig = rig();
    let cancelled = Arc::new(Mutex::new(Vec::new()));
    let data = tempfile::tempdir().unwrap();
    let routes_file = data.path().join(crate::session::gateway_routes::STORE_FILE);
    let route = json!({ "mode": "claude-current", "defaultProvider": "openai", "defaultModel": "gpt", "updatedAt": 1 });
    let stored = json!({ "version": 2, "updatedAt": 1, "sessions": { "sess_gone": route, "sess_kept": route }, "sessionHosts": {} });
    std::fs::write(&routes_file, stored.to_string()).unwrap();
    let maintenance = mixdog_rt::testing::tokens().maintenance_io;
    let deletion = crate::session::purge::SessionDeletion {
        app: Arc::new(mixdog_core_base::state::SectionFeedState::new(feed)),
        search: None,
        worktrees: Arc::new(open_maintenance(&rig, cancelled.clone())),
        board: board.clone(),
        gateway_routes: crate::session::gateway_routes::GatewaySessionRoutes::new(data.path(), maintenance),
        shells: shells.clone(),
        tool_events: Arc::new(crate::session::tool_events::ToolEventsLog::new(data.path(), maintenance, Arc::new(Epoch))),
        mcp_scopes: Arc::new(NoScopes),
    };

    deletion.release_session_work("sess_gone", "desktop-session-delete").await;
    assert_eq!(*stopped.lock().unwrap(), ["sess_gone"]);
    assert_eq!(*shells.0.lock().unwrap(), ["sess_gone"], "the session's shells go with its work");
    // Gone when the release returns, as Node's synchronous clear is.
    let left: Value = serde_json::from_str(&std::fs::read_to_string(&routes_file).unwrap()).unwrap();
    assert_eq!(left["sessions"], json!({ "sess_kept": route }));
    assert_eq!((left["version"].clone(), left["sessionHosts"].clone()), (json!(2), json!({})));
    deletion.thread_deleted(&mixdog_core_api::ids::ThreadId::from("sess_gone"));
    conn.drain_text_until(|texts| texts.iter().any(|t| t.contains(r#""method":"thread/deleted","params":{"threadId":"sess_gone"}"#))).await;
    deletion.release_deleted_worktree("sess_gone").await;
    assert_eq!(*cancelled.lock().unwrap(), [Some("sess_gone".to_owned())]);
    deletion.forget_session_search("sess_gone");
}

/// `clearGatewaySessionRoute`: an id the store never keys is refused; a session with no route
/// leaves the store untouched (Node's mutator answers `undefined`), so no file appears.
#[tokio::test]
async fn a_gateway_route_clear_keeps_what_node_keeps() {
    use crate::session::gateway_routes::clear_session_route;
    use crate::session::gateway_routes::normalize_session_id;
    use mixdog_rt::LaneToken;
    assert_eq!(normalize_session_id("  sess_abc1  "), Some("sess_abc1"));
    assert_eq!(normalize_session_id("short"), None);
    assert_eq!(normalize_session_id("_leading"), None);
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("routes.json");
    let maintenance = mixdog_rt::testing::tokens().maintenance_io;
    for (id, cleared) in [("tiny", false), ("sess_absent", true)] {
        let target = path.clone();
        let job = maintenance.submit(&CancellationToken::new(), move |lane| clear_session_route(lane, &target, id, 5));
        assert_eq!(job.expect("lane").await.expect("ran"), Ok(cleared), "{id}");
        assert!(!path.exists(), "{id}");
    }
}

/// The daemon's jobs: the startup reconcile runs at once and logs what it did; the cleanup task
/// is due 3 minutes after the start and every hour after that (never earlier).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_daemon_jobs_reconcile_at_start_and_clean_up_on_the_hour() {
    use mixdog_core_base::maintenance::MaintenanceSchedule;
    let rig = rig();
    run(&rig, enter("feat", "c1")).await.unwrap();
    run(&rig, SessionOp::Return { session_id: None, tx_id: "c2:return".into() }).await.unwrap();
    // No stored session keeps the returned, merged worktree: the reconcile removes it.
    let maintenance = Arc::new(open_maintenance(&rig, Arc::default()));
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = lines.clone();
    let logged = Arc::new(tokio::sync::Notify::new());
    let announce = logged.clone();
    let schedule = MaintenanceSchedule::new();
    let clock: mixdog_core_base::maintenance::Clock = Arc::new(|| 1_000);
    maintenance.start(&schedule, &clock, Arc::new(move |line| {
        sink.lock().unwrap().push(line.to_owned());
        announce.notify_one();
    }), CancellationToken::new());
    // The sink's notification keeps its permit, so a line logged before this wait still wakes it.
    crate::session::testing::awaiting("the startup reconcile to log what it did", logged.notified()).await;
    assert_eq!(*lines.lock().unwrap(), ["worktree reconcile: removed 1, recovered 0, pruned 0, incomplete 0, errors 0"]);
    let (due, hour) = (1_000 + 3 * 60_000, 60 * 60_000);
    assert!(schedule.run_tasks(false, due - 1).await.ran.is_empty());
    assert_eq!(schedule.run_tasks(false, due).await.ran, ["worktree-cleanup"]);
    assert!(schedule.run_tasks(false, due + hour - 1).await.ran.is_empty());
    assert_eq!(schedule.run_tasks(false, due + hour).await.ran, ["worktree-cleanup"]);
    assert_eq!(lines.lock().unwrap().len(), 1, "a cleanup that did nothing logs nothing");
}

#[test]
fn the_daemon_log_lines_equal_nodes() {
    let quiet = json!({"removed": [], "recovered": [], "pruned": [], "kept": [{"id": "a", "reason": "dirty"}], "errors": []});
    assert_eq!(startup_summary(&quiet), None);
    assert_eq!(cleanup_summary(&quiet), None);
    let busy = json!({
        "removed": ["a"], "recovered": ["b", "c"], "pruned": [],
        "kept": [{"id": "x", "reason": "incomplete"}, {"id": "y", "reason": "incomplete"}, {"id": "z", "reason": "dirty"}],
        "errors": [{"id": "e", "error": "boom"}],
    });
    assert_eq!(
        startup_summary(&busy).unwrap(),
        r#"worktree reconcile: removed 1, recovered 2, pruned 0, incomplete 2, errors 1 [{"id":"e","error":"boom"}]"#
    );
    assert_eq!(cleanup_summary(&busy).unwrap(), "worktree cleanup: removed 1, incomplete 2 (x, y), errors 1");
    let none = json!({"removed": [], "kept": [{"id": "x", "reason": "incomplete"}], "errors": []});
    assert_eq!(cleanup_summary(&none).unwrap(), "worktree cleanup: removed 0, incomplete 1 (x), errors 0");
}
