//! Sub-agent retention: membership and trees equal Node's byte for byte
//! (`golden/sub_agent_retention.json`, recorded by `record-sub-agent-retention.mjs`); the pass
//! and its timer run over a scripted host.
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_rt::CancellationToken;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use super::sub_agent_retention::*;

const GOLDEN: &str = include_str!("golden/sub_agent_retention.json");
const DAY: f64 = 86_400_000.0;

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

#[test]
fn members_equal_nodes() {
    for case in golden()["members"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let header: Header = case["doc"].as_object().unwrap().clone();
        match (member(id, &header), &case["member"]) {
            (None, want) => assert!(want.is_null(), "{id}"),
            (Some(got), want) => {
                assert_eq!(got.id, want["id"].as_str().unwrap(), "{id}");
                assert_eq!(Some(got.last_active), want["lastActive"].as_f64(), "{id}");
                assert_eq!(json!(got.parent_ids), want["parentIds"], "{id}");
            }
        }
    }
}

fn plain(id: &str, parents: &[&str], last_active: f64) -> Member {
    Member { id: id.into(), parent_ids: parents.iter().map(|p| (*p).to_owned()).collect(), last_active, archived: false }
}

#[test]
fn trees_equal_nodes() {
    for case in golden()["trees"].as_array().unwrap() {
        let members: Vec<Member> = case["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let parents: Vec<&str> = m["parentIds"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
                plain(m["id"].as_str().unwrap(), &parents, m["lastActive"].as_f64().unwrap())
            })
            .collect();
        let got: Vec<Vec<&str>> = trees(&members).iter().map(|t| t.iter().map(|&at| members[at].id.as_str()).collect()).collect();
        let want: Vec<Vec<&str>> =
            case["trees"].as_array().unwrap().iter().map(|t| t.as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect()).collect();
        assert_eq!(got, want, "{}", case["input"]);
    }
}

/// Stored activity per session (`None`: unreadable), the open ones, and what the pass did.
#[derive(Default)]
struct Host {
    stored: Mutex<HashMap<String, f64>>,
    live: Mutex<HashSet<String>>,
    archived: Mutex<Vec<String>>,
    deleted: Mutex<Vec<String>>,
    fail_delete: Mutex<HashSet<String>>,
    ids: Mutex<Vec<String>>,
    on_delete: Mutex<Option<DeleteHook>>,
}

type DeleteHook = Box<dyn Fn(&str) + Send>;

impl Host {
    fn with(activity: &[(&str, f64)]) -> Arc<Self> {
        let host = Arc::new(Self::default());
        for (id, at) in activity {
            host.stored.lock().unwrap().insert((*id).to_owned(), *at);
            host.ids.lock().unwrap().push((*id).to_owned());
        }
        host
    }
}

#[async_trait]
impl RetentionHost for Host {
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
        Ok(self.ids.lock().unwrap().clone())
    }

    async fn stored_header(&self, id: &str) -> Option<Header> {
        let at = *self.stored.lock().unwrap().get(id)?;
        let mut header = Header::new();
        header.insert("owner".into(), json!("agent"));
        header.insert("ownerSessionId".into(), json!("sess_lead"));
        header.insert("lastUsedAt".into(), json!(at));
        Some(header)
    }

    fn is_live(&self, id: &str) -> bool {
        self.live.lock().unwrap().contains(id)
    }

    async fn archive(&self, id: &str) -> Result<(), CoreError> {
        self.archived.lock().unwrap().push(id.to_owned());
        Ok(())
    }

    async fn delete(&self, id: &str, _activity: f64, _peers: &[(String, f64)], _cancel: &CancellationToken) -> Result<bool, CoreError> {
        if self.fail_delete.lock().unwrap().contains(id) {
            return Err(CoreError::Internal { incident_id: "boom".to_owned().into() });
        }
        if let Some(hook) = self.on_delete.lock().unwrap().as_ref() {
            hook(id);
        }
        self.stored.lock().unwrap().remove(id);
        self.deleted.lock().unwrap().push(id.to_owned());
        Ok(true)
    }
}

const NOW: f64 = 100.0 * DAY;

/// A tree idle under 3 days stays; 3 days archives each member once (never an archived one);
/// 30 days deletes the whole tree, children first.
#[tokio::test]
async fn a_tree_is_archived_after_three_days_and_deleted_after_thirty() {
    let host = Host::with(&[("sess_a", NOW - 2.0 * DAY), ("sess_b", NOW - 2.0 * DAY)]);
    let live = CancellationToken::new();
    assert_eq!(sweep(host.as_ref(), NOW, &live).await.unwrap(), Applied::default());
    assert_eq!(sweep(host.as_ref(), NOW + 1.0 * DAY, &live).await.unwrap().archived, ["sess_a", "sess_b"]);
    let after_thirty = sweep(host.as_ref(), NOW - 2.0 * DAY + 30.0 * DAY, &live).await.unwrap();
    assert_eq!(after_thirty.deleted, ["sess_a", "sess_b"]);
    assert!(after_thirty.archived.is_empty());
}

/// One member active recently keeps the tree; so does an open session, and a member whose
/// stored activity moved after the pass read it.
#[tokio::test]
async fn a_tree_with_a_recent_open_or_moved_member_stays() {
    let host = Host::with(&[("sess_old", NOW - 40.0 * DAY), ("sess_new", NOW - DAY)]);
    // Both hang off `sess_lead`, which is no member: two trees; only the old one is judged.
    let live = CancellationToken::new();
    assert_eq!(sweep(host.as_ref(), NOW, &live).await.unwrap().deleted, ["sess_old"]);

    let host = Host::with(&[("sess_old", NOW - 40.0 * DAY)]);
    host.live.lock().unwrap().insert("sess_old".into());
    assert_eq!(sweep(host.as_ref(), NOW, &live).await.unwrap(), Applied::default());

    let host = Host::with(&[("sess_old", NOW - 40.0 * DAY)]);
    let members = members_of(host.as_ref()).await.unwrap();
    host.stored.lock().unwrap().insert("sess_old".into(), NOW);
    assert_eq!(apply(host.as_ref(), &members, NOW, &live).await, Applied::default());
}

/// A failed delete keeps its session and the pass goes on; a delete that moves the next member
/// (re-asked right before its unlink) leaves that one.
#[tokio::test]
async fn a_failed_delete_keeps_its_session_and_a_moved_member_is_not_deleted() {
    let host = Host::with(&[("sess_x", NOW - 40.0 * DAY), ("sess_y", NOW - 40.0 * DAY)]);
    host.fail_delete.lock().unwrap().insert("sess_y".into());
    assert_eq!(sweep(host.as_ref(), NOW, &CancellationToken::new()).await.unwrap().deleted, ["sess_x"]);

    // The two form one tree (`sess_q` owned by `sess_p`); deleting the child first wakes the parent.
    let host = Arc::new(Host::default());
    for id in ["sess_p", "sess_q"] {
        host.ids.lock().unwrap().push(id.into());
        host.stored.lock().unwrap().insert(id.into(), NOW - 40.0 * DAY);
    }
    let again = host.clone();
    *host.on_delete.lock().unwrap() = Some(Box::new(move |_| {
        again.stored.lock().unwrap().insert("sess_p".into(), NOW);
    }));
    struct Linked(Arc<Host>);
    #[async_trait]
    impl RetentionHost for Linked {
        async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
            self.0.agent_only_ids().await
        }
        async fn stored_header(&self, id: &str) -> Option<Header> {
            let mut header = self.0.stored_header(id).await?;
            if id == "sess_q" {
                header.insert("ownerSessionId".into(), json!("sess_p"));
            }
            Some(header)
        }
        fn is_live(&self, id: &str) -> bool {
            self.0.is_live(id)
        }
        async fn archive(&self, id: &str) -> Result<(), CoreError> {
            self.0.archive(id).await
        }
        async fn delete(&self, id: &str, activity: f64, peers: &[(String, f64)], cancel: &CancellationToken) -> Result<bool, CoreError> {
            self.0.delete(id, activity, peers, cancel).await
        }
    }
    let applied = sweep(&Linked(host.clone()), NOW, &CancellationToken::new()).await.unwrap();
    assert_eq!(applied.deleted, ["sess_q"], "the child went; the parent moved meanwhile and stayed");
}

/// The timer runs a pass every interval from the start, reports a failure and goes on, and
/// ends with its token.
#[tokio::test(start_paused = true)]
async fn the_timer_sweeps_every_interval_until_cancelled() {
    mixdog_rt::testing::tokens();
    struct Failing(Mutex<u32>);
    #[async_trait]
    impl RetentionHost for Failing {
        async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
            *self.0.lock().unwrap() += 1;
            Err(CoreError::Internal { incident_id: "index".to_owned().into() })
        }
        async fn stored_header(&self, _: &str) -> Option<Header> {
            None
        }
        fn is_live(&self, _: &str) -> bool {
            false
        }
        async fn archive(&self, _: &str) -> Result<(), CoreError> {
            Ok(())
        }
        async fn delete(&self, _: &str, _: f64, _: &[(String, f64)], _: &CancellationToken) -> Result<bool, CoreError> {
            Ok(false)
        }
    }
    let host = Arc::new(Failing(Mutex::new(0)));
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = errors.clone();
    let cancel = CancellationToken::new();
    let ended = start(host.clone(), Arc::new(move |line| sink.lock().unwrap().push(line.to_owned())), cancel.clone());
    tokio::time::sleep(SWEEP_INTERVAL - Duration::from_secs(1)).await;
    assert_eq!(*host.0.lock().unwrap(), 0, "the first pass is an interval after the start");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(*host.0.lock().unwrap(), 1);
    tokio::time::sleep(SWEEP_INTERVAL).await;
    assert_eq!(*host.0.lock().unwrap(), 2);
    assert_eq!(errors.lock().unwrap().len(), 2);
    assert!(errors.lock().unwrap()[0].starts_with("sub-agent retention error: "));
    cancel.cancel();
    ended.await.expect("the timer task ends with its token");
    tokio::time::sleep(SWEEP_INTERVAL * 2).await;
    assert_eq!(*host.0.lock().unwrap(), 2);
}

/// The stored sessions of one recorded Node scenario, as the pass sees them.
#[derive(Default)]
struct Scripted {
    headers: Mutex<HashMap<String, Option<Header>>>,
    order: Vec<String>,
    live: HashSet<String>,
    open_after_deleted: Option<(String, String)>,
    archive_fails: HashSet<String>,
    archived: Mutex<Vec<String>>,
    deleted: Mutex<Vec<String>>,
    /// The sessions carrying an archive mark in the store: seeded, set by an archive, gone with
    /// the session.
    marks: Mutex<HashSet<String>>,
}

#[async_trait]
impl RetentionHost for Scripted {
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
        Ok(self.order.clone())
    }

    async fn stored_header(&self, id: &str) -> Option<Header> {
        self.headers.lock().unwrap().get(id).cloned().flatten()
    }

    fn is_live(&self, id: &str) -> bool {
        self.live.contains(id)
            || self.open_after_deleted.as_ref().is_some_and(|(opened, after)| opened == id && self.deleted.lock().unwrap().contains(after))
    }

    async fn archive(&self, id: &str) -> Result<(), CoreError> {
        if self.archive_fails.contains(id) {
            return Err(CoreError::Internal { incident_id: "refused".to_owned().into() });
        }
        self.archived.lock().unwrap().push(id.to_owned());
        self.marks.lock().unwrap().insert(id.to_owned());
        Ok(())
    }

    async fn delete(&self, id: &str, _activity: f64, _peers: &[(String, f64)], _cancel: &CancellationToken) -> Result<bool, CoreError> {
        self.headers.lock().unwrap().remove(id);
        self.marks.lock().unwrap().remove(id);
        self.deleted.lock().unwrap().push(id.to_owned());
        Ok(true)
    }
}

fn sess(suffix: &str) -> String {
    if suffix == "sess_lead" { suffix.to_owned() } else { format!("sess_ret_{suffix}") }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect()
}

/// `applySubAgentRetention` over sessions stored by Node (`outcomes`, recorded against the real
/// store and `deleteSession`): the members it reads, the ids it archives and deletes in order,
/// and what stays stored, for every threshold, open or moved member and unreadable record.
#[tokio::test]
async fn outcomes_equal_nodes_applied_retention() {
    for case in golden()["outcomes"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let archived_marks = strings(&case["archived"]);
        let mut scripted = Scripted::default();
        for entry in case["sessions"].as_array().unwrap() {
            let suffix = entry["id"].as_str().unwrap();
            let mut header: Header = entry["fields"].as_object().unwrap().clone();
            let owner = header.get("ownerSessionId").and_then(Value::as_str).map_or_else(|| "sess_lead".to_owned(), sess);
            header.insert("ownerSessionId".into(), json!(owner));
            header.insert("owner".into(), json!("agent"));
            header.insert("agent".into(), json!("worker"));
            if archived_marks.iter().any(|a| a == suffix) {
                header.insert("archivedAt".into(), json!(1));
                scripted.marks.get_mut().unwrap().insert(sess(suffix));
            }
            scripted.headers.get_mut().unwrap().insert(sess(suffix), Some(header));
            scripted.order.push(sess(suffix));
        }
        scripted.live = strings(&case["live"]).iter().map(|s| sess(s)).collect();
        scripted.archive_fails = strings(&case["archiveFails"]).iter().map(|s| sess(s)).collect();
        if let Some(pair) = case["openAfterDeleted"].as_array() {
            scripted.open_after_deleted = Some((sess(pair[0].as_str().unwrap()), sess(pair[1].as_str().unwrap())));
        }

        let members = members_of(&scripted).await.unwrap();
        let read: Vec<(String, Vec<String>, f64)> = members
            .iter()
            .map(|m| (m.id.clone(), m.parent_ids.clone(), m.last_active))
            .collect();
        let want: Vec<(String, Vec<String>, f64)> = case["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let parents = strings(&m["parentIds"]).iter().map(|p| sess(p)).collect();
                (sess(m["id"].as_str().unwrap()), parents, m["lastActive"].as_f64().unwrap())
            })
            .collect();
        assert_eq!(read, want, "{name}: members");

        // After the read: a session moves on, or can no longer be read.
        for (suffix, at) in case["move"].as_object().unwrap() {
            let mut headers = scripted.headers.lock().unwrap();
            headers.get_mut(&sess(suffix)).unwrap().as_mut().unwrap().insert("lastUsedAt".into(), at.clone());
        }
        for suffix in strings(&case["unreadable"]) {
            scripted.headers.lock().unwrap().insert(sess(&suffix), None);
        }
        let applied = apply(&scripted, &members, case["now"].as_f64().unwrap(), &CancellationToken::new()).await;
        let short = |ids: &[String]| ids.iter().map(|id| id.trim_start_matches("sess_ret_").to_owned()).collect::<Vec<_>>();
        assert_eq!(short(&applied.archived), strings(&case["archivedIds"]), "{name}: archived");
        assert_eq!(short(&applied.deleted), strings(&case["deletedIds"]), "{name}: deleted");
        // What is stored after the run, read from the store itself.
        let stored = scripted.headers.lock().unwrap();
        let initial: Vec<String> = case["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_owned()).collect();
        let remaining: Vec<String> = initial.iter().filter(|suffix| stored.contains_key(&sess(suffix))).cloned().collect();
        assert_eq!(remaining, strings(&case["remaining"]), "{name}: remaining");
        // A deleted session that was archived loses its mark with the session.
        let marks = scripted.marks.lock().unwrap();
        let forgotten: Vec<String> = archived_marks.iter().filter(|s| !stored.contains_key(&sess(s))).cloned().collect();
        assert_eq!(forgotten, strings(&case["forgotten"]), "{name}: forgotten");
        assert!(forgotten.iter().all(|s| !marks.contains(&sess(s))), "{name}: a forgotten session keeps no mark");
        // The marks left are the seeded and newly archived ones that still exist.
        let mut kept: Vec<String> = remaining.iter().filter(|s| marks.contains(&sess(s))).cloned().collect();
        let mut want: Vec<String> = archived_marks.iter().chain(strings(&case["archivedIds"]).iter()).filter(|s| remaining.contains(s)).cloned().collect();
        kept.sort();
        want.sort();
        want.dedup();
        assert_eq!(kept, want, "{name}: archive marks left in the store");
    }
}

/// Once the sweep's token fires, nothing new is admitted: not the next tree, not the next
/// member of a tree already begun, not an archive.
#[tokio::test]
async fn after_shutdown_no_further_archive_or_delete_is_admitted() {
    // Two trees idle 40 days; the first delete fires the token.
    let host = Host::with(&[("sess_a", NOW - 40.0 * DAY), ("sess_b", NOW - 40.0 * DAY)]);
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    *host.on_delete.lock().unwrap() = Some(Box::new(move |_| token.cancel()));
    let applied = sweep(host.as_ref(), NOW, &cancel).await.unwrap();
    assert_eq!(applied.deleted.len(), 1, "the delete already admitted finished, the next was not admitted");
    assert_eq!(host.stored.lock().unwrap().len(), 1);

    // Idle 4 days: already shut down, so nothing is archived.
    let host = Host::with(&[("sess_c", NOW - 4.0 * DAY)]);
    let down = CancellationToken::new();
    down.cancel();
    assert_eq!(sweep(host.as_ref(), NOW, &down).await.unwrap(), Applied::default());
    assert!(host.archived.lock().unwrap().is_empty());
}

/// A pass under way when the token fires is awaited by the returned task: it ends only after
/// the admitted delete is done, and admits no more.
#[tokio::test(start_paused = true)]
async fn the_timer_task_ends_after_the_admitted_operation() {
    mixdog_rt::testing::tokens();
    struct Slow {
        inner: Arc<Host>,
        entered: Arc<tokio::sync::Notify>,
        finished: Mutex<u32>,
    }
    #[async_trait]
    impl RetentionHost for Slow {
        async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
            self.inner.agent_only_ids().await
        }
        async fn stored_header(&self, id: &str) -> Option<Header> {
            self.inner.stored_header(id).await
        }
        fn is_live(&self, id: &str) -> bool {
            self.inner.is_live(id)
        }
        async fn archive(&self, id: &str) -> Result<(), CoreError> {
            self.inner.archive(id).await
        }
        async fn delete(&self, id: &str, activity: f64, peers: &[(String, f64)], cancel: &CancellationToken) -> Result<bool, CoreError> {
            self.entered.notify_one();
            tokio::time::sleep(Duration::from_secs(10)).await;
            *self.finished.lock().unwrap() += 1;
            self.inner.delete(id, activity, peers, cancel).await
        }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
    let inner = Host::with(&[("sess_a", now - 40.0 * DAY), ("sess_b", now - 40.0 * DAY)]);
    let entered = Arc::new(tokio::sync::Notify::new());
    let host = Arc::new(Slow { inner: inner.clone(), entered: entered.clone(), finished: Mutex::new(0) });
    let cancel = CancellationToken::new();
    let ended = start(host.clone(), Arc::new(|_| {}), cancel.clone());
    tokio::time::sleep(SWEEP_INTERVAL + Duration::from_secs(1)).await;
    entered.notified().await;
    cancel.cancel();
    ended.await.expect("ended");
    assert_eq!(*host.finished.lock().unwrap(), 1, "the admitted delete was awaited");
    assert_eq!(inner.deleted.lock().unwrap().len(), 1, "no second delete after the token fired");
}
