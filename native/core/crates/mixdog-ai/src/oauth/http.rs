//! The request helper of every login flow: one request through the shared
//! transport read whole, a refusal before a status being a failed login with
//! the transport's own reason (the scrubber is [`super::scrub`]).

use crate::transport::Exchange;
use crate::transport::deadlines::TOKEN_EXCHANGE;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::login::LoginFailure;
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
        .await
        .map_err(|err| failed("transport", err.message))?;
    let read = response
        .read_all()
        .await
        .map_err(|err| failed("transport", err.message))?;
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
