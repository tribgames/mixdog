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

    async fn delete(&self, id: &str) -> Result<bool, CoreError> {
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
    assert_eq!(sweep(host.as_ref(), NOW).await.unwrap(), Applied::default());
    assert_eq!(sweep(host.as_ref(), NOW + 1.0 * DAY).await.unwrap().archived, ["sess_a", "sess_b"]);
    let after_thirty = sweep(host.as_ref(), NOW - 2.0 * DAY + 30.0 * DAY).await.unwrap();
    assert_eq!(after_thirty.deleted, ["sess_a", "sess_b"]);
    assert!(after_thirty.archived.is_empty());
}

/// One member active recently keeps the tree; so does an open session, and a member whose
/// stored activity moved after the pass read it.
#[tokio::test]
async fn a_tree_with_a_recent_open_or_moved_member_stays() {
    let host = Host::with(&[("sess_old", NOW - 40.0 * DAY), ("sess_new", NOW - DAY)]);
    // Both hang off `sess_lead`, which is no member: two trees; only the old one is judged.
    assert_eq!(sweep(host.as_ref(), NOW).await.unwrap().deleted, ["sess_old"]);

    let host = Host::with(&[("sess_old", NOW - 40.0 * DAY)]);
    host.live.lock().unwrap().insert("sess_old".into());
    assert_eq!(sweep(host.as_ref(), NOW).await.unwrap(), Applied::default());

    let host = Host::with(&[("sess_old", NOW - 40.0 * DAY)]);
    let members = members_of(host.as_ref()).await.unwrap();
    host.stored.lock().unwrap().insert("sess_old".into(), NOW);
    assert_eq!(apply(host.as_ref(), &members, NOW).await, Applied::default());
}

/// A failed delete keeps its session and the pass goes on; a delete that moves the next member
/// (re-asked right before its unlink) leaves that one.
#[tokio::test]
async fn a_failed_delete_keeps_its_session_and_a_moved_member_is_not_deleted() {
    let host = Host::with(&[("sess_x", NOW - 40.0 * DAY), ("sess_y", NOW - 40.0 * DAY)]);
    host.fail_delete.lock().unwrap().insert("sess_y".into());
    assert_eq!(sweep(host.as_ref(), NOW).await.unwrap().deleted, ["sess_x"]);

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
        async fn delete(&self, id: &str) -> Result<bool, CoreError> {
            self.0.delete(id).await
        }
    }
    let applied = sweep(&Linked(host.clone()), NOW).await.unwrap();
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
        async fn delete(&self, _: &str) -> Result<bool, CoreError> {
            Ok(false)
        }
    }
    let host = Arc::new(Failing(Mutex::new(0)));
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = errors.clone();
    let cancel = CancellationToken::new();
    start(host.clone(), Arc::new(move |line| sink.lock().unwrap().push(line.to_owned())), cancel.clone());
    tokio::time::sleep(SWEEP_INTERVAL - Duration::from_secs(1)).await;
    assert_eq!(*host.0.lock().unwrap(), 0, "the first pass is an interval after the start");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(*host.0.lock().unwrap(), 1);
    tokio::time::sleep(SWEEP_INTERVAL).await;
    assert_eq!(*host.0.lock().unwrap(), 2);
    assert_eq!(errors.lock().unwrap().len(), 2);
    assert!(errors.lock().unwrap()[0].starts_with("sub-agent retention error: "));
    cancel.cancel();
    tokio::time::sleep(SWEEP_INTERVAL * 2).await;
    assert_eq!(*host.0.lock().unwrap(), 2);
}
