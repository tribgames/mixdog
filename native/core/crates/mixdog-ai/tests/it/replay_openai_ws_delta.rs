//! `provider-openai-ws-delta`, the PURE cases: the recorded `_computeDelta` / `_buildResponseCreateFrame` calls through
//! `delta::compute` / `delta::response_create` with the recorded arguments, the result compared whole in Node's shape.

use mixdog_ai::providers::openai::delta::Chain;
use mixdog_ai::providers::openai::delta::Framed;
use mixdog_ai::providers::openai::delta::Mode;
use mixdog_ai::providers::openai::delta::compute;
use mixdog_ai::providers::openai::delta::response_create;
use mixdog_ai::providers::openai::transport_policy;
use mixdog_testkit::Exact;
use serde_json::Map;
use serde_json::Value;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_cases::args_of;
use crate::provider_cases::assert_result;
use crate::provider_cases::number;
use crate::provider_cases::pure_ids;
use crate::provider_cases::object;
use crate::provider_cases::plain;
use crate::provider_cases::string;

const SET: &str = "openai-ws-delta";

fn map(value: &Exact) -> Map<String, Value> {
    match plain(value) {
        Value::Object(m) => m,
        other => panic!("recorded body is not an object: {other}"),
    }
}

fn opt_string(entry: &Exact, key: &str) -> Option<String> {
    match entry.try_get(key) {
        None | Some(Exact::Null | Exact::Undefined) => None,
        Some(v) => Some(v.as_str().to_owned()),
    }
}

fn opt_array(entry: &Exact, key: &str) -> Option<Vec<Value>> {
    match entry.try_get(key).map(plain) {
        Some(Value::Array(items)) => Some(items),
        _ => None,
    }
}

/// The recorded pool entry as the chain it holds.
pub fn chain(entry: &Exact) -> Chain {
    Chain::from_entry(
        opt_string(entry, "lastResponseId"),
        opt_string(entry, "lastRequestSansInput"),
        opt_array(entry, "lastRequestInput"),
        opt_array(entry, "lastResponseItems"),
    )
}

/// `_computeDelta({ entry, body })` under the transport setting the case ran with.
pub fn compute_recorded(args: &[Exact], setting: Option<&str>) -> Exact {
    let call = &args[0];
    let delta = transport_policy::resolve_openai(setting).delta.opt_in;
    render(compute(delta, &chain(call.get("entry")), &map(call.get("body"))))
}

/// `delta::Framed` in the shape `_computeDelta` returns it.
pub fn render(framed: Framed) -> Exact {
    let frame = Exact::plain(&Value::Object(framed.frame));
    match framed.mode {
        Mode::Delta => object(vec![
            ("mode", string("delta")),
            ("reason", Exact::Null),
            ("strippedResponseItems", number(framed.stripped)),
            // `_stripResponseItemsFromHead` never skips an item: its count is 0 on every path.
            ("skippedResponseItems", number(0)),
            ("frame", frame),
        ]),
        Mode::Full => {
            let mut out = vec![("mode", string("full")), ("reason", string(framed.reason.as_deref().expect("a full frame's reason")))];
            if let Some(m) = framed.input_mismatch {
                out.push((
                    "requestInputMismatch",
                    object(vec![
                        ("inputPrefixMismatchIndex", number(m.index)),
                        ("inputPrefixMismatchPreviousCount", number(m.previous_count)),
                        ("inputPrefixMismatchCurrentCount", number(m.current_count)),
                        ("inputPrefixMismatchExpectedType", string(&m.expected_type)),
                        ("inputPrefixMismatchExpectedHash", string(&m.expected_hash)),
                        ("inputPrefixMismatchActualType", string(&m.actual_type)),
                        ("inputPrefixMismatchActualHash", string(&m.actual_hash)),
                    ]),
                ));
            }
            if let Some(m) = framed.output_mismatch {
                out.push((
                    "responseOutputMismatch",
                    object(vec![
                        ("response_output_mismatch_expected_type", string(&m.expected_type)),
                        ("response_output_mismatch_expected_hash", string(&m.expected_hash)),
                        ("response_output_mismatch_expected_response_item_count", number(m.expected_response_item_count)),
                        ("response_output_mismatch_actual_type", string(&m.actual_type)),
                        ("response_output_mismatch_actual_hash", string(&m.actual_hash)),
                        ("response_output_mismatch_actual_replayed_input_item_count", number(m.actual_replayed_input_item_count)),
                    ]),
                ));
            }
            out.push(("frame", frame));
            object(out)
        }
    }
}

/// `_buildResponseCreateFrame(body, { previousResponseId, inputOverride })`.
pub fn frame_recorded(args: &[Exact]) -> Map<String, Value> {
    let options = args.get(1);
    let previous = options.and_then(|o| opt_string(o, "previousResponseId"));
    let input_override = options.and_then(|o| o.try_get("inputOverride")).map(|v| match plain(v) {
        Value::Array(items) => items,
        other => panic!("inputOverride is not an array: {other}"),
    });
    response_create(&map(&args[0]), previous.as_deref(), input_override)
}

fn keys(frame: &Map<String, Value>) -> Exact {
    Exact::Array(frame.keys().map(|k| string(k)).collect())
}

/// The setting `input.env` names (`ws-delta`), unset when the case names none.
fn setting(case: &Case) -> Option<String> {
    case.input.try_get("env").map(|e| e.as_str().to_owned())
}

fn default_delta_falls_back_on_request_property_mismatch(case: &Case) -> Exact {
    let args = &args_of(case, "._computeDelta")[0];
    object(vec![
        ("body", args[0].get("body").clone()),
        ("entry", args[0].get("entry").clone()),
        ("delta", compute_recorded(args, setting(case).as_deref())),
    ])
}

fn ws_delta_previous_response_id_safe_fallbacks(case: &Case) -> Exact {
    let setting = setting(case);
    let results: Vec<Exact> =
        args_of(case, "._computeDelta").iter().map(|args| compute_recorded(args, setting.as_deref())).collect();
    let [refs, changed, no_anchor, prefix_mismatch, response_mismatch] = <[Exact; 5]>::try_from(results).expect("five calls");
    // The recorder's check that the serialized diagnostics hold no call id or argument text.
    let diagnostics = plain(response_mismatch.get("responseOutputMismatch")).to_string();
    let trace_safe = ["call_other", "provider-function-secret", "replayed-function-secret"]
        .iter()
        .map(|s| Exact::Array(vec![string(s), Exact::Bool(diagnostics.contains(s))]))
        .collect();
    object(vec![
        ("refs", refs),
        ("changed", changed),
        ("noAnchor", no_anchor),
        ("prefixMismatch", prefix_mismatch),
        ("responseMismatch", response_mismatch),
        ("traceSafe", Exact::Array(trace_safe)),
    ])
}

fn canonical_full_frame_key_order(case: &Case) -> Exact {
    let args = &args_of(case, "._buildResponseCreateFrame")[0];
    let frame = frame_recorded(args);
    let json = serde_json::to_string(&Value::Object(frame.clone())).unwrap();
    object(vec![
        ("body", args[0].clone()),
        ("frame", Exact::plain(&Value::Object(frame.clone()))),
        ("frameKeys", keys(&frame)),
        ("frameJson", string(&json)),
    ])
}

fn canonical_delta_frame_key_order(case: &Case) -> Exact {
    let calls = args_of(case, "._buildResponseCreateFrame");
    let delta = frame_recorded(&calls[0]);
    let no_instr = frame_recorded(&calls[1]);
    object(vec![
        ("body", calls[0][0].clone()),
        ("delta", Exact::plain(&Value::Object(delta.clone()))),
        ("deltaKeys", keys(&delta)),
        ("noInstr", Exact::plain(&Value::Object(no_instr.clone()))),
        ("noInstrKeys", keys(&no_instr)),
    ])
}

#[test]
fn every_pure_case_replays_as_node_recorded_it() {
    let replays: [(&str, fn(&Case) -> Exact); 4] = [
        ("default-delta-falls-back-on-request-property-mismatch", default_delta_falls_back_on_request_property_mismatch),
        ("ws-delta-previous-response-id-safe-fallbacks", ws_delta_previous_response_id_safe_fallbacks),
        ("canonical-full-frame-key-order", canonical_full_frame_key_order),
        ("canonical-delta-frame-key-order", canonical_delta_frame_key_order),
    ];
    let set = CaseSet::load(SET);
    assert_eq!(replays.map(|(id, _)| id.to_owned()).to_vec(), pure_ids(&set));
    let pure = pure_ids(&set);
    let wire: Vec<&str> = set.ids().into_iter().filter(|id| !pure.iter().any(|p| p == id)).collect();
    set.not_replayed(&wire, "WIRE cases: group B's replay, not in this branch");
    for (id, replay) in replays {
        let case = set.case(id);
        assert_result(&set, case, &replay(case));
    }
}
