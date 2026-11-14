//! Owner: s4-engine-approval
//! Deterministic payment evidence of the page a submit or post step acts on (`payment-evidence.ts`). A step on such a page is a
//! payment: it asks once, every time, and no session or saved allow, nor "Allow all actions", covers it. Only page structure
//! counts, never a button's label, and only the top document is read: an input or select whose `autocomplete` token is a
//! payment-card one (or whose name or id plainly denotes a card number, expiry or CVC/CVV), or an embedded frame hosted by a
//! payment processor (the list below, kept small on purpose). Deleting something permanently is not detected here. A page that
//! cannot be evaluated counts as evidence (fail closed).

use mixdog_app_protocol::v2::browser_engine::HostBrowserPageEvalParams;
use mixdog_rt::CancellationToken;

use crate::port::BrowserHost;

/// Payment processors whose hosted fields embed in a frame: Stripe, Braintree, Adyen and PayPal.
pub const PAYMENT_PROCESSOR_FRAME_HOSTS: &[&str] = &[
    "js.stripe.com",
    "checkout.stripe.com",
    "js.braintreegateway.com",
    "assets.braintreegateway.com",
    "checkoutshopper-live.adyen.com",
    "checkoutshopper-test.adyen.com",
    "www.paypal.com",
    "www.sandbox.paypal.com",
];

/// The page-world source (`assets/page/payment-evidence.js`) with its processor hosts filled in as a JSON array.
const PAYMENT_EVIDENCE_SOURCE: &str = include_str!("../../assets/page/payment-evidence.js");

/// How long the page may take to answer; an answer that does not come in time counts as evidence.
const EVIDENCE_TIMEOUT_MS: u32 = 5_000;

/// The expression the engine evaluates in the page.
pub fn payment_evidence_expression() -> String {
    let hosts = serde_json::to_string(PAYMENT_PROCESSOR_FRAME_HOSTS).expect("host names are strings");
    PAYMENT_EVIDENCE_SOURCE.replace("__MIXDOG_HOSTS__", &hosts)
}

/// Whether the page shows payment evidence; a page that cannot be read does. The result is exactly `false` only when the
/// expression answered `false`.
pub async fn page_has_payment_evidence(host: &dyn BrowserHost, page_id: &str, cancel: &CancellationToken) -> bool {
    let params = HostBrowserPageEvalParams {
        page_id: page_id.to_owned(),
        expression: payment_evidence_expression(),
        frame: None,
        await_promise: None,
        return_by_value: Some(true),
        world: None,
        timeout_ms: EVIDENCE_TIMEOUT_MS,
        expect: None,
        check_unchanged: None,
    };
    match host.page_eval(params, cancel).await {
        Ok(result) => result.exception.is_some() || result.value != Some(serde_json::Value::Bool(false)),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::error::HostCallError;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;

    fn eval(value: serde_json::Value) -> Expect {
        Expect::ok("host/browser/page/eval", json!({"value": value, "facts": page_facts("p", 3)}))
    }

    #[test]
    fn the_expression_names_the_processor_hosts_and_never_a_label() {
        let expression = payment_evidence_expression();
        assert!(!expression.contains("__MIXDOG_"), "a placeholder is left");
        for host in PAYMENT_PROCESSOR_FRAME_HOSTS {
            assert!(expression.contains(&format!("\"{host}\"")), "{host}");
        }
        assert!(expression.contains("cc-(number|exp|exp-month|exp-year|csc|name)"));
        assert!(expression.contains("cardnum|ccnum|cardexp|ccexp|cvc|cvv"));
        assert!(!expression.to_lowercase().contains("innertext"), "labels are never read");
        assert_eq!(PAYMENT_PROCESSOR_FRAME_HOSTS.len(), 8);
    }

    #[tokio::test]
    async fn only_an_answer_of_false_is_no_evidence() {
        for (answer, evidence) in [(json!(false), false), (json!(true), true), (json!(null), true), (json!("no"), true), (json!(0), true)] {
            let host = FakeHost::scripted(vec![eval(answer.clone())]);
            assert_eq!(page_has_payment_evidence(&host, "p", &CancellationToken::new()).await, evidence, "{answer}");
            host.finish().expect("one eval");
        }
    }

    #[tokio::test]
    async fn an_unreadable_page_counts_as_evidence() {
        let failing = FakeHost::scripted(vec![Expect::err("host/browser/page/eval", HostCallError::Failed { message: "boom".into() })]);
        assert!(page_has_payment_evidence(&failing, "p", &CancellationToken::new()).await);
        let gone = FakeHost::scripted(vec![Expect::err("host/browser/page/eval", HostCallError::PageGone)]);
        assert!(page_has_payment_evidence(&gone, "p", &CancellationToken::new()).await);
        let threw = FakeHost::scripted(vec![Expect::ok(
            "host/browser/page/eval",
            json!({"exception": {"text": "x"}, "value": false, "facts": page_facts("p", 3)}),
        )]);
        assert!(page_has_payment_evidence(&threw, "p", &CancellationToken::new()).await);
    }

    #[tokio::test]
    async fn the_page_is_asked_in_its_top_document_by_value() {
        let host = FakeHost::scripted(vec![eval(json!(false)).with_params(json!({"pageId": "p", "returnByValue": true}))]);
        assert!(!page_has_payment_evidence(&host, "p", &CancellationToken::new()).await);
        host.finish().expect("params matched");
    }
}
