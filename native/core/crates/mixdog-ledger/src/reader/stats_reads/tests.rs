use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::ledger::UsageLedger;
use crate::reader::UsageReader;
use crate::refresh::{Pricer, UsageRefresher};
use crate::repair::{PriceRequest, Priced};
use crate::time::{day_key, local_midnight_ms, parse_day};
use crate::writer::UsageWriter;

type Gate = (&'static str, oneshot::Sender<()>);

#[derive(Default)]
pub(in crate::reader) struct Probe {
    reads: AtomicUsize,
    gates: OnceLock<mpsc::UnboundedSender<Gate>>,
}

impl Probe {
    pub(in crate::reader) fn count_read(&self) {
        self.reads.fetch_add(1, Ordering::Relaxed);
    }

    pub(in crate::reader) async fn pause(&self, point: &'static str) {
        if let Some(tx) = self.gates.get() {
            let (resume, wait) = oneshot::channel();
            tx.send((point, resume)).unwrap();
            wait.await.unwrap();
        }
    }
}

struct NoPrices;
impl Pricer for NoPrices {
    fn ready(&self) -> bool { false }
    fn revision(&self) -> String { String::new() }
    fn price(&self, _: &PriceRequest) -> crate::Result<Priced> { unreachable!() }
}

fn ledger() -> (UsageLedger, tempfile::TempDir) {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    (UsageLedger {
        writer: UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap(),
        reader: UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io),
        refresher: UsageRefresher::new(Arc::new(NoPrices), tokens.cpu_bulk),
    }, dir)
}

async fn ask(ledger: &UsageLedger, view: &str, now: i64) -> Value {
    ledger.get_usage_stats(serde_json::from_value(json!({"view": view})).unwrap(), || now).await.unwrap()
}

#[tokio::test]
async fn a_statistics_request_uses_its_own_clock_and_ledger_window() {
    let (ledger, _dir) = ledger();
    let midnight = local_midnight_ms(parse_day("2026-06-10").unwrap());
    let before = midnight + 3_600_000;
    let event = before - 86_400_000;
    ledger.writer.record_queued(serde_json::from_value(json!({
        "id":"edge", "ts":event, "day":day_key(event), "provider":"p", "model":"m", "kind":"api",
        "sessionId":"s", "sourceType":"user", "input":1, "output":1, "costUsd":0.1,
        "costSource":"catalog", "origin":"live", "durationMs":1, "cacheRead":0, "cacheWrite":0
    })).unwrap()).await.unwrap();

    let a = ask(&ledger, "hour", before).await;
    let b = ask(&ledger, "hour", before + 1).await;
    assert_eq!(a["totals"]["turns"], 1);
    assert_eq!(b["totals"]["turns"], 0);
    assert_eq!(b["period"]["fromMs"], event + 1);
    assert_eq!(b["period"]["toMs"], before + 1);
    assert_eq!(b["generatedAt"], before + 1);
    let yesterday = ask(&ledger, "day", midnight - 1).await;
    let today = ask(&ledger, "day", midnight).await;
    assert_eq!(yesterday["period"]["endDay"], "2026-06-09");
    assert_eq!(today["period"]["endDay"], "2026-06-10");
    assert_eq!(ledger.reader.probe.reads.load(Ordering::Relaxed), 4);
}

async fn gate(rx: &mut mpsc::UnboundedReceiver<Gate>, point: &str, call: &mut JoinHandle<Value>) -> oneshot::Sender<()> {
    tokio::select! {
        event = rx.recv() => {
            let (got, resume) = event.unwrap();
            assert_eq!(got, point);
            resume
        }
        result = call => panic!("call finished before {point}: {result:?}"),
    }
}

async fn answer(rx: &mut mpsc::UnboundedReceiver<Gate>, call: JoinHandle<Value>) -> Value {
    tokio::select! {
        result = call => result.unwrap(),
        event = rx.recv() => panic!("unexpected second read or wait: {}", event.unwrap().0),
    }
}

#[tokio::test]
async fn overlapping_statistics_requests_receive_their_own_stamps_read_once() {
    let (ledger, _dir) = ledger();
    ledger.writer.put_note("liveSince", "1000".into()).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    ledger.reader.probe.gates.set(tx).unwrap();
    let noon = local_midnight_ms(parse_day("2026-06-10").unwrap()) + 43_200_000;
    let start = |offset| {
        let ledger = ledger.clone();
        tokio::spawn(async move { ask(&ledger, "day", noon + offset).await })
    };

    let mut a = start(0);
    gate(&mut rx, "claim", &mut a).await.send(()).unwrap();
    let publish_a = gate(&mut rx, "publish", &mut a).await;
    // Both callers already took the old stamp. One reaches the decision during A's
    // flight; the other reaches it after A has published.
    let mut b = start(20_000);
    let claim_b = gate(&mut rx, "claim", &mut b).await;
    let mut c = start(1);
    let claim_c = gate(&mut rx, "claim", &mut c).await;
    ledger.writer.put_note("liveSince", "2000".into()).await.unwrap();
    let mut d = start(2);
    gate(&mut rx, "claim", &mut d).await.send(()).unwrap();
    let publish_d = gate(&mut rx, "publish", &mut d).await;
    claim_b.send(()).unwrap();
    let receive_b = gate(&mut rx, "joined", &mut b).await;
    publish_a.send(()).unwrap();
    assert_eq!(answer(&mut rx, a).await["coverage"]["liveSince"], 1000);
    claim_c.send(()).unwrap();
    assert_eq!(answer(&mut rx, c).await["coverage"]["liveSince"], 1000);
    publish_d.send(()).unwrap();
    assert_eq!(answer(&mut rx, d).await["coverage"]["liveSince"], 2000);
    // D has replaced A's completed read. B must receive A's input directly, not
    // look in the cache or perform another SQL read after being woken.
    receive_b.send(()).unwrap();
    let b = answer(&mut rx, b).await;
    assert_eq!(b["coverage"]["liveSince"], 1000);
    assert_eq!(b["generatedAt"], noon + 20_000);
    assert_eq!(b["period"]["toMs"], noon + 20_000);
    assert_eq!(ledger.reader.probe.reads.load(Ordering::Relaxed), 2);
}
