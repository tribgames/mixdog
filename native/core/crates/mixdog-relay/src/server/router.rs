//! `routeRequest` of `server.mjs`: which service answers a request. String tests on the raw `request.url`, first match wins:
//! a route answers its exact path plus the sub-path or query it takes, so `/client/registerX` and `/claims` fall to the
//! static gate as unknown paths, as does an absolute-form target (`GET http://host/x`).

use std::sync::Arc;

use crate::feedback::FeedbackEndpoint;
use crate::hook::HookHub;
use crate::http1::{Request, ResponseWriter, fail_request};
use crate::media::MediaProxy;
use crate::pages::app::AppPages;
use crate::pages::connect::connect_page;
use crate::pages::{PageReply, PageRequest};
use crate::pairing::Pairing;
use crate::web::gate::{StaticGate, write_page_reply};
use crate::web::readiness::RendererReadiness;
use crate::web_push::http::{WebPushEndpoint, is_web_push_request};

/// Every service a request can reach.
pub(super) struct Routes {
    pub readiness: RendererReadiness,
    pub feedback: Arc<FeedbackEndpoint>,
    pub hooks: Arc<HookHub>,
    pub pairing: Arc<Pairing>,
    pub app: AppPages,
    pub web_push: WebPushEndpoint,
    pub media: Arc<MediaProxy>,
    pub gate: StaticGate,
}

/// `writeHead(status, headers).end(body)`; a head that cannot be written is answered as the guarded handler answers a throw.
fn finish(response: &mut ResponseWriter, status: u16, headers: &[(&str, &str)], body: Option<&[u8]>) {
    match response.write_head(status, headers) {
        Ok(()) => response.end(body),
        Err(error) => fail_request("request", &error.to_string(), response),
    }
}

fn send_page(response: &mut ResponseWriter, reply: &PageReply) {
    if let Err(error) = write_page_reply(response, reply) {
        fail_request("request", &error.to_string(), response);
    }
}

/// `url` is `path` itself or `path` followed by one of `continuations`.
fn is_route(url: &str, path: &str, continuations: &[char]) -> bool {
    url.strip_prefix(path).is_some_and(|rest| rest.chars().next().is_none_or(|next| continuations.contains(&next)))
}

/// `POST /client/register`, whose pairing token may ride `?token=`.
fn is_registration(url: &str) -> bool {
    is_route(url, "/client/register", &['?'])
}

/// `POST /claim` and `GET /claim/<claimId>`.
fn is_claim(url: &str) -> bool {
    is_route(url, "/claim", &['/', '?'])
}

impl Routes {
    /// Answers one request.
    pub(super) async fn route(&self, request: Request, mut response: ResponseWriter) {
        let url = request.url.clone();
        // `url.split('?')[0]`
        let target = url.split('?').next().unwrap_or("");
        if target == "/readyz" {
            self.readyz(&request, &mut response);
            return;
        }
        if target == "/feedback" {
            self.feedback.handle(request, response).await;
            return;
        }
        // Public webhook ingress bypasses the pairing-token gate: callers are external services (GitHub, Stripe); authentication is
        // the per-endpoint HMAC signature verified on the agent side.
        if url.starts_with("/hook/") {
            self.hooks.handle_request(request, response).await;
            return;
        }
        // Pairing: redeem a six-digit code, probe a host, and the public browser entry page. None of them grants access; the desktop
        // still approves.
        if url.starts_with("/pair-code/") {
            self.pairing.handle_pair_code(request, response).await;
            return;
        }
        let page = PageRequest { method: &request.method, user_agent: request.headers.get("user-agent") };
        if target == "/app" {
            send_page(&mut response, &self.app.app_page(page));
            return;
        }
        if target == "/app/latest.json" {
            send_page(&mut response, &self.app.latest_release(page));
            return;
        }
        if target == "/connect" {
            send_page(&mut response, &connect_page(page));
            return;
        }
        // Relay-owned Web Push: the sender key and the per-PC subscription associations.
        if is_web_push_request(&url) {
            self.web_push.handle(request, response).await;
            return;
        }
        if is_registration(&url) {
            self.pairing.handle_registration(request, response).await;
            return;
        }
        // Approval handoff: the only surface a credential-less container may use, and it grants nothing without the desktop's answer.
        if is_claim(&url) {
            self.pairing.handle_claim(request, response).await;
            return;
        }
        // Media is a byte lane: it answers before the app shell so a gallery tile or a video seek never rides the phone's RPC socket.
        if url.starts_with("/media/") {
            self.media.handle_request(request, response).await;
            return;
        }
        self.gate.serve(&request, &mut response).await;
    }

    fn readyz(&self, request: &Request, response: &mut ResponseWriter) {
        if request.method != "GET" && request.method != "HEAD" {
            finish(response, 405, &[], None);
            return;
        }
        let ready = self.readiness.check();
        let body = ready.body_json();
        let body = (request.method != "HEAD").then_some(body.as_bytes());
        finish(response, ready.status_code(), &[("Content-Type", "application/json"), ("Cache-Control", "no-store")], body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The order of `routeRequest` is the order of the string tests; this keeps the one place that decides them honest.
    #[test]
    fn the_string_tests_match_nodes_on_the_raw_target() {
        let split = |url: &str| url.split('?').next().unwrap_or("").to_owned();
        assert_eq!(split("/readyz?probe=1"), "/readyz");
        assert_eq!(split("/readyz/"), "/readyz/");
        assert_eq!(split("http://other.example/readyz"), "http://other.example/readyz");
        assert!(!"/hook".starts_with("/hook/"));
        assert!(is_web_push_request("/webpush?x=1") && is_web_push_request("/webpush/key") && !is_web_push_request("/webpushx"));
    }

    #[test]
    fn look_alike_paths_miss_the_registration_and_claim_routes() {
        for url in ["/client/register", "/client/register?token=fedcba9876543210"] {
            assert!(is_registration(url), "{url}");
        }
        for url in ["/claim", "/claim?x=1", "/claim/0f8c2a6e-1d3b-4c5a-9e7f-2b6d8a4c1e3f"] {
            assert!(is_claim(url), "{url}");
        }
        for url in [
            "/client/registerX",
            "/client/registered",
            "/client/register/",
            "/client/register-x?token=1",
            "/client/register.json",
            "/client/registe",
            "//client/register",
            "http://host/client/register",
        ] {
            assert!(!is_registration(url), "{url}");
        }
        for url in ["/claimfoo", "/claims", "/claims/abc", "/claim-x", "/claim.json", "/clai", "http://host/claim"] {
            assert!(!is_claim(url), "{url}");
        }
    }
}
