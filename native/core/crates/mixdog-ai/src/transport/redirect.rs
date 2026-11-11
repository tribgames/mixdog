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
//! WebSocket: Node's world dials the loopback server over plain TCP for the TLS connect `ws` asked for, and the upgrade
//! carries the host the product addressed. [`RedirectedDialer`] does the same, and reports each dial (host, port) to `tap`.

use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::Response;

use super::link::BidiOpen;
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

/// A production link whose every request goes to `addr` over plain HTTP, as the recorder's `fetch` sent it.
pub struct Redirected<L> {
    pub inner: L,
    pub addr: SocketAddr,
}

impl<L> Redirected<L> {
    fn redirect(&self, mut request: WireRequest) -> WireRequest {
        let url = url::Url::parse(&request.url).unwrap_or_else(|e| panic!("redirect: {}: {e}", request.url));
        let mut target = format!("http://{}{}", self.addr, url.path());
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
        self.inner.send(self.redirect(request), exchange).await
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

/// Called with the host and port of each WebSocket dial (the world's `dial` entry).
pub type DialTap = Arc<dyn Fn(&str, u16) + Send + Sync>;

/// The production dialer with every dial going to `addr` over plain TCP; the upgrade is written unchanged.
pub struct RedirectedDialer {
    pub schedule: KeepaliveSchedule,
    pub addr: SocketAddr,
    pub tap: DialTap,
}

#[async_trait]
impl WsDial for RedirectedDialer {
    async fn dial(&self, request: Request) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        let uri = request.uri();
        let port = uri.port_u16().unwrap_or(if uri.scheme_str() == Some("wss") { 443 } else { 80 });
        (self.tap)(uri.host().unwrap_or_default(), port);
        let (connection, response) = ws::connect_redirected(request, self.addr, &self.schedule).await?;
        Ok((Box::new(connection), response))
    }
}
