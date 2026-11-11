//! Replay of `native/core/fixtures/error-presentation-cases` (Node `shared/error-presentation.test.mjs` at b6f10295a).
//!
//! Each recorded probe's input is built as the core holds that failure: a live error (`E`, `T`) is the
//! [`ProviderError`] an adapter classifies from its typed fields through [`kind_of`]; an Anthropic refusal (`Q`) is the
//! [`ErrorResponse`] the warm's [`classify_response`] reads, worded by [`quota_error_text`]; a bare string (`S`) is
//! [`ErrorView::message`]. For each the core's answers are compared with the recorded ones in order: `present`
//! ([`present_error_text`]), `safeDetails` ([`safe_error_details`] of the value's string form) and, for an error
//! object, `providerErrorKind` (the [`Descriptor`] the core persists as `errorKind`). `describe`,
//! `persistedDescribe`, `summaryReDescribe`, `builtError` and the persisted-descriptor (`D`) probes are the desktop
//! renderer's reading of a persisted item (`ErrorNotice.tsx` imports the shared JS module) and Node's own error
//! classes: declared in the manifest's `replay.declaredExclusions`.

use std::io;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::error_text::Descriptor;
use super::error_text::ErrorView;
use super::error_text::PresentOptions;
use super::error_text::present_error_text;
use super::error_text::safe_error_details;
use crate::providers::anthropic::errors::classify_response;
use crate::providers::anthropic::errors::quota_error_text;
use crate::retry::classify::Facts;
use crate::retry::classify::kind_of;
use crate::transport::fault::fault_from_io;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/error-presentation-cases/golden.json");

/// Every kind the core classifies to, in declaration order.
const KINDS: [ErrorKind; 17] = [
    ErrorKind::Overloaded,
    ErrorKind::RateLimited,
    ErrorKind::QuotaExhausted,
    ErrorKind::Entitlement,
    ErrorKind::Billing,
    ErrorKind::Auth,
    ErrorKind::Permission,
    ErrorKind::ContextOverflow,
    ErrorKind::RequestTooLarge,
    ErrorKind::Policy,
    ErrorKind::ServiceTierUnavailable,
    ErrorKind::InvalidRequest,
    ErrorKind::ImageRejected,
    ErrorKind::ReplayRejected,
    ErrorKind::ToolSchemaRejected,
    ErrorKind::Transient,
    ErrorKind::Unknown,
];

/// The live error an `E`/`T` spec describes, as the adapter boundary classifies it from its typed fields.
fn live_error(spec: &Value) -> (ProviderError, String) {
    let fields = &spec["fields"];
    // The recording's numbers decode as JSON floats (`401.0`).
    let whole = |key: &str| fields[key].as_f64().map(|n| n as u64);
    let status = whole("status").filter(|s| *s > 0).map(|s| s as u16);
    let code = fields["code"].as_str().filter(|c| !c.is_empty());
    let retry_after = whole("retryAfterMs").filter(|ms| *ms > 0).map(Duration::from_millis);
    let reauth_required = fields["reauthRequired"] == json!(true);
    let transport = whole("wsCloseCode").map(|c| TransportFault::WsClose { code: Some(c as u16) });
    // A socket failure reaches the core as an I/O error, not as Node's errno text: `code: ECONNRESET` is the
    // reset socket, undici's `TypeError: fetch failed` the connection that never opened.
    let transport = match (spec["t"].as_str(), code) {
        (_, Some("ECONNRESET")) => Some(fault_from_io(&io::Error::from(io::ErrorKind::ConnectionReset), false)),
        (Some("T"), _) => Some(fault_from_io(&io::Error::from(io::ErrorKind::ConnectionRefused), true)),
        _ => transport,
    };
    let facts = Facts { status, code, retry_after, reauth_required, transport: transport.as_ref(), ..Facts::default() };
    let mut error = ProviderError::new(kind_of(&facts), DeliveryState::Accepted);
    error.status = status;
    error.code = code.map(str::to_owned);
    error.retry_after = retry_after;
    error.reset_at = whole("resetAt").map(|ms| SystemTime::UNIX_EPOCH + Duration::from_millis(ms));
    error.reauth_required = reauth_required;
    error.transport = transport;
    error.message = spec["message"].as_str().unwrap().to_owned();
    let name = if spec["t"] == "T" { "TypeError" } else { "Error" };
    (error, name.to_owned())
}

/// The warm's refused POST of a `Q` spec (`anthropicQuotaError(status, headers, body)`).
fn quota_refusal(spec: &Value) -> (ProviderError, String) {
    let headers = spec["headers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned()))
        .collect();
    let response = ErrorResponse {
        status: spec["status"].as_f64().map(|s| s as u16),
        headers,
        body: spec["body"].as_str().unwrap().as_bytes().to_vec(),
    };
    let mut error = classify_response(&response);
    error.message = quota_error_text(&response);
    let name = if error.kind == ErrorKind::QuotaExhausted { "ProviderQuotaError" } else { "ProviderRequestRejectedError" };
    (error, name.to_owned())
}

fn descriptor_view(descriptor: &Descriptor) -> Value {
    json!({
        "kind": descriptor.kind,
        "code": descriptor.code,
        "status": descriptor.status,
        "retryAfterMs": descriptor.retry_after_ms,
        "resetAt": descriptor.reset_at,
    })
}

/// The core's answers for one recorded probe, keyed as the recording keys them.
fn replay_probe(probe: &Exact) -> Exact {
    let spec = probe.get("input").to_plain().unwrap();
    let options = PresentOptions::default();
    let mut out = vec![("input".to_owned(), probe.get("input").clone())];
    match spec["t"].as_str().unwrap() {
        "S" => {
            let text = spec["text"].as_str().unwrap();
            out.push(("present".into(), Exact::String(present_error_text(&ErrorView::message(text), &options))));
            out.push(("safeDetails".into(), Exact::String(safe_error_details(text))));
        }
        kind @ ("E" | "T" | "Q") => {
            let (error, name) = if kind == "Q" { quota_refusal(&spec) } else { live_error(&spec) };
            let mut view = ErrorView::from(&error);
            view.name = name.clone();
            out.push(("present".into(), Exact::String(present_error_text(&view, &options))));
            // `String(error)`: `<name>: <message>`.
            out.push(("safeDetails".into(), Exact::String(safe_error_details(&format!("{name}: {}", error.message)))));
            let descriptor = view.descriptor.clone().expect("a provider error carries its verdict");
            out.push(("providerErrorKind".into(), Exact::plain(&descriptor_view(&descriptor))));
        }
        other => panic!("probe {other} is declared, not replayed"),
    }
    Exact::Object(out)
}

/// The recorded probe reduced to the keys the core answers (the rest is declared in the manifest).
fn recorded_probe(probe: &Exact) -> Exact {
    let keep = ["input", "present", "safeDetails", "providerErrorKind"];
    Exact::Object(probe.entries().iter().filter(|(k, _)| keep.contains(&k.as_str())).cloned().collect())
}

/// Every probe of `value` whose input the core holds (not a persisted descriptor), in recorded order.
fn probes<'a>(value: &'a Exact, path: String, out: &mut Vec<(String, &'a Exact)>) {
    match value {
        Exact::Object(entries) => {
            if value.try_get("input").is_some() && value.try_get("present").is_some() {
                if value.get("input").get("t").as_str() != "D" {
                    out.push((path, value));
                }
                return;
            }
            for (key, child) in entries {
                probes(child, format!("{path}.{key}"), out);
            }
        }
        Exact::Array(items) => {
            for (i, child) in items.iter().enumerate() {
                probes(child, format!("{path}[{i}]"), out);
            }
        }
        _ => {}
    }
}

#[test]
fn every_recorded_failure_is_presented_and_classified_as_node_did() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let recorded = Exact::decode(&golden).unwrap();
    let cases = recorded.get("cases").as_array();
    assert_eq!(cases.len(), 19);
    let mut seen = 0;
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let mut found = Vec::new();
        probes(case.get("observed"), format!("cases[{index}].observed"), &mut found);
        for (path, probe) in found {
            seen += 1;
            let (want, got) = (recorded_probe(probe), replay_probe(probe));
            if want != got {
                failures.push(format!("{} {path}\n  want {want:?}\n  got  {got:?}", case.get("case").as_str()));
            }
        }
    }
    // The redaction case also compares the four texts it shows and the two direct calls.
    let redaction = cases[11].get("observed");
    let raw = redaction.get("raw").as_str();
    let present = present_error_text(&ErrorView { name: "Error".into(), ..ErrorView::object(raw) }, &PresentOptions::default());
    if redaction.get("safeDetailsOfString") != &Exact::String(safe_error_details(raw)) {
        failures.push("redaction: safeDetailsOfString".into());
    }
    if redaction.get("presentErrorText") != &Exact::String(present) {
        failures.push("redaction: presentErrorText".into());
    }
    let long = cases[12].get("observed");
    let data = format!("{{\"data\":\"{}\"}}", "a".repeat(1000));
    if long.get("safeDataOfLongJson") != &Exact::String(safe_error_details(&data)) {
        failures.push("bounded size: safeDataOfLongJson".into());
    }
    // The kinds a retry never repeats (`DETERMINISTIC_KINDS`): a Set, compared as one.
    let deterministic = cases[5].get("observed");
    let mut core: Vec<String> = Vec::new();
    for kind in KINDS.into_iter().filter(|k| k.is_deterministic()) {
        let name = Descriptor::of(&ProviderError::new(kind, DeliveryState::Accepted)).kind;
        if !core.contains(&name) {
            core.push(name);
        }
    }
    let node: Vec<String> = deterministic.get("deterministicKinds").as_array().iter().map(|k| k.as_str().to_owned()).collect();
    let as_set = |list: &[String]| list.iter().cloned().collect::<std::collections::BTreeSet<_>>();
    if as_set(&core) != as_set(&node) || core.len() != node.len() {
        failures.push(format!("deterministic kinds: node {node:?}, core {core:?}"));
    }
    for (key, name) in [("deterministicHasModelProxyPermission", "model_proxy_permission"), ("deterministicHasModelProxyWait", "model_proxy_wait")] {
        if deterministic.get(key) != &Exact::Bool(core.iter().any(|k| k == name)) {
            failures.push(format!("deterministic kinds: {key}"));
        }
    }
    assert!(seen > 0);
    assert!(failures.is_empty(), "{} of {seen} probes differ:\n{}", failures.len(), failures.join("\n"));
}
