//! Streamable HTTP transport: every message is a POST; the answer is JSON, an SSE stream or
//! 202. After the handshake one GET stream carries server-initiated messages when the server
//! offers it.

use crate::deadlines::STARTUP;
use crate::deadlines::expired;
use mixdog_rt::Liveness;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::transport::Authorizer;
use crate::transport::CloseCause;
use crate::transport::Incoming;
use crate::transport::IncomingRx;
use crate::transport::IncomingTx;
use crate::transport::Transport;
use crate::transport::TransportError;

const SESSION_HEADER: &str = "mcp-session-id";
const VERSION_HEADER: &str = "mcp-protocol-version";
const ERROR_BODY_CHARS: usize = 2048;

pub struct HttpTransport {
    client: reqwest::Client,
    url: Url,
    headers: HeaderMap,
    session: Mutex<Option<String>>,
    version: Mutex<Option<String>>,
    incoming: IncomingTx,
    shutdown: CancellationToken,
    auth: Option<Arc<dyn Authorizer>>,
}

fn request_error(error: reqwest::Error) -> TransportError {
    TransportError::Request(error.without_url().to_string())
}

impl HttpTransport {
    pub fn new(
        url: Url,
        headers: &BTreeMap<String, String>,
        auth: Option<Arc<dyn Authorizer>>,
    ) -> Result<(Self, IncomingRx), TransportError> {
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| TransportError::Request(format!("invalid header name {name:?}")))?;
            let mut value = HeaderValue::from_str(value)
                .map_err(|_| TransportError::Request(format!("invalid value for header {name}")))?;
            value.set_sensitive(true);
            map.insert(name, value);
        }
        let (incoming, rx) = mpsc::unbounded_channel();
        let client = reqwest::Client::builder().build().map_err(request_error)?;
        Ok((
            Self {
                client,
                url,
                headers: map,
                session: Mutex::new(None),
                version: Mutex::new(None),
                incoming,
                shutdown: CancellationToken::new(),
                auth,
            },
            rx,
        ))
    }

    fn decorate(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut builder = builder.headers(self.headers.clone());
        if let Some(session) = self.session.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            builder = builder.header(SESSION_HEADER, session);
        }
        if let Some(version) = self.version.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            builder = builder.header(VERSION_HEADER, version);
        }
        builder
    }

    fn deliver(&self, value: Value) {
        deliver(&self.incoming, value);
    }
}

fn deliver(tx: &IncomingTx, value: Value) {
    match value {
        Value::Array(batch) => batch.into_iter().for_each(|m| {
            let _ = tx.send(Incoming::Message(m));
        }),
        other => {
            let _ = tx.send(Incoming::Message(other));
        }
    }
}

/// What an SSE stream said about resuming it when it ended.
#[derive(Default, Debug, PartialEq, Eq)]
struct SseEnd {
    /// The last `id:` seen, sent back as `Last-Event-ID`.
    last_id: Option<String>,
    /// The server's `retry:` interval, which replaces the backoff delay.
    retry: Option<Duration>,
}

/// Splits an SSE byte stream into events and forwards each `data` payload that is JSON. Returns
/// when the stream ends or `shutdown` is cancelled.
async fn pump_sse(
    response: reqwest::Response,
    tx: IncomingTx,
    shutdown: CancellationToken,
) -> SseEnd {
    let mut end = SseEnd::default();
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_bytes: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            () = shutdown.cancelled() => break,
            chunk = stream.next() => chunk,
        };
        let Some(Ok(chunk)) = chunk else { break };
        pending_bytes.extend_from_slice(&chunk);
        match std::str::from_utf8(&pending_bytes) {
            Ok(text) => {
                buffer.push_str(text);
                pending_bytes.clear();
            }
            Err(error) => {
                let valid = error.valid_up_to();
                buffer.push_str(std::str::from_utf8(&pending_bytes[..valid]).unwrap_or_default());
                pending_bytes.drain(..valid);
            }
        }
        let normalized = buffer.replace("\r\n", "\n");
        let mut rest = normalized.as_str();
        while let Some(stop) = rest.find("\n\n") {
            let event = &rest[..stop];
            rest = &rest[stop + 2..];
            for line in event.lines() {
                if let Some(id) = line.strip_prefix("id:") {
                    end.last_id = Some(id.strip_prefix(' ').unwrap_or(id).to_owned());
                } else if let Some(ms) = line
                    .strip_prefix("retry:")
                    .and_then(|ms| ms.trim().parse::<u64>().ok())
                {
                    end.retry = Some(Duration::from_millis(ms));
                }
            }
            let data: Vec<&str> = event
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if data.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(&data.join("\n")) {
                Ok(value) => deliver(&tx, value),
                Err(error) => tracing::warn!(%error, "mcp http: SSE data is not JSON"),
            }
        }
        buffer = rest.to_owned();
    }
    end
}

/// How the standalone GET stream came up.
enum Listener {
    Stream(reqwest::Response),
    /// 405: the server offers no standalone stream.
    Absent,
    Failed,
}

/// The SDK's reconnection options (`StreamableHTTPClientTransport`
/// `DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS`, `@modelcontextprotocol/sdk` `client/streamableHttp.js:7-12`).
const RECONNECT_INITIAL: Duration = Duration::from_millis(1000);
const RECONNECT_MAX: Duration = Duration::from_millis(30_000);
const RECONNECT_GROWTH: f64 = 1.5;
const RECONNECT_RETRIES: u32 = 2;

fn reconnect_delay(attempt: u32, server_retry: Option<Duration>) -> Duration {
    server_retry.unwrap_or_else(|| {
        RECONNECT_INITIAL
            .mul_f64(RECONNECT_GROWTH.powi(attempt as i32))
            .min(RECONNECT_MAX)
    })
}

/// The standalone stream as the SDK keeps it (`_startOrAuthSse`, `_scheduleReconnection`): the
/// first open is tried once; once a stream has been up, its end (clean or not) reopens it after a
/// backoff with `Last-Event-ID`, and a reopen that fails is retried up to `RECONNECT_RETRIES`
/// times before the stream is given up. The client itself stays up either way, because POSTs
/// still work.
async fn keep_listening<O, F>(mut open: O, tx: IncomingTx, shutdown: CancellationToken)
where
    O: FnMut(Option<String>) -> F,
    F: std::future::Future<Output = Listener>,
{
    let mut resume: Option<String> = None;
    let mut server_retry: Option<Duration> = None;
    let mut attempt = 0;
    let mut first = true;
    loop {
        if !first {
            if attempt >= RECONNECT_RETRIES {
                tracing::warn!("mcp http: standalone stream reconnection attempts exceeded");
                return;
            }
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = mixdog_rt::time::sleep(reconnect_delay(attempt, server_retry)) => {}
            }
        }
        match open(resume.clone()).await {
            Listener::Stream(response) => {
                let ended = pump_sse(response, tx.clone(), shutdown.clone()).await;
                if shutdown.is_cancelled() {
                    return;
                }
                resume = ended.last_id.or(resume);
                server_retry = ended.retry.or(server_retry);
                attempt = 0;
            }
            Listener::Absent => return,
            Listener::Failed if first => return,
            Listener::Failed => attempt += 1,
        }
        first = false;
    }
}

impl Drop for HttpTransport {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&self, message: Value, liveness: Liveness) -> Result<(), TransportError> {
        liveness
            .bound_head(self.post_message(message))
            .await
            .map_err(expired)?
    }

    async fn close(&self) {
        if self.shutdown.is_cancelled() {
            return;
        }
        self.shutdown.cancel();
        let has_session = self
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        if has_session {
            // Tells the server the session is over; the answer does not matter.
            let _ = STARTUP
                .bound_head(self.decorate(self.client.delete(self.url.clone())).send())
                .await;
        }
        let _ = self.incoming.send(Incoming::Closed(CloseCause {
            reason: "closed by client".to_owned(),
            stderr_tail: String::new(),
        }));
    }

    fn set_protocol_version(&self, version: &str) {
        *self.version.lock().unwrap_or_else(|e| e.into_inner()) = Some(version.to_owned());
    }

    fn initialized(&self) {
        let Ok(base) = self
            .decorate(self.client.get(self.url.clone()))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .build()
        else {
            return;
        };
        let client = self.client.clone();
        let tx = self.incoming.clone();
        let shutdown = self.shutdown.clone();
        let auth = self.auth.clone();
        let open = move |resume: Option<String>| {
            let (client, auth, base) = (client.clone(), auth.clone(), base.try_clone());
            async move {
                let Some(base) = base else {
                    return Listener::Failed;
                };
                // Each attempt takes the token it is given (a reopen takes the current one, as the
                // SDK's `_commonHeaders` does).
                let request = |token: Option<String>| {
                    let mut request = base.try_clone()?;
                    if let Some(token) = token
                        && let Ok(mut value) = HeaderValue::from_str(&format!("Bearer {token}"))
                    {
                        value.set_sensitive(true);
                        request.headers_mut().insert(reqwest::header::AUTHORIZATION, value);
                    }
                    if let Some(id) = resume.clone().and_then(|id| HeaderValue::from_str(&id).ok()) {
                        request.headers_mut().insert("last-event-id", id);
                    }
                    Some(request)
                };
                let attempted = match &auth {
                    Some(auth) => match auth.token().await {
                        Ok(token) => token,
                        Err(_) => return Listener::Failed,
                    },
                    None => None,
                };
                let mut sent = attempted.clone();
                let Some(first) = request(attempted.clone()) else {
                    return Listener::Failed;
                };
                let Ok(Ok(mut response)) = STARTUP.bound_head(client.execute(first)).await else {
                    return Listener::Failed;
                };
                if let Some(auth) = &auth
                    && crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref())
                {
                    // As `post_message`: renew once and replay; a second refusal needs the user.
                    if auth.renew(attempted.clone(), crate::transport::challenge_of(&response)).await.is_err() {
                        return Listener::Failed;
                    }
                    let Ok(fresh) = auth.token().await else { return Listener::Failed };
                    let Some(second) = request(fresh.clone()) else {
                        return Listener::Failed;
                    };
                    let Ok(Ok(replayed)) = STARTUP.bound_head(client.execute(second)).await else {
                        return Listener::Failed;
                    };
                    response = replayed;
                    if crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref()) {
                        auth.refused_after_renewal(attempted.as_deref());
                        return Listener::Failed;
                    }
                    sent = fresh;
                }
                if response.status().is_success() {
                    if let Some(auth) = &auth {
                        auth.answered(sent.as_deref());
                    }
                    Listener::Stream(response)
                } else if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
                    Listener::Absent
                } else {
                    Listener::Failed
                }
            }
        };        mixdog_rt::spawn(
            "mcp.http.listen",
            mixdog_rt::TaskClass::Work,
            keep_listening(open, tx, shutdown),
        );
    }
}

impl HttpTransport {
    async fn post_message(&self, message: Value) -> Result<(), TransportError> {
        if self.shutdown.is_cancelled() {
            return Err(TransportError::Closed);
        }
        let post = |token: Option<String>| {
            let mut request = self
                .decorate(self.client.post(self.url.clone()))
                .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
                .json(&message);
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            request
        };
        let attempted = match &self.auth {
            Some(auth) => auth.token().await?,
            None => None,
        };
        let mut sent = attempted.clone();
        let mut response = post(attempted.clone()).send().await.map_err(request_error)?;
        if let Some(auth) = &self.auth
            && crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref())
        {
            // The token was refused: renew it once and replay; a second refusal needs the user.
            auth.renew(attempted.clone(), crate::transport::challenge_of(&response)).await?;
            let fresh = auth.token().await?;
            response = post(fresh.clone()).send().await.map_err(request_error)?;
            if crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref()) {
                auth.refused_after_renewal(attempted.as_deref());
                return Err(TransportError::AuthRequired);
            }
            sent = fresh;
        }
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let body: String = body.chars().take(ERROR_BODY_CHARS).collect();
            return Err(TransportError::Http { status: status.as_u16(), body });
        }
        if let Some(auth) = &self.auth {
            auth.answered(sent.as_deref());
        }
        if let Some(session) = response.headers().get(SESSION_HEADER).and_then(|v| v.to_str().ok()) {
            *self.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session.to_owned());
        }
        if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
            return Ok(());
        }
        let is_sse = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        if is_sse {
            mixdog_rt::spawn(
                "mcp.http.sse",
                mixdog_rt::TaskClass::Work,
                pump_sse(response, self.incoming.clone(), self.shutdown.clone()),
            );
        } else {
            let value: Value = response.json().await.map_err(request_error)?;
            self.deliver(value);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::*;

    /// The first GET gets a stream that ends after one event with an id and a `retry:`; every
    /// later GET gets a 500 and its `Last-Event-ID` is recorded.
    async fn listener_server() -> (std::net::SocketAddr, Arc<Mutex<Vec<Option<String>>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let served = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let record = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (record, served) = (Arc::clone(&record), Arc::clone(&served));
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..read]).to_lowercase();
                    let id = head
                        .lines()
                        .find_map(|l| l.strip_prefix("last-event-id: "))
                        .map(|v| v.trim().to_owned());
                    record.lock().unwrap().push(id);
                    let reply = if served.fetch_add(1, Ordering::SeqCst) == 0 {
                        let body = "id: 7\nretry: 100\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n";
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    } else {
                        "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned()
                    };
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        (addr, seen)
    }

    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

    /// Answers every GET `401` unless it carries `Bearer new`, which gets a stream; each answer is
    /// signalled (its status) after it was written.
    async fn refusing_server() -> (std::net::SocketAddr, UnboundedReceiver<u16>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (answered, signals) = unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let answered = answered.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..read]).to_lowercase();
                    let (status, reply) = if head.contains("authorization: bearer new") {
                        let body = "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n";
                        (200, format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()))
                    } else {
                        (401, "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned())
                    };
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = answered.send(status);
                });
            }
        });
        (addr, signals)
    }

    /// A sign-in holding `old`; a renewal gives `new` when `renews`, `stays` keeps `old` (the
    /// replay is refused again), else it needs the user. Every call is signalled.
    #[derive(Clone, Copy, PartialEq)]
    enum Renewal {
        Renews,
        Stays,
        NeedsUser,
    }

    struct Recording {
        token: Mutex<String>,
        renewal: Renewal,
        events: UnboundedSender<String>,
    }

    #[async_trait::async_trait]
    impl Authorizer for Recording {
        async fn token(&self) -> Result<Option<String>, TransportError> {
            Ok(Some(self.token.lock().unwrap().clone()))
        }
        async fn renew(&self, rejected: Option<String>, _: Option<String>) -> Result<(), TransportError> {
            let _ = self.events.send(format!("renew {}", rejected.unwrap_or_default()));
            match self.renewal {
                Renewal::Renews => {
                    *self.token.lock().unwrap() = "new".to_owned();
                    Ok(())
                }
                Renewal::Stays => Ok(()),
                Renewal::NeedsUser => Err(TransportError::AuthRequired),
            }
        }
        fn answered(&self, sent: Option<&str>) {
            let _ = self.events.send(format!("answered {}", sent.unwrap_or_default()));
        }
        fn refused_after_renewal(&self, attempted: Option<&str>) {
            let _ = self.events.send(format!("refused again {}", attempted.unwrap_or_default()));
        }
    }

    /// Opens the listener of a transport over `Recording` and awaits its first `n` reports and the
    /// first `m` answers of the server: signals, not time.
    async fn listen(renewal: Renewal, n: usize, m: usize) -> (Vec<String>, Vec<u16>) {
        // `initialized` spawns the listener through the runtime, which needs a backend installed.
        let _runtime = mixdog_rt::testing::tokens();
        let (addr, mut answers) = refusing_server().await;
        let (events, mut reports) = unbounded_channel();
        let auth = Arc::new(Recording { token: Mutex::new("old".to_owned()), renewal, events });
        let url = Url::parse(&format!("http://{addr}/mcp")).unwrap();
        let (transport, _rx) = HttpTransport::new(url, &BTreeMap::new(), Some(auth)).unwrap();
        transport.initialized();
        let mut seen = Vec::new();
        while seen.len() < n {
            seen.push(reports.recv().await.expect("the listener reports"));
        }
        let mut statuses = Vec::new();
        while statuses.len() < m {
            statuses.push(answers.recv().await.expect("the server answers"));
        }
        transport.close().await;
        (seen, statuses)
    }

    /// The listener's GET is covered like any other request (Node's fetch): a refused token is
    /// renewed and replayed, and the success is reported with the renewed token.
    #[tokio::test]
    async fn the_listener_renews_a_refused_token_and_reports_the_success() {
        let (seen, statuses) = listen(Renewal::Renews, 2, 2).await;
        assert_eq!(seen, ["renew old", "answered new"]);
        assert_eq!(statuses, [401, 200]);
    }

    /// A second refusal after the renewal is reported with the token first sent.
    #[tokio::test]
    async fn the_listener_reports_a_refusal_after_renewal() {
        let (seen, statuses) = listen(Renewal::Stays, 2, 2).await;
        assert_eq!(seen, ["renew old", "refused again old"]);
        assert_eq!(statuses, [401, 401]);
    }

    /// A renewal that needs the user ends the attempt: nothing is replayed or reported after it.
    #[tokio::test]
    async fn the_listener_stops_when_the_renewal_needs_the_user() {
        let (seen, statuses) = listen(Renewal::NeedsUser, 1, 1).await;
        assert_eq!(seen, ["renew old"]);
        assert_eq!(statuses, [401]);
    }
    #[tokio::test(start_paused = true)]
    async fn the_listener_stream_ends_and_is_reopened_with_its_last_event_id_then_given_up_after_two_failures()
     {
        let (addr, seen) = listener_server().await;
        let client = reqwest::Client::new();
        let open = move |resume: Option<String>| {
            let client = client.clone();
            async move {
                let mut request = client.get(format!("http://{addr}/mcp"));
                if let Some(id) = resume {
                    request = request.header("last-event-id", id);
                }
                match request.send().await {
                    Ok(response) if response.status().is_success() => Listener::Stream(response),
                    _ => Listener::Failed,
                }
            }
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        keep_listening(open, tx, CancellationToken::new()).await;

        // One stream, then two failed reopens: the SDK's `maxRetries` of 2. Both reopens resumed from id 7.
        assert_eq!(
            *seen.lock().unwrap(),
            vec![None, Some("7".to_owned()), Some("7".to_owned())]
        );
        // The event arrived, and the client was never told the connection closed.
        assert!(matches!(rx.try_recv(), Ok(Incoming::Message(_))));
        assert!(
            rx.try_recv().is_err(),
            "no Incoming::Closed: the POST path still works"
        );
    }

    #[test]
    fn the_reconnect_delay_grows_by_half_each_attempt_up_to_the_cap_and_yields_to_the_server() {
        assert_eq!(reconnect_delay(0, None), Duration::from_millis(1000));
        assert_eq!(reconnect_delay(1, None), Duration::from_millis(1500));
        assert_eq!(reconnect_delay(30, None), Duration::from_millis(30_000));
        assert_eq!(
            reconnect_delay(1, Some(Duration::from_millis(100))),
            Duration::from_millis(100)
        );
    }
}
