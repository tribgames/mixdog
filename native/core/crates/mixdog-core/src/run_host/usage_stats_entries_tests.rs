//! The statistics entry of the `usage` section, as a ledger source publishes it: the question the statistics dialog asks
//! (hour view), answered over the ledger as it stands, once when the ledger opens and again when committed records move the
//! figures. The expected figures are summed here from the rows written.

use std::sync::Arc;

use mixdog_ai::registry::keys::Environment;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_session::session::testing::awaiting;
use mixdog_ledger::LedgerError;
use mixdog_ledger::refresh::Pricer;
use mixdog_ledger::repair::PriceRequest;
use mixdog_ledger::repair::Priced;
use mixdog_protocol::SectionName;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use super::ledger_source::LedgerSource;
use super::usage_stats_feed::REFRESH_INTERVAL;
use super::usage_stats_feed::STATS_KEY;
use super::usage_stats_feed::UsagePush;

/// 2026-01-01T12:00:00Z.
const NOW: i64 = 1_767_268_800_000;

type Published = (SectionName, Option<String>, SectionChange);

struct Seen(mpsc::UnboundedSender<Published>);

impl StatePublisher for Seen {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        self.0.send((section, key, change)).unwrap();
    }
}

struct NoEnv;

impl Environment for NoEnv {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

/// Every row written here carries its own cost: nothing is priced.
struct NoPrices;

impl Pricer for NoPrices {
    fn revision(&self) -> String {
        String::new()
    }

    fn price(&self, _: &PriceRequest) -> mixdog_ledger::error::Result<Priced> {
        Err(LedgerError::Invalid("a price"))
    }
}

fn row(id: &str, minutes_before_now: i64, session: &str, input: u32, output: u32, cost: f64) -> Value {
    json!({
        "id": id, "ts": NOW - minutes_before_now * 60_000, "day": "2026-01-01", "provider": "p", "model": "m", "kind": "api",
        "sessionId": session, "sourceType": "user", "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
        "costUsd": cost, "costSource": "catalog", "origin": "live", "durationMs": 100,
    })
}

/// The statistics entry a published message carries.
fn stats(published: Published) -> Value {
    let (section, key, change) = published;
    assert_eq!((section, key.as_deref()), (SectionName::Usage, Some(STATS_KEY)));
    let SectionChange::Set(bytes) = change else { panic!("the statistics fit the inline limit") };
    serde_json::from_slice(&bytes).expect("a JSON entry")
}

#[tokio::test(start_paused = true)]
async fn the_statistics_entry_is_published_when_the_ledger_opens_and_again_with_the_committed_figures() {
    let (sender, mut published) = mpsc::unbounded_channel();
    let clock: super::usage_stats_feed::Clock = Arc::new(|| NOW);
    let push = UsagePush::new(Arc::new(Seen(sender)), clock);
    let root = tempfile::tempdir().expect("a data dir");
    let source = LedgerSource::new(Arc::new(NoEnv), root.path().join("data"), mixdog_rt::testing::tokens(), Arc::new(NoPrices), push);
    let ledger = source.get().await.expect("the ledger opens");
    ledger.writer.sums_built().await.expect("the sums are built");

    let opened = stats(awaiting(|| "the statistics entry of the opened ledger".to_owned(), published.recv()).await.expect("an entry"));
    assert_eq!(opened["generatedAt"].as_f64(), Some(NOW as f64));
    assert_eq!(opened["period"]["view"], "hour", "the dialog's own question");
    assert_eq!(opened["totals"]["turns"].as_f64(), Some(0.0));

    // The interval since the opening read has passed, so the committed change is read at once.
    tokio::time::advance(REFRESH_INTERVAL).await;
    // Queued together, so the writer is idle only after the last one: the change it signals covers all three.
    let queued: Vec<_> = [row("r1", 10, "s1", 100, 40, 0.5), row("r2", 5, "s1", 20, 10, 0.25), row("r3", 1, "s2", 30, 5, 0.125)]
        .into_iter()
        .map(|record| ledger.writer.record_queued(serde_json::from_value(record).expect("a usage record")))
        .collect();
    ledger.writer.settle_writes().await.expect("settled");
    for outcome in queued {
        outcome.await.expect("recorded");
    }

    let moved = stats(awaiting(|| "the statistics entry after the commit".to_owned(), published.recv()).await.expect("an entry"));
    let totals = &moved["totals"];
    assert_eq!(
        (totals["turns"].as_f64(), totals["sessions"].as_f64(), totals["input"].as_f64(), totals["output"].as_f64(), totals["costUsd"].as_f64()),
        (Some(3.0), Some(2.0), Some(150.0), Some(55.0), Some(0.875)),
        "three turns of two sessions: 100+20+30 in, 40+10+5 out, 0.5+0.25+0.125 dollars"
    );
    assert_eq!(totals["costKnownTurns"].as_f64(), Some(3.0), "every row carried its cost");
    assert!(published.try_recv().is_err(), "the commit is one publication");
    source.close_all();
}
