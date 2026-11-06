//! The idle schedule and the attachment census against Node's real modules
//! (`fixtures/maintenance-jobs/golden.json`, recorded by `record-maintenance-jobs.mjs`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::FutureExt;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_store::blobs::BlobStore;
use mixdog_store::blobs::digest_of;
use serde_json::Value;

use crate::blob_gc::DEFAULT_MIN_AGE;
use crate::blob_gc::SPACING_MS;
use crate::blob_gc::START_DELAY;
use crate::maintenance::ErrorSink;
use crate::maintenance::MaintenanceSchedule;
use crate::maintenance::TaskFn;
use crate::maintenance::TaskOptions;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/maintenance-jobs/golden.json")).unwrap()
}

/// Every scripted timeline: which tasks ran at each tick, whether it stopped busy, and which
/// tasks reported an error.
#[tokio::test]
async fn the_schedule_runs_what_nodes_does_at_every_tick() {
    let golden = golden();
    let t0 = golden["T0"].as_i64().unwrap();
    for case in golden["schedule"].as_array().unwrap() {
        let schedule = MaintenanceSchedule::new();
        let idle = Arc::new(AtomicBool::new(true));
        let probe_idle = idle.clone();
        let _probe = schedule.register_idle_probe(Arc::new(move || {
            let idle = probe_idle.load(Ordering::SeqCst);
            async move { idle }.boxed()
        }));
        let errors: Arc<Mutex<Vec<String>>> = Arc::default();
        for task in case["tasks"].as_array().unwrap() {
            let name = task[0].as_str().unwrap().to_owned();
            let fails = task[3].as_bool().unwrap();
            let run: TaskFn = Arc::new(move || async move { if fails { Err("boom".to_owned()) } else { Ok(()) } }.boxed());
            let (sink, failed) = (errors.clone(), name.clone());
            let on_error: ErrorSink = Arc::new(move |_| sink.lock().unwrap().push(failed.clone()));
            let options = TaskOptions {
                interval: Duration::from_millis(task[1].as_u64().unwrap()),
                initial_delay: Duration::from_millis(task[2].as_u64().unwrap()),
                on_error: Some(on_error),
            };
            drop(schedule.register_task(&name, run, options, t0));
        }
        let mut ran_all: Vec<String> = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            idle.store(step["idle"].as_bool().unwrap(), Ordering::SeqCst);
            let tick = schedule.run_tasks(false, t0 + step["at"].as_i64().unwrap()).await;
            let want: Vec<&str> = step["ran"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
            assert_eq!((tick.ran.iter().map(String::as_str).collect::<Vec<_>>(), tick.busy), (want, step["busy"].as_bool().unwrap()), "{case} at {}", step["at"]);
            ran_all.extend(tick.ran);
        }
        let want_runs: Vec<&str> = case["runs"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
        assert_eq!(ran_all.iter().map(String::as_str).collect::<Vec<_>>(), want_runs);
        let want_errors: Vec<&str> = case["errors"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
        assert_eq!(errors.lock().unwrap().iter().map(String::as_str).collect::<Vec<_>>(), want_errors);
    }
}

/// The census spacing, its trigger delay and the default minimum age are Node's.
#[test]
fn the_census_constants_are_nodes() {
    let constants = &golden()["attachments"]["constants"];
    assert_eq!(SPACING_MS, constants["spacingMs"].as_i64().unwrap());
    assert_eq!(START_DELAY, Duration::from_millis(constants["startDelayMs"].as_u64().unwrap()));
    assert_eq!(DEFAULT_MIN_AGE, Duration::from_millis(constants["defaultMinAgeMs"].as_u64().unwrap()));
}

/// Node's census over its fixture blobs (age, referenced or not) keeps exactly the blobs the
/// blob store's sweep keeps when asked the same reference question; the report counts agree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sweep_keeps_what_nodes_census_keeps() {
    let attachments = golden()["attachments"].clone();
    let min_age = Duration::from_millis(attachments["minAgeMs"].as_u64().unwrap());
    let mut deleted = 0;
    for blob in attachments["blobs"].as_array().unwrap() {
        let name = blob["name"].as_str().unwrap();
        let digest = digest_of(format!("blob {name}").as_bytes());
        let hex = digest.as_str()["sha256:".len()..].to_owned();
        let (kept, collected) = sweep_alone(&hex, &hex, format!("blob {name}"), blob["ageMs"].as_u64().unwrap(), min_age, blob["referenced"].as_bool().unwrap()).await;
        assert_eq!(kept, blob["kept"].as_bool().unwrap(), "{name}");
        deleted += collected;
    }
    assert_eq!(deleted, attachments["report"]["deleted"].as_u64().unwrap());
}

/// What a writer that died before its rename leaves (`<ref>.mixdog-tmp-*`, `.<ref>.*.tmp`,
/// `<ref>.*.*.tmp`) goes once it is as old as a collectable blob, and anything else beside the
/// blobs stays, exactly as in Node's census; this store's own writer leftover goes too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writer_leftovers_go_when_old_enough_as_in_nodes_census() {
    let attachments = golden()["attachments"].clone();
    let min_age = Duration::from_millis(attachments["minAgeMs"].as_u64().unwrap());
    let owner = digest_of(b"blob writer-owner").as_str()["sha256:".len()..].to_owned();
    for leftover in attachments["leftovers"].as_array().unwrap() {
        let template = leftover["name"].as_str().unwrap();
        let name = template.replace("<ref>", &owner).replace("<ref-1>", &owner[1..]);
        let (kept, collected) = sweep_alone(&owner, &name, "partial".to_owned(), leftover["ageMs"].as_u64().unwrap(), min_age, false).await;
        assert_eq!((kept, collected), (leftover["kept"].as_bool().unwrap(), 0), "{template}");
    }
    let own = format!(".{owner}.tmp-0123456789abcdef");
    assert_eq!(sweep_alone(&owner, &own, "partial".to_owned(), 8 * 24 * 3600 * 1000, min_age, false).await, (false, 0));
    assert_eq!(sweep_alone(&owner, &own, "partial".to_owned(), 24 * 3600 * 1000, min_age, false).await, (true, 0));
}

/// Writes one file `name` (a blob or a leftover) into its shard of a fresh store, sweeps that
/// shard at `its own mtime + age_ms` and reports whether the file is still there and how many
/// blobs the sweep collected. Each case has its own store so the file's real mtime is its age's
/// zero point, with no clock to set.
async fn sweep_alone(shard_of: &str, name: &str, bytes: String, age_ms: u64, min_age: Duration, referenced: bool) -> (bool, u64) {
    let dir = tempfile::tempdir().unwrap();
    let blobs = BlobStore::new(dir.path());
    let shard = u8::from_str_radix(&shard_of[..2], 16).unwrap();
    let path = blobs.root().join(format!("{shard:02x}")).join(name);
    LaneToken::submit(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| {
        mixdog_store::fsio::publish_file(lane, &path, bytes.as_bytes()).unwrap();
        let written = mixdog_statefile::metadata(lane, &path).unwrap().modified().unwrap();
        let collected = blobs
            .collect_shard(lane, shard, written + Duration::from_millis(age_ms), min_age, &mut |_| Ok(referenced))
            .unwrap()
            .len();
        let _keep_dir = &dir;
        (mixdog_statefile::metadata(lane, &path).is_ok(), collected as u64)
    })
    .unwrap()
    .await
    .unwrap()
}
