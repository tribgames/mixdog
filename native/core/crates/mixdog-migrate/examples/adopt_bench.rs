//! `adopt_bench <migrated-data> <work> <threads> <count> [--no-sync]`: times a serving core's adoption of converted sessions,
//! as the migration's verified hook adopts them. The first `count` session folders of `<migrated-data>/sessions` (with its
//! blobs) are moved into `<work>/data`, a data dir whose core index is opened empty, then adopted on `threads` threads, each
//! folder moved in just before its adoption; everything is moved back at the end. `--no-sync` elides the index's syncs.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "measurement binary")]

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src = PathBuf::from(&args[1]);
    let data = PathBuf::from(&args[2]).join("data");
    let threads: usize = args[3].parse().expect("threads");
    let count: usize = args[4].parse().expect("count");
    if args.iter().any(|a| a == "--no-sync") {
        mixdog_store::fsio::elide_syncs();
    }
    assert!(!data.exists(), "{} exists", data.display());
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::rename(src.join("blobs"), data.join("blobs")).unwrap();
    let mut ids: Vec<String> = std::fs::read_dir(src.join("sessions"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().join("log.000000").is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids.truncate(count);

    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let at = data.clone();
    let index = runtime
        .block_on(
            mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
                mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &at)
            })
            .expect("lane"),
        )
        .expect("job ran")
        .expect("the core's index");

    let next = AtomicUsize::new(0);
    let spent = Mutex::new(0.0f64);
    let began = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut mine = 0.0;
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(id) = ids.get(i) else { break };
                    std::fs::rename(src.join("sessions").join(id), data.join("sessions").join(id)).unwrap();
                    let t = Instant::now();
                    index.adopt(&data, id).expect("adopted");
                    mine += t.elapsed().as_secs_f64();
                    if i % 100 == 99 {
                        eprintln!("{} adopted at {:.1} s", i + 1, began.elapsed().as_secs_f64());
                    }
                }
                *spent.lock().unwrap() += mine;
            });
        }
    });
    let wall = began.elapsed().as_secs_f64();
    let spent = spent.into_inner().unwrap();
    println!("sessions {} threads {threads}: wall {wall:.2} s, adopt {spent:.2} thread-s, {:.1} ms per session", ids.len(), 1000.0 * spent / ids.len() as f64);
    // The store is left open: the process ends with the folders moved back.
    std::mem::forget(index);
    for id in &ids {
        std::fs::rename(data.join("sessions").join(id), src.join("sessions").join(id)).unwrap();
    }
    std::fs::rename(data.join("blobs"), src.join("blobs")).unwrap();
    std::process::exit(0);
}
