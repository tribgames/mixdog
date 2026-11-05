//! The request helper of every login flow: one request through the shared
//! transport read whole, a refusal before a status being a failed login with
//! the transport's own reason, and the scrubber that keeps secrets out of
//! failure messages.

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

/// One request; the failure carries code `transport`.
pub async fn call(
    http: &dyn HttpSend,
    method: &str,
    url: &str,
    headers: Vec<(&str, String)>,
    body: Vec<u8>,
) -> Result<Reply, LoginFailure> {
    let response = http
        .send(WireRequest {
            transport: TransportKind::Http1,
            method: method.into(),
            url: url.into(),
            headers: headers
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
            body,
        })
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

/// `text` with every secret removed, cut to `limit` UTF-16 units
/// (`slice(0, limit)`).
pub fn scrub(text: &str, secrets: &[&str], limit: usize) -> String {
    let mut out = text.to_owned();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        out = out.replace(secret, "[redacted]");
    }
    mixdog_js::slice_utf16(&out, limit)
}

#[cfg(test)]
mod scrub_tests {
    use super::scrub;

    #[test]
    fn the_cut_counts_utf16_units_and_a_split_pair_becomes_fffd() {
        // U+1F600 is two UTF-16 units: a cut of 3 keeps "ab" and half the pair.
        assert_eq!(scrub("ab\u{1F600}cd", &[], 3), "ab\u{fffd}");
        assert_eq!(scrub("ab\u{1F600}cd", &[], 4), "ab\u{1F600}");
        assert_eq!(scrub("ab", &[], 10), "ab");
    }

    #[test]
    fn secrets_are_removed_before_the_cut() {
        assert_eq!(scrub("key=sk-123 tail", &["sk-123"], 14), "key=[redacted]");
    }
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
        async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
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
