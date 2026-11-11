//! `replay/storesSettled` through its service (`StoresSettled::call`): every store's accepted count is taken as the call
//! arrives, so a write one store accepts while the call still waits on another is not the call's.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::agent_registry::StoreWorkers;
use mixdog_core_session::session::agent_registry::WorkerStore;
use mixdog_core_session::session::testing::Rig;
use mixdog_rt::CancellationToken;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::StoresSettled;
use super::WriteBehind;

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// Headers whose patch of a named session waits at a gate.
#[derive(Default)]
struct GatedHeaders {
    gates: Mutex<Vec<(String, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
}

impl GatedHeaders {
    /// The patch of `session` signals the first notify when it arrives and waits for the second.
    fn hold(&self, session: &str) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
        let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        self.gates.lock().unwrap().push((session.to_owned(), arrived.clone(), go.clone()));
        (arrived, go)
    }
}

#[async_trait::async_trait]
impl ThreadState for GatedHeaders {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, thread: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        let gate = self.gates.lock().unwrap().iter().find(|(s, _, _)| s == thread.as_str()).map(|(_, a, g)| (a.clone(), g.clone()));
        if let Some((arrived, go)) = gate {
            arrived.notify_one();
            go.notified().await;
        }
        Ok(())
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

/// Never runs what is scheduled on it: a gateway usage batch reaches the disk only through a flush.
struct NeverFires;

impl mixdog_core_session::session::gateway_usage::Scheduler for NeverFires {
    fn after(&self, _: u64, _: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }
}

struct Unpriced;

impl mixdog_ai::registry::accounting::UsagePricing for Unpriced {
    fn price_usage(&self, _: &mixdog_ai::catalog::UsageArgs) -> mixdog_ai::catalog::PricedUsage {
        mixdog_ai::catalog::PricedUsage { input: 0.0, cost_usd: None, rates: Default::default() }
    }
}

struct NoPrices;

impl mixdog_ledger::refresh::Pricer for NoPrices {
    fn revision(&self) -> String {
        String::new()
    }

    fn price(&self, _: &mixdog_ledger::repair::PriceRequest) -> mixdog_ledger::Result<mixdog_ledger::repair::Priced> {
        Err(mixdog_ledger::LedgerError::Invalid("a price"))
    }
}

async fn workers(headers: Arc<GatedHeaders>, root: &std::path::Path) -> StoreWorkers {
    let tokens = mixdog_rt::testing::tokens();
    let root = root.to_owned();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    StoreWorkers::new(index, headers, tokens.interactive_io)
}

/// The control over `directory`, the agent index `workers` and the other stores in `data`.
fn service(directory: Arc<SessionDirectory>, data: &std::path::Path, workers: StoreWorkers) -> StoresSettled {
    let tokens = mixdog_rt::testing::tokens();
    let gateway = mixdog_core_session::session::gateway_usage::GatewayUsage::new(
        data,
        tokens.durability_io,
        Arc::new(mixdog_core_session::session::SystemClock),
        Arc::new(Unpriced),
        Arc::new(NeverFires),
    );
    let push = mixdog_core::run_host::usage_stats_feed::UsagePush::new(Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), Arc::new(|| 0));
    let ledgers = mixdog_core::run_host::ledger_source::LedgerSource::new(Arc::new(mixdog_ai::registry::keys::ProcessEnv), data.join("ledger"), tokens, Arc::new(NoPrices), push);
    let writers = WriteBehind { workers: Arc::new(workers), read_state: Arc::new(mixdog_tools::fs::ReadState::new(None)) };
    StoresSettled::new(directory, writers, gateway, ledgers)
}

fn settled() -> CoreRequest {
    CoreRequest { method: Method(mixdog_app_server::REPLAY_STORES_SETTLED), params: json!({}), op: None, ctx: CallContext::internal("test") }
}

/// A header update awaiting its outside read on the actor as the call arrives (`UpdateHeaderAwaiting`): the actor handles
/// nothing else meanwhile, and once the read resumes it appends its record, which the store then holds unsynced. That record
/// was accepted after the call arrived, so the call answers without it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_an_awaiting_header_update_appends_after_the_call_arrived_is_not_waited_for() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let id = ThreadId::from("sess_awaiting");
    directory.create_with_id(id.clone(), Map::new(), json!({})).await.expect("the thread");
    directory.open_handle(&id, &CallContext::internal("test")).await.expect("the thread loads");

    let (reading, resume) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    type Awaiting = Box<dyn FnOnce(mixdog_store::schema::record::Header) -> futures::future::BoxFuture<'static, mixdog_store::schema::record::HeaderChange> + Send>;
    let update: Awaiting = {
        let (reading, resume) = (reading.clone(), resume.clone());
        Box::new(move |_header| {
            Box::pin(async move {
                reading.notify_one();
                resume.notified().await;
                let mut set = Map::new();
                set.insert("title".to_owned(), json!("after"));
                mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }
            })
        })
    };
    let mut updated = Box::pin({
        let (directory, id) = (directory.clone(), id.clone());
        async move { directory.update_header_awaiting(&id, update).await }
    });
    assert!(futures::poll!(updated.as_mut()).is_pending());
    tokio::time::timeout(DEADLINE, reading.notified()).await.expect("the update did not start its read within 10 s");

    let data = tempfile::tempdir().expect("temp dir");
    let stores = service(directory.clone(), data.path(), workers(Arc::new(GatedHeaders::default()), data.path()).await);
    let mut call = Box::pin(stores.call(settled()));
    // Nothing from before the call is pending, so it may answer on its first poll.
    let first = match futures::poll!(call.as_mut()) {
        std::task::Poll::Ready(answer) => Some(answer),
        std::task::Poll::Pending => None,
    };

    // After the call arrived, the read resumes and the update appends its record, which the store holds unsynced.
    let (after_arrived, after_go) = rig.store.hold_title("after");
    resume.notify_one();
    tokio::time::timeout(DEADLINE, after_arrived.notified()).await.expect("the update's record did not reach the store within 10 s");
    let answer = match first {
        Some(answer) => answer,
        None => tokio::time::timeout(DEADLINE, call).await.expect("the call did not answer within 10 s although nothing from before it was pending"),
    };
    match answer {
        Ok(Reply::Value(value)) => assert_eq!(value, json!({ "threads": 1 })),
        other => panic!("the call answers the threads it asked: {other:?}"),
    }
    assert!(futures::poll!(updated.as_mut()).is_pending(), "the update's record was still unsynced when the call answered");
    after_go.send(()).expect("the commit waits");
    tokio::time::timeout(DEADLINE, updated).await.expect("the update did not answer within 10 s").expect("committed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_accepted_while_the_call_waits_on_the_agent_index_is_not_waited_for() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let id = ThreadId::from("sess_settled");
    directory.create_with_id(id.clone(), Map::new(), json!({})).await.expect("the thread");
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("the thread loads");

    // A worker row written before the call, held at its header patch.
    let data = tempfile::tempdir().expect("temp dir");
    let headers = Arc::new(GatedHeaders::default());
    let workers = workers(headers.clone(), data.path()).await;
    let (row_arrived, row_go) = headers.hold("row");
    workers.write("row", Some(Map::new()));
    tokio::time::timeout(DEADLINE, row_arrived.notified()).await.expect("the row's patch did not start within 10 s");

    let stores = service(directory.clone(), data.path(), workers);
    let mut call = Box::pin(stores.call(settled()));
    assert!(futures::poll!(call.as_mut()).is_pending(), "the row write from before the call is still held");

    // After the call arrived, while the agent index still holds it: the thread accepts a record the store holds unsynced.
    let (after_arrived, after_go) = rig.store.hold_title("after");
    let rename = CoreRequest {
        method: Method("thread/name/set"),
        params: json!({ "threadId": id, "opId": "op-after", "title": "after" }),
        op: Some(OpId::from("op-after")),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    };
    let mut after = Box::pin(handle.request(rename));
    assert!(futures::poll!(after.as_mut()).is_pending(), "the later record waits for its commit");
    tokio::time::timeout(DEADLINE, after_arrived.notified()).await.expect("the later record did not reach the store within 10 s");

    row_go.notify_one();
    let answer = tokio::time::timeout(DEADLINE, call).await.expect("the call did not answer within 10 s although every write from before it was written");
    match answer {
        Ok(Reply::Value(value)) => assert_eq!(value, json!({ "threads": 1 })),
        other => panic!("the call answers the threads it asked: {other:?}"),
    }
    assert!(futures::poll!(after.as_mut()).is_pending(), "the later record was still unsynced when the call answered");
    after_go.send(()).expect("the commit waits");
    tokio::time::timeout(DEADLINE, after).await.expect("the later rename did not answer within 10 s").expect("committed");
}
