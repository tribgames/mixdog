//! Replays the corpora of `native/core/fixtures/browser-parity/*.json` (`[{ "case", "input", "expect" }]`), which the TypeScript tests
//! of `apps/desktop/src/main/browser/{url-policy,url-admission,redaction,timing}.test.mjs` read as well: both sides must give every
//! case the same answer. The expectations were recorded from the TypeScript modules.

use std::collections::HashMap;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_browser_policy::redaction::redact_text;
use mixdog_browser_policy::redaction::redact_url;
use mixdog_browser_policy::redaction::url_contains_secret;
use mixdog_browser_policy::timing::Collector;
use mixdog_browser_policy::timing::MouseEventKind;
use mixdog_browser_policy::timing::Phase;
use mixdog_browser_policy::url_admission::Resolve;
use mixdog_browser_policy::url_admission::ResolveFailed;
use mixdog_browser_policy::url_admission::UrlAdmission;
use mixdog_browser_policy::url_admission::admit_resolved;
use mixdog_browser_policy::url_policy::AdmitCtx;
use mixdog_browser_policy::url_policy::MailLink;
use mixdog_browser_policy::url_policy::Refusal;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_browser_policy::url_policy::admit;
use mixdog_browser_policy::url_policy::assert_resolved_address_allowed;
use mixdog_browser_policy::url_policy::normalize_agent_url;
use mixdog_browser_policy::url_policy::normalize_page_url;
use serde_json::Value;
use serde_json::json;

fn corpus(text: &str) -> Vec<Value> {
    serde_json::from_str(text).expect("a corpus is a JSON array")
}

fn now_ms() -> i64 {
    i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).expect("the clock is after the epoch").as_millis()).expect("a date")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn policy_of(value: &Value) -> UrlPolicy {
    UrlPolicy {
        allow_private_network: value["allowPrivateNetwork"].as_bool().unwrap_or(false),
        allowed_domains: value["allowedDomains"]
            .as_array()
            .map(|list| list.iter().map(|domain| text(domain).to_owned()).collect())
            .unwrap_or_default(),
    }
}

/// The mail link of a case: `ageMs` is how long before `now` the runtime read the mail (null: it carried no read time).
fn mail_link_of(value: &Value, now: i64) -> Option<MailLink> {
    (!value.is_null()).then(|| MailLink {
        url: text(&value["url"]).to_owned(),
        from_domain: text(&value["from_domain"]).to_owned(),
        read_at: value["ageMs"].as_i64().map(|age| now - age),
    })
}

fn verdict(result: Result<String, Refusal>) -> Value {
    match result {
        Ok(url) => json!({ "ok": url }),
        Err(refusal) => json!({ "error": refusal.reason }),
    }
}

fn unit_verdict(result: Result<(), Refusal>) -> Value {
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(refusal) => json!({ "error": refusal.reason }),
    }
}

#[test]
fn url_policy_corpus() {
    let cases = corpus(mixdog_testkit::fixture!("../../fixtures/browser-parity/url-policy.json"));
    assert!(cases.len() > 100);
    for case in &cases {
        let (name, input) = (text(&case["case"]), &case["input"]);
        let policy = policy_of(&input["policy"]);
        let now = now_ms();
        let got = match text(&input["fn"]) {
            "resolved" => unit_verdict(assert_resolved_address_allowed(text(&input["address"]), text(&input["hostname"]), &policy)),
            "page" => {
                let got = verdict(normalize_page_url(text(&input["url"]), &policy));
                assert_eq!(
                    unit_verdict(admit(text(&input["url"]), &policy, &AdmitCtx::page(now))).get("ok").is_some(),
                    got.get("ok").is_some(),
                    "{name}: admit"
                );
                got
            }
            _ => {
                let link = mail_link_of(&input["mailLink"], now);
                let got = verdict(normalize_agent_url(text(&input["url"]), &policy, link.as_ref(), now));
                let ctx = AdmitCtx { mail_link: link, ..AdmitCtx::agent(now) };
                assert_eq!(unit_verdict(admit(text(&input["url"]), &policy, &ctx)).get("ok").is_some(), got.get("ok").is_some(), "{name}: admit");
                got
            }
        };
        assert_eq!(got, case["expect"], "{name}");
    }
}

struct Table(HashMap<String, Option<Vec<String>>>);

#[async_trait]
impl Resolve for Table {
    async fn lookup(&self, hostname: &str) -> Result<Vec<String>, ResolveFailed> {
        self.0.get(hostname).cloned().flatten().ok_or(ResolveFailed)
    }
}

fn table_of(value: &Value) -> Table {
    Table(
        value
            .as_object()
            .expect("a lookup table")
            .iter()
            .map(|(host, answer)| (host.clone(), answer.as_array().map(|list| list.iter().map(|a| text(a).to_owned()).collect())))
            .collect(),
    )
}

#[tokio::test]
async fn url_admission_corpus() {
    let cases = corpus(mixdog_testkit::fixture!("../../fixtures/browser-parity/url-admission.json"));
    assert!(cases.len() > 40);
    for case in &cases {
        let (name, input) = (text(&case["case"]), &case["input"]);
        let policy = policy_of(&input["policy"]);
        let resolver = table_of(&input["lookup"]);
        let admission = UrlAdmission::new(policy.clone());
        let url = text(&input["url"]);
        let now = now_ms();
        let got = match text(&input["mode"]) {
            "url" => {
                let page_generated = input["pageGenerated"].as_bool().unwrap_or(false);
                let got = unit_verdict(admission.assert_resolved_url_allowed(url, page_generated, &resolver).await);
                if !page_generated {
                    assert_eq!(unit_verdict(admit_resolved(url, &policy, &resolver).await), got, "{name}: admit_resolved");
                }
                got
            }
            "resource" => unit_verdict(admission.assert_resolved_resource_url_allowed(url, &resolver).await),
            _ => {
                let link = mail_link_of(&input["mailLink"], now);
                verdict(admission.validated_agent_url(url, link.as_ref(), now, &resolver).await)
            }
        };
        assert_eq!(got, case["expect"], "{name}");
    }
}

#[test]
fn redaction_corpus() {
    let cases = corpus(mixdog_testkit::fixture!("../../fixtures/browser-parity/redaction.json"));
    assert!(cases.len() > 80);
    for case in &cases {
        let (name, input) = (text(&case["case"]), &case["input"]);
        let value = text(&input["value"]);
        let got = match text(&input["fn"]) {
            "containsSecret" => json!(url_contains_secret(value)),
            "redactUrl" => json!(redact_url(value)),
            _ => {
                let secrets: Vec<String> =
                    input["secrets"].as_array().map(|list| list.iter().map(|s| text(s).to_owned()).collect()).unwrap_or_default();
                json!(redact_text(value, &secrets))
            }
        };
        assert_eq!(got, case["expect"], "{name}");
    }
}

fn tick(clock: &mut f64) -> f64 {
    *clock += 1.0;
    *clock
}

/// Runs the scripted nodes against a collector whose clock advances one millisecond per call; `Err` is a scripted failure, which
/// leaves every phase and step it passes through as the TypeScript `finally` blocks do.
fn run(collector: &mut Collector, clock: &mut f64, nodes: &[Value]) -> Result<(), ()> {
    for node in nodes {
        if node["throw"].as_bool().unwrap_or(false) {
            return Err(());
        }
        if let Some(kind) = node["mouse"].as_str() {
            let kind = match kind {
                "mouseMoved" => MouseEventKind::Moved,
                "mousePressed" => MouseEventKind::Pressed,
                _ => MouseEventKind::Released,
            };
            collector.mouse_event(kind, tick(clock));
        } else if let Some(index) = node["step"].as_u64() {
            let mark = collector.step_begin(tick(clock));
            let outcome = run(collector, clock, node["do"].as_array().expect("a step's nodes"));
            collector.step_end(&mark, u32::try_from(index).expect("a step index"), tick(clock));
            outcome?;
        } else {
            let phase = match text(&node["phase"]) {
                "wait" => Phase::Wait,
                "snapshot" => Phase::Snapshot,
                "screenshot" => Phase::Screenshot,
                "target" => Phase::Target,
                "actionability" => Phase::Actionability,
                _ => Phase::Input,
            };
            collector.enter(phase, tick(clock));
            let outcome = run(collector, clock, node["do"].as_array().expect("a phase's nodes"));
            collector.exit(phase, tick(clock));
            outcome?;
        }
    }
    Ok(())
}

#[test]
fn timing_corpus() {
    let cases = corpus(mixdog_testkit::fixture!("../../fixtures/browser-parity/timing.json"));
    assert!(cases.len() > 5);
    for case in &cases {
        let (name, input) = (text(&case["case"]), &case["input"]);
        let mut clock = 0.0;
        let mut collector = Collector::start(input["queueMs"].as_f64().expect("a queue time"), clock);
        let failed = run(&mut collector, &mut clock, input["ops"].as_array().expect("nodes")).is_err();
        clock += 1.0;
        let timing = collector.finish(clock);
        let steps = timing.steps.as_ref().map_or(Value::Null, |steps| json!(steps.iter().map(|step| step.index).collect::<Vec<_>>()));
        let mouse = timing.mouse_events.map_or(Value::Null, |events| {
            let mut object = serde_json::Map::new();
            for (key, stat) in [("mouseMoved", events.mouse_moved), ("mousePressed", events.mouse_pressed), ("mouseReleased", events.mouse_released)] {
                if let Some(stat) = stat {
                    object.insert(key.to_owned(), json!(stat.count));
                }
            }
            Value::Object(object)
        });
        let mut got = json!({
            "snapshots": timing.snapshots,
            "screenshots": timing.screenshots,
            "steps": steps,
            "mouse": mouse,
            "failed": failed,
        });
        // The corpus spells a whole number of milliseconds as an integer, which a float of the same value does not equal as JSON.
        let queue = &case["expect"]["queueMs"];
        got["queueMs"] = if queue.as_f64() == Some(timing.queue_ms) { queue.clone() } else { json!(timing.queue_ms) };
        assert_eq!(got, case["expect"], "{name}");
        let wire = serde_json::to_value(&timing).expect("a timing serializes");
        for (key, value) in wire.as_object().expect("an object") {
            if let Some(number) = value.as_f64() {
                assert!(number.is_finite() && number >= 0.0, "{name}: {key}");
            }
        }
    }
}
