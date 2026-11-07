//! The process's usage ledger (`runtime/shared/llm/usage-ledger.mjs`: `usageLedgerPath`,
//! `getUsageLedger`, `usageLedgerIfOpen`, `closeUsageLedgers`), and the per-send source of
//! `ProcessInputs.ledger`.
//!
//! One [`UsageLedger`] (writer, reader, refresher) per ledger path, opened on first use and kept
//! until [`close_all`](LedgerSource::close_all). The accounting of a send and the usage reads
//! both get it from here, so they see one store. Node's `NODE_TEST_CONTEXT` rule (no ledger
//! under its own test runner) has no counterpart: a Rust test names the path it wants.
//!
//! Pricing needs no ordering with the catalog. A send's row is priced by the accounting's
//! `CatalogPricing` and a cold catalog records it unpriced, as Node's `priceUsage` does; the
//! refresh that prices such rows later runs on `CatalogPricer::ungated` (see `pricer`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_ai::registry::accounting::{UsageRow, UsageSink};
use mixdog_ai::registry::keys::Environment;
use mixdog_ledger::error::LedgerError;
use mixdog_ledger::error::Result;
use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::refresh::{Pricer, UsageRefresher};
use mixdog_ledger::writer::UsageWriter;
use mixdog_rt::LaneTokens;

use super::accounting_scope::LedgerSink;

/// `process.env.MIXDOG_USAGE_LEDGER_PATH`.
pub const LEDGER_PATH_ENV: &str = "MIXDOG_USAGE_LEDGER_PATH";

const IN_MEMORY: &str = ":memory:";

pub struct LedgerSource {
    env: Arc<dyn Environment>,
    plugin_data: PathBuf,
    lanes: LaneTokens,
    pricer: Arc<dyn Pricer>,
    stores: Mutex<HashMap<PathBuf, Arc<UsageLedger>>>,
}

impl LedgerSource {
    /// `plugin_data` is `resolvePluginData()`; `pricer` is what the refresher prices unpriced
    /// records with: `CatalogPricer::ungated(&catalog)`, which works on a cold catalog.
    pub fn new(env: Arc<dyn Environment>, plugin_data: PathBuf, lanes: LaneTokens, pricer: Arc<dyn Pricer>) -> Arc<Self> {
        Arc::new(Self { env, plugin_data, lanes, pricer, stores: Mutex::default() })
    }

    fn stores(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Arc<UsageLedger>>> {
        self.stores.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `usageLedgerPath()`: the environment's path when it is set and not empty, else
    /// `<plugin data>/usage/ledger.sqlite`. Read at every call, as Node reads `process.env`.
    pub fn path(&self) -> PathBuf {
        match self.env.var(LEDGER_PATH_ENV) {
            Some(path) if !path.is_empty() => PathBuf::from(path),
            _ => self.plugin_data.join("usage").join("ledger.sqlite"),
        }
    }

    /// `getUsageLedger()`: the ledger of the current path, opened (its directory made, its file
    /// created and upgraded) when this is the first ask. An open that fails is an error and
    /// leaves nothing stored, so the next ask tries again.
    pub async fn get(&self) -> Result<Arc<UsageLedger>> {
        self.get_at(self.path()).await
    }

    /// [`get`](Self::get) for a path read earlier (a send reads it when it starts).
    async fn get_at(&self, path: PathBuf) -> Result<Arc<UsageLedger>> {
        if let Some(open) = self.stores().get(&path) {
            return Ok(open.clone());
        }
        // The directory is made on the durability lane before the store is touched: no lock is held across the wait.
        if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()).map(Path::to_owned) {
            mixdog_core_base::support::on_lane(self.lanes.durability_io, &mixdog_rt::CancellationToken::new(), move |lane| mixdog_statefile::create_private_dir_all(lane, &dir))
                .await
                .map_err(|error| LedgerError::Io(std::io::Error::other(error.to_string())))??;
        }
        let mut stores = self.stores();
        if let Some(open) = stores.get(&path) {
            return Ok(open.clone());
        }
        let ledger = self.open(&path)?;
        stores.insert(path, ledger.clone());
        Ok(ledger)
    }

    /// `usageLedgerIfOpen()`: the ledger this process already has open at the current path;
    /// asking never opens one.
    pub fn if_open(&self) -> Option<Arc<UsageLedger>> {
        self.stores().get(&self.path()).cloned()
    }

    /// `closeUsageLedgers()`: releases every open ledger. Writers stop once their last holder
    /// lets go; the next [`get`](Self::get) reopens.
    pub fn close_all(&self) {
        self.stores().clear();
    }

    fn open(&self, path: &Path) -> Result<Arc<UsageLedger>> {
        // Node's `:memory:` ledger is one connection shared by its reads and writes, reachable
        // only by a test naming it. This crate's writer and reader hold their own connections, so
        // two in-memory databases would take the rows and answer every read empty: refuse.
        if path == Path::new(IN_MEMORY) {
            return Err(LedgerError::Invalid("a ledger file path (an in-memory ledger is not supported)"));
        }
        let writer = UsageWriter::open(self.lanes.sqlite_writer_thread, self.lanes.maintenance_io, path)?;
        let reader = UsageReader::new(path, self.lanes.interactive_io, self.lanes.maintenance_io);
        let refresher = UsageRefresher::new(self.pricer.clone(), self.lanes.cpu_bulk);
        Ok(Arc::new(UsageLedger { writer, reader, refresher }))
    }

    /// The `ProcessInputs.ledger` closure, read per send: a sink that opens the ledger of the path read now when it records (Node's
    /// `recordUsage` calls `getUsageLedger()` then). A ledger that cannot open fails every row with that error, as
    /// `accountProviderSend` rethrows `openingError` when it records.
    pub fn sink(self: &Arc<Self>) -> Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync> {
        let source = self.clone();
        Arc::new(move || Some(Arc::new(OpeningSink { source: source.clone(), path: source.path() }) as Arc<dyn UsageSink>))
    }
}

/// The usage services ask for the ledger per call, as Node calls `getUsageLedger()`: the same source
/// that opens it for the sends and the quota history, so every reader sees one ledger per path.
#[async_trait]
impl mixdog_core_domains::domains::ai_account::usage::LedgerAccess for LedgerSource {
    async fn ledger(&self) -> Result<Arc<UsageLedger>> {
        self.get().await
    }
}

/// The sink of one send: the ledger opens when the row is recorded.
struct OpeningSink {
    source: Arc<LedgerSource>,
    path: PathBuf,
}

#[async_trait]
impl UsageSink for OpeningSink {
    async fn record_queued(&self, row: UsageRow) -> std::result::Result<(), String> {
        let ledger = self.source.get_at(self.path.clone()).await.map_err(|error| error.to_string())?;
        LedgerSink(ledger.writer.clone()).record_queued(row).await
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use mixdog_ledger::refresh::Pricer;
    use mixdog_ledger::repair::{PriceRequest, Priced};
    use serde_json::Value;

    use super::*;

    const TWIN: &str = include_str!("../../../../fixtures/ai-admin/usage-ledger-source-twin.json");

    struct NoPrices;

    impl Pricer for NoPrices {
        fn revision(&self) -> String {
            String::new()
        }

        fn price(&self, _: &PriceRequest) -> Result<Priced> {
            Err(mixdog_ledger::LedgerError::Invalid("a price"))
        }
    }

    fn row() -> UsageRow {
        UsageRow {
            ts: 1,
            day: "1970-01-01".into(),
            provider: "p".into(),
            model: "m".into(),
            kind: "api".into(),
            session_id: "s".into(),
            owner_session_id: None,
            source_type: String::new(),
            input: 1.0,
            output: 1.0,
            cache_read: 0.0,
            cache_write: 0.0,
            cost_usd: None,
            cost_source: "unpriced".into(),
            rates: None,
            response_id: String::new(),
            account: String::new(),
            origin: String::new(),
            duration_ms: 0.0,
            requested_model: "m".into(),
            requested_provider: "p".into(),
            status: "ok".into(),
            attempts: 1,
            ttft_ms: None,
            elapsed_ms: 0.0,
            id: "row-1".into(),
        }
    }

    /// The process environment the script changes.
    #[derive(Default)]
    struct Vars(Mutex<HashMap<String, String>>);

    impl Environment for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0.lock().unwrap().get(name).cloned()
        }
    }

    fn shown(path: &Path, root: &Path) -> String {
        let text = path.to_string_lossy().replace('\\', "/");
        text.replacen(&root.to_string_lossy().replace('\\', "/"), "<root>", 1)
    }

    /// Node's recorder runs with `MIXDOG_DATA_DIR` = `<root>/mixdog_data_dir`.
    #[tokio::test]
    async fn the_ledger_source_acts_as_nodes_get_usage_ledger() {
        let twin: Value = serde_json::from_str(TWIN).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let mut opened = 0;
        for (n, flow) in twin["flows"].as_array().unwrap().iter().enumerate() {
            let root = tempfile::tempdir().unwrap();
            let vars = Arc::new(Vars::default());
            let source = LedgerSource::new(vars.clone(), root.path().join("mixdog_data_dir"), tokens, Arc::new(NoPrices));
            let mut seen: Vec<Arc<UsageLedger>> = Vec::new();
            for (s, step) in flow["steps"].as_array().unwrap().iter().enumerate() {
                let at = format!("flow {n} step {s} {}", step["op"]);
                match step["op"].as_str().unwrap() {
                    "env" => {
                        let mut vars = vars.0.lock().unwrap();
                        match step["value"].as_str() {
                            None => vars.remove(LEDGER_PATH_ENV),
                            Some("") => vars.insert(LEDGER_PATH_ENV.into(), String::new()),
                            Some(name) => vars.insert(LEDGER_PATH_ENV.into(), root.path().join("led").join(name).join("ledger.sqlite").to_string_lossy().into_owned()),
                        };
                    }
                    "path" => assert_eq!(shown(&source.path(), root.path()), step["path"].as_str().unwrap(), "{at}"),
                    "close" => {
                        source.close_all();
                        seen.clear();
                    }
                    op => {
                        let got = if op == "get" { Some(source.get().await.unwrap()) } else { source.if_open() };
                        assert_eq!(got.is_some(), step["open"].as_bool().unwrap(), "{at} open");
                        let Some(got) = got else { continue };
                        let instance = seen.iter().position(|known| Arc::ptr_eq(known, &got)).unwrap_or_else(|| {
                            seen.push(got.clone());
                            seen.len() - 1
                        });
                        assert_eq!(instance as u64, step["instance"].as_u64().unwrap(), "{at} instance");
                        assert_eq!(shown(&source.path(), root.path()), step["path"].as_str().unwrap(), "{at} path");
                        assert!(source.path().exists() == step["fileExists"].as_bool().unwrap(), "{at} file");
                        opened += 1;
                    }
                }
            }
            source.close_all();
        }
        assert!(opened >= 200, "the recording opens ledgers: {opened}");
        assert_eq!(twin["defaultPath"], "<root>/mixdog_data_dir/usage/ledger.sqlite");
    }

    #[tokio::test]
    async fn a_sends_row_reaches_the_ledger_the_source_opened_and_a_failed_open_fails_the_row() {
        let root = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let source = LedgerSource::new(Arc::new(Vars::default()), root.path().join("data"), tokens, Arc::new(NoPrices));
        let sink = source.sink()().unwrap();
        assert!(source.if_open().is_none(), "the ledger opens when the first row is recorded");
        sink.record_queued(row()).await.unwrap();
        assert!(source.if_open().is_some(), "the first send opens the ledger");
        assert!(root.path().join("data").join("usage").join("ledger.sqlite").exists());
        assert!(Arc::ptr_eq(&source.get().await.unwrap(), &source.if_open().unwrap()), "one ledger for the accounting and the reads");
        drop(sink);
        // A path whose parent is a file cannot be opened: every row fails with that error.
        let file = root.path().join("file");
        std::fs::write(&file, "x").unwrap();
        let vars = Arc::new(Vars::default());
        vars.0.lock().unwrap().insert(LEDGER_PATH_ENV.into(), file.join("ledger.sqlite").to_string_lossy().into_owned());
        let broken = LedgerSource::new(vars, root.path().join("data2"), tokens, Arc::new(NoPrices));
        let sink = broken.sink()().unwrap();
        assert!(sink.record_queued(row()).await.is_err());
        assert!(broken.if_open().is_none(), "a failed open stores nothing");
        // Node's test-only in-memory ledger is refused, not half-supported.
        let memory = Arc::new(Vars::default());
        memory.0.lock().unwrap().insert(LEDGER_PATH_ENV.into(), IN_MEMORY.into());
        let memory = LedgerSource::new(memory, root.path().join("data3"), tokens, Arc::new(NoPrices));
        assert!(memory.get().await.is_err() && memory.if_open().is_none());
    }
}