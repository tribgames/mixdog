//! Node's recording `fixtures/session-switch/recording.json` (`record-session-switch.mjs`, test file
//! `src/session-runtime/lifecycle/session-switch.test.mjs`), read when the test runs and decoded with [`Exact`].
//! Node's runtime holds one current session; the daemon holds threads, and a client names the thread it acts on. Each
//! case is driven through the client's entries over the real thread store in a scratch data dir: `thread/delete`
//! (`deleteSession`), the session crate's `thread/switchContext` implementation (`SessionContextSwitch`, which
//! `ThreadSettings` serves the method with), `thread/start` (`newSession`), the thread's open (`prefetchSession`).
//! The recorded calls are read off what the core did: the delete's fence of the thread (`close`), the release of its
//! work (`releaseSessionWork`: `cancelTasks` then `clearRoute`, `purge.rs` `release_session_work`), its delete mark
//! (`delete`), the close-time memory ingest, the context target's invalidations; the worktree cleanup and search
//! forget notes are `cleaned` and `forgotten`. What a single runtime's current-session state holds (`state`, the
//! current-session calls) is declared in the manifest's `exclusions`.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::address_replay::Real;
use super::address_replay::delete;
use super::address_replay::real;
use super::testing::lock;
use super::thread_switches::ContextTarget;
use super::thread_switches::SessionContextSwitch;
use mixdog_core_api::ThreadDirectory;

const DELETE_REASON: &str = "desktop-session-delete";
const SWITCH_REASON: &str = "desktop-context-switch";

fn recording() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-switch/recording.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

fn case(recording: &Exact, line: f64) -> Exact {
    recording.get("cases").as_array().iter().find(|case| case.get("testLine").as_f64() == line).cloned().unwrap_or_else(|| panic!("no case at line {line}"))
}

fn exact(value: Value) -> Exact {
    Exact::plain(&value)
}

/// A recorded row as a thread: created under its id with its header fields (its `messages` become a turn, so the
/// catalog lists it), settled.
async fn thread(real: &Real, row: &Exact) -> ThreadId {
    let id = ThreadId::from(row.get("id").as_str());
    let mut header = serde_json::Map::new();
    let mut prompt = None;
    for (key, value) in row.entries() {
        match key.as_str() {
            "id" => {}
            "messages" => prompt = value.as_array().iter().find(|m| m.get("role").as_str() == "user").map(|m| m.get("content").as_str().to_owned()),
            _ => {
                header.insert(key.clone(), value.to_plain().expect("a plain field"));
            }
        }
    }
    real.directory.create_with_id(id.clone(), header, json!({})).await.expect("created");
    let handle = real.directory.handle(&id).expect("loaded");
    let listed = prompt.is_some();
    if let Some(prompt) = prompt {
        super::tests::turn(&handle, &prompt, "op-1").await;
    }
    // Settled: no run, and a turn's prompt row committed (the index catches up with it before a listing reads it).
    crate::eventually_on!(&[&handle.cell.stepped], || {
        (super::tests::idle(&handle) && (!listed || super::tests::rows(&handle).iter().any(|(role, _)| *role == "user"))).then_some(())
    })
    .await;
    id
}

/// What the delete seams noted since `from`, once the delete's detached steps (the search forget and the worktree
/// release, Node's `void`ed calls) have landed for each deleted id.
async fn notes(real: &Real, from: usize, deleted: &[String]) -> Vec<String> {
    let done = || {
        let notes = lock(&real.rig.deletes.0);
        deleted.iter().all(|id| notes[from..].iter().any(|n| n == &format!("releaseDeletedWorktree:{id}")) && notes[from..].iter().any(|n| n == &format!("forgetSessionSearch:{id}")))
    };
    crate::eventually_on!(&[&real.rig.deletes.1], || done().then_some(())).await;
    lock(&real.rig.deletes.0)[from..].to_vec()
}

/// The recorded calls a delete made, read off the core: the fence of the thread (`close`: Node's
/// `closeSession(id, reason, { tombstone: false, isSessionLive })`, `isSessionLive` being whether the runtime has the
/// session current, at the call and after the op), the release of its work and its delete mark.
fn delete_calls(real: &Real, id: &str, fenced: bool, notes: &[String]) -> Vec<Value> {
    let live = lock(&real.rig.deletes.3).as_deref() == Some(id);
    let mut calls = Vec::new();
    if fenced {
        calls.push(json!(["close", id, DELETE_REASON, { "tombstone": false, "isSessionLive": { "function": "isSessionLive", "resultAtCall": live, "resultAfterOp": live } }]));
    }
    for note in notes {
        if *note == format!("releaseSessionWork:{id}:{DELETE_REASON}") {
            calls.push(json!(["cancelTasks", { "reason": DELETE_REASON, "notify": false, "executionSessionId": id }]));
            calls.push(json!(["clearRoute", id]));
        } else if *note == format!("tombstoned:{id}") {
            calls.push(json!(["delete", id]));
        }
    }
    calls
}

fn noted(notes: &[String], step: &str) -> Vec<Value> {
    notes.iter().filter_map(|n| n.strip_prefix(step)).map(|id| json!(id)).collect()
}

/// `cleaned` at the field the manifest keeps: the deleted session each cleanup was asked for.
fn cleaned_ids(recorded: &Exact) -> Exact {
    Exact::Array(recorded.as_array().iter().map(|args| Exact::Array(vec![args.as_array()[0].clone()])).collect())
}

/// One delete through `thread/delete`: its answer, the calls, the cleanups and forgets it caused.
async fn delete_observed(real: &Real, id: &str) -> (bool, Vec<Value>, Vec<Value>, Vec<Value>) {
    let handle = real.directory.handle(&ThreadId::from(id));
    let from = lock(&real.rig.deletes.0).len();
    let deleted = delete(&real.directory, id).await.expect("thread/delete");
    let notes = if deleted { notes(real, from, &[id.to_owned()]).await } else { lock(&real.rig.deletes.0)[from..].to_vec() };
    let fenced = handle.is_some_and(|h| h.cell.closed.load(std::sync::atomic::Ordering::SeqCst));
    let calls = delete_calls(real, id, fenced, &notes);
    let cleaned = noted(&notes, "releaseDeletedWorktree:").into_iter().map(|id| json!([id])).collect();
    (deleted, calls, cleaned, noted(&notes, "forgetSessionSearch:"))
}

fn delete_view(deleted: bool, calls: Vec<Value>, cleaned: Vec<Value>, forgotten: Vec<Value>) -> Exact {
    exact(json!({ "deleted": deleted, "calls": calls, "cleaned": cleaned, "forgotten": forgotten }))
}

fn recorded_delete_view(deleted: &Exact, view: &Exact, calls: bool) -> Exact {
    let mut fields = vec![("deleted".to_owned(), deleted.clone())];
    if calls {
        fields.push(("calls".into(), view.get("calls").clone()));
    }
    fields.push(("cleaned".into(), cleaned_ids(view.get("cleaned"))));
    fields.push(("forgotten".into(), view.get("forgotten").clone()));
    Exact::Object(fields)
}

fn without_calls(view: Exact) -> Exact {
    let Exact::Object(fields) = view else { panic!("a view") };
    Exact::Object(fields.into_iter().filter(|(key, _)| key != "calls").collect())
}

fn without_deleted(view: Exact) -> Exact {
    let Exact::Object(fields) = view else { panic!("a view") };
    Exact::Object(fields.into_iter().filter(|(key, _)| key != "deleted").collect())
}

/// Line 116: a deleted session's worktree is handed to the cleanup once the delete is done, whether another session is
/// current (run 1) or the deleted one is the session the client has open (run 2: the core has no current session, so
/// the delete is the same `thread/delete`; that run's calls, Node's current-session sequence, are not compared).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_116_a_deleted_session_hands_its_worktree_to_the_cleanup() {
    let recording = recording();
    let case = case(&recording, 116.0);
    let mut got = Vec::new();
    let mut want = Vec::new();
    for (run, recorded) in case.get("input").get("runs").as_array().iter().zip(case.get("result").as_array()) {
        let real = real().await;
        let current = run.get("current");
        for row in run.get("rows").as_array() {
            thread(&real, row).await;
        }
        let (deleted, calls, cleaned, forgotten) = delete_observed(&real, run.get("delete").as_str()).await;
        let current_deleted = current.get("id").as_str() == run.get("delete").as_str();
        // The run's view: what the delete did, its answer beside it (as recorded).
        let view = without_deleted(delete_view(deleted, calls, cleaned, forgotten));
        got.push(exact(json!({ "label": recorded.get("label").as_str(), "deleted": deleted })).with("view", if current_deleted { without_calls(view) } else { view }));
        let recorded_view = without_deleted(recorded_delete_view(&recorded.get("deleted").clone(), recorded.get("view"), !current_deleted));
        want.push(exact(json!({ "label": recorded.get("label").as_str() })).with("deleted", recorded.get("deleted").clone()).with("view", recorded_view));
    }
    assert_eq!(Exact::Array(got), Exact::Array(want), "line 116");
}

/// Line 152: a malformed id and an id the catalog does not list are refused before anything is touched; the stored
/// session stays (`storeFiles`: the store's session `parent` is `parent.json` in Node's store dir).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_152_a_malformed_or_unlisted_id_is_refused_untouched() {
    let recording = recording();
    let case = case(&recording, 152.0);
    let real = real().await;
    let mut kept = Vec::new();
    for row in case.get("input").get("rows").as_array() {
        kept.push(thread(&real, row).await);
    }
    let from = lock(&real.rig.deletes.0).len();
    let mut results = Vec::new();
    for id in case.get("input").get("deletes").as_array() {
        results.push(json!(delete(&real.directory, id.as_str()).await.expect("thread/delete")));
    }
    let notes = lock(&real.rig.deletes.0)[from..].to_vec();
    let mut files = Vec::new();
    for id in &kept {
        if real.directory.stored_header(id).await.is_some() {
            files.push(json!(format!("{id}.json")));
        }
    }
    let got = exact(json!({ "results": results, "calls": notes, "cleaned": [], "forgotten": [], "storeFiles": files }));
    let recorded = case.get("result");
    let want = exact(json!({ "results": recorded.get("results").to_plain().expect("plain"), "calls": recorded.get("calls").to_plain().expect("plain"), "cleaned": recorded.get("cleaned").to_plain().expect("plain"), "forgotten": recorded.get("forgotten").to_plain().expect("plain"), "storeFiles": recorded.get("storeFiles").to_plain().expect("plain") }));
    assert_eq!(got, want, "line 152");
}

/// Line 159: an agent's session is listed (`thread/list` with agent sessions shown) and deleted like any other.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_159_an_agent_session_is_listed_and_deleted_directly() {
    let recording = recording();
    let case = case(&recording, 159.0);
    let real = real().await;
    for row in case.get("input").get("rows").as_array() {
        thread(&real, row).await;
    }
    let listed = list_ids(&real).await;
    let child = case.get("input").get("rows").as_array()[0].get("id").as_str().to_owned();    let (deleted, calls, cleaned, forgotten) = delete_observed(&real, &child).await;
    let recorded = case.get("result");
    let got = exact(json!({ "listed": listed })).with("view", delete_view(deleted, calls, cleaned, forgotten));
    let want_listed: Vec<Value> = recorded.get("listed").as_array().iter().map(|row| json!(row.get("id").as_str())).collect();
    let want = exact(json!({ "listed": want_listed })).with("view", recorded_delete_view(recorded.get("deleted"), recorded, true));
    assert_eq!(got, want, "line 159");
}

/// No live overlay and no rooms: the rows as the index holds them.
struct Plain;

impl super::thread_list::ListOverlay for Plain {
    fn of(&self, _: &ThreadId) -> super::thread_list::RowOverlay {
        super::thread_list::RowOverlay::default()
    }
}

#[async_trait::async_trait]
impl super::thread_list::ListRooms for Plain {
    async fn with_rooms(&self, rows: Vec<mixdog_protocol::ThreadSummary>) -> Result<Vec<mixdog_protocol::ThreadSummary>, String> {
        Ok(rows)
    }
    async fn room_threads(&self) -> Result<Vec<ThreadId>, String> {
        Ok(Vec::new())
    }
}

/// The ids of the rows `thread/list` answers over the store's index (Node's `listSessions()`: every catalogued
/// session; the runtime's current session is not a stored row there, and none is made here).
async fn list_ids(real: &Real) -> Vec<Value> {
    let list = super::thread_list::ThreadListService::new(Arc::new(real.index.clone()), Arc::new(Plain), Arc::new(Plain), Arc::new(super::testing::FixedTaskWorkspace("/tasks")));
    // As the daemon composes it: the listing waits for the index writes acknowledged before it.
    list.fence(real.threads.clone());
    let answer = mixdog_core_base::support::testing::value(&list, mixdog_core_base::support::testing::request(super::thread_list::LIST, json!({ "limit": 100 }), None)).await.expect("thread/list");
    answer["data"].as_array().expect("rows").iter().map(|row| row["id"].clone()).collect()
}

/// Line 182: deleting a session that is not current leaves the agent sessions it delegated to running.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_182_deleting_a_non_current_session_leaves_its_children() {
    let recording = recording();
    let case = case(&recording, 182.0);
    let real = real().await;
    for row in case.get("input").get("rows").as_array() {
        thread(&real, row).await;
    }
    let mut children = Vec::new();
    for id in case.get("input").get("ownedAgentSessionIds").as_array() {
        let id = id.as_str().trim();
        if super::delete::is_session_id(id) && id != case.get("input").get("delete").as_str() && !children.contains(&id.to_owned()) {
            thread(&real, &exact(json!({ "id": id, "owner": "agent", "sourceType": "agent", "agent": "worker" }))).await;
            children.push(id.to_owned());
        }
    }
    let (deleted, calls, cleaned, forgotten) = delete_observed(&real, case.get("input").get("delete").as_str()).await;
    for child in &children {
        assert!(real.directory.handle(&ThreadId::from(child.as_str())).is_some_and(|h| !h.cell.closed.load(std::sync::atomic::Ordering::SeqCst)), "{child} keeps running");
    }
    assert_eq!(delete_view(deleted, calls, cleaned, forgotten), recorded_delete_view(case.get("result").get("deleted"), case.get("result"), true), "line 182");
}

/// Line 198: deleting the session a client has open deletes only it (the core's thread/delete; the replacement
/// session is the client's next `thread/start`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_198_deleting_the_open_session_deletes_only_it() {
    let recording = recording();
    let case = case(&recording, 198.0);
    let real = real().await;
    for row in case.get("input").get("rows").as_array() {
        thread(&real, row).await;
    }
    let (deleted, calls, cleaned, forgotten) = delete_observed(&real, case.get("input").get("delete").as_str()).await;
    let fresh = super::tests::start_thread(&real.directory).await;
    assert!(fresh.id.as_str() != case.get("input").get("delete").as_str(), "a new session is a new thread");
    assert_eq!(without_calls(delete_view(deleted, calls, cleaned, forgotten)), recorded_delete_view(case.get("result").get("deleted"), case.get("result"), false), "line 198");
}

/// The context target, recording Node's two invalidations under their recorded names.
#[derive(Default)]
struct Target(std::sync::Mutex<Vec<Value>>);

impl ContextTarget for Target {
    fn invalidate(&self, _: &ThreadId) {
        lock(&self.0).extend([json!(["invalidateContext"]), json!(["invalidateTools"])]);
    }
}

pub(super) struct NoShells;

impl super::shell_jobs::OwnedShells for NoShells {
    fn cancel_owned(&self, _: &ThreadId) {}
}

pub(super) struct NoProviders;

#[async_trait::async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err(format!("no {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        false
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// `switchContext` of the thread `id` over the real directory: its answer and the calls read off the core (the close
/// of the thread left, with whether it was tombstoned, its memory ingest, the release of its work, the invalidations).
async fn switch_context(real: &Real, directory: Arc<super::SessionDirectory>, id: &ThreadId, args: &Exact) -> (bool, Vec<Value>) {
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let close = Arc::new(super::close::SessionClose::new(directory.clone(), providers, Arc::new(NoShells), Arc::new(mixdog_tools::fs::ReadState::new(None))));
    let target = Arc::new(Target::default());
    let switch = SessionContextSwitch::new(directory.clone(), close, target.clone());
    let from = lock(&real.rig.deletes.0).len();
    let ingests_from = lock(&real.rig.closes.seen).len();
    let cwd = args.try_get("cwd").map(|cwd| cwd.as_str().to_owned());
    let desktop = args.try_get("desktopSession").map(|d| d.to_plain().expect("plain")).filter(Value::is_object);
    let for_resume = args.try_get("forResume") == Some(&Exact::Bool(true));
    let answered = mixdog_core_config::workflow::thread_settings::ContextSwitch::switch_context(&switch, id.as_str(), cwd, desktop, for_resume).await.is_ok();
    crate::eventually_on!(&[&*real.rig.closes.ended], || lock(&real.rig.closes.seen).iter().any(|(seen, _)| seen == id).then_some(())).await;
    let stored = directory.stored_header(id).await.expect("the thread left is kept");
    let tombstone = stored.get("closed") == Some(&Value::Bool(true));
    let mut calls = vec![json!(["closeSurface", id.as_str(), SWITCH_REASON, { "tombstone": tombstone }])];
    // The memory ingests the close ran (the directory's `CloseIngest`), as they reached it.
    calls.extend(lock(&real.rig.closes.seen)[ingests_from..].iter().map(|(seen, _)| json!(["ingest", seen.as_str()])));
    for note in &lock(&real.rig.deletes.0)[from..] {
        if *note == format!("releaseSessionWork:{id}:{SWITCH_REASON}") {
            calls.push(json!(["cancelTasks", { "reason": SWITCH_REASON, "notify": false, "executionSessionId": id.as_str() }]));
            calls.push(json!(["clearRoute", id.as_str()]));
        }
    }
    calls.extend(lock(&target.0).iter().cloned());
    (answered, calls)
}

/// The recorded switch at what the manifest keeps: the answer and the calls that act on the thread left
/// (`clearPrep`, `cwd`, `setRoute`, `refreshEffort` retarget Node's single runtime for the next session).
fn recorded_switch(result: &Exact) -> Exact {
    let retarget = ["clearPrep", "cwd", "setRoute", "refreshEffort"];
    let calls: Vec<Exact> = result.get("calls").as_array().iter().filter(|call| !retarget.contains(&call.as_array()[0].as_str())).cloned().collect();
    Exact::Object(vec![("result".into(), result.get("result").clone()), ("calls".into(), Exact::Array(calls))])
}

/// A context switch of the case at `line`: the thread left is closed (a scratch one tombstoned, a conversation
/// detached), its memory ingested, its work released and the context invalidated.
async fn context_switch(line: f64) {
    let recording = recording();
    let case = case(&recording, line);
    let real = real().await;
    let current = case.get("input").get("current");
    let id = thread(&real, current).await;
    let (answered, calls) = switch_context(&real, real.directory.clone(), &id, case.get("input").get("args")).await;
    let got = Exact::Object(vec![("result".into(), Exact::Bool(answered)), ("calls".into(), exact(Value::Array(calls)))]);
    assert_eq!(got, recorded_switch(case.get("result")), "line {line}");
}

/// Line 213: a context switch leaves the open thread.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_213_a_context_switch_leaves_the_open_thread() {
    context_switch(213.0).await;
}

/// Line 233: a context switch for a resume leaves the open thread the same way.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_233_a_resume_switch_leaves_the_open_thread() {
    context_switch(233.0).await;
}

/// Line 244: a new session is a new thread (`thread/start`), the open conversation's memory is ingested and it is left
/// resumable (Node's `newSession` closes it with `cli-new`; the core's thread/start leaves the threads a client holds).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_244_a_new_session_is_a_new_thread() {
    let recording = recording();
    let case = case(&recording, 244.0);
    let real = real().await;
    let talked = thread(&real, case.get("input").get("current")).await;
    let fresh = super::tests::start_thread(&real.directory).await;
    let result = case.get("result");
    let fresh_id = result.get("result").as_str();
    let got = if fresh.id != talked { fresh_id } else { talked.as_str() };
    assert_eq!(text(got), result.get("result").clone(), "line 244: thread/start answers a thread that is not the one open");
}

fn text(value: &str) -> Exact {
    Exact::String(value.to_owned())
}

/// Line 255: `prefetchSession(id)` is the thread's open (it loads the session; the answer is whether it did) and
/// `sessionStoreDir()` the store's `sessions` folder under the data dir.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_255_prefetch_and_the_store_dir() {
    let recording = recording();
    let case = case(&recording, 255.0);
    let real = real().await;
    let id = case.get("input").get("prefetch").as_str();
    let made = thread(&real, &exact(json!({ "id": id }))).await;
    let opened = real.directory.open(&made, &super::address_replay::client()).await.is_ok();
    let dir = real.data.path().join("sessions");
    assert!(dir.is_dir(), "the store made its sessions folder");
    let store_dir = format!("<DATA>{}sessions", std::path::MAIN_SEPARATOR);
    let got = exact(json!({ "result": opened, "calls": [["prefetch", id]], "sessionStoreDir": store_dir }));
    let result = case.get("result");
    let want = exact(json!({ "result": result.get("result").to_plain().expect("plain"), "calls": result.get("calls").to_plain().expect("plain"), "sessionStoreDir": result.get("sessionStoreDir").to_plain().expect("plain") }));
    assert_eq!(got, want, "line 255");
}

trait With {
    fn with(self, key: &str, value: Exact) -> Exact;
}

impl With for Exact {
    fn with(self, key: &str, value: Exact) -> Exact {
        let Exact::Object(mut fields) = self else { panic!("an object") };
        fields.push((key.to_owned(), value));
        Exact::Object(fields)
    }
}

