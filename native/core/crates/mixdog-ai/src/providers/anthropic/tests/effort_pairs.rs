//! Consecutive requests of one conversation whose efforts differ. On a route that takes mid-conversation effort
//! updates the later request keeps every byte of the earlier one's prefix: the top-level effort stays the
//! conversation's first and each change rides as an empty `system` control message, before the user message of the
//! turn it starts with or after the whole tool batch of the step it follows (`lowerAnthropicEffortHistory`). A route
//! that takes none sends each request's own effort, with or without a projection.

use std::sync::Arc;

use mixdog_core_api::domain::provider::EffortProjection;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use serde_json::Value;
use serde_json::json;

use super::super::codec::beta_names;
use super::super::prefix_trace;
use super::super::threads::Mode;
use super::super::threads::PlanInput;
use super::super::threads::Threads;
use super::AnthropicCodec;
use super::AnthropicConfig;
use super::Flavor;
use super::ModelCaps;
use super::text_message;

const OFFICIAL: &str = "https://api.anthropic.com";
const GATEWAY: &str = "https://gateway.example";
const MODEL: &str = "claude-opus-5-5";

fn config(base: &str) -> AnthropicConfig {
    let caps = ModelCaps {
        adaptive_thinking: true,
        effort_levels: ["low", "medium", "high"].map(String::from).to_vec(),
        max_output_tokens: Some(16384),
        ..ModelCaps::default()
    };
    let mut config = AnthropicConfig::new(Arc::new(move |_: &str| Some(caps.clone())));
    config.base_url = base.to_owned();
    config
}

fn route(flavor: Flavor) -> AnthropicCodec {
    AnthropicCodec::new(flavor, config(OFFICIAL))
}

/// The conversation as the loop sends it, one request per entry: a first turn at `low`, a second judged `high`, the
/// step after its tool batch judged `medium`, and a third turn at `medium`. Each request runs at its turn's effort
/// and, when `projected`, carries the projection of the rows it holds.
fn conversation(model: &str, projected: bool) -> Vec<ModelRequest> {
    let mut call = text_message(Role::Assistant, "");
    call.tool_calls.push(ToolCall { id: "call_1".into(), name: "lookup".into(), arguments: json!({ "key": "answer" }), native_type: None });
    let mut result = text_message(Role::Tool, "42");
    result.tool_call_id = Some("call_1".into());
    let rows = [
        text_message(Role::System, "You are a fixture assistant."),
        text_message(Role::User, "q1"),
        text_message(Role::Assistant, "a1"),
        text_message(Role::User, "q2"),
        call,
        result,
        text_message(Role::Assistant, "a2"),
        text_message(Role::User, "q3"),
    ];
    let updates = [(3, "high"), (5, "medium")];
    [(2, "low"), (4, "high"), (6, "high"), (8, "medium")]
        .into_iter()
        .map(|(count, effort)| {
            let projection = EffortProjection {
                initial_effort: "low".into(),
                updates: updates.iter().filter(|(index, _)| *index < count).map(|(index, effort)| (*index, (*effort).to_owned())).collect(),
            };
            let options = RequestOptions { effort: Some(effort.into()), effort_projection: projected.then_some(projection), ..RequestOptions::default() };
            ModelRequest { model: model.into(), messages: rows[..count].to_vec(), tools: Vec::new(), options }
        })
        .collect()
}

fn body(codec: &AnthropicCodec, request: &ModelRequest) -> Value {
    serde_json::from_slice(&codec.encode_plain(request).expect("the request encodes").wire.body).expect("the body is JSON")
}

fn messages(body: &Value) -> Vec<Value> {
    body["messages"].as_array().expect("messages").clone()
}

/// The body without its messages: every field the whole message cache hangs under.
fn frame(body: &Value) -> Value {
    let mut frame = body.clone();
    frame.as_object_mut().expect("a body").shift_remove("messages");
    frame
}

/// The messages as the cache reads them: no breakpoint.
fn unmarked(messages: &[Value]) -> Vec<Value> {
    let mut messages = messages.to_vec();
    for block in messages.iter_mut().filter_map(|message| message["content"].as_array_mut()).flatten() {
        if let Some(block) = block.as_object_mut() {
            block.shift_remove("cache_control");
        }
    }
    messages
}

fn marked_blocks(messages: &[Value]) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        for (block_index, block) in message["content"].as_array().into_iter().flatten().enumerate() {
            if block.get("cache_control").is_some() {
                found.push((index, block_index));
            }
        }
    }
    found
}

#[test]
fn a_request_after_an_effort_change_keeps_every_byte_of_the_request_before_it() {
    for flavor in [Flavor::ApiKey, Flavor::OAuth] {
        let codec = route(flavor);
        let bodies: Vec<Value> = conversation(MODEL, true).iter().map(|request| body(&codec, request)).collect();
        for pair in bodies.windows(2) {
            let (earlier, later) = (&pair[0], &pair[1]);
            assert_eq!(frame(earlier), frame(later), "{flavor:?}: nothing outside the messages moves with the effort");
            assert_eq!(later["output_config"], json!({ "effort": "low" }), "{flavor:?}: the conversation's first effort");
            let sent = serde_json::to_string(&unmarked(&messages(earlier))).expect("json");
            let next = serde_json::to_string(&unmarked(&messages(later))).expect("json");
            assert!(next.starts_with(sent.strip_suffix(']').expect("an array")), "{flavor:?}: {sent} is not a prefix of {next}");
        }
        // Where each change rides: before the user message of the turn it starts with, and after the whole tool batch
        // of the step it follows.
        let last = messages(&bodies[3]);
        let roles: Vec<&str> = last.iter().map(|message| message["role"].as_str().expect("a role")).collect();
        assert_eq!(roles, ["user", "assistant", "system", "user", "assistant", "user", "system", "assistant", "user"], "{flavor:?}");
        assert_eq!(last[2], json!({ "role": "system", "content": [], "output_config": { "effort": "high" } }));
        assert_eq!(last[6], json!({ "role": "system", "content": [], "output_config": { "effort": "medium" } }));
        assert_eq!(last[5]["content"][0]["type"], "tool_result");
        // The request sent right after the batch already ends on that control, behind its breakpoint.
        let step = messages(&bodies[2]);
        assert_eq!(step.last(), Some(&last[6]));
        assert_eq!(marked_blocks(&step), [(5, 0)]);
    }
}

#[test]
fn a_route_that_takes_no_effort_update_sends_each_requests_own_effort_as_before() {
    let mut betas_off = config(OFFICIAL);
    betas_off.disable_beta_headers = true;
    let routes = [
        ("an engine", AnthropicCodec::new(Flavor::ApiKey, config(GATEWAY)).with_floors_of("openrouter"), MODEL),
        ("an engine on the official origin", AnthropicCodec::new(Flavor::ApiKey, config(OFFICIAL)).with_floors_of("openrouter"), MODEL),
        ("a custom base URL", AnthropicCodec::new(Flavor::ApiKey, config(GATEWAY)), MODEL),
        ("beta headers off", AnthropicCodec::new(Flavor::ApiKey, betas_off), MODEL),
        ("a model under the floor", route(Flavor::ApiKey), "claude-opus-4-6"),
        ("a model under the floor on the subscription", route(Flavor::OAuth), "claude-opus-4-6"),
    ];
    for (name, codec, model) in routes {
        for (projected, plain) in conversation(model, true).iter().zip(conversation(model, false)) {
            let sent = codec.encode_plain(projected).expect("the request encodes").wire;
            let before = codec.encode_plain(&plain).expect("the request encodes").wire;
            assert_eq!(sent.body, before.body, "{name}: the bytes of a request with no projection");
            assert_eq!(sent.headers, before.headers, "{name}");
            let body: Value = serde_json::from_slice(&sent.body).expect("json");
            assert_eq!(body["output_config"]["effort"], json!(plain.options.effort), "{name}");
            assert!(messages(&body).iter().all(|message| message["role"] != "system"), "{name}: no control message");
            assert!(!beta_names(&sent).iter().any(|beta| beta.starts_with("mid-conversation-output-config")), "{name}");
        }
    }
}

#[test]
fn a_fork_after_an_effort_change_reads_the_entry_the_saved_request_wrote() {
    for flavor in [Flavor::ApiKey, Flavor::OAuth] {
        let codec = route(flavor);
        // Saved right after a turn's change, and right after a step's (its request ends on the control message).
        for saved in &conversation(MODEL, true)[1..3] {
            let mut prompt = text_message(Role::User, "Summarize the conversation.");
            prompt.source = Some(MessageSource::Steering);
            let mut fork = saved.clone();
            fork.options.shared_cache_prefix_count = Some(saved.messages.len());
            fork.messages.extend([text_message(Role::Assistant, "working"), prompt]);
            let (sent, forked) = (body(&codec, saved), body(&codec, &fork));
            assert_eq!(frame(&sent), frame(&forked), "{flavor:?}");
            let (sent, forked): (Vec<Value>, Vec<Value>) = (messages(&sent), messages(&forked));
            assert_eq!(forked[..sent.len()], sent[..], "{flavor:?}: the saved request's messages, its breakpoint where it was");
            assert_eq!(marked_blocks(&forked), marked_blocks(&sent), "{flavor:?}: no entry is written for the fork's own suffix");
            assert_eq!(forked.len(), sent.len() + 2);
        }
    }
}

fn reply_stream(id: &str, text: &str) -> String {
    [
        json!({ "type": "message_start", "message": { "id": id } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" } }),
        json!({ "type": "message_stop" }),
    ]
    .iter()
    .map(|event| format!("data: {event}\n\n"))
    .collect()
}

#[test]
fn a_thread_continues_across_an_effort_change() {
    for flavor in [Flavor::ApiKey, Flavor::OAuth] {
        let codec = route(flavor);
        let threads = Arc::new(Threads::default());
        let requests = conversation(MODEL, true);
        let plan = |request: &ModelRequest| {
            let plain = codec.encode_plain(request).expect("the request encodes");
            let body: Value = serde_json::from_slice(&plain.wire.body).expect("json");
            threads.plan(PlanInput {
                provider: flavor.provider_name(),
                scope: "session-1",
                body: &body,
                betas: &beta_names(&plain.wire),
                account: "account",
                cache_ttls: &codec.cache_ttls(request),
                now: super::super::oauth::now_ms(),
                directive: None,
                send_group: None,
            })
        };
        let mut first = plan(&requests[0]);
        assert_eq!(first.mode, Mode::Create, "{flavor:?}");
        let mut session = first.take_session().expect("a threaded send");
        session.feed(reply_stream("msg_1", "a1").as_bytes());
        session.complete(None);
        // The next turn runs at another effort: the stored conversation is continued, the change and the new turn its delta.
        let second = plan(&requests[1]);
        assert_eq!((second.mode, second.blocker), (Mode::Continue, None), "{flavor:?}");
        assert_eq!(second.body["thread"], json!({ "type": "continue", "previous_message_id": "msg_1" }));
        assert_eq!(second.body["output_config"], json!({ "effort": "low" }));
        let delta = unmarked(&messages(&second.body));
        assert_eq!(
            delta,
            [json!({ "role": "system", "content": [], "output_config": { "effort": "high" } }), json!({ "role": "user", "content": [{ "type": "text", "text": "q2" }] })],
            "{flavor:?}"
        );
    }
}

#[test]
fn the_prefix_trace_reports_no_changed_block_across_an_effort_change() {
    let trace = |session: &str, flavor: Flavor, projected: bool| -> Vec<Value> {
        let codec = route(flavor);
        let mut changes = Vec::new();
        for request in conversation(MODEL, projected) {
            prefix_trace::record(Some(session), codec.encode_plain(&request).expect("the request encodes").prefix);
            changes.extend(prefix_trace::changes(session).map(Value::Object));
        }
        changes
    };
    for flavor in [Flavor::ApiKey, Flavor::OAuth] {
        let changes = trace(&format!("effort-pairs-{flavor:?}"), flavor, true);
        assert_eq!(changes.len(), 3);
        for change in changes {
            assert_eq!(change, json!({ "changedBlocks": "none", "markersChanged": false, "lostMessageBreakpoints": "none" }), "{flavor:?}");
        }
        // The same turns with each request's own effort at the top (no projection): the trace names the parameters.
        let unprojected = trace(&format!("effort-pairs-plain-{flavor:?}"), flavor, false);
        assert_eq!(unprojected[0]["changedBlocks"], "params", "{flavor:?}");
        assert_eq!(unprojected[0]["lostMessageBreakpoints"], "m0", "{flavor:?}");
    }
}
