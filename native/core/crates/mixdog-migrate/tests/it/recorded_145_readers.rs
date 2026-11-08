//! The Rust core's readers over the migrated 1.4.5 directory, set against what 1.4.5 itself answered for the same
//! data (`answers.json`, recorded by `benchmarks/rust-core/recorders/record-migration-145.mjs`).

use std::sync::Arc;

use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::refresh::Pricer;
use mixdog_ledger::refresh::UsageRefresher;
use mixdog_ledger::repair::PriceRequest;
use mixdog_ledger::repair::Priced;
use mixdog_ledger::stats::UsageStatsOptions;
use mixdog_ledger::writer::UsageWriter;
use serde_json::Value;

#[path = "../support/recorded_145.rs"]
mod harness;
use harness::*;

/// The recording ran offline: 1.4.5 had no price catalog, so a record is priced as it was stored or not at all.
struct NoCatalog;

impl Pricer for NoCatalog {
    fn revision(&self) -> String {
        String::new()
    }

    fn price(&self, _: &PriceRequest) -> mixdog_ledger::Result<Priced> {
        Ok(Priced { cost_usd: None, rates: None })
    }
}

fn open_migrated_ledger(copy: &Copy) -> UsageLedger {
    let tokens = mixdog_rt::testing::tokens();
    let path = copy.roots.data.join("usage").join("ledger.sqlite");
    let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).expect("the migrated ledger opens");
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let refresher = UsageRefresher::new(Arc::new(NoCatalog), tokens.cpu_bulk);
    UsageLedger { writer, reader, refresher }
}

fn recorded(answer_key: &str) -> Vec<(Value, Value)> {
    answers()[answer_key]
        .as_array()
        .unwrap_or_else(|| panic!("{answer_key} is recorded"))
        .iter()
        .map(|a| (a["options"].clone(), a["answer"].clone()))
        .collect()
}

#[tokio::test]
async fn usage_stats_on_the_migrated_ledger_are_what_1_4_5_answered() {
    let (copy, _) = migrated();
    let ledger = open_migrated_ledger(&copy);
    let all = recorded("usageStats");
    assert!(all.iter().any(|(o, _)| o["view"] == "hour"), "the hour view is recorded");
    for (options, want) in all {
        let now = want["generatedAt"].as_i64().expect("generatedAt");
        let asked: UsageStatsOptions = serde_json::from_value(options.clone()).expect("options");
        let got = ledger.get_usage_stats(asked, || now).await.expect("usage stats");
        assert_eq!(got, want, "usage stats for {options}");
    }
}
