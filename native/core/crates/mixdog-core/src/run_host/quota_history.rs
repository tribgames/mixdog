//! The production `QuotaHistory` of the plan-usage measurement: `recordQuotaQueued(samples)` on the
//! usage ledger (`providers/lib/quota-readings.mjs`). The ledger is opened at the write, through
//! the one [`LedgerSource`] every usage read shares, as Node's `getUsageLedger()` is called then.
//! A failed open or write is the caller's log line; the measurement never fails on it.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::oauth_usage::QuotaHistory;
use mixdog_ai::service::oauth_usage::QuotaSample as Sample;
use mixdog_ledger::quota::QuotaReading;
use mixdog_ledger::quota::QuotaSample;

use super::ledger_source::LedgerSource;

pub struct LedgerQuotaHistory {
    source: Arc<LedgerSource>,
}

impl LedgerQuotaHistory {
    pub fn new(source: Arc<LedgerSource>) -> Self {
        Self { source }
    }
}

fn reading(sample: Sample) -> QuotaReading {
    QuotaReading {
        provider: sample.provider,
        account: sample.account,
        label: sample.label,
        sample: QuotaSample { ts: sample.ts, used_pct: sample.used_pct, reset_at: sample.reset_at },
    }
}

#[async_trait]
impl QuotaHistory for LedgerQuotaHistory {
    async fn record(&self, samples: Vec<Sample>) -> Result<(), String> {
        let ledger = self.source.get().map_err(|e| e.to_string())?;
        ledger.writer.record_quota_queued(samples.into_iter().map(reading).collect()).await.map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::collections::HashMap;

    use mixdog_ai::registry::keys::Environment;
    use mixdog_ledger::quota::QuotaHistoryOptions;
    use mixdog_ledger::refresh::Pricer;
    use mixdog_ledger::repair::PriceRequest;
    use mixdog_ledger::repair::Priced;
    use serde_json::Value;
    use serde_json::json;

    use super::*;

    // Test files go through the durability lane and `mixdog_statefile`, as the tree's other tests do.
    fn on_lane<R: Send + 'static>(job: impl FnOnce(&mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
        use futures::FutureExt as _;
        use mixdog_rt::LaneToken as _;
        tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&mixdog_rt::CancellationToken::new(), job).unwrap())
            .now_or_never()
            .expect("the test backend runs the job inline")
            .unwrap()
    }

    fn write_file(path: &std::path::Path, body: &[u8]) {
        let (path, body) = (path.to_owned(), body.to_vec());
        on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())).unwrap();
    }

    const TWIN: &str = include_str!("../../../../fixtures/usage-ports/usage-ports-twin.json");

    struct NoPrices;

    impl Pricer for NoPrices {
        fn revision(&self) -> String {
            String::new()
        }

        fn price(&self, _: &PriceRequest) -> mixdog_ledger::error::Result<Priced> {
            Err(mixdog_ledger::error::LedgerError::Invalid("a price"))
        }
    }

    struct Vars(HashMap<String, String>);

    impl Environment for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    /// The samples Node's usage fetch handed its ledger land in the ledger the source opens, and come
    /// back through the same reader the subscription view uses.
    #[tokio::test]
    async fn the_samples_nodes_fetch_recorded_are_stored_through_the_shared_source() {
        let twin: Value = serde_json::from_str(TWIN).unwrap();
        let root = tempfile::tempdir().unwrap();
        let source = LedgerSource::new(Arc::new(Vars(HashMap::new())), root.path().join("mixdog_data_dir"), mixdog_rt::testing::tokens(), Arc::new(NoPrices));
        let history = LedgerQuotaHistory::new(source.clone());
        let mut stored = 0;
        for flow in twin["flows"].as_array().unwrap() {
            for batch in flow["history"].as_array().into_iter().flatten() {
                let samples: Vec<Sample> = batch
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| Sample {
                        provider: s["provider"].as_str().unwrap().to_owned(),
                        account: s["account"].as_str().unwrap().to_owned(),
                        label: s["label"].as_str().unwrap().to_owned(),
                        ts: s["ts"].as_i64().unwrap(),
                        used_pct: s["usedPct"].as_f64().unwrap(),
                        reset_at: s["resetAt"].as_i64(),
                    })
                    .collect();
                history.record(samples.clone()).await.unwrap();
                let ledger = source.get().unwrap();
                ledger.writer.settle_writes().await.unwrap();
                for sample in &samples {
                    let options: QuotaHistoryOptions = serde_json::from_value(json!({ "provider": sample.provider, "account": sample.account, "window": sample.label })).unwrap();
                    let page = ledger.reader.quota_history(options, BTreeMap::new(), sample.ts + 1).await.unwrap();
                    // Stored = the reader selects exactly this series. Not the points: a lone reading whose window
                    // has no reset ends where it starts, and Node's `overlapping` (usage-ledger-quota.mjs:893,
                    // `endMs > domainFrom`) shows no window for it.
                    assert_eq!(
                        page["selection"],
                        json!({ "provider": sample.provider, "account": sample.account, "label": sample.label }),
                        "{} {} {} is stored",
                        sample.provider,
                        sample.account,
                        sample.label
                    );
                    stored += 1;
                }
            }
        }
        assert!(stored >= 10, "the recording hands the ledger samples: {stored}");
    }

    #[tokio::test]
    async fn a_ledger_that_cannot_open_fails_the_record_with_the_open_error() {
        let root = tempfile::tempdir().unwrap();
        let blocker = root.path().join("file");
        write_file(&blocker, b"x");
        let vars = Vars(HashMap::from([("MIXDOG_USAGE_LEDGER_PATH".to_owned(), blocker.join("sub").join("ledger.sqlite").to_string_lossy().into_owned())]));
        let source = LedgerSource::new(Arc::new(vars), root.path().to_path_buf(), mixdog_rt::testing::tokens(), Arc::new(NoPrices));
        let sample = Sample { provider: "p".into(), account: "a".into(), label: "5H".into(), ts: 1, used_pct: 1.0, reset_at: None };
        assert!(LedgerQuotaHistory::new(source).record(vec![sample]).await.is_err());
    }
}
