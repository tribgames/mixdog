//! P §14.10 with a scripted owner over `state/core.sqlite`.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ops::OpIndex;
use mixdog_core_api::ops::OpScope;
use mixdog_core_api::ops::OpStatus;
use mixdog_rt::testing::tokens;
use mixdog_store::state::CoreState;
use mixdog_store::state::OpRow;
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::oneshot;

use super::*;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const NOW_MS: u64 = 1_793_306_570_000;

fn op_id(ms: u64, n: u64) -> OpId {
    OpId::from(format!(
        "{:08x}-{:04x}-7000-8000-{n:012x}",
        ms >> 16,
        ms & 0xffff
    ))
}

fn ctx() -> CallContext {
    CallContext::internal("test")
}

fn scope(name: &str) -> OpScope {
    OpScope::Domain(name.into())
}

/// A `state/core.sqlite` in its own directory.
struct Db {
    dir: tempfile::TempDir,
    state: CoreState,
}

impl Db {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = Self::open(&dir);
        Self { dir, state }
    }

    fn open(dir: &tempfile::TempDir) -> CoreState {
        let t = tokens();
        let path = dir.path().join("core.sqlite");
        CoreState::open(t.sqlite_writer_thread, t.interactive_io, &path)
            .unwrap()
            .0
    }

    /// A new process on the same file: boot recovery runs again.
    fn restart(self) -> Self {
        drop(self.state);
        let state = Self::open(&self.dir);
        Self {
            dir: self.dir,
            state,
        }
    }

    fn store(&self, name: &str) -> Arc<StateOpStore> {
        Arc::new(StateOpStore::new(self.state.clone(), name.into()))
    }

    /// Records `n` applied ops of `name` in one transaction, the k-th at `from_ms + k`.
    async fn seed(&self, name: &str, from_ms: u64, n: u64) -> Vec<OpId> {
        let ids: Vec<OpId> = (0..n).map(|k| op_id(from_ms + k, k)).collect();
        let rows: Vec<(OpId, OpRow)> = ids
            .iter()
            .map(|id| {
                let req = rename(id, "x");
                let record = OpRecord::Settled {
                    method: req.method.clone(),
                    digest: req.digest.clone(),
                    state: OpState::Applied {
                        seq: None,
                        result: None,
                    },
                };
                (id.clone(), op_row(id, &record, NOW_MS as i64).unwrap())
            })
            .collect();
        let scope = name.to_owned();
        self.state
            .write(move |tx| {
                rows.iter()
                    .try_for_each(|(id, row)| tx.put_op(&scope, id.as_str(), row))
            })
            .await
            .unwrap();
        ids
    }

    async fn count(&self, name: &str, n: usize) -> bool {
        self.state.nth_newest_ms(name, n).await.unwrap().is_some()
    }
}

/// The scope's owner: one effect per execution, recorded with its op in one transaction of
/// `state/core.sqlite`.
struct Owner {
    gate: OpGate,
    db: Db,
    store: Arc<StateOpStore>,
    effects: AtomicUsize,
}

impl Owner {
    async fn new(name: &str) -> Arc<Self> {
        Self::on(Db::new(), name).await
    }

    async fn on(db: Db, name: &str) -> Arc<Self> {
        let store = db.store(name);
        Arc::new(Self {
            gate: OpGate::domain(scope(name), store.clone()).await.unwrap(),
            db,
            store,
            effects: AtomicUsize::new(0),
        })
    }

    /// `started` fires once executing; the effect waits for `release`.
    async fn mutate(
        &self,
        req: &OpRequest,
        hold: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
    ) -> Result<AppliedOp, CoreError> {
        match self.gate.begin(req, &ctx()).await? {
            Begin::Done(outcome) => outcome.into_result(&req.id),
            Begin::Execute(ticket) => {
                if let Some((started, release)) = hold {
                    started.send(()).unwrap();
                    release.await.unwrap();
                }
                let n = self.effects.fetch_add(1, Ordering::SeqCst) + 1;
                let applied = AppliedOp {
                    seq: Some(n as u64),
                    result: Some(json!({ "n": n })),
                };
                let record = OpRecord::Settled {
                    method: req.method.clone(),
                    digest: req.digest.clone(),
                    state: OpState::Applied {
                        seq: applied.seq,
                        result: applied.result.clone(),
                    },
                };
                let row = op_row(&req.id, &record, NOW_MS as i64)?;
                let (scope, id) = (self.store.scope().to_owned(), req.id.clone());
                self.db
                    .state
                    .write(move |tx| {
                        tx.put_meta(&format!("effect:{n}"), id.as_str())?;
                        tx.put_op(&scope, id.as_str(), &row)
                    })
                    .await
                    .unwrap();
                ticket.complete(OpOutcome::Applied(applied.clone()));
                Ok(applied)
            }
        }
    }

    fn effects(&self) -> usize {
        self.effects.load(Ordering::SeqCst)
    }
}

fn rename(id: &OpId, title: &str) -> OpRequest {
    OpRequest::new(
        id.clone(),
        "thread/name/update",
        &json!({ "opId": id.as_str(), "name": title }),
    )
}

#[test]
fn payload_digest_is_canonical_and_ignores_the_op_id() {
    let a = PayloadDigest::of_params(
        &json!({ "z": true, "opId": "x", "a": [1, "x", { "c": 1.5, "b": null }] }),
    );
    let b = PayloadDigest::of_params(&json!({ "a": [1, "x", { "b": null, "c": 1.5 }], "z": true }));
    assert_eq!(a, b);
    assert_eq!(
        a.as_str(),
        "sha256:0c7dfa09052b45548ea78f488795a6d2cdd4a1b5583a90a5dd328968ef2638a1",
        "sha256 of {{\"a\":[1,\"x\",{{\"b\":null,\"c\":1.5}}],\"z\":true}}"
    );
    assert_ne!(
        a,
        PayloadDigest::of_params(&json!({ "a": [1, "x"], "z": true }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn duplicate_with_the_same_payload_runs_once_and_shares_the_response() {
    let owner = Owner::new("config").await;
    let req = rename(&op_id(NOW_MS, 1), "a");

    let (started_tx, started) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let first = tokio::spawn({
        let owner = owner.clone();
        let req = req.clone();
        async move { owner.mutate(&req, Some((started_tx, release_rx))).await }
    });
    started.await.unwrap();
    let second = tokio::spawn({
        let owner = owner.clone();
        let req = req.clone();
        async move { owner.mutate(&req, None).await }
    });
    // The duplicate waits on the running execution, never re-executing.
    tokio::task::yield_now().await;
    assert_eq!(
        owner
            .gate
            .status(std::slice::from_ref(&req.id), false, &ctx())
            .await
            .unwrap(),
        [OpStatus::InProgress]
    );
    release.send(()).unwrap();
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(first, second);

    // A later duplicate replays the stored response.
    assert_eq!(owner.mutate(&req, None).await.unwrap(), first);
    assert_eq!(owner.effects(), 1);
    assert_eq!(
        owner
            .gate
            .status(std::slice::from_ref(&req.id), true, &ctx())
            .await
            .unwrap(),
        [OpStatus::Applied {
            seq: first.seq,
            result: first.result
        }]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn another_payload_under_the_same_op_id_conflicts() {
    let owner = Owner::new("config").await;
    let id = op_id(NOW_MS, 2);

    let (started_tx, started) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let running = tokio::spawn({
        let owner = owner.clone();
        let req = rename(&id, "a");
        async move { owner.mutate(&req, Some((started_tx, release_rx))).await }
    });
    started.await.unwrap();
    let conflict = CoreError::OpIdConflict { op_id: id.clone() };
    assert_eq!(
        owner.mutate(&rename(&id, "b"), None).await,
        Err(conflict.clone())
    );
    release.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(owner.mutate(&rename(&id, "b"), None).await, Err(conflict));
    assert_eq!(owner.effects(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fenced_id_never_executes() {
    let owner = Owner::new("agent").await;
    let id = op_id(NOW_MS, 3);

    // Without `fence` a missing id is reported but stays executable.
    let open = op_id(NOW_MS, 4);
    assert_eq!(
        owner
            .gate
            .status(std::slice::from_ref(&open), false, &ctx())
            .await
            .unwrap(),
        [OpStatus::NotApplied]
    );
    owner.mutate(&rename(&open, "x"), None).await.unwrap();

    assert_eq!(
        owner
            .gate
            .status(std::slice::from_ref(&id), true, &ctx())
            .await
            .unwrap(),
        [OpStatus::NotApplied]
    );
    assert_eq!(
        owner.mutate(&rename(&id, "late"), None).await,
        Err(CoreError::OpFenced { op_id: id.clone() })
    );
    assert_eq!(
        owner.gate.status(&[id], false, &ctx()).await.unwrap(),
        [OpStatus::NotApplied]
    );
    assert_eq!(owner.effects(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fence_racing_its_late_arrival_has_one_winner() {
    let owner = Owner::new("agent").await;
    for n in 0..300 {
        let req = rename(&op_id(NOW_MS, 1000 + n), "race");
        let effects_before = owner.effects();
        let arrival = tokio::spawn({
            let owner = owner.clone();
            let req = req.clone();
            async move { owner.mutate(&req, None).await }
        });
        let fence = tokio::spawn({
            let owner = owner.clone();
            let id = req.id.clone();
            async move { owner.gate.status(&[id], true, &ctx()).await }
        });
        let arrival = arrival.await.unwrap();
        let fence = fence.await.unwrap().unwrap();
        match &fence[..] {
            [OpStatus::NotApplied] => {
                assert_eq!(
                    arrival,
                    Err(CoreError::OpFenced {
                        op_id: req.id.clone()
                    })
                );
                assert_eq!(owner.effects(), effects_before);
            }
            [OpStatus::InProgress] | [OpStatus::Applied { .. }] => {
                assert!(arrival.is_ok());
                assert_eq!(owner.effects(), effects_before + 1);
            }
            other => panic!("unexpected status {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crash_during_an_external_action_reads_external_unknown_after_restart() {
    let db = Db::new();
    let gate = OpGate::domain(scope("git"), db.store("git")).await.unwrap();
    let req = OpRequest::new(op_id(NOW_MS, 5), "git/push", &json!({ "remote": "origin" }));
    let Begin::Execute(ticket) = gate.begin(&req, &ctx()).await.unwrap() else {
        panic!("first arrival executes");
    };
    ticket
        .external_pending("git/push".into(), "origin".into())
        .await
        .unwrap();
    // The process dies mid-action: nothing settles the ticket.
    std::mem::forget(ticket);
    drop(gate);

    let db = db.restart();
    let restarted = OpGate::domain(scope("git"), db.store("git")).await.unwrap();
    let unknown = OpStatus::ExternalUnknown {
        effect: "git/push".into(),
        target: "origin".into(),
    };
    assert_eq!(
        restarted
            .status(std::slice::from_ref(&req.id), true, &ctx())
            .await
            .unwrap(),
        [unknown]
    );
    let Begin::Done(outcome) = restarted.begin(&req, &ctx()).await.unwrap() else {
        panic!("an op with an unknown outcome never re-executes");
    };
    assert_eq!(
        outcome.into_result(&req.id),
        Err(CoreError::ExternalOutcomeUnknown {
            op_id: req.id.clone(),
            effect: "git/push".into(),
            target: "origin".into(),
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_external_action_finishes_with_its_recorded_outcome() {
    let owner = Owner::new("git").await;
    let req = OpRequest::new(op_id(NOW_MS, 6), "git/push", &json!({ "remote": "origin" }));
    let Begin::Execute(ticket) = owner.gate.begin(&req, &ctx()).await.unwrap() else {
        panic!("first arrival executes");
    };
    ticket
        .external_pending("git/push".into(), "origin".into())
        .await
        .unwrap();
    let rejected = CoreError::DomainError {
        domain: "git".into(),
        code: Some("PUSH_REJECTED".into()),
        message: None,
        detail: None,
    };
    ticket
        .finish(OpOutcome::Rejected(rejected.clone()))
        .await
        .unwrap();
    assert_eq!(owner.mutate(&req, None).await, Err(rejected.clone()));
    assert_eq!(
        owner.gate.status(&[req.id], false, &ctx()).await.unwrap(),
        [OpStatus::Rejected { error: rejected }]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_abandoned_execution_lets_a_duplicate_execute() {
    let owner = Owner::new("config").await;
    let req = rename(&op_id(NOW_MS, 7), "a");
    let Begin::Execute(ticket) = owner.gate.begin(&req, &ctx()).await.unwrap() else {
        panic!("first arrival executes");
    };
    // The write failed with nothing applied (for example `barrierFailed`).
    drop(ticket);
    owner.mutate(&req, None).await.unwrap();
    assert_eq!(owner.effects(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_prune_advances_the_watermark_and_older_ids_expire() {
    let db = Db::new();
    let old = NOW_MS - 8 * DAY_MS;
    let ids = db.seed("media", old, 10_100).await;
    let owner = Owner::on(db, "media").await;

    let mut deleted = 0;
    loop {
        let step = owner.gate.prune_step(NOW_MS).await.unwrap();
        assert!(step.deleted <= 500, "bounded batch");
        deleted += step.deleted;
        if !step.more {
            break;
        }
    }
    assert_eq!(deleted, 100, "everything but the newest 10,000");
    assert!(owner.db.count("media", 10_000).await);
    assert!(!owner.db.count("media", 10_001).await);
    let watermark = old + 100;
    assert_eq!(owner.store.watermark().await.unwrap(), Some(watermark));

    let oldest = ids[0].clone();
    assert_eq!(
        owner
            .gate
            .status(std::slice::from_ref(&oldest), true, &ctx())
            .await
            .unwrap(),
        [OpStatus::Expired]
    );
    assert_eq!(
        owner.mutate(&rename(&oldest, "x"), None).await,
        Err(CoreError::OpIdExpired {
            op_id: oldest,
            watermark: super::uuid7::watermark_text(watermark),
        })
    );
    assert!(matches!(
        owner
            .gate
            .status(&[ids[100].clone()], false, &ctx())
            .await
            .unwrap()[..],
        [OpStatus::Applied { .. }]
    ));

    // The watermark survives a restart.
    let restarted = OpGate::domain(scope("media"), owner.store.clone())
        .await
        .unwrap();
    assert_eq!(
        restarted
            .status(&[ids[99].clone()], false, &ctx())
            .await
            .unwrap(),
        [OpStatus::Expired]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn records_younger_than_seven_days_are_kept() {
    let db = Db::new();
    db.seed("media", NOW_MS - DAY_MS, 10_100).await;
    let owner = Owner::on(db, "media").await;
    let step = owner.gate.prune_step(NOW_MS).await.unwrap();
    assert_eq!(
        step,
        PruneStep {
            deleted: 0,
            more: false
        }
    );
    assert!(owner.db.count("media", 10_100).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_scope_waiting_on_its_store_never_delays_another() {
    /// The real store, with `get` waiting for a notification.
    struct Stalled {
        store: Arc<StateOpStore>,
        stall: Arc<Notify>,
    }

    #[async_trait]
    impl OpStore for Stalled {
        async fn get(&self, id: &OpId) -> Result<Option<OpRecord>, CoreError> {
            self.stall.notified().await;
            self.store.get(id).await
        }

        async fn put(&self, id: &OpId, record: OpRecord) -> Result<(), CoreError> {
            self.store.put(id, record).await
        }

        async fn watermark(&self) -> Result<Option<u64>, CoreError> {
            self.store.watermark().await
        }
    }

    #[async_trait]
    impl OpRetention for Stalled {
        async fn nth_newest_ms(&self, n: usize) -> Result<Option<u64>, CoreError> {
            self.store.nth_newest_ms(n).await
        }

        async fn set_watermark(&self, ms: u64) -> Result<(), CoreError> {
            self.store.set_watermark(ms).await
        }

        async fn delete_before(&self, ms: u64, limit: usize) -> Result<usize, CoreError> {
            self.store.delete_before(ms, limit).await
        }
    }

    let db = Db::new();
    let stall = Arc::new(Notify::new());
    let slow = Arc::new(Stalled {
        store: db.store("account"),
        stall: stall.clone(),
    });
    let slow_gate = OpGate::domain(scope("account"), slow).await.unwrap();
    let waiting = tokio::spawn({
        let gate = slow_gate.clone();
        let req = rename(&op_id(NOW_MS, 8), "a");
        async move { gate.begin(&req, &ctx()).await.map(|_| ()) }
    });
    tokio::task::yield_now().await;

    let other = Owner::new("config").await;
    other
        .mutate(&rename(&op_id(NOW_MS, 9), "b"), None)
        .await
        .unwrap();
    assert!(!waiting.is_finished());
    stall.notify_one();
    waiting.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn op_index_routes_status_to_the_scope_gate() {
    struct Threads(OpGate);

    #[async_trait]
    impl ThreadOpGates for Threads {
        async fn gate(&self, thread: &ThreadId, _ctx: &CallContext) -> Result<OpGate, CoreError> {
            if thread.as_str() == "t1" {
                Ok(self.0.clone())
            } else {
                Err(CoreError::ThreadNotFound {
                    thread_id: thread.clone(),
                })
            }
        }
    }

    let config = Owner::new("config").await;
    let applied = op_id(NOW_MS, 10);
    config.mutate(&rename(&applied, "a"), None).await.unwrap();
    // A thread's records live in its log; any store serves to check the routing.
    let thread_store: Arc<dyn OpStore> = config.db.store("thread:t1");
    let thread_gate = OpGate::thread(OpScope::Thread(ThreadId::from("t1")), thread_store);
    let index = CoreOpIndex::new([config.gate.clone()], Arc::new(Threads(thread_gate)));

    let statuses = index
        .status(&scope("config"), &[applied], false, &ctx())
        .await
        .unwrap();
    assert!(matches!(statuses[..], [OpStatus::Applied { .. }]));
    assert_eq!(
        index
            .status(
                &OpScope::Thread("t1".into()),
                &[op_id(NOW_MS, 11)],
                true,
                &ctx()
            )
            .await
            .unwrap(),
        [OpStatus::NotApplied]
    );
    assert!(matches!(
        index.status(&scope("nope"), &[], false, &ctx()).await,
        Err(CoreError::InvalidParams { .. })
    ));
    assert!(matches!(
        index
            .status(&OpScope::Thread("t2".into()), &[], false, &ctx())
            .await,
        Err(CoreError::ThreadNotFound { .. })
    ));
    assert!(matches!(
        index
            .status(&scope("config"), &[OpId::from("not-a-uuid")], false, &ctx())
            .await,
        Err(CoreError::InvalidParams { .. })
    ));
}
