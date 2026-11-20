//! Incremental `response.create` frames on a warm socket: a request that extends the previous exchange sends only what
//! is new, anchored on the previous response; anything else goes out whole, with the reason it could not be a delta.

use mixdog_ai::providers::openai::delta::Chain;
use mixdog_ai::providers::openai::delta::Framed;
use mixdog_ai::providers::openai::delta::Mode;
use mixdog_ai::providers::openai::delta::compute;
use mixdog_ai::providers::openai::delta::logical_item_match;
use mixdog_ai::providers::openai::delta::response_create;
use mixdog_ai::providers::openai::delta::sans_input;
use mixdog_ai::providers::openai::delta::stable_stringify;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn user(text: &str) -> Value {
    json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]})
}

fn answer(text: &str) -> Value {
    json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]})
}

fn body(input: Vec<Value>) -> Map<String, Value> {
    object(json!({"model": "gpt-5", "instructions": "be brief", "input": input, "tools": [], "stream": true, "store": false}))
}

/// The socket has just carried `request` and the server answered `items` as response `resp_1`.
fn anchored(request: &Map<String, Value>, items: &[Value]) -> Chain {
    let mut chain = Chain::default();
    chain.anchor("resp_1", request, items);
    chain
}

fn keys(framed: &Framed) -> Vec<&str> {
    framed.frame.keys().map(String::as_str).collect()
}

#[test]
fn a_request_that_extends_the_exchange_sends_only_its_new_tail_anchored_on_the_response() {
    let first = body(vec![user("hello")]);
    let chain = anchored(&first, &[answer("hi there")]);
    let second = body(vec![user("hello"), answer("hi there"), user("and now?")]);
    let framed = compute(true, &chain, &second);
    assert_eq!((framed.mode, framed.reason.clone()), (Mode::Delta, None));
    assert_eq!(framed.stripped, 1, "the response item the request replayed is not sent again");
    assert_eq!(framed.frame["previous_response_id"], "resp_1");
    assert_eq!(framed.frame["input"], json!([user("and now?")]));
    assert_eq!(
        keys(&framed),
        ["type", "model", "instructions", "previous_response_id", "input", "tools", "store"],
        "type first, the anchor right before the tail, no transport-only fields"
    );
    assert_eq!(framed.frame["type"], "response.create");
}

#[test]
fn a_full_frame_is_the_body_with_its_type_first_and_without_the_transport_only_fields() {
    let request = object(json!({"model": "m", "stream": true, "background": false, "input": [user("a")], "generate": false}));
    let frame = response_create(&request, None, None);
    assert_eq!(frame.keys().map(String::as_str).collect::<Vec<_>>(), ["type", "model", "input", "generate"]);
    assert_eq!(frame["type"], "response.create");
}

#[test]
fn a_delta_drops_an_empty_instructions_field_and_keeps_a_filled_one() {
    let mut request = body(vec![user("a")]);
    request.insert("instructions".into(), json!(""));
    let tail = response_create(&request, Some("resp_9"), Some(vec![user("b")]));
    assert!(!tail.contains_key("instructions"));
    assert_eq!((tail["previous_response_id"].as_str(), &tail["input"]), (Some("resp_9"), &json!([user("b")])));
    request.insert("instructions".into(), json!("be brief"));
    assert_eq!(response_create(&request, Some("resp_9"), Some(vec![])).get("instructions"), Some(&json!("be brief")));
}

#[test]
fn without_an_anchor_or_with_deltas_off_the_frame_is_full_with_its_reason() {
    let request = body(vec![user("a")]);
    let none = compute(true, &Chain::default(), &request);
    assert_eq!((none.mode, none.reason.as_deref()), (Mode::Full, Some("no_anchor")));
    assert!(!none.frame.contains_key("previous_response_id") && none.frame["input"] == json!([user("a")]));
    let off = compute(false, &anchored(&request, &[]), &body(vec![user("a"), user("b")]));
    assert_eq!((off.mode, off.reason.as_deref()), (Mode::Full, Some("full_default")));

    let mut chain = anchored(&request, &[]);
    chain.clear();
    assert_eq!(compute(true, &chain, &request).reason.as_deref(), Some("no_anchor"), "a cleared chain anchors nothing");
    let no_snapshot = Chain::from_entry(Some("resp_1".into()), Some(stable_stringify(&Value::Object(sans_input(&request)))), None, Some(vec![]));
    assert_eq!(compute(true, &no_snapshot, &request).reason.as_deref(), Some("no_input_snapshot"));
}

#[test]
fn a_change_of_anything_but_the_input_makes_the_frame_full() {
    let first = body(vec![user("a")]);
    let chain = anchored(&first, &[answer("x")]);
    let mut next = body(vec![user("a"), answer("x"), user("b")]);
    next.insert("model".into(), json!("another"));
    let framed = compute(true, &chain, &next);
    assert_eq!((framed.mode, framed.reason.as_deref()), (Mode::Full, Some("request_properties_changed")));
    assert_eq!(framed.frame["input"].as_array().unwrap().len(), 3, "a full frame carries the whole input");

    // The order of keys in the request does not matter, the values do.
    let mut reordered = Map::new();
    for key in ["store", "stream", "tools", "input", "instructions", "model"] {
        reordered.insert(key.into(), body(vec![user("a"), answer("x"), user("b")])[key].clone());
    }
    assert_eq!(compute(true, &chain, &reordered).mode, Mode::Delta);
}

#[test]
fn a_request_that_does_not_begin_with_the_previous_input_is_full_and_says_where_it_diverged() {
    let chain = anchored(&body(vec![user("a"), user("b")]), &[answer("x")]);
    let framed = compute(true, &chain, &body(vec![user("a"), user("CHANGED"), answer("x")]));
    assert_eq!(framed.reason.as_deref(), Some("input_prefix_mismatch"));
    let diff = framed.input_mismatch.expect("the divergence is described");
    assert_eq!((diff.index, diff.previous_count, diff.current_count), (1, 2, 3));
    assert_eq!((diff.expected_type.as_str(), diff.actual_type.as_str()), ("message", "message"));
    assert_ne!(diff.expected_hash, diff.actual_hash, "hashes tell the two items apart without carrying content");
    assert!(!diff.expected_hash.contains("CHANGED"));

    let shorter = compute(true, &chain, &body(vec![user("a")]));
    assert_eq!(shorter.reason.as_deref(), Some("input_prefix_mismatch"), "a request shorter than the previous one cannot extend it");
}

#[test]
fn a_response_item_the_request_did_not_replay_makes_the_frame_full() {
    let chain = anchored(&body(vec![user("a")]), &[json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "E"}), answer("x")]);
    // The request carries the answer but lost the reasoning item that came first.
    let framed = compute(true, &chain, &body(vec![user("a"), answer("x"), user("b")]));
    assert_eq!(framed.reason.as_deref(), Some("response_output_mismatch:reasoning"));
    let diff = framed.output_mismatch.expect("the missing item is described");
    assert_eq!((diff.expected_type.as_str(), diff.expected_response_item_count, diff.actual_type.as_str()), ("reasoning", 2, "message"));
    // Replayed in order they are stripped, and the tail is what follows them.
    let ok = compute(
        true,
        &chain,
        &body(vec![user("a"), json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "E", "summary": []}), answer("x"), user("b")]),
    );
    assert_eq!((ok.mode, ok.stripped), (Mode::Delta, 2));
    assert_eq!(ok.frame["input"], json!([user("b")]));
}

#[test]
fn a_replayed_item_is_the_response_item_when_it_says_the_same_thing() {
    // A function call: by call id and name when both sides have an id, else by name and arguments as data.
    let call = json!({"type": "function_call", "call_id": "c1", "name": "lookup", "arguments": "{\"b\":1,\"a\":2}"});
    assert!(logical_item_match(&json!({"type": "function_call", "call_id": "c1", "name": "lookup", "arguments": "{}"}), &call), "the id decides");
    assert!(!logical_item_match(&json!({"type": "function_call", "call_id": "c2", "name": "lookup", "arguments": "{\"b\":1,\"a\":2}"}), &call));
    assert!(!logical_item_match(&json!({"type": "function_call", "call_id": "c1", "name": "other", "arguments": "{}"}), &call));
    let anonymous = json!({"type": "function_call", "name": "lookup", "arguments": "{\"b\":1,\"a\":2}"});
    assert!(
        logical_item_match(&json!({"type": "function_call", "name": "lookup", "arguments": "{ \"a\": 2, \"b\": 1 }"}), &anonymous),
        "same arguments whatever the spelling"
    );
    assert!(!logical_item_match(&json!({"type": "function_call", "name": "lookup", "arguments": "{\"a\":3}"}), &anonymous));

    // A message: role and text, the input and output spellings of text being one.
    let said = json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hi", "annotations": []}]});
    assert!(logical_item_match(&json!({"role": "assistant", "content": [{"type": "input_text", "text": "hi"}]}), &said), "an assistant turn echoed as input");
    assert!(!logical_item_match(&json!({"role": "assistant", "content": [{"type": "input_text", "text": "bye"}]}), &said));
    assert!(!logical_item_match(&json!({"role": "user", "content": [{"type": "input_text", "text": "hi"}]}), &said));

    // Reasoning: by id and encrypted content where the response has them.
    let thought = json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "E"});
    assert!(logical_item_match(&json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "E", "summary": []}), &thought));
    assert!(!logical_item_match(&json!({"type": "reasoning", "id": "rs_2", "encrypted_content": "E"}), &thought));
    assert!(!logical_item_match(&json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "F"}), &thought));

    // A custom tool call: by call id and name, else by name and raw input.
    let patch = json!({"type": "custom_tool_call", "call_id": "p1", "name": "apply_patch", "input": "*** Begin"});
    assert!(logical_item_match(&json!({"type": "custom_tool_call", "call_id": "p1", "name": "apply_patch", "input": "other"}), &patch));
    assert!(
        !logical_item_match(&json!({"type": "function_call", "call_id": "p1", "name": "apply_patch", "arguments": "{}"}), &patch),
        "a different kind of call"
    );

    // Any other item: everything but its id and status.
    let search = json!({"type": "image_generation_call", "id": "ig_1", "status": "completed", "result": "AAAA"});
    assert!(logical_item_match(&json!({"type": "image_generation_call", "id": "ig_9", "result": "AAAA"}), &search));
    assert!(!logical_item_match(&json!({"type": "image_generation_call", "result": "BBBB"}), &search));
}

#[test]
fn the_properties_snapshot_leaves_out_the_input_and_the_chain_anchor_and_puts_generate_last() {
    let request = object(json!({"generate": false, "model": "m", "input": [1], "previous_response_id": "r", "tools": [{"type": "function", "name": "t"}]}));
    let rest = sans_input(&request);
    assert_eq!(rest.keys().map(String::as_str).collect::<Vec<_>>(), ["model", "tools", "generate"]);
    // Keys are ordered everywhere but inside arrays, so equal objects compare equal as text.
    assert_eq!(stable_stringify(&json!({"b": 1, "a": {"d": 1, "c": 2}})), "{\"a\":{\"c\":2,\"d\":1},\"b\":1}");
    assert_eq!(stable_stringify(&json!([{"type": "function", "name": "t"}])), "[{\"type\":\"function\",\"name\":\"t\"}]");
}
