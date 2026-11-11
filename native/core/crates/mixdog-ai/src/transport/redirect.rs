//! The Rust twin of the provider recorders' network redirect (`benchmarks/rust-core/recorders/lib/provider-case-recorder.mjs`
//! `globalThis.fetch`, `lib/ws-world.mjs` `tls.connect`): the product addresses its real origin, and the request goes to a
//! scripted loopback endpoint instead. Compiled for tests and the `test-support` feature only.
//!
//! HTTP: Node's recorder sends the request to `http://127.0.0.1:<port><path><query>` and adds an `x-bench-origin` header
//! naming the origin the product addressed (appended to the caller's headers, before the ones `fetch` adds). [`Redirected`]
//! does the same to each request before the production link sends it, so the production client writes what undici wrote
//! there (the head of a plain-HTTP target, `host` the loopback address); the endpoint drops the header and writes `host`
//! as the origin's host, as the recorder did.
//!
//! A connection fault the recorder made instead of reaching the endpoint (its `fetch` sent the attempt to a closed loopback
//! port, or to a listener that resets the TLS handshake) is [`Redirected::fault_origin`]: while set, requests go to that
//! origin (`http://127.0.0.1:<closed port>`, `https://127.0.0.1:<port>`) and each send that fails is reported to `failed`.
//!
//! The product's handling of each response body ([`BodyEvent`]: a read begun, the end reached, the body dropped) goes to
//! the endpoint's `tap`, so a replay on a paused clock moves the clock once the product waits where the recording waited.
//!
//! WebSocket: Node's world dials the loopback server over plain TCP for the TLS connect `ws` asked for, and the upgrade
//! carries the host the product addressed. [`RedirectedDialer`] does the same, and reports each dial (host, port) to `tap`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::Response;

use super::link::BidiOpen;
use super::link::BodyStream;
use super::link::Exchange;
use super::link::FrameSink;
use super::link::HttpResponse;
use super::link::HttpSend;
use super::link::WsDial;
use super::link::WsSocket;
use super::ws;
use super::ws::ConnectError;
use super::KeepaliveSchedule;

/// The header naming the origin the product addressed (the recorder's `x-bench-origin`).
pub const ORIGIN_HEADER: &str = "x-bench-origin";

/// What the product did with the body of the n-th response (a `HEAD` warm-up not counted) the link returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyEvent {
    /// A read of the body began (the product waits on it).
    Read,
    /// A read returned the end of the body or its fault.
    Ended,
    /// The product dropped the body.
    Dropped,
}

/// Called with the response's index and what the product did with its body.
pub type BodyTap = Arc<dyn Fn(usize, BodyEvent) + Send + Sync>;

/// A production link whose every request goes to `addr` over plain HTTP, as the recorder's `fetch` sent it.
pub struct Redirected<L> {
    pub inner: L,
    pub addr: SocketAddr,
    pub tap: BodyTap,
    /// The responses returned so far (a `HEAD` not counted).
    pub returned: Arc<AtomicUsize>,
    /// The origin requests go to instead of `addr` while set (a connection fault of the case).
    pub fault_origin: Arc<std::sync::Mutex<Option<String>>>,
    /// Called after each send that failed.
    pub failed: Arc<dyn Fn() + Send + Sync>,
}

/// A response body reporting to the tap.
struct Tapped {
    body: Box<dyn BodyStream>,
    index: usize,
    tap: BodyTap,
}

#[async_trait]
impl BodyStream for Tapped {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        (self.tap)(self.index, BodyEvent::Read);
        let next = self.body.next().await;
        if !matches!(next, Some(Ok(_))) {
            (self.tap)(self.index, BodyEvent::Ended);
        }
        next
    }

    fn hold_connection(&mut self) {
        self.body.hold_connection();
    }
}

impl Drop for Tapped {
    fn drop(&mut self) {
        (self.tap)(self.index, BodyEvent::Dropped);
    }
}

impl<L> Redirected<L> {
    fn redirect(&self, mut request: WireRequest) -> WireRequest {
        let url = url::Url::parse(&request.url).unwrap_or_else(|e| panic!("redirect: {}: {e}", request.url));
        let origin = self.fault_origin.lock().unwrap().clone().unwrap_or_else(|| format!("http://{}", self.addr));
        let mut target = format!("{origin}{}", url.path());
        if let Some(query) = url.query() {
            target.push('?');
            target.push_str(query);
        }
        request.url = target;
        request.headers.push((ORIGIN_HEADER.to_owned(), url.origin().ascii_serialization()));
        request
    }
}

#[async_trait]
impl<L: HttpSend> HttpSend for Redirected<L> {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let head = request.method.eq_ignore_ascii_case("HEAD");
        let mut response = match self.inner.send(self.redirect(request), exchange).await {
            Ok(response) => response,
            Err(error) => {
                (self.failed)();
                return Err(error);
            }
        };
        if !head {
            let index = self.returned.fetch_add(1, Ordering::SeqCst);
            let body = std::mem::replace(&mut response.body, Box::new(Empty));
            response.body = Box::new(Tapped { body, index, tap: self.tap.clone() });
        }
        Ok(response)
    }
}

#[async_trait]
impl<L: BidiOpen> BidiOpen for Redirected<L> {
    async fn open(
        &self,
        request: WireRequest,
        first: Vec<u8>,
        exchange: Exchange,
    ) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        self.inner.open(self.redirect(request), first, exchange).await
    }
}

/// A body with nothing in it, standing in while the response's own is moved into its tap.
struct Empty;

#[async_trait]
impl BodyStream for Empty {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        None
    }
}

/// Called with the host and port of each WebSocket dial (the world's `dial` entry).
pub type DialTap = Arc<dyn Fn(&str, u16) + Send + Sync>;

/// The `Sec-WebSocket-Key` of the next upgrade, as the test scripts it (the recorded keys in dial order); `None`: drawn as
/// in production.
pub type KeySource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// The production dialer with every dial going to `addr` over plain TCP; the upgrade is written unchanged but for its key,
/// which `keys` gives.
pub struct RedirectedDialer {
    pub schedule: KeepaliveSchedule,
    pub addr: SocketAddr,
    pub tap: DialTap,
    pub keys: KeySource,
}

#[async_trait]
impl WsDial for RedirectedDialer {
    async fn dial(&self, mut request: Request) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        let uri = request.uri().clone();
        let port = uri.port_u16().unwrap_or(if uri.scheme_str() == Some("wss") { 443 } else { 80 });
        (self.tap)(uri.host().unwrap_or_default(), port);
        if let Some(key) = (self.keys)() {
            request.extensions_mut().insert(ws::ScriptedKey(key));
        }
        let (connection, response) = ws::connect_redirected(request, self.addr, &self.schedule).await?;
        Ok((Box::new(connection), response))
    }
}
