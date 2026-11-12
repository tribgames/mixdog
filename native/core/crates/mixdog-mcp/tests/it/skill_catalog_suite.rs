//! The skill catalog against a lane that refuses and drops jobs: a full lane is waited out, and
//! a job the lane did not finish is an error, never "no skills" or "not found".
#![allow(clippy::disallowed_methods, reason = "test fixtures write and inspect directories directly")]

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_mcp::skill_catalog::CatalogError;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillLoad;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_rt::Backend;
use mixdog_rt::LaneFull;
use mixdog_rt::QueuedJob;
use mixdog_rt::TaskClass;
use mixdog_rt::ThreadKind;
use tokio::sync::Notify;

/// Refuses the first `refuse` submits (the lane is full), drops the next `drop_jobs` accepted
/// jobs unrun (the lane lost them), and runs everything else inline.
struct FlakyLane {
    refuse: AtomicUsize,
    drop_jobs: AtomicUsize,
    freed: Arc<Notify>,
}

fn take(counter: &AtomicUsize) -> bool {
    counter.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok()
}

impl Backend for FlakyLane {
    fn handle(&self, _class: TaskClass) -> tokio::runtime::Handle {
        tokio::runtime::Handle::current()
    }

    fn record_poll(&self, _task: &'static str, _class: TaskClass, _elapsed: Duration) {}

    fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        if take(&self.refuse) {
            return Err(LaneFull { lane: job.lane() });
        }
        if take(&self.drop_jobs) {
            return Ok(());
        }
        job.run();
        Ok(())
    }

    fn enter_thread(&self, _kind: ThreadKind) {}

    fn capacity_notify(&self, _lane: mixdog_rt::LaneKind) -> Option<Arc<Notify>> {
        Some(Arc::clone(&self.freed))
    }
}

struct NoSettings;

impl SkillSettingsSource for NoSettings {
    fn current(&self) -> SkillSettings {
        SkillSettings::default()
    }
}

fn catalog(data: &std::path::Path, root: &std::path::Path, tokens: &mixdog_rt::LaneTokens) -> Arc<SkillCatalog> {
    let root = SkillRoot { dir: root.to_path_buf(), source: SkillSource::Global, plugin: None };
    SkillCatalog::new(data.to_path_buf(), tokens.maintenance_io, Arc::new(move |_| vec![root.clone()]), Arc::new(NoSettings), &SkillsWatch::new())
}

#[tokio::test]
async fn a_full_or_lossy_lane_is_waited_out_or_reported_never_hidden_as_empty_data() {
    let lane = Arc::new(FlakyLane { refuse: AtomicUsize::new(0), drop_jobs: AtomicUsize::new(0), freed: Arc::new(Notify::new()) });
    let tokens = mixdog_rt::install(lane.clone()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("skills");
    let file = root.join("demo").join("SKILL.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "---\nname: demo\ndescription: d\n---\n\nbody\n").unwrap();
    let cwd = dir.path();

    // A full lane: the scan waits for room (the lane frees up while it waits) and finds the skill.
    lane.refuse.store(3, Ordering::SeqCst);
    let freeing = {
        let lane = lane.clone();
        tokio::spawn(async move {
            for _ in 0..200 {
                mixdog_rt::time::sleep(Duration::from_millis(5)).await;
                lane.freed.notify_waiters();
            }
        })
    };
    let waiting = catalog(dir.path(), &root, &tokens);
    let skills = waiting.skills().await.expect("a full lane is waited out");
    assert_eq!(skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["demo"]);
    freeing.abort();

    // A scan the lane drops is an error, and is not cached as an empty list.
    let lossy = catalog(dir.path(), &root, &tokens);
    lane.drop_jobs.store(1, Ordering::SeqCst);
    assert!(matches!(lossy.skills().await, Err(CatalogError::Dropped(_))));
    assert_eq!(lossy.skills().await.expect("the next scan succeeds").len(), 1);

    // A read the lane drops is an error, not "not found".
    lane.drop_jobs.store(1, Ordering::SeqCst);
    assert!(matches!(lossy.load("demo", cwd).await, Err(CatalogError::Dropped(_))));
    assert!(matches!(lossy.load("demo", cwd).await, Ok(SkillLoad::Loaded(_))));

    // A file that cannot be read is an error; one removed since the scan is "not found".
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(matches!(lossy.load("demo", cwd).await, Err(CatalogError::Read(_))));
    std::fs::remove_dir(&file).unwrap();
    assert!(matches!(lossy.load("demo", cwd).await, Ok(SkillLoad::NotFound)));
}
