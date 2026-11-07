//! The request every provider adapter makes: a JSON POST that never follows a redirect
//! (`redirect: 'error'`: a credential is not sent on to another host) and gives up after a
//! timeout. The production implementation rides the daemon's single `RoutedClients`, like
//! [`super::catalog_http::RoutedCatalogHttp`].

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::netproxy::RoutedClients;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::catalog_fetch::HttpFailure;

/// The answer to a POST: its status and body text.
pub struct PostReply {
    pub status: u16,
    /// Response headers, names as the server sent them.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[async_trait]
pub trait JsonPost: Send + Sync {
    /// `fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal })`.
    /// `headers` are sent in the order given; `body` is serialised as the value holds it. A
    /// timeout is `HttpFailure { timed_out: true }`, a cancelled request the abort message, a
    /// redirect or a transport failure `fetch failed`.
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, cancel: &CancellationToken) -> Result<PostReply, HttpFailure>;

    /// The same for a GET (a job's status poll).
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration, cancel: &CancellationToken) -> Result<PostReply, HttpFailure>;
}

pub struct RoutedJsonPost {
    clients: Arc<RoutedClients>,
}

impl RoutedJsonPost {
    pub fn new(clients: Arc<RoutedClients>) -> Self {
        Self { clients }
    }
}

fn failure(message: &str, timed_out: bool) -> HttpFailure {
    HttpFailure { message: message.to_owned(), timed_out }
}

fn transport(error: &reqwest::Error) -> HttpFailure {
    if error.is_timeout() { failure("The operation was aborted due to timeout", true) } else { failure("fetch failed", false) }
}

impl RoutedJsonPost {
    async fn send(&self, url: &str, headers: &[(String, String)], body: Option<&Value>, timeout: Duration, cancel: &CancellationToken) -> Result<PostReply, HttpFailure> {
        let client = self.clients.client_for(url).await.map_err(|error| failure(&error.to_string(), false))?;
        let mut request = match body {
            Some(body) => client.post(url).body(mixdog_js::json_stringify(body)),
            None => client.get(url),
        }
        .timeout(timeout);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let aborted = || failure("This operation was aborted", false);
        let response = tokio::select! {
            () = cancel.cancelled() => return Err(aborted()),
            sent = request.send() => sent.map_err(|error| transport(&error))?,
        };
        // `redirect: 'error'`
        if response.status().is_redirection() {
            return Err(failure("fetch failed", false));
        }
        let status = response.status().as_u16();
        let headers = response.headers().iter().map(|(name, value)| (name.to_string(), String::from_utf8_lossy(value.as_bytes()).into_owned())).collect();
        let text = tokio::select! {
            () = cancel.cancelled() => return Err(aborted()),
            text = response.text() => text.map_err(|error| transport(&error))?,
        };
        Ok(PostReply { status, headers, body: text })
    }
}

#[async_trait]
impl JsonPost for RoutedJsonPost {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, cancel: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.send(url, headers, Some(body), timeout, cancel).await
    }

    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration, cancel: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.send(url, headers, None, timeout, cancel).await
    }
}