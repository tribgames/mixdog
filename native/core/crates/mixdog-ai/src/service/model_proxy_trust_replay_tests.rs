//! Replay of `native/core/fixtures/model-proxy-host-trust-cases`, case "inline attachment data passes untouched, and
//! nesting is bounded" (Node `model-proxy-host-trust.test.mjs` at b6f10295a calls `withoutAttachmentReferences`
//! directly): the same inputs through [`without_attachment_references`], the PC's lowering of every free-form JSON
//! field of a proxied request (`request_in`'s `plain_json`). The call crosses no wire and arms no timer, as recorded.

use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::model_proxy::Refusal;
use super::model_proxy::without_attachment_references;

const GOLDEN: mixdog_testkit::Fixture =
    mixdog_testkit::fixture_const!("../../fixtures/model-proxy-host-trust-cases/golden.json");
const CASE: &str = "inline attachment data passes untouched, and nesting is bounded";

fn thrown(refusal: &Refusal) -> Exact {
    Exact::Error {
        name: "Error".into(),
        message: refusal.message.clone(),
        code: Some(Box::new(Exact::String(refusal.code.into()))),
        cause: None,
        props: vec![("status".into(), Exact::from(f64::from(refusal.status)))],
    }
}

#[test]
fn inline_data_passes_untouched_and_deep_nesting_is_refused_as_node_refused_it() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let recorded = Exact::decode(&golden).unwrap();
    let case = recorded.get("cases").as_array().iter().find(|c| c.get("case").as_str() == CASE).expect("the case is recorded");
    let observed = case.get("observed");
    let messages = observed.get("inlineMessages").to_plain().unwrap();
    let depth = observed.get("nestingDepth").as_f64() as usize;
    let mut deep = json!({});
    for _ in 0..depth {
        deep = json!({ "content": [deep] });
    }
    let refused = without_attachment_references(&json!([deep]), 0).expect_err("a nesting this deep is refused");
    let lowered = without_attachment_references(&messages, 0).expect("inline data is accepted");
    let replayed = Exact::Object(vec![
        ("inlineMessages".into(), Exact::plain(&messages)),
        // Node answers the very input object; the core answers an equal value.
        ("inlineReturnedSameObject".into(), Exact::Bool(lowered == messages)),
        ("nestingDepth".into(), Exact::from(depth as f64)),
        ("deepThrew".into(), thrown(&refused)),
        ("wire".into(), Exact::Array(vec![])),
        (
            "timers".into(),
            Exact::plain(&json!({ "armed": [], "fired": [], "advances": [], "pending": [] })),
        ),
    ]);
    assert_eq!(&replayed, observed);
}
