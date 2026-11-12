//! `openHedged` (`openai-ws-connect.mjs`) under the pool's acquire deadline (`openai-ws-pool.mjs` `_openSocket`): one
//! acquire is a race of dial legs. A new leg starts every hedge window while none has opened and the deadline leaves
//! room; the first leg to open wins and the others are dropped (their connections close); an HTTP answer to the
//! upgrade is the server's decision and ends the race at once; any other failure ends it only when no leg is left
//! connecting; the deadline ends it with the acquire timeout.

use std::future::Future;
use std::time::Duration;

use futures::StreamExt;
use futures::future::BoxFuture;
use futures::stream::FuturesUnordered;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use tokio_tungstenite::tungstenite::http::Response;

use crate::providers::google::cache::policy::ws_connect_ms;
use crate::transport::WsSocket;
use crate::transport::ws::ConnectError;

/// `WS_HEDGE_MS` and `WS_ACQUIRE_TIMEOUT_MS`: when the next leg starts, and when the acquire gives up.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Window {
    pub hedge: Duration,
    pub deadline: Duration,
}

impl Window {
    /// From the process settings (`MIXDOG_PROVIDER_WS_HEDGE_MS`, `MIXDOG_PROVIDER_WS_ACQUIRE_TIMEOUT_MS`).
    pub fn from_settings(get: impl Fn(&str) -> Option<String>) -> Self {
        let (hedge, deadline) = ws_connect_ms(get);
        Self { hedge: Duration::from_millis(hedge as u64), deadline: Duration::from_millis(deadline as u64) }
    }
}

/// An upgrade that opened: the socket and the server's answer.
pub type Opened = (Box<dyn WsSocket>, Response<Option<Vec<u8>>>);

/// How a race ended.
pub enum Raced {
    Opened(Opened),
    Failed(ConnectError),
    TimedOut,
}

/// `leg()` starts one dial. A leg is cancelled by dropping it.
pub async fn race<'a, F>(window: Window, mut leg: impl FnMut() -> F) -> Raced
where
    F: Future<Output = Result<Opened, ConnectError>> + Send + 'a,
{
    let started = mixdog_rt::time::Instant::now();
    let deadline = started + window.deadline;
    let mut legs: FuturesUnordered<BoxFuture<'a, Result<Opened, ConnectError>>> = FuturesUnordered::new();
    let mut hedge_at: Option<mixdog_rt::time::Instant> = None;
    let mut start = |legs: &mut FuturesUnordered<BoxFuture<'a, Result<Opened, ConnectError>>>, hedge_at: &mut Option<mixdog_rt::time::Instant>| {
        legs.push(Box::pin(leg()));
        let now = mixdog_rt::time::Instant::now();
        // `scheduleHedge`: no further leg when the next one would start no sooner than the deadline.
        *hedge_at = (!window.hedge.is_zero() && now - started + window.hedge < window.deadline).then(|| now + window.hedge);
    };
    start(&mut legs, &mut hedge_at);
    let deadline_sleep = mixdog_rt::time::sleep_until(deadline);
    tokio::pin!(deadline_sleep);
    loop {
        let hedge = async {
            match hedge_at {
                Some(at) => mixdog_rt::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            () = &mut deadline_sleep => return Raced::TimedOut,
            Some(done) = legs.next() => match done {
                Ok(opened) => return Raced::Opened(opened),
                // An HTTP answer is the server's decision for this request: it ends the race unchanged.
                Err(error @ ConnectError::Rejected(_)) => return Raced::Failed(error),
                Err(error) => {
                    if legs.is_empty() {
                        return Raced::Failed(error);
                    }
                }
            },
            () = hedge => start(&mut legs, &mut hedge_at),
        }
    }
}

/// `_acquireTimeoutError`: the acquire ended before any leg opened. `label` is the route's WebSocket label.
pub fn acquire_timeout(label: &str, window: Window) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    error.transport = Some(TransportFault::Connect { os_code: None });
    error.code = Some("EWSACQUIRETIMEOUT".into());
    error.timed_out = true;
    error.message = format!("{label} acquire timed out before open ({}ms)", window.deadline.as_millis());
    error
}
