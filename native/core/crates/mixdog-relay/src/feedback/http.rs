//! `POST /feedback` (`lib/feedback-http.mjs`): the refusals that need no body come first, the body is read under a size cap, a
//! time limit and a limit on how many are read at once, and `202` is answered only once the service has the record on disk.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use super::service::FeedbackService;
use super::{FeedbackError, MAX_BODY_BYTES};
use crate::http1::util::client_ip;
use crate::http1::{ConnHandle, Request, ResponseWriter};
use crate::js;

/// How long a body may take to arrive.
pub const BODY_TIMEOUT: Duration = Duration::from_secs(60);
/// The most bodies read at the same time: each can be ~8 MB and is held about twice.
const MAX_CONCURRENT_READS: usize = 3;

/// What reading the body came to.
enum Read {
    Body(Vec<u8>),
    /// The body is refused with this status and code; the connection is closed once the answer is out.
    Refused(u16, &'static str),
    /// The request ended before its body did: there is no one to answer.
    Gone,
}

/// One of the places for a body being read; the place is given back when this is dropped, however the request ends.
struct Slot<'a>(&'a AtomicUsize);

impl<'a> Slot<'a> {
    fn take(active: &'a AtomicUsize) -> Option<Self> {
        active.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |held| (held < MAX_CONCURRENT_READS).then_some(held + 1)).ok()?;
        Some(Self(active))
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The handler of the `/feedback` route. `service` is `None` when it failed to build.
pub struct FeedbackEndpoint {
    service: Option<FeedbackService>,
    active_reads: AtomicUsize,
    body_timeout: Duration,
}

/// `application/json` with optional parameters, in any case: `/^application\/json\s*(;|$)/i` of the trimmed header.
fn is_json(content_type: &str) -> bool {
    let trimmed = js::js_trim(content_type);
    let Some(head) = trimmed.get(..16).filter(|head| head.eq_ignore_ascii_case("application/json")) else { return false };
    let rest = mixdog_js::js_trim_start(&trimmed[head.len()..]);
    rest.is_empty() || rest.starts_with(';')
}

fn reply(response: &mut ResponseWriter, status: u16, payload: &Value, extra: &[(&str, &str)]) {
    let mut headers = vec![("Content-Type", "application/json"), ("Cache-Control", "no-store")];
    headers.extend_from_slice(extra);
    if response.write_head(status, &headers).is_ok() {
        response.end(Some(js::wire(payload).as_bytes()));
    } else {
        response.destroy();
    }
}

fn fail(response: &mut ResponseWriter, status: u16, code: &str, extra: &[(&str, &str)]) {
    reply(response, status, &json!({ "error": code }), extra);
}

/// Answers without consuming the body, then drops the connection once the answer is out.
async fn refuse_unread(conn: ConnHandle, response: &mut ResponseWriter, status: u16, code: &str) {
    fail(response, status, code, &[("Connection", "close")]);
    response.finished().await;
    conn.destroy();
}

impl FeedbackEndpoint {
    pub fn new(service: Option<FeedbackService>) -> Self {
        Self { service, active_reads: AtomicUsize::new(0), body_timeout: BODY_TIMEOUT }
    }

    /// The same with another limit on how long a body may take.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_body_timeout(mut self, timeout: Duration) -> Self {
        self.body_timeout = timeout;
        self
    }

    /// The service the endpoint answers with, for the relay to close it.
    pub fn service(&self) -> Option<&FeedbackService> {
        self.service.as_ref()
    }

    async fn read_body(&self, request: &mut Request) -> Read {
        let timer = mixdog_rt::time::sleep(self.body_timeout);
        tokio::pin!(timer);
        let mut body = Vec::new();
        loop {
            let step = tokio::select! {
                () = &mut timer => Err(()),
                next = request.body.next() => match next {
                    None => Ok(None),
                    Some(Err(_)) => return Read::Gone,
                    Some(Ok(chunk)) => Ok(Some(chunk)),
                },
            };
            match step {
                Err(()) => return Read::Refused(408, "request_timeout"),
                Ok(None) => return Read::Body(body),
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > MAX_BODY_BYTES {
                        return Read::Refused(413, "payload_too_large");
                    }
                    body.extend_from_slice(&chunk);
                }
            }
        }
    }

    /// `handleFeedbackRequest(feedback, request, response)`.
    pub async fn handle(&self, mut request: Request, mut response: ResponseWriter) {
        if request.method != "POST" {
            fail(&mut response, 405, "method_not_allowed", &[("Allow", "POST")]);
            return;
        }
        let Some(service) = self.service.as_ref().filter(|service| service.configured()) else {
            refuse_unread(request.conn().clone(), &mut response, 503, "feedback_unavailable").await;
            return;
        };
        if !request.headers.get("content-type").is_some_and(is_json) {
            refuse_unread(request.conn().clone(), &mut response, 415, "unsupported_media_type").await;
            return;
        }
        if let Err(error) = service.check_rate(client_ip(request.remote_address.as_deref())) {
            fail(&mut response, error.status, error.code, &[]);
            return;
        }
        let declared = request.headers.get("content-length").map_or(f64::NAN, mixdog_js::string_to_number);
        if declared > MAX_BODY_BYTES as f64 {
            refuse_unread(request.conn().clone(), &mut response, 413, "payload_too_large").await;
            return;
        }
        let Some(slot) = Slot::take(&self.active_reads) else {
            refuse_unread(request.conn().clone(), &mut response, 503, "feedback_busy").await;
            return;
        };
        let raw = match self.read_body(&mut request).await {
            Read::Body(raw) => raw,
            Read::Refused(status, code) => {
                // The place is given back before the refusal goes out (`readBody` resolves first); a body that was read
                // keeps it until the answer.
                drop(slot);
                refuse_unread(request.conn().clone(), &mut response, status, code).await;
                return;
            }
            Read::Gone => return,
        };
        let result = match js::parse_bytes(&raw) {
            Ok(body) => service.submit(&body).await,
            Err(_) => Err(FeedbackError { status: 400, code: "invalid_feedback" }),
        };
        match result {
            Ok(accepted) => reply(&mut response, 202, &json!({ "id": accepted.id, "status": accepted.status }), &[]),
            Err(error) => fail(&mut response, error.status, error.code, &[]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_content_type_is_application_json_in_any_case_with_optional_parameters() {
        for yes in ["application/json", "Application/JSON; charset=utf-8", " application/json ", "application/json ;x=1", "application/json;"] {
            assert!(is_json(yes), "{yes}");
        }
        for no in ["", "text/plain", "application/jsonp", "application/json-seq", "application/x-www-form-urlencoded", "multipart/form-data", "application/jso"] {
            assert!(!is_json(no), "{no}");
        }
    }

    #[test]
    fn a_slot_is_given_back_when_dropped_and_only_three_exist() {
        let active = AtomicUsize::new(0);
        let held: Vec<_> = (0..3).map(|_| Slot::take(&active).expect("a place")).collect();
        assert!(Slot::take(&active).is_none());
        drop(held);
        assert!(Slot::take(&active).is_some());
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}
