//! The routing pool: every method the Rust worker serves goes to a pool of Rust workers
//! (`mixdogd ext-worker`), every other to the pool of Node workers. Nothing but the method
//! chooses the route: the native method list is given at construction, with no environment variable
//! and no setting behind it.
//!
//! The two pools share one render browser ([`ExtHostPool::sharing_browser`]): one Chromium, one launch
//! count, closed by the Rust pool's close after the Node pool's.
//!
//! Each pool keeps its own per-thread FIFO, round-robin and ⌈W/2⌉ cap, so until the Node worker is
//! removed (`nr-exthost-node-worker-removal`) up to 2W calls can run at once (W per pool). A Node
//! runtime that is missing ([`ExtError::Unavailable`]) is the Node pool's answer to Node-routed
//! methods only.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Mutex;

use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ExtWorkerId;
use mixdog_core_api::domain::ext::ExtWorkerStatus;

use crate::browser::RenderBrowser;
use crate::exits::ExtHostError;
use crate::pool::ExtHostConfig;
use crate::pool::ExtHostPool;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum WorkerPool {
    Native,
    Node,
}

/// Public ids belong to this routing pool, never to either child. Dead workers
/// are pruned on status refresh, but their public ids are never reused, so stale
/// stop requests cannot address replacements. Arc owners share the same map.
#[derive(Default)]
struct WorkerIds {
    public: HashMap<(WorkerPool, ExtWorkerId), ExtWorkerId>,
    actual: HashMap<ExtWorkerId, (WorkerPool, ExtWorkerId)>,
    next: u64,
}

impl WorkerIds {
    fn publish(&mut self, pool: WorkerPool, actual: ExtWorkerId) -> ExtWorkerId {
        let key = (pool, actual);
        if let Some(id) = self.public.get(&key) {
            return *id;
        }
        // The unchanged API has a finite u32 id space. Never wrap or alias an
        // earlier id, even if a router outlives all 2^32 distinct public ids.
        let id = ExtWorkerId(u32::try_from(self.next).expect("routed worker id space exhausted"));
        self.next += 1;
        self.actual.insert(id, key);
        self.public.insert(key, id);
        id
    }
}

pub struct RoutedExtPool<P = ExtHostPool> {
    native: P,
    node: P,
    native_methods: HashSet<String>,
    worker_ids: Mutex<WorkerIds>,
}

impl RoutedExtPool<ExtHostPool> {
    /// The Rust pool runs `native` (the current executable with `ext-worker`), the Node pool `node`;
    /// the Node pool uses the Rust pool's render browser. Must run inside the Tokio runtime.
    ///
    /// # Errors
    /// The child-exit signal of a pool cannot be registered.
    pub fn new<I, S>(native: ExtHostConfig, node: ExtHostConfig, native_methods: I) -> Result<Self, ExtHostError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let native = ExtHostPool::new(native)?;
        let node = ExtHostPool::sharing_browser(node, &native)?;
        Ok(Self::with_pools(native, node, native_methods))
    }

    /// The shared render browser, for in-process users.
    pub fn render_browser(&self) -> RenderBrowser {
        self.native.render_browser()
    }

    /// Render browsers launched so far, for both pools.
    pub fn browser_launches(&self) -> u64 {
        self.native.browser_launches()
    }

    /// Closes both pools, the Node pool first, then the Rust pool, which ends the shared browser. The
    /// core's stop procedure awaits this before the runtime is dropped.
    pub async fn close(&self) {
        self.node.close().await;
        self.native.close().await;
    }

    /// Chunk bytes delivered and not yet taken, for each call alive in either pool.
    #[cfg(feature = "test-support")]
    pub fn outstanding_window_bytes(&self) -> Vec<u64> {
        let mut bytes = self.native.outstanding_window_bytes();
        bytes.extend(self.node.outstanding_window_bytes());
        bytes
    }
}

impl<P: ExtPool> RoutedExtPool<P> {
    pub fn with_pools<I, S>(native: P, node: P, native_methods: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            native,
            node,
            native_methods: native_methods.into_iter().map(Into::into).collect(),
            worker_ids: Mutex::new(WorkerIds::default()),
        }
    }
}

impl<P: ExtPool> ExtPool for RoutedExtPool<P> {
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
        if self.native_methods.contains(&call.method) {
            self.native.call(call)
        } else {
            self.node.call(call)
        }
    }

    fn status(&self) -> Vec<ExtWorkerStatus> {
        let mut ids = self.worker_ids.lock().expect("routed worker ids");
        let mut rows = self.native.status();
        let node_rows = self.node.status();
        let live: HashSet<_> = rows.iter().map(|row| (WorkerPool::Native, row.id))
            .chain(node_rows.iter().map(|row| (WorkerPool::Node, row.id))).collect();
        ids.public.retain(|key, _| live.contains(key));
        ids.actual.retain(|_, key| live.contains(key));
        for row in &mut rows {
            row.id = ids.publish(WorkerPool::Native, row.id);
        }
        rows.extend(node_rows.into_iter().map(|mut row| {
            row.id = ids.publish(WorkerPool::Node, row.id);
            row
        }));
        rows
    }

    fn stop_worker(&self, worker: ExtWorkerId) -> Result<(), ExtError> {
        let route = self.worker_ids.lock().expect("routed worker ids").actual.get(&worker).copied();
        // Release the map lock before calling the child; it alone knows whether
        // the worker still exists and returns UnknownWorker after a restart.
        match route {
            Some((WorkerPool::Native, id)) => self.native.stop_worker(id),
            Some((WorkerPool::Node, id)) => self.node.stop_worker(id),
            None => Err(ExtError::UnknownWorker),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use mixdog_core_api::domain::ext::ExtWorkerState;
    use mixdog_core_api::domain::mock::MockExtPool;
    use mixdog_protocol::ThreadId;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::browser::RenderBrowserConfig;
    use crate::pool::tests::fake_binary;

    fn call(method: &str) -> ExtCall {
        ExtCall {
            thread: ThreadId::from("t"),
            method: method.into(),
            params: json!({ "m": method }),
            paths: Vec::new(),
        }
    }

    /// A pool that records what it was asked and answers with its name, or refuses.
    struct Stub {
        name: &'static str,
        log: Arc<Mutex<Vec<String>>>,
        refuse: Option<ExtError>,
        workers: Mutex<Vec<u32>>,
    }

    impl Stub {
        fn new(name: &'static str, log: &Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                name,
                log: log.clone(),
                refuse: None,
                workers: Mutex::new(vec![0, 1]),
            }
        }
    }

    struct Answer(Option<ExtFrame>);

    #[async_trait::async_trait]
    impl EventSource<ExtFrame> for Answer {
        async fn next(&mut self) -> Option<ExtFrame> {
            self.0.take()
        }
    }

    impl ExtPool for Stub {
        fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            self.log.lock().unwrap().push(format!("{}:call:{}", self.name, call.method));
            match &self.refuse {
                Some(error) => Err(error.clone()),
                None => Ok(Box::new(Answer(Some(ExtFrame::Done(Ok(json!(self.name))))))),
            }
        }

        fn status(&self) -> Vec<ExtWorkerStatus> {
            self.workers
                .lock().unwrap()
                .iter()
                .map(|&id| ExtWorkerStatus {
                    id: ExtWorkerId(id),
                    state: ExtWorkerState::Idle,
                })
                .collect()
        }

        fn stop_worker(&self, worker: ExtWorkerId) -> Result<(), ExtError> {
            self.log.lock().unwrap().push(format!("{}:stop:{}", self.name, worker.0));
            if self.workers.lock().unwrap().contains(&worker.0) {
                Ok(())
            } else {
                Err(ExtError::UnknownWorker)
            }
        }
    }

    async fn answer(pool: &impl ExtPool, method: &str) -> Result<Value, ExtError> {
        let mut stream = pool.call(call(method))?;
        loop {
            match stream.next().await {
                Some(ExtFrame::Done(result)) => return result,
                Some(ExtFrame::Chunk(_)) => {}
                None => panic!("the stream ended without a result"),
            }
        }
    }

    fn routed(native: Stub, node: Stub) -> RoutedExtPool<Stub> {
        RoutedExtPool::with_pools(native, node, ["read_docx", "read_image"])
    }

    #[tokio::test]
    async fn a_method_goes_to_the_pool_that_serves_it() {
        let log = Arc::default();
        let pool = routed(Stub::new("rust", &log), Stub::new("node", &log));
        assert_eq!(answer(&pool, "read_docx").await.unwrap(), json!("rust"));
        assert_eq!(answer(&pool, "read_image").await.unwrap(), json!("rust"));
        assert_eq!(answer(&pool, "office_open").await.unwrap(), json!("node"));
        assert_eq!(
            *log.lock().unwrap(),
            ["rust:call:read_docx", "rust:call:read_image", "node:call:office_open"]
        );
    }

    #[tokio::test]
    async fn a_missing_node_runtime_affects_only_node_methods() {
        let log = Arc::default();
        let mut node = Stub::new("node", &log);
        node.refuse = Some(ExtError::Unavailable { reason: "no node".into() });
        let pool = routed(Stub::new("rust", &log), node);
        assert_eq!(answer(&pool, "read_docx").await.unwrap(), json!("rust"));
        assert!(matches!(answer(&pool, "office_open").await, Err(ExtError::Unavailable { .. })));
    }

    #[tokio::test]
    async fn overloaded_of_one_pool_does_not_touch_the_other() {
        let log = Arc::default();
        let mut native = Stub::new("rust", &log);
        native.refuse = Some(ExtError::Overloaded);
        let pool = routed(native, Stub::new("node", &log));
        assert!(matches!(answer(&pool, "read_docx").await, Err(ExtError::Overloaded)));
        assert_eq!(answer(&pool, "office_open").await.unwrap(), json!("node"));
    }

    #[test]
    fn status_maps_full_width_child_ids_and_stop_routes_back() {
        let log = Arc::default();
        let native = Stub::new("rust", &log);
        *native.workers.lock().unwrap() = vec![0, 65536, u32::MAX];
        let node = Stub::new("node", &log);
        *node.workers.lock().unwrap() = vec![0, 65536, u32::MAX];
        let pool = routed(native, node);
        let ids: Vec<_> = pool.status().iter().map(|row| row.id).collect();
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 6);
        assert_eq!(pool.status().iter().map(|row| row.id).collect::<Vec<_>>(), ids);
        for id in ids {
            pool.stop_worker(id).unwrap();
        }
        assert_eq!(*log.lock().unwrap(), [
            "rust:stop:0", "rust:stop:65536", "rust:stop:4294967295",
            "node:stop:0", "node:stop:65536", "node:stop:4294967295",
        ]);
        let before = log.lock().unwrap().len();
        assert_eq!(pool.stop_worker(ExtWorkerId(9)), Err(ExtError::UnknownWorker));
        assert_eq!(pool.stop_worker(ExtWorkerId(u32::MAX)), Err(ExtError::UnknownWorker));
        assert_eq!(log.lock().unwrap().len(), before, "unknown public ids never reach either child");
    }

    #[test]
    fn restarted_workers_get_new_ids_and_stale_ids_keep_their_source_pool() {
        let log = Arc::default();
        let pool = routed(Stub::new("rust", &log), Stub::new("node", &log));
        let old: Vec<_> = pool.status().iter().map(|row| row.id).collect();
        *pool.native.workers.lock().unwrap() = vec![65536, 65537];
        *pool.node.workers.lock().unwrap() = vec![65536, 65537];
        // Before a status refresh, the child still receives only its original id.
        assert_eq!(pool.stop_worker(old[0]), Err(ExtError::UnknownWorker));
        assert_eq!(pool.stop_worker(old[2]), Err(ExtError::UnknownWorker));
        assert_eq!(*log.lock().unwrap(), ["rust:stop:0", "node:stop:0"]);
        log.lock().unwrap().clear();
        let current: Vec<_> = pool.status().iter().map(|row| row.id).collect();
        assert!(current.iter().all(|id| !old.contains(id)));
        for id in old {
            assert_eq!(pool.stop_worker(id), Err(ExtError::UnknownWorker));
        }
        for id in current {
            pool.stop_worker(id).unwrap();
        }
        assert_eq!(pool.worker_ids.lock().unwrap().actual.len(), 4, "dead routes were pruned");
        assert_eq!(pool.worker_ids.lock().unwrap().public.len(), 4);
        assert_eq!(*log.lock().unwrap(), [
            "rust:stop:65536", "rust:stop:65537", "node:stop:65536", "node:stop:65537",
        ]);
    }

    #[test]
    fn surviving_worker_ids_stay_stable_when_status_order_changes() {
        let log = Arc::default();
        let pool = routed(Stub::new("rust", &log), Stub::new("node", &log));
        let before = pool.status();
        *pool.native.workers.lock().unwrap() = vec![65536, 0];
        *pool.node.workers.lock().unwrap() = vec![1, 0];
        let after = pool.status();
        assert_ne!(after[0].id, before[1].id, "a replacement never reuses the departed worker's id");
        assert_eq!(after[1].id, before[0].id);
        assert_eq!(after[2].id, before[3].id);
        assert_eq!(after[3].id, before[2].id);
        assert_eq!(pool.stop_worker(before[1].id), Err(ExtError::UnknownWorker));
        pool.native.workers.lock().unwrap().clear();
        pool.node.workers.lock().unwrap().clear();
        assert!(pool.status().is_empty());
        assert!(pool.worker_ids.lock().unwrap().actual.is_empty());
        assert!(pool.worker_ids.lock().unwrap().public.is_empty());
    }

    #[test]
    fn public_id_exhaustion_never_wraps_or_aliases() {
        let mut ids = WorkerIds { next: u64::from(u32::MAX), ..WorkerIds::default() };
        let last = ids.publish(WorkerPool::Native, ExtWorkerId(65536));
        assert_eq!(last, ExtWorkerId(u32::MAX));
        assert_eq!(ids.publish(WorkerPool::Native, ExtWorkerId(65536)), last);
        let exhausted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ids.publish(WorkerPool::Node, ExtWorkerId(65536));
        }));
        assert!(exhausted.is_err());
        assert_eq!(ids.actual.len(), 1);
        assert_eq!(ids.public.len(), 1);
        assert_eq!(ids.actual[&last].1, ExtWorkerId(65536));
    }

    #[test]
    fn concurrent_arc_owners_share_one_stable_id_map() {
        let log = Arc::default();
        let pool = Arc::new(routed(Stub::new("rust", &log), Stub::new("node", &log)));
        assert_eq!(pool.stop_worker(ExtWorkerId(0)), Err(ExtError::UnknownWorker));
        let threads: Vec<_> = (0..8).map(|_| {
            let pool = Arc::clone(&pool);
            std::thread::spawn(move || {
                let ids: Vec<_> = pool.status().iter().map(|row| row.id).collect();
                pool.stop_worker(ids[0]).unwrap();
                pool.stop_worker(ids[2]).unwrap();
                ids
            })
        }).collect();
        let expected: Vec<_> = pool.status().iter().map(|row| row.id).collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), expected);
        }
        assert_eq!(log.lock().unwrap().iter().filter(|line| *line == "rust:stop:0").count(), 8);
        assert_eq!(log.lock().unwrap().iter().filter(|line| *line == "node:stop:0").count(), 8);
    }

    #[tokio::test]
    async fn dropping_a_stream_frees_the_pool_it_came_from() {
        let pool = RoutedExtPool::with_pools(MockExtPool::new(1), MockExtPool::new(1), ["read_docx"]);
        let held = pool.call(call("read_docx")).unwrap();
        assert!(matches!(pool.call(call("read_docx")), Err(ExtError::Overloaded)), "the Rust pool is full");
        let other = pool.call(call("office_open")).expect("the Node pool is not");
        assert!(matches!(pool.call(call("office_open")), Err(ExtError::Overloaded)));
        drop(held);
        let again = pool.call(call("read_docx")).expect("dropping the stream released the Rust pool's slot");
        assert!(
            matches!(pool.call(call("office_open")), Err(ExtError::Overloaded)),
            "the Node pool's slot is still held"
        );
        drop((other, again));
    }

    fn pool_config(browser: Option<RenderBrowserConfig>) -> ExtHostConfig {
        ExtHostConfig {
            program: fake_binary("ext_fake_worker"),
            args: Vec::new(),
            electron: false,
            workers: 1,
            pending_cap: 4,
            spawn_io: mixdog_rt::testing::tokens().spawn_io,
            render_browser: browser.unwrap_or(RenderBrowserConfig {
                command: None,
                profile_root: std::env::temp_dir().join("mixdog-exthost-routed-unused"),
                no_sandbox: false,
            }),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn both_pools_use_one_render_browser() {
        let browser = RenderBrowserConfig {
            command: Some((fake_binary("ext_fake_browser"), vec!["endpoint".into()])),
            profile_root: std::env::temp_dir().join("mixdog-exthost-routed"),
            no_sandbox: false,
        };
        // "browser" is the Rust pool's, "whoami" the Node pool's: each pool's own worker answers.
        let pool = RoutedExtPool::new(pool_config(Some(browser)), pool_config(None), ["browser"]).unwrap();
        let native = answer(&pool, "browser").await.unwrap();
        assert!(native.as_str().unwrap().starts_with("ws://127.0.0.1:9222/devtools/browser/fake-"));
        assert!(answer(&pool, "whoami").await.unwrap().is_u64());
        assert_eq!(pool.status().len(), 2, "one worker in each pool");
        // The Node pool's worker asks for the browser through its own pool: the same one answers.
        let node = ExtHostPool::sharing_browser(pool_config(None), &pool.native).unwrap();
        let mut stream = node.call(call("browser")).unwrap();
        let shared = loop {
            if let Some(ExtFrame::Done(result)) = stream.next().await {
                break result.unwrap();
            }
        };
        assert_eq!(shared, native, "one browser, one endpoint");
        assert_eq!(pool.browser_launches(), 1);
        assert_eq!(node.browser_launches(), 1);
        node.close().await;
        pool.close().await;
        assert!(pool.status().is_empty());
    }
}
