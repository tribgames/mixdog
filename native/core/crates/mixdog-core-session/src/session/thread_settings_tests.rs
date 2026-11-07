//! The thread settings against `fixtures/session-sidebar/golden.json` (recorded by
//! `record-session-sidebar.mjs` from the desktop's own `DesktopSessionMetadata` and Node's rules),
//! and the service over a session directory and a workspace rig.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::FeedSource;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::maintenance::ShellJob;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::session::seams::RunOutcome;
use crate::session::testing::Rig;
use crate::session::testing::lock;
use crate::session::tests::eventually;
use crate::session::tests::turn;
use crate::session::worktree::worktree_tests;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/session-sidebar/golden.json")).expect("golden.json")
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

// ---- Node's rules, replayed ---------------------------------------------------------------------

/// `markRead` step by step: the answer, the refusal and the cursor left, numbered or not.
#[test]
fn read_cursors_follow_nodes_mark_read() {
    let golden = golden();
    let mut cursors: HashMap<String, Map<String, Value>> = HashMap::new();
    for (at, step) in golden["reads"].as_array().unwrap().iter().enumerate() {
        let id = step["id"].as_str().unwrap();
        let count = step["count"].as_i64().unwrap();
        let numbering = &step["numbering"];
        if !read_cursor_valid(id, count) {
            assert_eq!(step["error"], "Session read cursor is invalid.", "step {at}");
        } else {
            let mark = mark_read(
                cursors.get(id),
                count,
                step["consumed"] == true,
                numbering.get("compactCount"),
                numbering.get("messageCount"),
            );
            assert_eq!(json!(mark.changed), step["value"], "step {at}: answer");
            if let Some(cursor) = mark.store {
                cursors.insert(id.to_owned(), cursor);
            }
        }
        let left = cursors.get(id).map_or(Value::Null, |cursor| Value::Object(cursor.clone()));
        assert_eq!(left, step["cursor"], "step {at}: cursor");
    }
}

#[test]
fn tool_modes_conversations_projects_and_descendants_follow_node() {
    let golden = golden();
    for case in golden["toolModes"].as_array().unwrap() {
        let mode = normalize_tool_mode(case["mode"].as_str().unwrap());
        assert_eq!((json!(mode), tool_spec_for_mode(mode)), (case["normalized"].clone(), case["spec"].clone()), "{case}");
    }
    for case in golden["conversations"].as_array().unwrap() {
        let messages = case["messages"].as_array().unwrap();
        assert_eq!(json!(has_conversation_messages(messages)), case["conversation"], "{case}");
    }
    for case in golden["identities"].as_array().unwrap() {
        assert_eq!(json!(project_identity(case["path"].as_str())), case["identity"], "{case}");
    }
    for case in golden["projectKeys"].as_array().unwrap() {
        let keys: Vec<String> = serde_json::from_value(case["keys"].clone()).unwrap();
        assert_eq!(json!(session_project_key(&case["row"], &keys)), case["key"], "{case}");
    }
    let rows: Vec<(String, Header)> = golden["descendantRows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["id"].as_str().unwrap().to_owned(), object(row).unwrap().clone()))
        .collect();
    for case in golden["descendants"].as_array().unwrap() {
        assert_eq!(json!(agent_descendant_ids(&rows, case["root"].as_str().unwrap())), case["ids"], "{case}");
    }
}

// ---- the service --------------------------------------------------------------------------------

/// The registered Projects; what a move asked of them.
struct Projects {
    registered: Vec<String>,
    task: String,
    touched: Mutex<Vec<String>>,
}

#[async_trait]
impl ProjectFolders for Projects {
    async fn projects(&self) -> Result<Vec<String>, String> {
        Ok(self.registered.clone())
    }
    async fn registered(&self, path: &str) -> Result<String, String> {
        let key = project_identity(Some(path));
        self.registered.iter().find(|p| project_identity(Some(p)) == key).cloned().ok_or_else(|| "Project is not available.".to_owned())
    }
    async fn canonical_directory(&self, path: &str) -> Result<String, String> {
        Ok(path.to_owned())
    }
    async fn task_workspace(&self) -> Result<String, String> {
        Ok(self.task.clone())
    }
    async fn touch_selected(&self, cwd: &str) -> Result<(), String> {
        lock(&self.touched).push(cwd.to_owned());
        Ok(())
    }
}

#[derive(Default)]
struct Notes(Mutex<Vec<(String, bool)>>);

#[async_trait]
impl ArchiveRetention for Notes {
    async fn note_archived(&self, session_id: &str, archived: bool) -> Result<(), String> {
        lock(&self.0).push((session_id.to_owned(), archived));
        Ok(())
    }
    async fn forget(&self, _session_id: &str) -> Result<(), String> {
        unreachable!("the thread settings never forget a record: a delete does")
    }
}

#[derive(Default)]
struct Effort(Mutex<Vec<(String, String, bool)>>);

#[async_trait]
impl EffortTuning for Effort {
    async fn set_effort(&self, thread: &ThreadId, value: &str, session_only: bool) -> Result<Value, String> {
        if value == "huge" {
            return Err("effort must be one of auto, none, minimal, low, medium, high, xhigh, max, ultra".into());
        }
        lock(&self.0).push((thread.as_str().to_owned(), value.to_owned(), session_only));
        Ok(json!({ "provider": "anthropic", "model": "opus", "effort": value, "autoEffort": false }))
    }
    fn route(&self, _: &ThreadId) -> Value {
        json!({})
    }
}

/// The stored agent-only sessions, set by the test.
#[derive(Default)]
struct AgentOnly(Mutex<Vec<String>>);

#[async_trait]
impl AgentOnlyIndex for AgentOnly {
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
        Ok(lock(&self.0).clone())
    }
}

struct NoSessions;

#[async_trait]
impl SessionSource for NoSessions {
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
        Ok(HashSet::new())
    }
    async fn favorites(&self) -> Option<HashSet<String>> {
        None
    }
    async fn archived(&self) -> Option<HashSet<String>> {
        None
    }
    async fn activity(&self, _: &[String]) -> HashMap<String, SessionActivity> {
        HashMap::new()
    }
    async fn running_jobs(&self) -> Result<Vec<ShellJob>, ScmFailure> {
        Ok(Vec::new())
    }
}

struct World {
    rig: Rig,
    directory: Arc<SessionDirectory>,
    workspace: worktree_tests::Rig,
    settings: ThreadSettings,
    projects: Arc<Projects>,
    notes: Arc<Notes>,
    effort: Arc<Effort>,
    agent_only: Arc<AgentOnly>,
    app: MockConnection,
    _ops: tempfile::TempDir,
}

async fn world() -> World {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let workspace = worktree_tests::rig();
    let projects = Arc::new(Projects {
        registered: vec![workspace.repo.to_string_lossy().into_owned()],
        task: workspace.data.join("unclassified").to_string_lossy().into_owned(),
        touched: Mutex::default(),
    });
    let (notes, effort, agent_only) = (Arc::new(Notes::default()), Arc::new(Effort::default()), Arc::new(AgentOnly::default()));
    let live: crate::session::worktree::LiveSessions = Arc::new(HashSet::new);
    let worktrees = WorktreeMaintenance::new(workspace.worktrees.clone(), Arc::new(NoSessions), live, Arc::new(|_: Option<&str>| {}));
    let limits = MockLimits::default();
    let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
    let app = MockConnection::new(ConnectionId(1), limits);
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).unwrap();
    mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
    let ops = tempfile::tempdir().unwrap();
    let settings = ThreadSettings::new(ThreadSettingsParts {
        directory: directory.clone(),
        workspaces: workspace.ws.clone(),
        effort: effort.clone(),
        projects: projects.clone(),
        agent_only: agent_only.clone(),
        worktrees: Arc::new(worktrees),
        retention: notes.clone(),
        app: Arc::new(mixdog_core_base::state::SectionFeedState::new(feed)),
        ops: scopes(ops.path(), "thread").await,
    });
    World { rig, directory, workspace, settings, projects, notes, effort, agent_only, app, _ops: ops }
}

impl World {
    async fn session(&self, id: &str, header: Value) {
        let mut header = object(&header).cloned().unwrap_or_default();
        header.insert("createdAt".into(), json!(1));
        self.directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("created");
    }

    async fn header(&self, id: &str) -> Header {
        self.directory.stored_header(&ThreadId::from(id)).await.expect("stored")
    }

    async fn call(&self, method: &'static str, params: Value, op: u64) -> Result<Value, CoreError> {
        value(&self.settings, request(method, with_op(params, op), Some(op))).await
    }

    /// The app feed's frames so far.
    fn published(&self) -> Vec<String> {
        self.app.drain_text()
    }
}

/// The error's text and code as the wire carries them.
fn message(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { code, message, .. } => format!("{} {}", code.as_deref().unwrap_or_default(), message.as_deref().unwrap_or_default()),
        other => format!("{other:?}"),
    }
}

/// `setSessionFavorite` and `setSessionArchived` step by step as the desktop's metadata took them:
/// every session's `favoriteAt` and `archivedAt` after each step, archive stamps that never
/// repeat, a restore that brings back only the sub-agent sessions its archive took, and
/// `thread/archived` / `thread/unarchived` for a change of the session's own state.
#[tokio::test(start_paused = true)]
async fn favorites_and_archives_replay_the_desktops_metadata() {
    let golden = golden();
    let world = world().await;
    let steps = golden["sidebar"].as_array().unwrap();
    let mut ids: Vec<String> = Vec::new();
    for step in steps {
        for id in std::iter::once(&step["id"]).chain(step["descendants"].as_array().unwrap()) {
            let id = id.as_str().unwrap().to_owned();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    for id in &ids {
        // Every sub-agent session links to both roots the script archives it under.
        let header = if id.starts_with("sess_c") {
            json!({ "visibility": "agent-only", "ownerSessionId": "sess_lead", "parentSessionId": "sess_other" })
        } else {
            json!({})
        };
        world.session(id, header).await;
    }
    world.published();
    for (at, step) in steps.iter().enumerate() {
        world.rig.clock.0.store(step["now"].as_u64().unwrap(), Ordering::SeqCst);
        *lock(&world.agent_only.0) = serde_json::from_value(step["descendants"].clone()).unwrap();
        let (id, flag) = (step["id"].as_str().unwrap(), step["flag"] == true);
        let op = at as u64 + 1;
        let answer = if step["op"] == "favorite" {
            world.call(METADATA_UPDATE, json!({ "threadId": id, "favorite": flag }), op).await
        } else {
            world.call(if flag { ARCHIVE } else { UNARCHIVE }, json!({ "threadId": id }), op).await
        };
        assert_eq!(answer.unwrap(), json!({}), "step {at}");
        let (mut favorites, mut archived) = (Map::new(), Map::new());
        for id in &ids {
            let header = world.header(id).await;
            if let Some(at) = header.get("favoriteAt") {
                favorites.insert(id.clone(), at.clone());
            }
            if let Some(at) = header.get("archivedAt") {
                archived.insert(id.clone(), at.clone());
            }
        }
        assert_eq!(Value::Object(favorites), step["favorites"], "step {at}: favorites");
        assert_eq!(Value::Object(archived), step["archived"], "step {at}: archived");
        if step["op"] == "archive" {
            let method = if flag { "thread/archived" } else { "thread/unarchived" };
            let frame = format!(r#""method":"{method}","params":{{"threadId":"{id}"}}"#);
            if step["value"] == true {
                eventually(|| world.published().iter().any(|text| text.contains(&frame)).then_some(())).await;
            } else {
                tokio::time::sleep(Duration::from_millis(20)).await;
                assert!(!world.published().iter().any(|text| text.contains(method)), "step {at}: nothing changed");
            }
        }
    }
    let notes = lock(&world.notes.0).clone();
    let changed: Vec<(String, bool)> = steps
        .iter()
        .filter(|step| step["op"] == "archive" && step["value"] == true)
        .map(|step| (step["id"].as_str().unwrap().to_owned(), step["flag"] == true))
        .collect();
    assert_eq!(notes, changed, "auto-retention hears each change of a session's own state");
}

/// The cursor lands on the session's header; the answer says whether it moved, and a cursor
/// that cannot be one is refused with the desktop's text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_lands_on_the_header_and_answers_whether_it_moved() {
    let world = world().await;
    world.session("sess_read", json!({})).await;
    let read = |count: i64, consumed: bool, op: u64| {
        world.call(READ_STATE_UPDATE, json!({ "threadId": "sess_read", "messageCount": count, "consumedUnread": consumed }), op)
    };
    assert_eq!(read(4, false, 1).await.unwrap(), json!(true));
    assert_eq!(read(4, false, 2).await.unwrap(), json!(false));
    assert_eq!(read(4, true, 3).await.unwrap(), json!(true));
    assert_eq!(world.header("sess_read").await["readState"], json!({ "messageCount": 4, "revision": 2 }));
    let refused = read(10_000_001, false, 4).await.unwrap_err();
    assert!(message(&refused).contains("Session read cursor is invalid."), "{refused:?}");
    // A duplicate op answers what the first one did.
    assert_eq!(read(4, false, 1).await.unwrap(), json!(true));
}

/// `setToolMode`: the normalized mode always; an empty idle session takes its tool spec, one
/// running a turn keeps its surface.
#[tokio::test(start_paused = true)]
async fn a_tool_mode_reaches_only_an_empty_idle_session() {
    let world = world().await;
    world.session("sess_empty", json!({ "toolSpec": "full" })).await;
    let answer = world.call(SET_TOOL_MODE, json!({ "threadId": "sess_empty", "mode": " ReadOnly " }), 1).await.unwrap();
    assert_eq!(answer, json!("readonly"));
    assert_eq!(world.header("sess_empty").await["toolSpec"], json!(["tools:readonly"]));
    assert_eq!(world.call(SET_TOOL_MODE, json!({ "threadId": "sess_empty", "mode": "lead" }), 2).await.unwrap(), json!("lead"));
    assert_eq!(world.header("sess_empty").await["toolSpec"], json!("full"));

    world.rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    world.session("sess_busy", json!({ "toolSpec": "full" })).await;
    let handle = world.directory.handle(&ThreadId::from("sess_busy")).expect("loaded");
    turn(&handle, "work", "op-busy").await;
    eventually(|| handle.cell.run.load().is_some().then_some(())).await;
    let answer = world.call(SET_TOOL_MODE, json!({ "threadId": "sess_busy", "mode": "readonly" }), 3).await.unwrap();
    assert_eq!(answer, json!("readonly"));
    assert_eq!(world.header("sess_busy").await["toolSpec"], json!("full"), "a running turn keeps its tool surface");
    assert_eq!(world.header("sess_busy").await["toolMode"], json!("readonly"), "but the thread's mode follows, as `rt.mode` does");
    assert_eq!(world.header("sess_empty").await["toolMode"], json!("lead"));
    let missing = world.call(SET_TOOL_MODE, json!({ "mode": "readonly" }), 4).await.unwrap_err();
    assert!(matches!(missing, CoreError::InvalidParams { .. }), "{missing:?}");
}

/// `setCwd`: resolved from the session's folder, checked to be a folder, then the Project switch:
/// a registered Project's folder is classified `project`, any other a task; the Project selected
/// becomes the most recent. A turn refuses it, background shells do not, a worktree does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cwd_switches_the_project_with_its_classification() {
    let world = world().await;
    let repo = world.workspace.repo.to_string_lossy().into_owned();
    let sub = tempfile::Builder::new().prefix("sub").tempdir_in(&world.workspace.repo).unwrap();
    let note = tempfile::NamedTempFile::new_in(&world.workspace.repo).unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    world.session("lead", json!({ "cwd": repo, "desktopSession": { "classification": "task", "projectPath": null } })).await;

    let sub_name = sub.path().file_name().unwrap().to_string_lossy().into_owned();
    let sub_text = sub.path().to_string_lossy().into_owned();
    let answer = world.call(SET_CWD, json!({ "threadId": "lead", "path": sub_name }), 1).await.unwrap();
    assert_eq!(answer, json!(sub_text));
    {
        let state = world.workspace.state.lock().unwrap();
        assert_eq!(state.cwd, sub_text);
        assert_eq!(state.desktop, Some(json!({ "classification": "project", "projectPath": sub_text })));
    }
    assert_eq!(*lock(&world.projects.touched), std::slice::from_ref(&sub_text));

    world.workspace.state.lock().unwrap().shell_jobs = 2;
    let other = elsewhere.path().to_string_lossy().into_owned();
    assert_eq!(world.call(SET_CWD, json!({ "threadId": "lead", "path": other }), 2).await.unwrap(), json!(other));
    assert_eq!(
        world.workspace.state.lock().unwrap().desktop,
        Some(json!({ "classification": "task", "projectPath": null })),
        "outside every registered Project a session is a task again; background shells do not refuse it"
    );

    let blank = world.call(SET_CWD, json!({ "threadId": "lead", "path": "  " }), 3).await.unwrap_err();
    assert!(message(&blank).contains("session: path is required for action=set-project"), "{blank:?}");
    let file = note.path().to_string_lossy().into_owned();
    let not_folder = world.call(SET_CWD, json!({ "threadId": "lead", "path": file }), 4).await.unwrap_err();
    assert!(message(&not_folder).contains(&format!("cwd: not a directory: {file}")), "{not_folder:?}");
    let gone = world.workspace.repo.join("gone").to_string_lossy().into_owned();
    let missing = world.call(SET_CWD, json!({ "threadId": "lead", "path": gone }), 5).await.unwrap_err();
    assert!(message(&missing).contains(&format!("ENOENT: no such file or directory, stat '{gone}'")), "{missing:?}");

    world.workspace.state.lock().unwrap().turn_running = true;
    let busy = world.call(SET_CWD, json!({ "threadId": "lead", "path": repo }), 6).await.unwrap_err();
    assert!(message(&busy).contains("WORKTREE_BUSY_JOBS"), "{busy:?}");
    world.workspace.state.lock().unwrap().turn_running = false;
    world.workspace.state.lock().unwrap().workspace =
        Some(json!({ "projectPath": repo, "repoCommonDir": "/r/.git", "cwd": other, "worktreeId": "w1", "branch": "b", "revision": 2 }));
    let bound = world.call(SET_CWD, json!({ "threadId": "lead", "path": repo }), 7).await.unwrap_err();
    assert!(message(&bound).contains("The session works in a managed worktree; exit the worktree first"), "{bound:?}");
    assert_eq!(world.workspace.state.lock().unwrap().cwd, other, "a refused switch moves nothing");
}

/// `setEffort(value, { sessionOnly })` reaches the route as given and answers the live route;
/// the route's refusal is the answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_effort_reaches_the_route_with_its_session_only_flag() {
    let world = world().await;
    world.session("sess_effort", json!({})).await;
    let route = world
        .call(SET_EFFORT, json!({ "threadId": "sess_effort", "value": "high", "options": { "sessionOnly": true } }), 1)
        .await
        .unwrap();
    assert_eq!(route["effort"], "high");
    world.call(SET_EFFORT, json!({ "threadId": "sess_effort", "value": "low" }), 2).await.unwrap();
    assert_eq!(
        *lock(&world.effort.0),
        [("sess_effort".to_owned(), "high".to_owned(), true), ("sess_effort".to_owned(), "low".to_owned(), false)]
    );
    let refused = world.call(SET_EFFORT, json!({ "threadId": "sess_effort", "value": "huge" }), 3).await.unwrap_err();
    assert!(message(&refused).contains("effort must be one of auto"), "{refused:?}");
}

/// `setSessionProject` of a session the catalog does not list.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_move_of_an_unlisted_session_is_refused() {
    let world = world().await;
    world.session("sess_move", json!({})).await;
    let refused = world.call(METADATA_UPDATE, json!({ "threadId": "sess_move", "projectPath": "" }), 1).await.unwrap_err();
    assert!(message(&refused).contains("Session is not available."), "{refused:?}");
}

/// `noteArchived` and `forget` over `desktop.retentionState`: after every step of
/// `fixtures/archive-retention/golden.json` the record holds what the real desktop
/// `session-auto-retention.ts` left in `session-auto-retention.json` (the file the profile import
/// moves to that key), from no record, a valid one with bad stamps, one with no `enabledAt` and one
/// that is not an object.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_retention_record_follows_the_desktops_archive_notes() {
    use std::sync::atomic::AtomicI64;

    use mixdog_core_config::config::Config;
    use mixdog_core_config::config::ConfigLanes;

    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/archive-retention/golden.json")).expect("golden.json");
    for case in golden["cases"].as_array().expect("cases") {
        let dir = tempfile::tempdir().expect("dir");
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let publisher = Arc::new(mixdog_core_api::mock::MockStatePublisher::default());
        let (config, _) = Config::open(dir.path().join("mixdog-config.json"), publisher, lanes).await.expect("config");
        if !case["initial"].is_null() {
            let initial = case["initial"].clone();
            config
                .update(move |doc| {
                    doc.insert("desktop".into(), json!({ "retentionState": initial }));
                    Ok(())
                })
                .await
                .expect("initial record");
        }
        let now = Arc::new(AtomicI64::new(0));
        let clock = now.clone();
        let retention = ConfigArchiveRetention::new(config.clone(), Arc::new(move || clock.load(Ordering::SeqCst)));
        let steps = case["steps"].as_array().expect("steps");
        for (step, after) in steps.iter().zip(case["after"].as_array().expect("after")) {
            now.store(step["at"].as_i64().expect("at"), Ordering::SeqCst);
            let session = step["session"].as_str().expect("session");
            if step["forget"] == true {
                retention.forget(session).await.expect("forgot");
            } else {
                retention.note_archived(session, step["archived"].as_bool().expect("archived")).await.expect("noted");
            }
            let stored = config.full().get("desktop").and_then(|desktop| desktop.get("retentionState")).cloned().unwrap_or(Value::Null);
            assert_eq!(&stored, after, "{} at {}", case["name"], step["at"]);
        }
    }
}
