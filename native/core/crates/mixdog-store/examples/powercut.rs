//! Power-cut harness driver (SM §11.8 §7), run by `powercut/run.sh` on a dm-log-writes
//! device inside a privileged Linux container.
//!
//! `powercut write <data_dir> <batches>`: appends batches to one session and prints
//! `acked <n>` after each barrier returns (n = items acknowledged so far). The script
//! inserts a dm-log-writes mark per line, so the mark proves what was promised durable.
//!
//! `powercut verify <data_dir> <acked>`: opens the session as the core does after a crash
//! and exits non-zero unless the log is clean or torn (never damaged) and holds at least
//! the first `acked` items, in order.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness binary")]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::testing::tokens;
use mixdog_store::blobs::BlobStore;
use mixdog_store::encode::Encoded;
use mixdog_store::fold::NoIndex;
use mixdog_store::log::*;
use mixdog_store::schema::checkpoint::FramePos;
use mixdog_store::schema::record::Record;
use serde_json::json;

const SESSION: &str = "powercut";

fn rec(v: serde_json::Value) -> Encoded {
    Encoded::new(serde_json::from_value(v).expect("record"), Vec::new()).expect("encodes")
}

fn item(n: u64) -> Encoded {
    // ~20 KiB bodies: a run crosses checkpoints (1 MiB) within a few hundred batches.
    let body = format!("{n:08}:{}", "p".repeat(20 * 1024));
    rec(json!({"k":"item","iid":format!("i{n}"),"role":"user","form":"message","model":true,"visible":true,
        "refs":[],"body":{"inline":{"content":body,"role":"user"}}}))
}

async fn on_lane<R: Send + 'static>(f: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokens().durability_io.submit(&CancellationToken::new(), f).expect("lane").await.expect("job ran")
}

fn deps(data: &Path) -> WriterDeps {
    WriterDeps {
        io: Arc::new(OsIo),
        blobs: BlobStore::new(data),
        ownership: Arc::new(MockOwnership::default()),
        index: Arc::new(NoIndex),
    }
}

async fn write(data: PathBuf, batches: u64) {
    let dir = data.join("sessions").join(SESSION);
    let session = rec(json!({"k":"session","v":2,"id":SESSION,"log_id":"0123456789abcdef01234567",
        "header":{"inline":{"title":"powercut"}}}));
    let d = deps(&data);
    let (mut w, _) = on_lane(move |l| LogWriter::create(l, &dir, session, d).expect("create")).await;
    let mut out = std::io::stdout().lock();
    let mut n = 0u64;
    for b in 0..batches {
        let size = 1 + b % 7;
        let batch: Vec<Encoded> = (n..n + size).map(item).collect();
        w = on_lane(move |l| {
            let mut w = w;
            w.append_barrier(l, batch).expect("barrier");
            w
        })
        .await;
        n += size;
        writeln!(out, "acked {n}").expect("stdout");
        out.flush().expect("stdout");
    }
}

async fn verify(data: PathBuf, acked: u64) -> Result<(), String> {
    let dir = data.join("sessions").join(SESSION);
    if acked == 0 && !dir.exists() {
        return Ok(());
    }
    let blobs = BlobStore::new(&data);
    on_lane(move |l| {
        let opened = open_log(l, &dir, &blobs, &NoIndex).map_err(|e| e.to_string())?;
        if let LogStatus::Damaged(damage) = opened.status {
            return Err(format!("damaged at {damage:?}"));
        }
        // Every committed item, in order, from the session frame.
        let mut pos = FramePos { ordinal: 0, file_no: 0, offset: 0 };
        let mut items = 0u64;
        loop {
            let read = read_forward(l, &dir, pos, 8 << 20).map_err(|e| e.to_string())?;
            for (record, _, _) in &read.frames {
                if let Record::Item(i) = record {
                    if i.iid.as_str() != format!("i{items}") {
                        return Err(format!("item {} out of order", i.iid.as_str()));
                    }
                    items += 1;
                }
            }
            match read.next {
                ForwardEnd::More(next) => pos = next,
                ForwardEnd::Done { .. } => break,
                ForwardEnd::Damaged(d) => return Err(format!("damaged at {d:?}")),
            }
        }
        if items < acked {
            return Err(format!("{items} items survive, {acked} were acknowledged"));
        }
        if items != opened.fold.rows {
            return Err(format!("open folded {} rows, the scan found {items}", opened.fold.rows));
        }
        println!("ok: {items} items, {acked} acked, status {:?}", opened.status);
        Ok(())
    })
    .await
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    match (args.get(1).map(String::as_str), args.get(2), args.get(3)) {
        (Some("write"), Some(dir), Some(n)) => write(dir.into(), n.parse().expect("batches")).await,
        (Some("verify"), Some(dir), Some(n)) => {
            if let Err(e) = verify(dir.into(), n.parse().expect("acked")).await {
                eprintln!("FAIL: {e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("usage: powercut write <data_dir> <batches> | verify <data_dir> <acked>");
            std::process::exit(2);
        }
    }
}
