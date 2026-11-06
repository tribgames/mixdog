//! The background task count (`spawn_task`) settles however the task ends.

use std::time::Duration;

use super::runtime::{GoalConfig, GoalEnv, GoalRuntime};

fn runtime() -> GoalRuntime {
    GoalRuntime::new(GoalConfig::new("unused"), GoalEnv::system(mixdog_rt::testing::tokens().durability_io))
}

/// A panicking task used to skip the decrement: `settled` and `close` then waited forever. The
/// paused clock makes the bound deterministic: the timeout fires only if nothing else can run.
#[tokio::test(start_paused = true)]
async fn a_panicking_background_task_still_settles_and_closes() {
    let runtime = runtime();
    runtime.inner.spawn_task(async { panic!("background task failure") });
    runtime.inner.spawn_task(async {});
    tokio::time::timeout(Duration::from_secs(60), runtime.settled()).await.expect("settled returned");
    tokio::time::timeout(Duration::from_secs(60), runtime.close()).await.expect("close returned");
}
