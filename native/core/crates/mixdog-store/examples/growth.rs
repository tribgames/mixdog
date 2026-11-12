//! Measures one session driven through a long life with the store's save path: stored bytes against the live
//! session's bytes, and the time and peak heap of open, load (head + tail) and a transcript page read.
//!
//! `growth <data_dir> <messages> <patches_per_message> <compact_every>`
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "measurement binary")]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Instant;

use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::testing::tokens;
use mixdog_store::blobs::BlobStore;
use mixdog_store::encode::Encoded;
use mixdog_store::encode::encode_record;
use mixdog_store::fold::NoIndex;
use mixdog_store::log::*;
use serde_json::json;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let now = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
        PEAK.fetch_max(now, Ordering::Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static A: Counting = Counting;

fn rec(v: serde_json::Value) -> Encoded {
    encode_record(serde_json::from_value(v).expect("record")).expect("encodes")
}

fn body(n: u64) -> serde_json::Value {
    json!({"role": if n % 2 == 0 { "user" } else { "assistant" }, "content": format!("{n:08}:{}", "p".repeat(3000))})
}

fn item(n: u64) -> Encoded {
    rec(json!({"k":"item","iid":format!("i{n}"),"role":"user","form":"message","model":true,"visible":true,
        "refs":[],"body":{"inline":body(n)}}))
}

fn meta(n: u64) -> Encoded {
    let usage = json!({"input": n * 7, "output": n * 3, "cache": n, "note": "x".repeat(200)});
    rec(json!({"k":"meta","change":{"inline":{"set":{"updatedAt": 1_700_000_000_000u64 + n, "usage": usage, "contextTokens": n},"unset":[]}}}))
}

fn compacted(n: u64) -> Encoded {
    let replacement: Vec<_> = (0..20).map(|i| json!({"iid": format!("r{n}-{i}"), "body": body(i)})).collect();
    rec(json!({"k":"compacted","cid":format!("c{n}"),"dropped_count":10,"replacement":{"inline":replacement}}))
}

async fn on_lane<R: Send + 'static>(f: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokens().durability_io.submit(&CancellationToken::new(), f).expect("lane").await.expect("job ran")
}

fn deps(data: &Path) -> WriterDeps {
    WriterDeps { io: Arc::new(OsIo), blobs: BlobStore::new(data), ownership: Arc::new(MockOwnership::default()), index: Arc::new(NoIndex) }
}

fn du(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| if e.path().is_dir() { du(&e.path()) } else { e.metadata().map_or(0, |m| m.len()) }).sum())
        .unwrap_or(0)
}

fn measure<R>(what: &str, f: impl FnOnce() -> R) -> R {
    let base = LIVE.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let t = Instant::now();
    let r = f();
    println!("{what}: {:?}, peak heap +{} KiB", t.elapsed(), (PEAK.load(Ordering::Relaxed) - base) / 1024);
    r
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let data: PathBuf = a[1].clone().into();
    let (messages, patches, every): (u64, u64, u64) = (a[2].parse().unwrap(), a[3].parse().unwrap(), a[4].parse().unwrap());
    let dir = data.join("sessions").join("growth");
    let session = rec(json!({"k":"session","v":2,"id":"growth","log_id":"0123456789abcdef01234567","header":{"inline":{"title":"growth","cwd":"c:/x"}}}));
    let d = deps(&data);
    let d1 = dir.clone();
    let (mut w, _) = on_lane(move |l| LogWriter::create(l, &d1, session, d).expect("create")).await;
    let (mut live, mut metas, mut near_end) = (0u64, 0u64, None);
    for n in 0..messages {
        let mut batch = vec![item(n)];
        live += body(n).to_string().len() as u64;
        if every > 0 && n > 0 && n % every == 0 {
            batch.push(compacted(n));
            live += 20 * body(0).to_string().len() as u64;
        }
        for _ in 0..patches {
            metas += 1;
            batch.push(meta(metas));
        }
        // One save per message with its item and the header patches it made; the last patch of each save alone is the common case
        // for a turn, so the rest go as their own saves.
        let tail = batch.split_off(batch.len().min(2));
        w = on_lane(move |l| {
            let mut w = w;
            w.append_barrier(l, batch).expect("barrier");
            for m in tail {
                w.append_barrier(l, vec![m]).expect("barrier");
            }
            w
        })
        .await;
        if n + 50 == messages {
            near_end = Some(w.fold().next_ordinal);
        }
    }
    drop(w);
    let stored = du(&data);
    println!("messages {messages}, header patches {metas}, live bytes {live}, stored bytes {stored}, ratio {:.2}", stored as f64 / live as f64);
    let blobs = BlobStore::new(&data);
    let d2 = dir.clone();
    let b2 = blobs.clone();
    let (opened_at, _) = on_lane(move |l| {
        let o = measure("open_log", || open_log(l, &d2, &b2, &NoIndex).expect("open"));
        let head = measure("read_head", || read_head(l, &d2).expect("head"));
        let tail = measure("read_tail", || read_tail(l, head, &b2, &NoIndex).expect("tail"));
        let _ = tail;
        println!("rows {}", o.fold.rows);
        let from = o.fold.context.unwrap_or(mixdog_store::schema::checkpoint::FramePos { ordinal: 0, file_no: 0, offset: 0 });
        let page = measure("read_forward page (8 MiB window from the context)", || read_forward(l, &d2, from, 8 << 20).expect("page"));
        println!("page frames {}", page.frames.len());
        (o.fold.next_ordinal, ())
    })
    .await;
    println!("next ordinal {opened_at} (50 from end: {near_end:?})");
}
