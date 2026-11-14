//! The request helper of every login flow: one request through the shared
//! transport read whole, a refusal before a status being a failed login with
//! the transport's own reason (the scrubber is [`super::scrub`]).

use crate::transport::Exchange;
use crate::transport::deadlines::TOKEN_EXCHANGE;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::JsonValue;

use crate::transport::HttpSend;

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Option<JsonValue> {
        serde_json::from_slice(&self.body).ok()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub fn failed(code: &str, message: impl Into<String>) -> LoginFailure {
    LoginFailure::Failed {
        code: code.into(),
        message: message.into(),
    }
}

/// One request under the token-exchange deadline; the failure carries code `transport`.
pub async fn call(
    http: &dyn HttpSend,
    method: &str,
    url: &str,
    headers: Vec<(&str, String)>,
    body: Vec<u8>,
) -> Result<Reply, LoginFailure> {
    call_under(http, TOKEN_EXCHANGE, method, url, headers, body).await
}

/// [`call`] under the deadline and redirect rule of the call site in Node.
pub async fn call_under(
    http: &dyn HttpSend,
    exchange: Exchange,
    method: &str,
    url: &str,
    headers: Vec<(&str, String)>,
    body: Vec<u8>,
) -> Result<Reply, LoginFailure> {
    try_call_under(http, exchange, method, url, headers, body)
        .await
        .map_err(|err| failed("transport", err.message))
}

/// The hint Node's sign-in pages add to a request that got no answer (`OAUTH_NETWORK_HINT`).
pub const NETWORK_HINT: &str = "Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY.";

/// `oauthNetworkCause` (`oauth-token-utils.mjs:246`): the transport cause of a request that got no answer, as a code
/// ("timed out" for a timer). The typed fault names the codes it can; any other reads as Node's generic "network error".
pub fn network_cause(error: &ProviderError) -> String {
    if error.timed_out {
        return "timed out".to_owned();
    }
    error.transport.as_ref().and_then(|fault| fault.errno_name()).unwrap_or("network error").to_owned()
}

/// `oauthRequestError`: `<operation> request failed (<cause>). <hint>`.
pub fn request_failed(operation: &str, error: &ProviderError) -> String {
    format!("{operation} request failed ({}). {NETWORK_HINT}", network_cause(error))
}

/// [`call`] keeping the transport's typed error, for the sites whose Node code words the failure itself.
pub async fn try_call(
    http: &dyn HttpSend,
    method: &str,
    url: &str,
    headers: Vec<(&str, String)>,
    body: Vec<u8>,
) -> Result<Reply, ProviderError> {
    try_call_under(http, TOKEN_EXCHANGE, method, url, headers, body).await
}

/// [`call_under`] keeping the transport's typed error.
pub async fn try_call_under(
    http: &dyn HttpSend,
    exchange: Exchange,
    method: &str,
    url: &str,
    headers: Vec<(&str, String)>,
    body: Vec<u8>,
) -> Result<Reply, ProviderError> {
    let response = http
        .send(
            WireRequest {
                transport: TransportKind::Http1,
                method: method.into(),
                url: url.into(),
                headers: headers
                    .into_iter()
                    .map(|(k, v)| (k.to_owned(), v))
                    .collect(),
                body,
            },
            exchange,
        )
        .await?;
    let read = response.read_all().await?;
    Ok(Reply {
        status: read.status.unwrap_or(0),
        headers: read.headers,
        body: read.body,
    })
}

#[cfg(test)]
pub(crate) mod testing {
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::login::LoginSession;
    use mixdog_core_api::domain::login::LoginState;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::TransportFault;

    use super::*;
    use crate::transport::BodyStream;
    use crate::transport::HttpResponse;

    struct Once(Option<Bytes>);

    #[async_trait]
    impl BodyStream for Once {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.take().map(Ok)
        }
    }

    /// Answers requests in order and records them.
    pub struct Scripted {
        replies: Mutex<VecDeque<(u16, String)>>,
        pub seen: Mutex<Vec<WireRequest>>,
    }

    impl Scripted {
        pub fn new(replies: &[(u16, &str)]) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.iter().map(|(s, b)| (*s, (*b).to_owned())).collect()),
                seen: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl HttpSend for Scripted {
        async fn send(
            &self,
            request: WireRequest,
            _exchange: crate::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            self.seen.lock().unwrap().push(request);
            let (status, body) = self.replies.lock().unwrap().pop_front().expect("a scripted reply");
            Ok(HttpResponse {
                status,
                headers: Vec::new(),
                body: Box::new(Once(Some(Bytes::from(body)))),
            })
        }
    }

    /// Drives a session to its terminal state.
    pub async fn finish(session: &dyn LoginSession) -> Vec<LoginState> {
        let mut seen = Vec::new();
        while let Some(state) = session.next().await {
            seen.push(state);
        }
        seen
    }
}
