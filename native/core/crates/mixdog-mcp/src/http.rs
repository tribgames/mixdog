//! Streamable HTTP transport: every message is a POST; the answer is JSON, an SSE stream or
//! 202. After the handshake one GET stream carries server-initiated messages when the server
//! offers it.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

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

/// Splits an SSE byte stream into events and forwards each `data` payload that is JSON.
async fn pump_sse(response: reqwest::Response, tx: IncomingTx, shutdown: CancellationToken) {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_bytes: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            () = shutdown.cancelled() => return,
            chunk = stream.next() => chunk,
        };
        let Some(Ok(chunk)) = chunk else { return };
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
        while let Some(end) = rest.find("\n\n") {
            let event = &rest[..end];
            rest = &rest[end + 2..];
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
}

impl Drop for HttpTransport {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&self, message: Value) -> Result<(), TransportError> {
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
        let mut response = post(attempted.clone()).send().await.map_err(request_error)?;
        if let Some(auth) = &self.auth
            && crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref())
        {
            // The token was refused: renew it once and replay; a second refusal needs the user.
            auth.renew(attempted, crate::transport::challenge_of(&response)).await?;
            let fresh = auth.token().await?;
            response = post(fresh).send().await.map_err(request_error)?;
            if crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref()) {
                return Err(TransportError::AuthRequired);
            }
        }
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let body: String = body.chars().take(ERROR_BODY_CHARS).collect();
            return Err(TransportError::Http { status: status.as_u16(), body });
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

    async fn close(&self) {
        if self.shutdown.is_cancelled() {
            return;
        }
        self.shutdown.cancel();
        let has_session = self.session.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        if has_session {
            // Tells the server the session is over; the answer does not matter.
            let _ = self.decorate(self.client.delete(self.url.clone())).send().await;
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
        let mut request = self
            .decorate(self.client.get(self.url.clone()))
            .header(reqwest::header::ACCEPT, "text/event-stream");
        let tx = self.incoming.clone();
        let shutdown = self.shutdown.clone();
        let auth = self.auth.clone();
        mixdog_rt::spawn("mcp.http.listen", mixdog_rt::TaskClass::Work, async move {
            if let Some(auth) = auth
                && let Ok(Some(token)) = auth.token().await
            {
                request = request.bearer_auth(token);
            }
            // 405 means the server has no standalone stream; any other outcome ends it too.
            if let Ok(response) = request.send().await
                && response.status().is_success()
            {
                pump_sse(response, tx, shutdown).await;
            }
        });
    }
}
