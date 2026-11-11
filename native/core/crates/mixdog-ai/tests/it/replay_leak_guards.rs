//! `fixtures/provider-leak-guards` (`record-leak-guards.mjs`): each route's real send over a scripted endpoint, two
//! turns: the leaked stream (`onTextDelta` / `onToolCall` observed, in order), then the transcript the agent keeps.
//! Every route (Anthropic, Gemini, the compat Chat and Responses wires) replays through `DefaultProviderBuilder::build`
//! and the broker's send: the visible text and the dispatched calls interleaved (`TextDelta` / `ToolCallDone`), both
//! results whole, the transcript, and both requests as they arrived.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::assert_exact;
use crate::provider_case::plain;
use crate::provider_case::within;
use crate::replay_anthropic;
use crate::replay_world;

fn entry(key: &str, value: Exact) -> (String, Exact) {
    (key.to_owned(), value)
}

/// The n-th send of the case: its messages, model and tools; `opts` holds only the observing callbacks.
fn request(case: &Case, n: usize) -> ModelRequest {
    let args = case.args_of("#send", n);
    for (key, value) in args[3].entries() {
        // `compatWireApi: "responses"`: the custom provider's protocol (see `provider`).
        let wire = key == "compatWireApi" && value.as_str() == "responses";
        assert!(wire || matches!(key.as_str(), "onTextDelta" | "onToolCall"), "{}: send option {key}: {value:?}", case.id);
    }
    let without_state = |m: &Exact| Exact::Object(m.entries().iter().filter(|(k, _)| k != "providerState").cloned().collect());
    ModelRequest {
        model: args[1].as_str().to_owned(),
        messages: args[0].as_array().iter().map(|m| replay_world::message(&without_state(m))).collect(),
        tools: args[2].as_array().iter().map(replay_world::tool).collect(),
        options: RequestOptions::default(),
    }
}

/// `onTextDelta` texts and `onToolCall` calls interleaved, as the recorder logs them.
fn observed(events: &[StreamEvent]) -> Exact {
    Exact::Array(
        events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::TextDelta(text) => Some(Exact::Object(vec![entry("text", Exact::String(text.clone()))])),
                StreamEvent::ToolCallDone(call) => Some(Exact::Object(vec![entry(
                    "tool",
                    Exact::Object(vec![
                        entry("id", Exact::String(call.id.clone())),
                        entry("name", Exact::String(call.name.clone())),
                        entry("arguments", plain(&call.arguments)),
                    ]),
                )])),
                _ => None,
            })
            .collect(),
    )
}

/// The random bytes Node's guards drew for the recovered ids (`randomBytes(8)`, the hex after `_leaked_`), in the
/// order the calls were dispatched. The Gemini guard's id is a hash of the call, no draw.
fn leaked_draws(case: &Case) -> Vec<Vec<u8>> {
    case.result()
        .get("events")
        .as_array()
        .iter()
        .filter_map(|e| e.try_get("tool"))
        .map(|t| t.get("id").as_str())
        .filter(|id| !id.starts_with("gemini_"))
        .filter_map(|id| id.split_once("_leaked_").map(|(_, hex)| hex.to_owned()))
        .map(|hex| (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect())
        .collect()
}

/// The provider the route's recorded constructor builds, as the registry builds it. Node's custom gateway on the
/// Responses wire (`OpenAICompatProvider(name, cfg)` sent with `compatWireApi: "responses"`) is the registry's custom
/// provider of protocol `openai-responses`, whose sends carry that option.
fn provider(case: &Case) -> (String, serde_json::Value) {
    match case.input.get("route").as_str() {
        "anthropic" => ("anthropic".into(), crate::provider_cases::plain(&case.args_of("AnthropicProvider", 0)[0])),
        "gemini" => ("gemini".into(), crate::provider_cases::plain(&case.args_of("GeminiProvider", 0)[0])),
        // The recorder built Node's chat engine itself (`new OpenAICompatProvider('deepseek', ..)`); the product's
        // DeepSeek reaches that engine for a tool request through the model's `modelWires: chat` override
        // (`WireGatewayProvider.resolveWireRoute`, wire-gateway.mjs:122; wire-route.test.mjs:114).
        "chat" => {
            let args = case.args_of("OpenAICompatProvider", 0);
            let mut cfg = crate::provider_cases::plain(&args[1]);
            let model = case.args_of("#send", 0)[1].as_str().to_owned();
            cfg["modelWires"] = serde_json::json!({ model: "chat" });
            (args[0].as_str().to_owned(), cfg)
        }
        "responses" => {
            let args = case.args_of("OpenAICompatProvider", 0);
            let mut cfg = crate::provider_cases::plain(&args[1]);
            cfg["type"] = "custom".into();
            cfg["protocol"] = "openai-responses".into();
            (args[0].as_str().to_owned(), cfg)
        }
        other => panic!("route {other}"),
    }
}

fn stop_text(route: &str, stop: Option<&StopReason>) -> Exact {
    let text = |s: &str| Exact::String(s.to_owned());
    match (route, stop) {
        (_, None) => Exact::Null,
        (_, Some(StopReason::Other(value))) => text(value),
        ("chat", Some(StopReason::EndTurn)) => text("stop"),
        ("chat", Some(StopReason::ToolUse)) => text("tool_calls"),
        ("chat", Some(StopReason::MaxTokens)) => text("length"),
        (route, Some(other)) => panic!("{route}: stop {other:?}"),
    }
}

fn num(n: u64) -> Exact {
    Exact::Number(n as f64)
}

/// Node's `send` result of the Chat, Responses and Gemini routes (`openai-compat.mjs` `_sendChat` / `_sendResponses`,
/// `gemini.mjs` `geminiSendResult`) from the core's events, in Node's key order.
fn route_result(route: &str, events: &[StreamEvent], requested: &str) -> Exact {
    let mut content = String::new();
    let mut model = requested.to_owned();
    let mut calls = Vec::new();
    let mut replay = None;
    let mut state = None;
    let mut usage = None;
    let mut stop = None;
    let mut citations = Vec::new();
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => content.push_str(text),
            StreamEvent::FinalContent(text) => content.clone_from(text),
            StreamEvent::ServedModel(served) => model.clone_from(served),
            StreamEvent::ToolCallDone(call) => calls.push(Exact::Object(vec![
                entry("id", Exact::String(call.id.clone())),
                entry("name", Exact::String(call.name.clone())),
                entry("arguments", plain(&call.arguments)),
            ])),
            // The turn's returned list replaces the folded one (`dedupeToolCallList`).
            StreamEvent::ReturnedCalls(list) => {
                calls = list
                    .iter()
                    .map(|call| {
                        Exact::Object(vec![
                            entry("id", Exact::String(call.id.clone())),
                            entry("name", Exact::String(call.name.clone())),
                            entry("arguments", plain(&call.arguments)),
                        ])
                    })
                    .collect();
            }
            StreamEvent::ReasoningReplay(envelope) => replay = Some(envelope.clone()),
            StreamEvent::ProviderState(s) => state = Some(s.to_json()),
            StreamEvent::Usage(u) => usage = Some(u.clone()),
            StreamEvent::Citation(c) => citations.push(c.clone()),
            StreamEvent::Completed { stop: s, .. } => stop = Some(s.clone()),
            _ => {}
        }
    }
    let stop = stop.unwrap_or_else(|| panic!("the send completed: {events:?}"));
    let calls = if calls.is_empty() { Exact::Undefined } else { Exact::Array(calls) };
    let usage = usage.map_or(Exact::Undefined, |u| {
        let mut slots = vec![
            entry("inputTokens", num(u.input_tokens - u.cache_read_tokens - u.cache_write_tokens)),
            entry("outputTokens", num(u.output_tokens)),
            entry("cachedTokens", num(u.cache_read_tokens)),
            entry("cacheWriteTokens", num(u.cache_write_tokens)),
            entry("promptTokens", num(u.input_tokens)),
        ];
        if let Some(raw) = &u.raw {
            slots.push(entry("raw", plain(raw)));
        }
        Exact::Object(slots)
    });
    assert!(citations.is_empty(), "no recorded case cites: {citations:?}");
    let replay = replay.map_or(Exact::Undefined, |r| {
        let mut out = vec![entry("version", num(1)), entry("provider", Exact::String(r.owner.as_str().to_owned()))];
        if route == "gemini" {
            out.push(entry("items", plain(&r.items["parts"])));
            if let Some(model) = r.items.get("model") {
                out.push(entry("requestContext", Exact::Object(vec![entry("model", plain(model))])));
            }
        } else {
            out.push(entry("items", plain(&r.items)));
        }
        Exact::Object(out)
    });
    let state = state.map_or(Exact::Undefined, |s| plain(&s));
    let mut out = vec![entry("content", Exact::String(content)), entry("model", Exact::String(model)), entry("toolCalls", calls)];
    match route {
        "chat" => {
            out.push(entry("stopReason", stop_text(route, stop.as_ref())));
            out.push(entry("usage", usage));
            // The paused clock: the output starts and completes at the same instant.
            out.push(entry("generationMs", num(0)));
        }
        "responses" => {
            out.push(entry("stopReason", stop_text(route, stop.as_ref())));
            out.extend([
                entry("citations", Exact::Undefined),
                entry("webSearchCalls", Exact::Undefined),
                entry("providerReplay", replay),
                entry("providerState", state),
                entry("usage", usage),
            ]);
        }
        "gemini" => out.extend([
            entry("citations", Exact::Undefined),
            entry("providerReplay", replay),
            entry("providerMetadata", Exact::Undefined),
            entry("providerState", state),
            entry("usage", usage),
        ]),
        other => panic!("route {other}"),
    }
    Exact::Object(out)
}

/// The n-th send's request; a transcript message's `providerState` is the session state the agent hands the send
/// (`opts.providerState` in the core), not part of the message.
fn send_request(case: &Case, n: usize) -> ModelRequest {
    let mut request = request(case, n);
    for message in case.args_of("#send", n)[0].as_array() {
        if let Some(state) = message.try_get("providerState") {
            request.options.provider_state = Some(serde_json::from_value(crate::provider_cases::plain(state)).expect("a provider state"));
        }
    }
    request
}

/// One case's two sends against `endpoint`, compared with Node's.
async fn replay(set: &CaseSet, case: &Case, endpoint: &Endpoint) {
    let route = case.input.get("route").as_str();
    let home = tempfile::tempdir().expect("a home");
    let builder = replay_world::builder(&endpoint, home.path(), Vec::new()).await;
    let (name, config) = provider(case);
    let adapter = replay_world::adapter(&builder, &name, &config).await;
    // Node's guard drew each recovered id from randomBytes(8): the replay mints the recorded ones, in order.
    mixdog_ai::random::script(leaked_draws(case));
    let mut results = Vec::new();
    let mut firsts = Vec::new();
    for n in 0..2 {
        let request = send_request(case, n);
        let model = request.model.clone();
        let cancel = CancellationToken::new();
        // The recorder's frozen `Date.now`, which stamps the session state's `updatedAt`.
        mixdog_ai::wall::set(Some(crate::provider_case::T0_MS + endpoint.now_ms()));
        let what = format!("{}: send {n}", case.id);
        let (outcome, events) = within(&what, replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default())).await;
        assert_eq!(outcome.expect("the scripted stream completes"), 1, "{what}: one attempt");
        if n == 0 {
            firsts = events.events.clone();
        }
        results.push(match route {
            "anthropic" => replay_anthropic::send(&events.events, &model).result,
            _ => route_result(route, &events.events, &model),
        });
    }
    let recorded = case.result();
    assert_exact(&format!("{}: events", case.id), recorded.get("events"), &observed(&firsts));
    assert_exact(&format!("{}: first", case.id), &replay_anthropic::comparable(recorded.get("first")), &results[0]);
    // The transcript the agent keeps: the first turn's text, calls, replay and state, the tool's answer, the next
    // user turn.
    let first = &results[0];
    let mut assistant = vec![entry("role", Exact::String("assistant".into())), entry("content", first.get("content").clone())];
    for key in ["toolCalls", "providerReplay", "providerState"] {
        if first.try_get(key).is_some_and(|v| v != &Exact::Undefined) {
            assistant.push(entry(key, first.get(key).clone()));
        }
    }
    let kept = recorded.get("transcript").as_array();
    let mut transcript = vec![kept[0].clone(), Exact::Object(assistant)];
    transcript.extend(kept[2..].iter().cloned());
    assert_exact(&format!("{}: transcript", case.id), recorded.get("transcript"), &Exact::Array(transcript));
    assert_exact(&format!("{}: transcript sent", case.id), recorded.get("transcript"), &case.args_of("#send", 1)[0]);
    assert_exact(&format!("{}: second", case.id), &replay_anthropic::comparable(recorded.get("second")), &results[1]);
    set.assert_requests(case, &endpoint.arrivals(), None);
}

#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    use futures::FutureExt as _;
    let set = CaseSet::load("leak-guards");
    let mut failures = Vec::new();
    for case in &set.cases {
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        if let Err(panic) = std::panic::AssertUnwindSafe(replay(&set, case, &endpoint)).catch_unwind().await {
            let text = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned())).unwrap_or_default();
            let arrived: Vec<String> = endpoint.arrivals().iter().map(|a| format!("{a:?}").chars().take(600).collect()).collect();
            let failure = format!("{}: {text}\n  arrived: {arrived:?}", case.id);
            eprintln!("{failure}");
            failures.push(failure);
        }
    }
    assert_eq!(set.cases.len(), 25, "the recorded cases");
    assert!(failures.is_empty(), "cases that differ from Node:\n{}", failures.join("\n"));
}
