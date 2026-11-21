//! Forced-order tests of Rule A over a real database: work a cancelled caller left behind stays owned by the database's scope until it completes
//! (the graceful stop waits for it) or the scope revokes it (no later SQL, no open transaction left on a pooled connection); a trace feed batch
//! taken before its delivery holds the store's close until both its writes land. Barriers, never sleeps: each step waits for an observed state.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::memory::ingest::SessionIngest;
use crate::memory::ingest::embed_flush::{ClaimSeam, RawEmbedFlush};
use crate::memory::pg::db::{Db, Schema};
use crate::memory::recall::period::Clock;
use crate::memory::recall::{Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::service::LocalMemory;
use crate::memory::tests::awaiting::awaiting;
use crate::memory::tests::support::TestPg;

const LIMIT: Duration = Duration::from_secs(60);

/// A memory over `db` whose raw flushes hold after their claim (transaction open, rows locked) until `release` has permits.
fn memory_holding_claims(db: &Db, dir: &std::path::Path) -> (Arc<LocalMemory>, tokio::sync::mpsc::UnboundedReceiver<()>, Arc<tokio::sync::Semaphore>) {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(|| Clock { now_ms: 1_700_000_000_000, zone: chrono_tz::UTC }),
        embedder: None,
        session_cwd: None,
        lane,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let flush = Arc::new(RawEmbedFlush::new(db.clone(), None));
    let (entered_tx, entered) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    flush.hold_after_claim(ClaimSeam { entered: entered_tx, release: release.clone() });
    let ingest = SessionIngest::new(db.clone(), flush, None, Arc::new(|| 1_700_000_000_000), lane);
    (Arc::new(LocalMemory::new(db.clone(), dir.to_owned(), recall, ingest, lane)), entered, release)
}

fn ingest_args(embed_wait: bool) -> Value {
    json!({"action": "ingest_session", "sessionId": "lifecycle", "embedWait": embed_wait,
        "messages": [{"role": "user", "content": "the deploy needs a second look"}, {"role": "assistant", "content": "I will check the staging logs"}]})
}

/// Sessions of this test's database that hold an open transaction.
async fn open_transactions(db: &Db) -> i64 {
    db.query("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'", &[])
        .await
        .expect("activity")[0]
        .get(0)
}

/// Starts the ingest as a caller would, waits until its embedding holds its claim, then cancels the caller: the work is the scope's now.
async fn ingest_then_cancel_the_caller(memory: &Arc<LocalMemory>, entered: &mut tokio::sync::mpsc::UnboundedReceiver<()>, embed_wait: bool) {
    let caller = {
        let memory = memory.clone();
        tokio::spawn(async move { memory.memory_reply(&ingest_args(embed_wait)).await })
    };
    awaiting("the embedding to hold its claim", entered.recv()).await.expect("entered");
    caller.abort();
    let _ = caller.await;
}

/// The own-row embedding (awaited by the ingest) and the deferred flush (queued) of an ingest whose caller was cancelled: a graceful shutdown waits
/// for them, with their backlog chain, and no transaction is left open when it ends.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_graceful_shutdown_waits_for_the_embedding_a_cancelled_ingest_left_behind() {
    for embed_wait in [true, false] {
        let pg = TestPg::start().await;
        let db = pg.db(Schema::Memory).await;
        ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
        let (memory, mut entered, release) = memory_holding_claims(&db, &pg.dir.path().join("data"));
        ingest_then_cancel_the_caller(&memory, &mut entered, embed_wait).await;
        let scope = db.scope().clone();
        scope.seal();
        let mut idle = Box::pin(scope.idle());
        assert!(futures::poll!(&mut idle).is_pending(), "the embedding the cancelled caller left is still owned (embedWait={embed_wait})");
        assert_eq!(open_transactions(&db).await, 1, "its claim is open");
        // Every later batch of the chain (the backlog flush queued behind it) may pass too.
        release.add_permits(tokio::sync::Semaphore::MAX_PERMITS / 2);
        mixdog_rt::time::timeout(LIMIT, idle).await.expect("the owned work ends");
        assert!(scope.spawn("late", async {}).is_none(), "a sealed scope admits nothing new");
        assert_eq!(open_transactions(&db).await, 0, "no transaction outlived the work");
    }
}

/// The same work cut instead: the revocation drops it with its lease, so its claim's backend goes away (its transaction ends with it), the rows
/// are unlocked, nothing of it runs afterwards, and no open transaction is left in the pool.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_forced_cut_discards_the_connection_of_an_embedding_a_cancelled_ingest_left_behind() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    let (memory, mut entered, release) = memory_holding_claims(&db, &pg.dir.path().join("data"));
    ingest_then_cancel_the_caller(&memory, &mut entered, true).await;
    let held: i32 =
        db.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'", &[]).await.expect("activity")[0]
            .get(0);
    // The observer is a handle of its own owner: the cut owner's transport admits nothing after its revocation.
    let observer = pg.db(Schema::Memory).await;
    let scope = db.scope().clone();
    scope.revoke().await;
    assert_eq!(scope.running() + scope.transport().running(), 0, "the acknowledgement came after every piece of the work and every driver was destroyed");
    // A batch the revocation dropped can never pass its hold again: nothing is waiting on it.
    release.add_permits(tokio::sync::Semaphore::MAX_PERMITS / 2);
    let db = observer;
    awaiting("the discarded connection's backend to end", async {
        loop {
            let alive: i64 = db.query("SELECT count(*) FROM pg_stat_activity WHERE pid = $1", &[&held]).await.expect("activity")[0].get(0);
            if alive == 0 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(open_transactions(&db).await, 0, "no open transaction is left on any connection");
    let locked = db.query("SELECT id FROM entries WHERE session_id = 'lifecycle' FOR UPDATE NOWAIT", &[]).await;
    assert!(locked.is_ok_and(|rows| rows.len() == 2), "the claim's row locks went with its backend");
    let embedded: i64 = db.query("SELECT count(*) FROM entries WHERE embedding IS NOT NULL", &[]).await.expect("rows")[0].get(0);
    assert_eq!(embedded, 0, "the cut work wrote nothing");
    assert!(scope.spawn("late", async {}).is_none());
}

/// A connection driver whose destruction is fenced: the owner's local revocation is not acknowledged while the driver's destruction is held, and is
/// once it ended. (The backend's disappearance is the server's eventual outcome, observed by the forced-cut test, never this acknowledgement.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn local_revocation_is_not_acknowledged_while_a_driver_destruction_is_fenced() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel();
    *crate::memory::pg::db::DRIVER_DROP_FENCE.lock().expect("fence") = Some(crate::memory::pg::db::DriverDropFence { entered: entered_tx, gate });
    let client = db.client().await.expect("a connection whose driver holds the fence");
    let scope = db.scope().clone();
    assert_eq!(scope.transport().running(), 1, "the driver is a slot of the owner's transport");
    scope.request_revoke();
    let mut acknowledged = Box::pin(scope.revoked());
    // The driver's pump destroys it on a worker thread; the destruction holds there (the test body runs on its own thread).
    entered.recv().expect("the driver's destruction began");
    assert!(futures::poll!(&mut acknowledged).is_pending(), "no acknowledgement while the driver's destruction is held");
    assert_eq!(scope.transport().running(), 1);
    release.send(()).expect("release the destruction");
    awaiting("the acknowledgement after the driver's destruction", acknowledged).await;
    assert_eq!(scope.transport().running(), 0);
    assert!(client.simple_query("SELECT 1").await.is_err(), "the client of a destroyed driver submits nothing");
}

/// The host's memory control (the rooms' list/delete) is one owned operation: fenced inside the database (its statement waits on a table lock another
/// session holds), the owner's cut ends it with nothing more submitted by this process, the caller is answered as stopping, and a later call is refused
/// before it touches the database. Nothing here stops PostgreSQL (a secondary process's stop dispatches nothing: `StopDispatch::SecondaryNotOwned`).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_memory_control_call_cut_mid_statement_submits_nothing_more_and_later_calls_are_refused() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    let observer = pg.db(Schema::Memory).await;
    let lane = mixdog_rt::testing::tokens().durability_io;
    let control = crate::memory::core::action::ControlScope::new(db.clone(), pg.dir.path().join("data"), Arc::new(std::sync::atomic::AtomicU64::new(0)), lane);
    let fence = crate::memory::pg::db::Lease::take(&observer).await.expect("the fence's connection");
    fence.begin().await.expect("begin");
    fence.batch_execute("LOCK TABLE core_entries IN ACCESS EXCLUSIVE MODE").await.expect("the fence");
    let calling = {
        let control = control.clone();
        tokio::spawn(async move { control.call(json!({"op": "list", "agent_id": "a", "format": "json", "limit": 5, "offset": 0})).await })
    };
    awaiting("the control's statement to wait on the fence", async {
        loop {
            let waiting: i64 = observer
                .query("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'", &[])
                .await
                .expect("activity")[0]
                .get(0);
            if waiting > 0 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    let scope = db.scope().clone();
    scope.revoke().await;
    assert_eq!(scope.running() + scope.transport().running(), 0, "the operation and its connection's driver were destroyed before the acknowledgement");
    assert_eq!(awaiting("the cut call's answer", calling).await.expect("answered"), "core failed: memory service stopping");
    assert_eq!(control.call(json!({"op": "list", "agent_id": "a"})).await, "core failed: memory service stopping", "a later call is refused");
    drop(fence);
}

/// A connect in flight at the cut: the connect is the transport slot's own work, so the revocation destroys the attempt, the acknowledgement follows,
/// and the caller's checkout fails instead of finishing a connection after it.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_connect_in_flight_at_the_cut_is_destroyed_with_its_slot() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    let (mut entered, _release) = crate::memory::lifecycle::fences::arm("pg-connect");
    let checkout = {
        let db = db.clone();
        tokio::spawn(async move { db.client().await.map(drop) })
    };
    awaiting("the connect to be in flight", entered.recv()).await.expect("entered");
    let scope = db.scope().clone();
    assert_eq!(scope.transport().running(), 1, "the connect is a slot of the transport");
    scope.revoke().await;
    assert_eq!(scope.transport().running(), 0);
    assert!(awaiting("the checkout's answer", checkout).await.expect("answered").is_err(), "no connection came out of the cut connect");
}

/// A transaction whose holder is cancelled after `BEGIN` and a write: the connection is discarded, never returned to circulation (the next checkout of
/// the same pool gets another backend), and another connection sees no part of the write.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_transaction_cancelled_after_begin_never_returns_its_connection_and_commits_nothing() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    let observer = pg.db(Schema::Memory).await;
    let (held_tx, held) = tokio::sync::oneshot::channel::<i32>();
    let holder = {
        let db = db.clone();
        tokio::spawn(async move {
            crate::memory::pg::db::transaction(&db, async |tx| {
                tx.execute("INSERT INTO meta(key, value) VALUES ('cancelled-after-begin', '1'::jsonb)", &[]).await?;
                let pid: i32 = tx.query_one("SELECT pg_backend_pid()", &[]).await?.get(0);
                let _ = held_tx.send(pid);
                std::future::pending::<()>().await;
                Ok(())
            })
            .await
        })
    };
    let pid = awaiting("the transaction to hold after its write", held).await.expect("held");
    holder.abort();
    let _ = holder.await;
    awaiting("the discarded connection's backend to end", async {
        loop {
            let alive: i64 = observer.query("SELECT count(*) FROM pg_stat_activity WHERE pid = $1", &[&pid]).await.expect("activity")[0].get(0);
            if alive == 0 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    let next: i32 = db.query("SELECT pg_backend_pid()", &[]).await.expect("next checkout")[0].get(0);
    assert_ne!(next, pid, "the cancelled transaction's connection never returned to the pool");
    let seen: i64 = observer.query("SELECT count(*) FROM meta WHERE key = 'cancelled-after-begin'", &[]).await.expect("meta")[0].get(0);
    assert_eq!(seen, 0, "nothing of the cancelled transaction was committed");
}

/// The scoped operations that replaced raw handles (session deletion, `thread/search`, the legacy migration), fenced inside the database (their
/// statements wait on a table lock another session holds): the owner's cut ends them with nothing more submitted, and every later call is refused
/// before it touches the database.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn scoped_operations_are_cut_mid_statement_and_refused_after_the_stop() {
    let pg = TestPg::start().await;
    let search_db = crate::memory::session_search::db::SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("schema");
    let memory_db = pg.db(Schema::Memory).await;
    let observer = pg.db(Schema::SessionSearch).await;
    let ingest =
        crate::memory::session_search::ingest::SessionSearchIngest::new(search_db.clone(), Arc::new(crate::memory::sensitive::SensitiveStore::default()));
    let search = crate::memory::access::MemoryAccess::over(search_db.db().clone());
    let thread_search = crate::memory::thread_search::ThreadSearchService::new(search.clone());
    observer.batch("CREATE SCHEMA IF NOT EXISTS scheduler; CREATE TABLE IF NOT EXISTS scheduler.schedules (name text)").await.expect("the legacy table");
    let legacy = crate::scheduler::legacy::PgLegacyRoutines::new(crate::memory::access::MemoryAccess::over(search_db.db().clone()));
    let fence = crate::memory::pg::db::Lease::take(&observer).await.expect("the fence's connection");
    fence.begin().await.expect("begin");
    fence.batch_execute("LOCK TABLE session_search.messages, scheduler.schedules IN ACCESS EXCLUSIVE MODE").await.expect("the fence");
    ingest.forget_session_owned("deleted-session");
    let migrating = tokio::spawn(async move { crate::scheduler::legacy::LegacyRoutineSource::read(&legacy).await });
    let searching = {
        let service = thread_search.clone();
        tokio::spawn(async move { service.run("deploy").await })
    };
    awaiting("the three statements to wait on the fence", async {
        loop {
            let waiting: i64 = observer
                .query("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'", &[])
                .await
                .expect("activity")[0]
                .get(0);
            if waiting >= 3 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    let scope = search_db.scope().clone();
    scope.revoke().await;
    assert_eq!(scope.running() + scope.transport().running(), 0, "the deletion, the search and their connections were destroyed");
    let answered = awaiting("the cut search's answer", searching).await.expect("answered");
    assert!(answered.is_err_and(|error| format!("{error:?}").contains("stopping")), "the cut search is answered as stopping");
    assert!(thread_search.run("deploy").await.is_err(), "a later search is refused");
    ingest.forget_session_owned("another");
    assert_eq!(scope.running(), 0, "a later deletion is refused before it is registered");
    let cut = awaiting("the cut legacy read's answer", migrating).await.expect("answered");
    assert!(cut.is_err_and(|error| error.contains("stopping")), "the legacy read cut mid-statement is answered as stopping");
    // The legacy migration over a cut owner is refused before it touches the database.
    let legacy = crate::scheduler::legacy::PgLegacyRoutines::new(crate::memory::access::MemoryAccess::over(search_db.db().clone()));
    let refused = crate::scheduler::legacy::LegacyRoutineSource::read(&legacy).await;
    assert!(refused.is_err_and(|error| error.contains("stopping")), "the legacy read is refused after the stop");
    drop(memory_db);
    drop(fence);
}

/// A feed batch held right after it took its rows from the feed and before their delivery: the store's close stays pending, and once the batch goes
/// on, both its trace rows and its agent analytics are written before the close returns.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_close_waits_for_a_feed_batch_taken_before_its_delivery_and_writes_both_tables() {
    let pg = TestPg::start().await;
    let db = Arc::new(pg.db(Schema::Memory).await);
    let now = chrono::Utc::now().timestamp_millis();
    let store = crate::memory::trace::TraceStore::open(db.clone(), true, 0, now).await.expect("the store opens").expect("tracing is on");
    let (entered_tx, mut entered) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    store.hold_feed_after_take(ClaimSeam { entered: entered_tx, release: release.clone() });
    for tool in ["read", "grep"] {
        let row = json!({"kind": "tool", "session_id": "trace-close", "tool_name": tool, "tool_ms": 5, "ts": now});
        mixdog_trace::RowSink::row(&store, row.as_object().expect("an object"), now);
    }
    let mut closing = Box::pin(store.close(now));
    assert!(futures::poll!(&mut closing).is_pending());
    // The close sealed the store and fired the feed's timer: the batch took the rows and holds before their delivery.
    awaiting("the feed batch to take its rows", entered.recv()).await.expect("entered");
    assert_eq!(store.feed_rows(), 0, "the rows left the feed");
    assert!(futures::poll!(&mut closing).is_pending(), "the close waits for the batch it took");
    release.add_permits(1);
    mixdog_rt::time::timeout(LIMIT, closing).await.expect("the close ends");
    let count = |sql: &'static str| {
        let db = db.clone();
        async move { db.query(sql, &[]).await.expect("count")[0].get::<_, i64>(0) }
    };
    assert_eq!(count("SELECT count(*) FROM trace.trace_events WHERE session_id = 'trace-close'").await, 2, "the trace rows were written");
    assert_eq!(count("SELECT count(*) FROM trace.agent_calls WHERE session_id = 'trace-close'").await, 2, "the analytics were written");
    mixdog_trace::RowSink::row(&store, json!({"kind": "tool", "session_id": "trace-close"}).as_object().expect("an object"), now);
    assert_eq!(store.feed_rows(), 0, "a closed store takes no row");
}
