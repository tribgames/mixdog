//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so a test still runs alone in its program. The suites that need the
//! `test-support` feature were targets with `required-features`; they are its modules now.

#[path = "../core_units.rs"]
mod core_units;
#[path = "../diagnostics.rs"]
mod diagnostics;
#[cfg(feature = "test-support")]
#[path = "../feedback_http.rs"]
mod feedback_http;
#[cfg(feature = "test-support")]
#[path = "../feedback_service.rs"]
mod feedback_service;
#[path = "../hook.rs"]
mod hook;
#[path = "../http1.rs"]
mod http1;
#[cfg(feature = "test-support")]
#[path = "../legs_core.rs"]
mod legs_core;
#[cfg(feature = "test-support")]
#[path = "../legs_ingress.rs"]
mod legs_ingress;
#[cfg(feature = "test-support")]
#[path = "../legs_phone.rs"]
mod legs_phone;
#[path = "../legs_policy.rs"]
mod legs_policy;
#[cfg(feature = "test-support")]
#[path = "../media_proxy.rs"]
mod media_proxy;
#[cfg(feature = "test-support")]
#[path = "../native_push.rs"]
mod native_push;
#[path = "../pages.rs"]
mod pages;
#[path = "../pair_codes.rs"]
mod pair_codes;
#[path = "../pairing.rs"]
mod pairing;
#[cfg(feature = "test-support")]
#[path = "../push_ice_frames.rs"]
mod push_ice_frames;
#[path = "../server_smoke.rs"]
mod server_smoke;
#[cfg(feature = "test-support")]
#[path = "../smtp.rs"]
mod smtp;
#[path = "../store.rs"]
mod store;
#[path = "../tool_coturn.rs"]
mod tool_coturn;
#[path = "../tool_renderer_delta.rs"]
mod tool_renderer_delta;
#[path = "../tool_renderer_releases.rs"]
mod tool_renderer_releases;
#[path = "../tool_verify_release.rs"]
mod tool_verify_release;
#[path = "../turn.rs"]
mod turn;
#[path = "../web_gate.rs"]
mod web_gate;
#[path = "../web_push.rs"]
mod web_push;
#[path = "../web_push_http.rs"]
mod web_push_http;
#[path = "../web_releases.rs"]
mod web_releases;
#[path = "../web_static.rs"]
mod web_static;
#[path = "../ws.rs"]
mod ws;
