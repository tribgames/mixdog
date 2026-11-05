//! Legacy HTTP+SSE transport: one long-lived GET event stream carries the server's messages and
//! announces (`endpoint` event) the URL the client POSTs its own messages to. The endpoint must be
//! on the server's origin: nothing else receives the headers or the sign-in token.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::transport::Authorizer;
use crate::transport::CloseCause;
use crate::transport::Incoming;
use crate::transport::IncomingRx;
use crate::transport::IncomingTx;
use crate::transport::Transport;
use crate::transport::TransportError;

const ERROR_BODY_CHARS: usize = 2048;

pub struct SseTransport {
    client: reqwest::Client,
    endpoint: Url,
    headers: HeaderMap,
    auth: Option<Arc<dyn Authorizer>>,
    shutdown: CancellationToken,
    incoming: IncomingTx,
}

fn request_error(error: reqwest::Error) -> TransportError {
    TransportError::Request(error.without_url().to_string())
}

pub(crate) fn header_map(headers: &BTreeMap<String, String>) -> Result<HeaderMap, TransportError> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| TransportError::Request(format!("invalid header name {name:?}")))?;
        let mut value = HeaderValue::from_str(value)
            .map_err(|_| TransportError::Request(format!("invalid value for header {name}")))?;
        value.set_sensitive(true);
        map.insert(name, value);
    }
    Ok(map)
}

/// One parsed event: its `event` name (default `message`) and joined `data`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Event {
    pub name: String,
    pub data: String,
}

/// Accumulates a byte stream into events.
#[derive(Default)]
pub(crate) struct EventParser {
    pending: Vec<u8>,
    text: String,
}

impl EventParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<Event> {
        self.pending.extend_from_slice(chunk);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                self.text.push_str(text);
                self.pending.clear();
            }
            Err(error) => {
                let valid = error.valid_up_to();
                self.text.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                self.pending.drain(..valid);
            }
        }
        let normalized = self.text.replace("\r\n", "\n").replace('\r', "\n");
        let mut rest = normalized.as_str();
        let mut events = Vec::new();
        while let Some(end) = rest.find("\n\n") {
            let block = &rest[..end];
            rest = &rest[end + 2..];
            let (mut name, mut data) = (String::from("message"), Vec::new());
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    name = value.trim().to_owned();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.strip_prefix(' ').unwrap_or(value));
                }
            }
            if !data.is_empty() {
                events.push(Event { name, data: data.join("\n") });
            }
        }
        self.text = rest.to_owned();
        events
    }
}

async fn pump(
    response: reqwest::Response,
    origin: Url,
    tx: IncomingTx,
    endpoint: oneshot::Sender<Result<Url, TransportError>>,
    shutdown: CancellationToken,
) {
    let mut endpoint = Some(endpoint);
    let mut stream = response.bytes_stream();
    let mut parser = EventParser::default();
    let reason = loop {
        let chunk = tokio::select! {
            () = shutdown.cancelled() => break "closed by client".to_owned(),
            chunk = stream.next() => chunk,
        };
        let Some(Ok(chunk)) = chunk else { break "event stream ended".to_owned() };
        for event in parser.push(&chunk) {
            if event.name == "endpoint" {
                let resolved = origin
                    .join(event.data.trim())
                    .map_err(|_| TransportError::Request("the server announced an invalid endpoint".to_owned()))
                    .and_then(|url| {
                        if url.origin() == origin.origin() {
                            Ok(url)
                        } else {
                            Err(TransportError::Request("the server announced an endpoint on another origin".to_owned()))
                        }
                    });
                if let Some(sender) = endpoint.take() {
                    let _ = sender.send(resolved);
                }
            } else if event.name == "message" {
                match serde_json::from_str::<Value>(&event.data) {
                    Ok(message) => {
                        let _ = tx.send(Incoming::Message(message));
                    }
                    Err(error) => tracing::warn!(%error, "mcp sse: message is not JSON"),
                }
            }
        }
    };
    if let Some(sender) = endpoint.take() {
        let _ = sender.send(Err(TransportError::Closed));
    }
    let _ = tx.send(Incoming::Closed(CloseCause { reason, stderr_tail: String::new() }));
}

impl SseTransport {
    pub async fn connect(
        url: Url,
        headers: &BTreeMap<String, String>,
        auth: Option<Arc<dyn Authorizer>>,
    ) -> Result<(Self, IncomingRx), TransportError> {
        let headers = header_map(headers)?;
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(request_error)?;
        let get = |token: Option<String>| {
            let mut request =
                client.get(url.clone()).headers(headers.clone()).header(reqwest::header::ACCEPT, "text/event-stream");
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            request
        };
        let attempted = match &auth {
            Some(auth) => auth.token().await?,
            None => None,
        };
        let mut response = get(attempted.clone()).send().await.map_err(request_error)?;
        if let Some(auth) = &auth
            && crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref())
        {
            auth.renew(attempted, crate::transport::challenge_of(&response)).await?;
            response = get(auth.token().await?).send().await.map_err(request_error)?;
            if crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref()) {
                return Err(TransportError::AuthRequired);
            }
        }
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(TransportError::Http { status: status.as_u16(), body: body.chars().take(ERROR_BODY_CHARS).collect() });
        }
        let (incoming, rx) = mpsc::unbounded_channel();
        let (endpoint_tx, endpoint_rx) = oneshot::channel();
        let shutdown = CancellationToken::new();
        mixdog_rt::spawn(
            "mcp.sse.pump",
            mixdog_rt::TaskClass::Work,
            pump(response, url, incoming.clone(), endpoint_tx, shutdown.clone()),
        );
        let endpoint = endpoint_rx.await.map_err(|_| TransportError::Closed)??;
        Ok((Self { client, endpoint, headers, auth, shutdown, incoming }, rx))
    }
}

impl Drop for SseTransport {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[async_trait]
impl Transport for SseTransport {
    async fn send(&self, message: Value) -> Result<(), TransportError> {
        if self.shutdown.is_cancelled() {
            return Err(TransportError::Closed);
        }
        let post = |token: Option<String>| {
            let mut request = self.client.post(self.endpoint.clone()).headers(self.headers.clone()).json(&message);
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
            auth.renew(attempted, crate::transport::challenge_of(&response)).await?;
            response = post(auth.token().await?).send().await.map_err(request_error)?;
            if crate::transport::refused(response.status().as_u16(), crate::transport::challenge_of(&response).as_deref()) {
                return Err(TransportError::AuthRequired);
            }
        }
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(TransportError::Http { status: status.as_u16(), body: body.chars().take(ERROR_BODY_CHARS).collect() })
    }

    async fn close(&self) {
        if !self.shutdown.is_cancelled() {
            self.shutdown.cancel();
            let _ = self.incoming.send(Incoming::Closed(CloseCause {
                reason: "closed by client".to_owned(),
                stderr_tail: String::new(),
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_split_across_chunks_and_carry_their_names() {
        let mut parser = EventParser::default();
        assert!(parser.push(b"event: endpoint\r\ndata: /messages?s=1").is_empty());
        let first = parser.push(b"\r\n\r\ndata: {\"a\":1}\ndata: 2\n\n");
        assert_eq!(first[0], Event { name: "endpoint".into(), data: "/messages?s=1".into() });
        assert_eq!(first[1], Event { name: "message".into(), data: "{\"a\":1}\n2".into() });
    }
}
