//! The request the Antigravity codec builds for the gateway (Node 1.4.5 `antigravity-request.mjs`
//! `buildAntigravityRequest`): the envelope and its field order, the session id, the system instruction, the
//! function-calling mode, the Claude generation config, the replay of a Claude turn and the closure of a tool loop that
//! did not open with signed thinking. Inputs are small and inline; each expectation states the rule it holds.

use std::sync::Arc;

use mixdog_ai::providers::google::codec::ANTIGRAVITY_ORIGIN;
use mixdog_ai::providers::google::codec::GoogleCodec;
use mixdog_ai::providers::google::codec::antigravity_function_calling_mode;
use mixdog_ai::providers::google::traits::CatalogGoogleTraits;
use mixdog_ai::registry::keys::Environment;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec as _;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

struct Vars(Vec<(&'static str, &'static str)>);

impl Environment for Vars {
    fn var(&self, name: &str) -> Option<String> {
        self.0.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned())
    }
}

fn codec() -> GoogleCodec {
    GoogleCodec::antigravity(ANTIGRAVITY_ORIGIN, "proj-1", "1.0.0", Arc::new(CatalogGoogleTraits(Vec::new()))).with_env(Arc::new(Vars(Vec::new())))
}

fn message(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.into()))
}

fn call_message(id: &str, name: &str, arguments: Value) -> Message {
    let mut m = message(Role::Assistant, "");
    m.tool_calls = vec![ToolCall { id: id.into(), name: name.into(), arguments, native_type: None }];
    m
}

fn result(id: &str, text: &str) -> Message {
    let mut m = message(Role::Tool, text);
    m.tool_call_id = Some(id.into());
    m
}

fn read_tool() -> ToolDefinition {
    ToolDefinition {
        name: "read".into(),
        description: "Read a file".into(),
        input_schema: json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
        defer_loading: false,
        freeform: None,
    }
}

fn built(model: &str, messages: Vec<Message>, tools: Vec<ToolDefinition>, options: RequestOptions) -> Value {
    let wire = codec().encode(&ModelRequest { model: model.into(), messages, tools, options }).unwrap_or_else(|e| panic!("{model}: {}", e.message));
    serde_json::from_slice(&wire.body).unwrap()
}

fn keys(value: &Value) -> Vec<&str> {
    value.as_object().unwrap().keys().map(String::as_str).collect()
}

fn effort(level: &str) -> RequestOptions {
    RequestOptions { effort: Some(level.into()), ..RequestOptions::default() }
}

/// `-` and the first eight bytes of the SHA-256 of the first user turn's text, big-endian, modulo 2^63 - 1.
fn session_of(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let head = u64::from_be_bytes(digest[..8].try_into().unwrap());
    format!("-{}", head % 9_223_372_036_854_775_807)
}

#[test]
fn the_envelope_names_the_project_model_request_and_agent_in_nodes_order_and_the_session_follows_the_first_user_text() {
    let body = built("gemini-3.6-flash", vec![message(Role::User, "hello"), message(Role::Assistant, "hi"), message(Role::User, "more")], vec![], RequestOptions::default());
    assert_eq!(keys(&body), ["project", "model", "request", "requestType", "userAgent", "requestId"]);
    assert_eq!((body["project"].as_str(), body["model"].as_str()), (Some("proj-1"), Some("gemini-3.6-flash")));
    assert_eq!((body["requestType"].as_str(), body["userAgent"].as_str()), (Some("agent"), Some("antigravity")));
    let id = body["requestId"].as_str().unwrap().strip_prefix("agent-").expect("an agent- request id");
    assert_eq!(id.len(), 36);
    assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()), "{id}");
    let request = &body["request"];
    assert_eq!(keys(request), ["contents", "generationConfig", "sessionId"], "no tools and no system text: neither field is written");
    assert_eq!(request["sessionId"], session_of("hello"), "derived from the first user turn: a resumed conversation keeps its session");
    assert_eq!(
        request["contents"],
        json!([{"role": "user", "parts": [{"text": "hello"}]}, {"role": "model", "parts": [{"text": "hi"}]}, {"role": "user", "parts": [{"text": "more"}]}])
    );
}

#[test]
fn a_first_turn_without_text_gets_a_fresh_session_each_time_and_a_request_with_no_messages_is_refused() {
    let blank = || built("gemini-3.6-flash", vec![message(Role::User, "  ")], vec![], RequestOptions::default())["request"]["sessionId"].as_str().unwrap().to_owned();
    let (a, b) = (blank(), blank());
    assert!(a.starts_with('-') && a.len() > 30 && a != b, "{a} {b}");
    let err = codec().encode(&ModelRequest { model: "gemini-3.6-flash".into(), messages: vec![message(Role::System, "only a system prompt")], tools: vec![], options: RequestOptions::default() });
    assert!(err.err().expect("refused").message.contains("No messages to send"));
}

#[test]
fn system_messages_are_joined_into_the_system_instruction_and_kept_out_of_the_contents() {
    let body = built(
        "gemini-3.6-flash",
        vec![message(Role::System, "one"), message(Role::User, "q"), message(Role::System, "two")],
        vec![],
        RequestOptions::default(),
    );
    let request = &body["request"];
    assert_eq!(keys(request), ["contents", "systemInstruction", "generationConfig", "sessionId"]);
    assert_eq!(request["systemInstruction"], json!({"role": "user", "parts": [{"text": "one\n\ntwo"}]}));
    assert_eq!(request["contents"], json!([{"role": "user", "parts": [{"text": "q"}]}]));
}

#[test]
fn function_declarations_bring_a_tool_config_whose_mode_is_validated_unless_the_environment_names_another() {
    let body = built("gemini-3.6-flash", vec![message(Role::User, "q")], vec![read_tool()], RequestOptions::default());
    let request = &body["request"];
    assert_eq!(keys(request), ["contents", "tools", "toolConfig", "generationConfig", "sessionId"]);
    assert_eq!(request["tools"][0]["functionDeclarations"][0]["name"], "read");
    assert_eq!(request["toolConfig"], json!({"functionCallingConfig": {"mode": "VALIDATED"}}));

    // `MIXDOG_ANTIGRAVITY_FC_MODE`: trimmed, any case, one of AUTO, ANY, VALIDATED; anything else is the default.
    for (raw, mode) in [("AUTO", "AUTO"), (" any ", "ANY"), ("validated", "VALIDATED"), ("NONE", "VALIDATED"), ("", "VALIDATED")] {
        assert_eq!(antigravity_function_calling_mode(&Vars(vec![("MIXDOG_ANTIGRAVITY_FC_MODE", raw)])), mode, "{raw:?}");
    }
    assert_eq!(antigravity_function_calling_mode(&Vars(Vec::new())), "VALIDATED");
    let from_env = GoogleCodec::antigravity(ANTIGRAVITY_ORIGIN, "proj-1", "1.0.0", Arc::new(CatalogGoogleTraits(Vec::new()))).with_env(Arc::new(Vars(vec![("MIXDOG_ANTIGRAVITY_FC_MODE", "AUTO")])));
    let wire = from_env.encode(&ModelRequest { model: "gemini-3.6-flash".into(), messages: vec![message(Role::User, "q")], tools: vec![read_tool()], options: RequestOptions::default() }).unwrap();
    let sent: Value = serde_json::from_slice(&wire.body).unwrap();
    assert_eq!(sent["request"]["toolConfig"], json!({"functionCallingConfig": {"mode": "AUTO"}}));
}

#[test]
fn a_claude_request_is_always_capped_and_its_effort_rides_on_the_thinking_level_the_gateway_knows() {
    let ask = |options| built("claude-sonnet-4-6", vec![message(Role::User, "q")], vec![], options)["request"]["generationConfig"].clone();
    // No effort: thoughts are asked for, the cap is the fixed 64000 of a gateway that declared none.
    assert_eq!(ask(RequestOptions::default()), json!({"maxOutputTokens": 64000, "thinkingConfig": {"includeThoughts": true}}));
    // The gateway's enum ends at `high`: the levels above it are sent as `high`, a level it does not name is left out.
    for (asked, level) in [("low", Some("low")), ("MEDIUM", Some("medium")), ("high", Some("high")), ("xhigh", Some("high")), ("max", Some("high")), ("ultra", Some("high")), ("bogus", None)] {
        let mut want = json!({"includeThoughts": true});
        if let Some(level) = level {
            want["thinkingLevel"] = json!(level);
        }
        assert_eq!(ask(effort(asked))["thinkingConfig"], want, "{asked}");
    }
}

fn tool_loop() -> Vec<Message> {
    vec![message(Role::User, "q"), call_message("c1", "read", json!({"path": "a.txt"})), result("c1", "file text")]
}

fn roles_and_texts(body: &Value) -> Vec<(String, Option<String>)> {
    body["request"]["contents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["role"].as_str().unwrap().to_owned(), c["parts"][0]["text"].as_str().map(str::to_owned)))
        .collect()
}

#[test]
fn a_claude_tool_loop_that_did_not_open_with_signed_thinking_is_closed_and_a_fresh_turn_is_opened_when_thinking_is_on() {
    let closed = built("claude-sonnet-4-6", tool_loop(), vec![read_tool()], effort("high"));
    assert_eq!(
        roles_and_texts(&closed),
        [
            ("user".to_owned(), Some("q".to_owned())),
            ("model".to_owned(), None),
            ("user".to_owned(), None),
            ("model".to_owned(), Some("[Tool result received.]".to_owned())),
            ("user".to_owned(), Some("[Continue.]".to_owned())),
        ],
        "the results are acknowledged by a model reply and a user nudge opens the turn Claude starts with new thinking"
    );
    // Two results of one step are counted in the acknowledgement.
    let mut two = vec![message(Role::User, "q")];
    let mut step = call_message("c1", "read", json!({"path": "a"}));
    step.tool_calls.push(ToolCall { id: "c2".into(), name: "read".into(), arguments: json!({"path": "b"}), native_type: None });
    two.extend([step, result("c1", "x"), result("c2", "y")]);
    let acknowledged = built("claude-sonnet-4-6", two, vec![read_tool()], effort("high"));
    assert_eq!(roles_and_texts(&acknowledged).iter().filter_map(|(_, t)| t.as_deref()).last(), Some("[Continue.]"));
    assert!(roles_and_texts(&acknowledged).iter().any(|(_, t)| t.as_deref() == Some("[2 tool results received.]")));

    // Thinking off (no effort, a wire id without `-thinking`): the loop is sent as it is.
    let open = built("claude-sonnet-4-6", tool_loop(), vec![read_tool()], RequestOptions::default());
    assert_eq!(open["request"]["contents"].as_array().unwrap().len(), 3);
    // A `-thinking` wire id thinks without an effort.
    let thinking = built("claude-sonnet-4-6-thinking", tool_loop(), vec![read_tool()], RequestOptions::default());
    assert_eq!(thinking["request"]["contents"].as_array().unwrap().len(), 5);
}

#[test]
fn an_empty_text_part_the_stream_recorded_is_not_replayed_to_claude_and_a_turn_of_nothing_else_is_left_out() {
    let replayed = |parts: Value| {
        let mut turn = message(Role::Assistant, "");
        turn.push_replay(ProviderReplay { owner: ProviderId::from("antigravity"), items: json!({"parts": parts, "model": "claude-sonnet-4-6"}) });
        built("claude-sonnet-4-6", vec![message(Role::User, "q"), turn, message(Role::User, "next")], vec![], RequestOptions::default())["request"]["contents"].clone()
    };
    // The bridge rejects `text.text: Field required`: the empty part goes, the others stay in order.
    let contents = replayed(json!([{"text": ""}, {"text": "answer"}]));
    assert_eq!(contents[1], json!({"role": "model", "parts": [{"text": "answer"}]}));
    // A model turn that held only empty parts is omitted, not sent as `parts: []`.
    let contents = replayed(json!([{"text": ""}]));
    assert_eq!(contents.as_array().unwrap().iter().map(|c| c["role"].as_str().unwrap()).collect::<Vec<_>>(), ["user", "user"]);
}
