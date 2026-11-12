//! `fixtures/provider-leak-guards` (`record-leak-guards.mjs`): each route's real send over a scripted endpoint, two
//! turns: the leaked stream (`onTextDelta` / `onToolCall` observed, in order), then the transcript the agent keeps.
//! Every route (Anthropic, Gemini, the compat Chat and Responses wires) replays through `DefaultProviderBuilder::build`
//! and the broker's send: the visible text and the dispatched calls interleaved (`TextDelta` / `ToolCallDone`), both
//! results whole, the transcript, and both requests as they arrived. The transcript is built from the core's first result
//! as the recorder builds it from Node's (the history, the assistant turn, a `done` tool result per call, `continue`), and
//! the second send sends that transcript. The recovered ids come from the recording's random bytes (`RecorderDraws`).

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::plain;
use crate::provider_case::within;
use crate::replay_anthropic;
use crate::replay_world;

fn entry(key: &str, value: Exact) -> (String, Exact) {
    (key.to_owned(), value)
}

/// The n-th send of the case with `messages` (Node transcript messages): its model and tools; `opts` holds only the
/// observing callbacks.
fn request(case: &Case, n: usize, messages: &[Exact]) -> ModelRequest {
    let args = case.args_of("#send", n);
    for (key, value) in args[3].entries() {
        // `compatWireApi: "responses"`: the custom provider's protocol (see `provider`).
        let wire = key == "compatWireApi" && value.as_str() == "responses";
        assert!(wire || matches!(key.as_str(), "onTextDelta" | "onToolCall"), "{}: send option {key}: {value:?}", case.id);
    }
    let without_state = |m: &Exact| Exact::Object(m.entries().iter().filter(|(k, _)| k != "providerState").cloned().collect());
    ModelRequest {
        model: args[1].as_str().to_owned(),
        messages: messages.iter().map(|m| replay_world::message(&without_state(m))).collect(),
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

/// The n-th send's request over `messages`; a transcript message's `providerState` is the session state the agent hands
/// the send (`opts.providerState` in the core), not part of the message.
fn send_request(case: &Case, n: usize, messages: &[Exact]) -> ModelRequest {
    let mut request = request(case, n, messages);
    for message in messages {
        if let Some(state) = message.try_get("providerState") {
            request.options.provider_state = Some(serde_json::from_value(crate::provider_cases::plain(state)).expect("a provider state"));
        }
    }
    request
}

/// The transcript the recorder builds from the first result (record-leak-guards.mjs `viaProvider`): the history, the
/// assistant turn (`content`, then `toolCalls`, `providerState`, `providerReplay` where present), a `done` result per call,
/// and the follow-up `continue`.
fn transcript(history: &[Exact], first: &Exact) -> Vec<Exact> {
    let text = |s: &str| Exact::String(s.to_owned());
    let mut assistant = vec![entry("role", text("assistant")), entry("content", first.get("content").clone())];
    for key in ["toolCalls", "providerState", "providerReplay"] {
        if first.try_get(key).is_some_and(|v| v != &Exact::Undefined && v != &Exact::Array(Vec::new())) {
            assistant.push(entry(key, first.get(key).clone()));
        }
    }
    let mut out = history.to_vec();
    out.push(Exact::Object(assistant));
    if let Some(Exact::Array(calls)) = first.try_get("toolCalls") {
        out.extend(calls.iter().map(|c| Exact::Object(vec![entry("role", text("tool")), entry("toolCallId", c.get("id").clone()), entry("content", text("done"))])));
    }
    out.push(Exact::Object(vec![entry("role", text("user")), entry("content", text("continue"))]));
    out
}

/// One case's two sends against `endpoint`, compared with Node's.
async fn replay(set: &CaseSet, case: &Case, endpoint: &Endpoint) {
    let route = case.input.get("route").as_str();
    let home = tempfile::tempdir().expect("a home");
    let builder = replay_world::builder(&endpoint, home.path(), Vec::new()).await;
    let (name, config) = provider(case);
    let adapter = replay_world::adapter(&builder, &name, &config).await;
    let recorded = case.recorded();
    let mut results = Vec::new();
    let mut firsts = Vec::new();
    let mut messages = case.args_of("#send", 0)[0].as_array().to_vec();
    let history = messages.clone();
    for n in 0..2 {
        if n == 1 {
            messages = transcript(&history, &results[0]);
            recorded.get("transcript").assert_eq(&format!("{}: transcript", case.id), &Exact::Array(messages.clone()));
        }
        let request = send_request(case, n, &messages);
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
    recorded.get("events").assert_eq(&format!("{}: events", case.id), &observed(&firsts));
    recorded.get("first").assert_eq(&format!("{}: first", case.id), &results[0]);
    recorded.get("second").assert_eq(&format!("{}: second", case.id), &results[1]);
    set.assert_requests(case, &endpoint.arrivals(), None);
}

pub const REPLAYS: &[crate::provider_case::Replay] = &[crate::provider_case::Replay { set: "leak-guards", run: every_case_replays_as_nodes }];

/// Run in the replay's own scope (`run_scoped`), on the paused clock: its scripted draws and wall time are its own.
#[test]
fn every_case_replays_as_nodes() {
    mixdog_ai::random::run_scoped(every_case());
}

async fn every_case() {
    use futures::FutureExt as _;
    tokio::time::pause();
    let set = CaseSet::load("leak-guards");
    // Node's guards drew each recovered id from `randomBytes(8)` of the recording process, in order over the whole
    // recording: the core's draws are those bytes, computed as the recorder drew them.
    let mut draws = crate::provider_case::RecorderDraws::default();
    mixdog_ai::random::script((0..64).map(|_| draws.bytes(8)));
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
