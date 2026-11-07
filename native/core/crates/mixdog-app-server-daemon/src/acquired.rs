//! What composition has acquired and must give back if it fails (Node: a boot error goes through `shutdown`, `daemon.mjs:1347`, whose steps stop what had started,
//! PostgreSQL last, `:383`). `compose` runs [`Acquired::release`] when the real core fails, newest acquisition first, so a half-composed core leaves no running
//! PostgreSQL behind. A composed core releases through its stop procedure instead; the two never both run.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use tokio_util::sync::CancellationToken;

type Release = (&'static str, Pin<Box<dyn Future<Output = ()> + Send>>);

pub struct Acquired {
    interrupt: CancellationToken,
    releases: Mutex<Vec<Release>>,
}

impl Acquired {
    /// `interrupt` is cancelled by `serve` when a stop arrives while composition runs.
    pub fn new(interrupt: CancellationToken) -> Arc<Self> {
        Arc::new(Self { interrupt, releases: Mutex::new(Vec::new()) })
    }

    /// The token the slow acquisitions (`initdb`, the PostgreSQL start) take, so a stop ends their wait.
    pub fn token(&self) -> CancellationToken {
        self.interrupt.clone()
    }

    /// Registers what gives a resource back, at the point it is acquired.
    pub fn on_release(&self, name: &'static str, release: impl Future<Output = ()> + Send + 'static) {
        self.releases.lock().unwrap_or_else(PoisonError::into_inner).push((name, Box::pin(release)));
    }

    /// Runs every registered release, newest first, once.
    pub async fn release(&self) {
        let mut releases = std::mem::take(&mut *self.releases.lock().unwrap_or_else(PoisonError::into_inner));
        while let Some((name, release)) = releases.pop() {
            tracing::debug!(release = name, "releasing after a failed composition");
            release.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_failed_composition_releases_what_it_acquired_newest_first_and_only_once() {
        let acquired = Acquired::new(CancellationToken::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        for name in ["postgres", "channels"] {
            let order = order.clone();
            acquired.on_release(name, async move { order.lock().unwrap().push(name) });
        }
        acquired.release().await;
        acquired.release().await;
        assert_eq!(*order.lock().unwrap(), ["channels", "postgres"]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_interrupt_ends_a_wait_that_takes_the_token() {
        let interrupt = CancellationToken::new();
        let acquired = Acquired::new(interrupt.clone());
        let token = acquired.token();
        let wait = tokio::spawn(async move { token.cancelled().await });
        interrupt.cancel();
        wait.await.unwrap();
    }
}
