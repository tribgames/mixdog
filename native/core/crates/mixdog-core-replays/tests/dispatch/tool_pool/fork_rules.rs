//! `session action=fork`: the Lead's session copied into a new one. The real `SessionTool` over the real port and the real
//! session directory, its compaction and measuring seams the session rig's.

use mixdog_core::run_host::tool_pool::session_bots::LateBotSources;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_tools::orch::session::SessionTool;

use super::replay::Fixture;
use super::*;

const SOURCE: &str = "sess_lead1";

const PLAN: [(&str, &str); 2] = [("user", "Plan the migration."), ("assistant", "Here is the plan.")];

struct Forking {
    tool: SessionTool,
    directory: Arc<SessionDirectory>,
    rig: Rig,
}

/// A Lead session `SOURCE` holding `conversation`, with `budget` tokens for a heir's compacted carry.
async fn forking(conversation: &[(&str, &str)]) -> Forking {
    let rig = Rig::new();
    // The catalog lists the sessions (a delete removes only a listed one).
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let header = json!({ "cwd": "/ws", "provider": "fork-model", "model": "fake-model", "title": "Source title", "sourceType": "lead" });
    directory.create_with_id(ThreadId::from(SOURCE), header.as_object().cloned().expect("header"), json!({})).await.expect("create the source");
    if !conversation.is_empty() {
        let rows: Vec<Value> = conversation.iter().map(|(role, content)| json!({ "role": role, "content": content })).collect();
        ThreadRequests::request(&*directory, &ThreadId::from(SOURCE), "thread/inheritedRows/append", json!({ "messages": rows }))
            .await
            .expect("the conversation");
    }
    *rig.inherit.budget.lock().expect("budget") = Some(100_000);
    let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
    let callers = || Arc::new(ThreadCallers::new(threads.clone(), HeartbeatSessions::new(), UnattendedRunRegistry::new(Arc::new(NoStamps))));
    let port = DirectorySessionPort::new(SessionPortParts {
        callers: callers(),
        threads: threads.clone(),
        requests: directory.clone(),
        titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(threads.clone(), Arc::new(Messages), Arc::new(Now))),
        ai_titles: Arc::new(Titles(true)),
        projects: Arc::new(NoProjects),
        bots: Arc::new(Bots(Vec::new())),
        suggestions: Arc::new(Suggested::default()),
        catalog: Arc::new(NoCatalog),
        world: Arc::new(NoBotWorld),
        quota: Rig::new().quota.clone(),
        clock: Arc::new(Now),
        listing: Arc::new(Fixture::default()),
        send: Arc::default(),
        bot_sources: Arc::new(LateBotSources::default()),
        io: mixdog_rt::testing::tokens().interactive_io,
    });
    Forking { tool: SessionTool::new(Arc::new(port), callers()), directory, rig }
}

impl Forking {
    async fn fork(&self, caller: &str, surface: SurfaceKind, args: Value) -> (bool, String) {
        let ctx = ToolContext { thread_id: ThreadId::from(caller), tool: "session".into(), surface, ..ctx() };
        match self.tool.call(&ctx, args).await {
            Ok(out) => match &out.parts[..] {
                [ToolPart::Text(text)] => (true, text.clone()),
                other => panic!("{other:?}"),
            },
            Err(error) => (false, error.message_for_model),
        }
    }

    async fn lead_fork(&self, args: Value) -> (bool, String) {
        self.fork(SOURCE, SurfaceKind::Lead, args).await
    }

    /// What the heir `minted` holds besides system rows.
    async fn held(&self, minted: &str) -> Vec<(String, String)> {
        let rows = ThreadRequests::request(&*self.directory, &ThreadId::from(minted), "thread/messages/read", json!({ "threadId": minted }))
            .await
            .expect("the heir's rows");
        rows["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .filter(|m| m["role"] != "system")
            .map(|m| (m["role"].as_str().expect("role").to_owned(), m["content"].as_str().expect("content").to_owned()))
            .collect()
    }
}

fn minted(text: &str) -> (Value, String) {
    let answer: Value = serde_json::from_str(text).unwrap_or_else(|_| panic!("{text}"));
    let id = answer["sessionId"].as_str().expect("the heir's id").to_owned();
    (answer, id)
}

fn plan() -> Vec<(String, String)> {
    PLAN.iter().map(|(role, content)| ((*role).to_owned(), (*content).to_owned())).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_is_a_new_session_that_holds_the_sources_conversation() {
    let world = forking(&PLAN).await;
    let (ok, text) = world.lead_fork(json!({ "action": "fork" })).await;
    assert!(ok, "{text}");
    let (answer, heir) = minted(&text);
    assert_ne!(heir, SOURCE, "the heir is a new session");
    assert_eq!(answer, json!({ "action": "fork", "sourceSessionId": SOURCE, "sessionId": heir, "compacted": false }));
    assert_eq!(world.held(&heir).await, plan());
    assert_eq!(world.held(SOURCE).await, plan(), "the source keeps its own");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_asked_to_compact_carries_the_compacted_rows_instead() {
    let world = forking(&PLAN).await;
    *world.rig.compaction.heir_rows.lock().expect("rows") = Some(vec![json!({ "role": "user", "content": "Summarized for the heir." })]);
    let (ok, text) = world.lead_fork(json!({ "action": "fork", "compact": true })).await;
    assert!(ok, "{text}");
    let (answer, heir) = minted(&text);
    assert_eq!(answer["compacted"], true);
    assert_eq!(world.held(&heir).await, vec![("user".to_owned(), "Summarized for the heir.".to_owned())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_a_compact_of_true_compacts() {
    let world = forking(&PLAN).await;
    *world.rig.compaction.heir_rows.lock().expect("rows") = Some(vec![json!({ "role": "user", "content": "Summarized for the heir." })]);
    let (ok, text) = world.lead_fork(json!({ "action": "fork", "compact": "yes" })).await;
    assert!(ok, "{text}");
    let (answer, heir) = minted(&text);
    assert_eq!(answer["compacted"], false);
    assert_eq!(world.held(&heir).await, plan());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_whose_compaction_fails_or_comes_back_empty_is_refused_and_leaves_no_session() {
    for fails in [true, false] {
        let world = forking(&PLAN).await;
        if fails {
            world.rig.compaction.heir_fails.store(true, std::sync::atomic::Ordering::SeqCst);
        } else {
            *world.rig.compaction.heir_rows.lock().expect("rows") = Some(Vec::new());
        }
        let refused = world.lead_fork(json!({ "action": "fork", "compact": true })).await;
        assert_eq!(refused, (false, "inheritFrom: the conversation could not be compacted for the new session".to_owned()), "fails: {fails}");
        assert_eq!(world.directory.loaded_ids(), [ThreadId::from(SOURCE)], "a refused fork leaves only the source");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_with_no_conversation_has_nothing_to_fork() {
    let world = forking(&[]).await;
    assert_eq!(
        world.lead_fork(json!({ "action": "fork", "compact": true })).await,
        (false, "inheritFrom: the source session has no conversation to carry".to_owned())
    );
    assert_eq!(world.directory.loaded_ids(), [ThreadId::from(SOURCE)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_belongs_to_the_lead_session_and_a_worker_may_not_make_one() {
    let world = forking(&PLAN).await;
    assert_eq!(
        world.fork("sess_worker1", SurfaceKind::Agent, json!({ "action": "fork" })).await,
        (false, "session: fork belongs to the Lead session".to_owned())
    );
    assert_eq!(world.directory.loaded_ids(), [ThreadId::from(SOURCE)]);
}
/// `thread/inheritancePreflight` for the source: the verdict its carry would reach on the heir's route policy.
async fn preflight(world: &Forking) -> Value {
    // The preflight is answered by the directory, which looks the source up itself; no session actor serves it.
    use mixdog_core_api::call::{CallContext, CoreRequest};
    let request = CoreRequest {
        method: mixdog_core_api::ids::Method("thread/inheritancePreflight"),
        params: json!({ "threadId": SOURCE }),
        op: None,
        ctx: CallContext::internal("replay"),
    };
    match mixdog_core_api::ThreadDirectory::request(&*world.directory, request).await.expect("preflight") {
        mixdog_core_api::Reply::Value(value) => value,
        mixdog_core_api::Reply::Subscribe(_) => panic!("a value reply"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_preflight_says_a_conversation_under_the_heirs_limit_fits_and_how_much_of_it_is_used() {
    let world = forking(&PLAN).await;
    *world.rig.inherit.basis.lock().expect("basis") = Some((200, 50, true));
    let verdict = preflight(&world).await;
    assert_eq!(verdict["sourceSessionId"], SOURCE);
    assert_eq!(
        (&verdict["known"], &verdict["fits"], &verdict["used"], &verdict["limit"], &verdict["percent"]),
        (&json!(true), &json!(true), &json!(50), &json!(200), &json!(25))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_preflight_says_a_conversation_over_the_heirs_limit_does_not_fit_and_the_fork_that_asks_to_compact_carries_it_anyway() {
    let world = forking(&PLAN).await;
    *world.rig.inherit.basis.lock().expect("basis") = Some((200, 300, true));
    *world.rig.compaction.heir_rows.lock().expect("rows") = Some(vec![json!({ "role": "user", "content": "Summarized for the heir." })]);
    let verdict = preflight(&world).await;
    assert_eq!((&verdict["fits"], &verdict["percent"]), (&json!(false), &json!(150)));
    // The carry is measured again on the compacted rows, and one that still did not fit is refused (`inheritance.rs`, the
    // `fit_message` refusal): the compacted conversation is the small one.
    *world.rig.inherit.basis.lock().expect("basis") = Some((200, 50, true));
    let (ok, text) = world.lead_fork(json!({ "action": "fork", "compact": true })).await;
    assert!(ok, "{text}");
    assert_eq!(minted(&text).0["compacted"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_route_that_cannot_be_measured_gets_a_permissive_verdict() {
    let world = forking(&PLAN).await;
    *world.rig.inherit.basis.lock().expect("basis") = None;
    let verdict = preflight(&world).await;
    assert_eq!((&verdict["known"], &verdict["fits"], &verdict["limit"], &verdict["percent"]), (&json!(false), &json!(true), &json!(0), &Value::Null));
}
