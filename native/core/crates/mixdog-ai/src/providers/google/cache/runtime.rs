//! [`CacheRuntime`] over `mixdog-rt`: the clock, the work-executor task that
//! carries a cache create past its first caller, and the delayed delete on the
//! shared ticker. No private timer or detached runtime task.

use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use futures::FutureExt;
use futures::future::BoxFuture;
use mixdog_rt::TaskClass;

use super::layer::CacheRuntime;

pub struct RtCacheRuntime;

impl CacheRuntime for RtCacheRuntime {
    fn now_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
    }

    fn spawn(&self, task: BoxFuture<'static, ()>) {
        drop(mixdog_rt::spawn("gemini.cache-create", TaskClass::Work, task));
    }

    fn deadline(&self, ms: u64) -> BoxFuture<'static, ()> {
        mixdog_rt::ticker().wait_until(Instant::now() + Duration::from_millis(ms)).boxed()
    }

    fn spawn_after(&self, delay_ms: u64, task: BoxFuture<'static, ()>) {
        let at = Instant::now() + Duration::from_millis(delay_ms);
        let wait = mixdog_rt::ticker().wait_until(at);
        drop(mixdog_rt::spawn("gemini.cache-delete", TaskClass::Work, async move {
            wait.await;
            task.await;
        }));
    }
}
