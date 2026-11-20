//! The compat family's Responses wire: which wire a gateway model is reached on, the request head per route and
//! transport (URL, header order, body key order), and the xAI `prompt_cache_key` (what it identifies and what changes it).

use std::collections::HashMap;
use std::sync::Arc;

use mixdog_ai::providers::compat::chat::CompatConfig;
use mixdog_ai::providers::compat::chat::EnvSource;
use mixdog_ai::providers::compat::profile::CompatProfile;
use mixdog_ai::providers::compat::profile::CredentialKind;
use mixdog_ai::providers::compat::profile::LegacyWire;
use mixdog_ai::providers::compat::profile::Wire;
use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
use mixdog_ai::providers::compat::wire_route::RouteSource;
use mixdog_ai::providers::compat::wire_route::WireFacts;
use mixdog_ai::providers::compat::wire_route::resolve_wire;
use mixdog_ai::registry::keys::Environment;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;
use serde_json::json;

// which wire a model is reached on

/// A gateway that offers Chat and Responses, defaults to Chat, and started pre-table sessions on Chat.
fn gateway() -> CompatProfile {
    let mut profile = CompatProfile::plain("custom", "http://127.0.0.1/v1", CredentialKind::Keyless);
    profile.default_wire = Wire::Chat;
    profile.wires.offered = &[Wire::Chat, Wire::Responses];
    profile.wires.legacy = LegacyWire::Fixed(Wire::Chat);
    profile
}

fn known() -> WireFacts<'static> {
    WireFacts { model: "any-model", known: true, ..WireFacts::default() }
}

fn route(facts: WireFacts<'_>) -> Option<(Wire, RouteSource)> {
    resolve_wire(&gateway(), &facts).map(|r| (r.wire, r.source))
}

#[test]
fn a_models_wire_is_decided_by_the_first_tier_that_speaks_in_this_order() {
    use RouteSource::*;
    use Wire::*;
    let rows: Vec<(&str, WireFacts<'static>, Option<(Wire, RouteSource)>)> = vec![
        ("nothing known about the wire: the default", known(), Some((Chat, Default))),
        ("a pinned wire stays", WireFacts { keep: Some(Responses), ..known() }, Some((Responses, Pinned))),
        ("a pin outranks the user's override", WireFacts { keep: Some(Responses), override_wire: Some(Chat), ..known() }, Some((Responses, Pinned))),
        ("a pin the model is no longer offered on is dropped", WireFacts { keep: Some(Responses), exclude: &[Responses], ..known() }, Some((Chat, Default))),
        ("a pin on a wire the gateway never offered is dropped", WireFacts { keep: Some(Wire::Messages), ..known() }, Some((Chat, Default))),
        ("a model nothing describes keeps its pin", WireFacts { keep: Some(Responses), known: false, ..known() }, Some((Responses, Pinned))),
        ("the user's override", WireFacts { override_wire: Some(Responses), ..known() }, Some((Responses, Override))),
        ("an override outranks the catalog", WireFacts { override_wire: Some(Chat), catalog_wire: Some(Responses), ..known() }, Some((Chat, Override))),
        ("an override works even for an undescribed model", WireFacts { override_wire: Some(Responses), known: false, ..known() }, Some((Responses, Override))),
        (
            "an override on the wire just refused is not taken again",
            WireFacts { override_wire: Some(Responses), exclude: &[Responses], ..known() },
            Some((Chat, Default)),
        ),
        ("the catalog's wire", WireFacts { catalog_wire: Some(Responses), ..known() }, Some((Responses, Catalog))),
        ("a catalog wire the gateway does not offer says nothing", WireFacts { catalog_wire: Some(Wire::Gemini), ..known() }, Some((Chat, Default))),
        ("the one wire the roster advertises", WireFacts { endpoints: Some(&[Responses]), ..known() }, Some((Responses, Endpoints))),
        ("a roster that advertises both leaves the default", WireFacts { endpoints: Some(&[Chat, Responses]), ..known() }, Some((Chat, Default))),
        (
            "the catalog outranks the single-wire roster rule when both wires are advertised",
            WireFacts { endpoints: Some(&[Chat, Responses]), catalog_wire: Some(Responses), ..known() },
            Some((Responses, Catalog)),
        ),
        (
            "a catalog wire the roster does not advertise says nothing: the one advertised wire",
            WireFacts { endpoints: Some(&[Responses]), catalog_wire: Some(Chat), ..known() },
            Some((Responses, Endpoints)),
        ),
        ("a model nothing describes gets the default, flagged unknown", WireFacts { known: false, ..known() }, Some((Chat, Unknown))),
        ("a session that predates the table keeps the wire it started on", WireFacts { legacy: true, ..known() }, Some((Chat, Legacy))),
        ("and that outranks the override", WireFacts { legacy: true, override_wire: Some(Responses), ..known() }, Some((Chat, Legacy))),
        ("a legacy session on an undescribed model is unknown", WireFacts { legacy: true, known: false, ..known() }, Some((Chat, Unknown))),
        ("a roster that advertises nothing leaves no wire", WireFacts { endpoints: Some(&[]), ..known() }, None),
        ("every offered wire refused leaves no wire", WireFacts { exclude: &[Chat, Responses], ..known() }, None),
    ];
    for (what, facts, expected) in rows {
        assert_eq!(route(facts), expected, "{what}");
    }
}

#[test]
fn a_family_row_decides_after_the_roster_and_an_agent_only_row_only_for_agent_sessions() {
    // DeepSeek: tool sessions reach the Messages wire, one-shot sends the Chat wire.
    let deepseek = CompatProfile::deepseek();
    let facts = WireFacts { model: "deepseek-v4-pro", known: true, ..WireFacts::default() };
    let routed = |agent: bool| resolve_wire(&deepseek, &WireFacts { agent, ..facts }).map(|r| (r.wire, r.source));
    assert_eq!(routed(true), Some((Wire::Messages, RouteSource::Family)));
    assert_eq!(routed(false), Some((Wire::Chat, RouteSource::Default)));
}

#[test]
fn each_real_gateway_resolves_by_its_own_table() {
    let cases: [(CompatProfile, WireFacts<'static>, Wire); 6] = [
        (CompatProfile::muse_code_oauth(), known(), Wire::Responses),
        (CompatProfile::muse_code_oauth(), WireFacts { override_wire: Some(Wire::Chat), agent: true, ..known() }, Wire::Responses),
        (CompatProfile::command_code_oauth(), WireFacts { endpoints: Some(&[Wire::Messages]), ..known() }, Wire::Messages),
        (CompatProfile::command_code_oauth(), WireFacts { endpoints: Some(&[Wire::Messages, Wire::Chat]), ..known() }, Wire::Chat),
        (CompatProfile::opencode_go(), WireFacts { catalog_wire: Some(Wire::Responses), ..known() }, Wire::Responses),
        (CompatProfile::openrouter(), WireFacts { override_wire: Some(Wire::Messages), ..known() }, Wire::Messages),
    ];
    for (profile, facts, wire) in cases {
        assert_eq!(resolve_wire(&profile, &facts).map(|r| r.wire), Some(wire), "{} {facts:?}", profile.id);
    }
}

// the request head

struct MapEnv(HashMap<String, String>);

impl Environment for MapEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

fn config(env: &[(&str, &str)]) -> CompatConfig {
    let vars = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    CompatConfig { environment: Some(EnvSource(Arc::new(MapEnv(vars)))), ..CompatConfig::default() }
}

fn lookup() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Read a value".into(),
        input_schema: json!({"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}),
        defer_loading: false,
        freeform: None,
    }
}

fn request(model: &str, options: RequestOptions) -> ModelRequest {
    ModelRequest {
        model: model.into(),
        messages: vec![Message::new(Role::System, Content::Text("be brief".into())), Message::new(Role::User, Content::Text("go".into()))],
        tools: vec![lookup()],
        options,
    }
}

fn encode(profile: CompatProfile, config: CompatConfig, transport: TransportKind, request: &ModelRequest) -> (String, String, Vec<(String, String)>, Value) {
    let wire = CompatResponsesCodec::new(profile, config, transport).encode(request).unwrap();
    (wire.method, wire.url, wire.headers, serde_json::from_slice(&wire.body).unwrap())
}

fn keys(body: &Value) -> Vec<&str> {
    body.as_object().unwrap().keys().map(String::as_str).collect()
}

/// `present` appears in `order`'s relative order (each key of `present` is in `order`).
fn follows(present: &[&str], order: &[&str]) -> bool {
    let mut at = 0;
    present.iter().all(|key| match order[at..].iter().position(|o| o == key) {
        Some(found) => {
            at += found + 1;
            true
        }
        None => false,
    })
}

#[test]
fn an_http_request_goes_to_the_responses_endpoint_with_the_fixed_header_order_and_the_stream_flag() {
    let options = RequestOptions { session_id: Some("s1".into()), ..RequestOptions::default() };
    for (profile, accept) in [
        (CompatProfile::xai(), "application/json"),
        (CompatProfile::opencode_go(), "application/json"),
        (CompatProfile::muse_code_oauth(), "text/event-stream"),
    ] {
        let id = profile.id;
        let base = profile.base_url;
        let (method, url, headers, body) = encode(profile.clone(), CompatConfig::default(), TransportKind::Http1, &request("m1", options.clone()));
        assert_eq!((method.as_str(), url.as_str()), ("POST", format!("{base}/responses").as_str()), "{id}");
        assert_eq!(
            (headers[0].clone(), headers[1].clone()),
            (("content-type".into(), "application/json".into()), ("accept".into(), accept.into())),
            "{id}: content type, then accept, then the profile's own"
        );
        assert_eq!(body["stream"], true, "{id}");
        assert_eq!(body["model"], "m1", "{id}");
        assert!(body["input"].is_array(), "{id}");
    }
}

#[test]
fn extra_headers_follow_the_profiles_and_a_trailing_slash_of_the_base_url_is_ignored() {
    let mut cfg = CompatConfig::default();
    cfg.extra_headers = vec![("x-org-id".into(), "org-1".into())];
    cfg.base_url = Some("https://gateway.example/v1/".into());
    let (_, url, headers, _) = encode(CompatProfile::opencode_go(), cfg, TransportKind::Http1, &request("m", RequestOptions::default()));
    assert_eq!(url, "https://gateway.example/v1/responses");
    let at = |name: &str| headers.iter().position(|(k, _)| k == name).unwrap_or_else(|| panic!("{name} missing in {headers:?}"));
    assert!(at("accept") < at("x-org-id"), "the config's headers come after the profile's");
}

#[test]
fn the_xai_socket_sends_a_response_create_frame_without_stream_or_http_headers() {
    let options = RequestOptions { session_id: Some("s1".into()), ..RequestOptions::default() };
    let (method, url, headers, body) = encode(CompatProfile::xai(), CompatConfig::default(), TransportKind::WebSocket, &request("grok-4", options));
    assert_eq!((method.as_str(), url.as_str()), ("GET", "wss://api.x.ai/v1/responses"));
    assert!(headers.iter().all(|(k, _)| k != "content-type" && k != "accept"), "{headers:?}");
    assert_eq!(keys(&body)[0], "type");
    assert_eq!(body["type"], "response.create");
    assert!(body.get("stream").is_none(), "a socket has no stream key");
    assert_eq!(body["instructions"], "be brief", "the system text travels as instructions");
}

#[test]
fn body_keys_follow_each_routes_fixed_order() {
    let options = RequestOptions { session_id: Some("s1".into()), effort: Some("high".into()), ..RequestOptions::default() };
    let req = request("grok-4", options);
    let http = encode(CompatProfile::xai(), CompatConfig::default(), TransportKind::Http1, &req).3;
    let order = [
        "model",
        "input",
        "store",
        "include",
        "prompt_cache_key",
        "previous_response_id",
        "instructions",
        "tools",
        "parallel_tool_calls",
        "max_output_tokens",
        "tool_choice",
        "reasoning",
        "stream",
    ];
    assert!(follows(&keys(&http), &order), "{:?}", keys(&http));
    assert!(keys(&http).contains(&"reasoning") && keys(&http).contains(&"prompt_cache_key"));
    let ws = encode(CompatProfile::xai(), CompatConfig::default(), TransportKind::WebSocket, &req).3;
    assert!(follows(&keys(&ws)[1..], &order[..order.len() - 1]), "{:?}", keys(&ws));

    let gateway_order = [
        "model",
        "input",
        "store",
        "include",
        "stream",
        "previous_response_id",
        "max_output_tokens",
        "tools",
        "parallel_tool_calls",
        "tool_choice",
        "reasoning",
        "instructions",
        "prompt_cache_key",
    ];
    let go = encode(CompatProfile::opencode_go(), CompatConfig::default(), TransportKind::Http1, &req).3;
    assert!(follows(&keys(&go), &gateway_order), "{:?}", keys(&go));

    let muse_order = ["model", "input", "store", "include", "stream", "max_output_tokens", "tools", "instructions", "reasoning", "prompt_cache_key"];
    let muse = encode(CompatProfile::muse_code_oauth(), CompatConfig::default(), TransportKind::Http1, &req).3;
    assert!(follows(&keys(&muse), &muse_order), "{:?}", keys(&muse));
    assert_eq!(keys(&muse).last(), Some(&"prompt_cache_key"), "the cache key is the last thing Muse appends");
}

#[test]
fn xai_takes_only_the_efforts_it_knows_and_forces_no_tool_choice_but_none() {
    let body = |effort: Option<&str>, choice: Option<&str>| {
        let options = RequestOptions { effort: effort.map(str::to_owned), tool_choice: choice.map(str::to_owned), ..RequestOptions::default() };
        encode(CompatProfile::xai(), CompatConfig::default(), TransportKind::Http1, &request("grok-4", options)).3
    };
    for effort in ["low", "medium", "high", "xhigh"] {
        assert_eq!(body(Some(effort), None)["reasoning"], json!({"effort": effort}), "{effort}");
    }
    assert_eq!(body(Some(" HIGH "), None)["reasoning"], json!({"effort": "high"}), "trimmed and lower-cased");
    for effort in ["none", "minimal", "max", "weird"] {
        assert!(body(Some(effort), None).get("reasoning").is_none(), "{effort}");
    }
    assert!(body(None, None).get("reasoning").is_none());
    assert!(body(None, Some("lookup")).get("tool_choice").is_none(), "xAI's Responses send forces no named tool");
    assert!(body(None, Some("required")).get("tool_choice").is_none());
}

#[test]
fn muse_code_places_reasoning_by_its_own_levels_and_caches_by_the_given_key_or_the_session() {
    let body =
        |options: RequestOptions| encode(CompatProfile::muse_code_oauth(), CompatConfig::default(), TransportKind::Http1, &request("muse-spark", options)).3;
    let with_effort = |effort: &str| body(RequestOptions { effort: Some(effort.into()), ..RequestOptions::default() });
    assert_eq!(with_effort("high")["reasoning"], json!({"effort": "high", "summary": "auto"}));
    assert_eq!(with_effort("max")["reasoning"], json!({"effort": "xhigh", "summary": "auto"}), "max is the top level it has");
    assert_eq!(with_effort("off")["reasoning"], json!({"effort": "none"}));
    assert!(with_effort("off").get("include").is_none(), "forced off asks for no encrypted reasoning back");
    assert!(with_effort("ultra").get("reasoning").is_none(), "a level it does not take is not sent");
    assert!(body(RequestOptions::default()).get("reasoning").is_none());

    let key = |options: RequestOptions| body(options).get("prompt_cache_key").cloned();
    assert_eq!(key(RequestOptions { session_id: Some("s1".into()), ..RequestOptions::default() }), Some(json!("s1")));
    assert_eq!(
        key(RequestOptions { session_id: Some("s1".into()), prompt_cache_key: Some(" lane ".into()), ..RequestOptions::default() }),
        Some(json!("lane"))
    );
    assert_eq!(
        key(RequestOptions { session_id: Some("s1".into()), prompt_cache_key: Some(String::new()), ..RequestOptions::default() }),
        None,
        "an explicit blank key suppresses caching"
    );
    let long = "k".repeat(65);
    let hashed = key(RequestOptions { prompt_cache_key: Some(long), ..RequestOptions::default() }).unwrap();
    let hashed = hashed.as_str().unwrap();
    assert!(
        hashed.starts_with("pc_") && hashed.len() == 3 + 32 && hashed[3..].bytes().all(|b| b.is_ascii_hexdigit()),
        "past 64 units the key is a bounded hash: {hashed}"
    );
    let kept = key(RequestOptions { prompt_cache_key: Some("k".repeat(64)), ..RequestOptions::default() }).unwrap();
    assert_eq!(kept.as_str().unwrap().len(), 64, "up to 64 units it is kept");
}

// the xAI cache key

fn xai_key(env: &[(&str, &str)], mut request: ModelRequest, tweak: impl FnOnce(&mut RequestOptions)) -> Option<String> {
    tweak(&mut request.options);
    let body = encode(CompatProfile::xai(), config(env), TransportKind::Http1, &request).3;
    body.get("prompt_cache_key").map(|k| k.as_str().unwrap().to_owned())
}

fn session(id: &str) -> impl FnOnce(&mut RequestOptions) + '_ {
    move |o| o.session_id = Some(id.into())
}

#[test]
fn the_default_key_identifies_the_session_and_changes_with_the_session_model_and_namespace_only() {
    let base = || request("grok-4", RequestOptions::default());
    let key = xai_key(&[], base(), session("s1")).expect("a session has a key");
    let uuid = key.split('-').map(str::len).collect::<Vec<_>>();
    assert_eq!(uuid, [8, 4, 4, 4, 12], "{key}");
    assert!(key.split('-').nth(2).unwrap().starts_with('4'), "a version 4 shaped id: {key}");
    assert_eq!(xai_key(&[], base(), session("s1")), Some(key.clone()), "stable");
    assert_ne!(xai_key(&[], base(), session("s2")), Some(key.clone()), "another session");
    assert_ne!(xai_key(&[], request("grok-4.3", RequestOptions::default()), session("s1")), Some(key.clone()), "another model");
    let named = xai_key(&[], base(), |o| {
        o.session_id = Some("s1".into());
        o.prompt_cache_key = Some("team-a".into());
    });
    assert_ne!(named, Some(key.clone()), "the caller's key names the namespace");
    // What the conversation says does not change it.
    let mut other_text = base();
    other_text.messages[1] = Message::new(Role::User, Content::Text("something else entirely".into()));
    other_text.messages[0] = Message::new(Role::System, Content::Text("different system".into()));
    other_text.tools.clear();
    assert_eq!(xai_key(&[], other_text, session("s1")), Some(key.clone()));
    // The transport does not either.
    let ws = encode(CompatProfile::xai(), config(&[]), TransportKind::WebSocket, &{
        let mut r = base();
        r.options.session_id = Some("s1".into());
        r
    })
    .3;
    assert_eq!(ws["prompt_cache_key"].as_str(), Some(key.as_str()));
}

#[test]
fn a_request_without_a_session_or_with_the_scope_off_sends_no_key() {
    let base = || request("grok-4", RequestOptions::default());
    assert_eq!(xai_key(&[], base(), |_| {}), None, "the default scope needs a session");
    assert_eq!(xai_key(&[], base(), |o| o.session_id = Some("   ".into())), None, "a blank session is none");
    for scope in ["none", "off", "omit", " OFF "] {
        assert_eq!(
            xai_key(&[], base(), |o| {
                o.session_id = Some("s1".into());
                o.xai_responses_cache_scope = Some(scope.into());
            }),
            None,
            "{scope:?}"
        );
        assert_eq!(xai_key(&[("MIXDOG_XAI_RESPONSES_CACHE_SCOPE", scope)], base(), session("s1")), None, "{scope:?} from the environment");
    }
}

#[test]
fn the_prefix_scope_keys_the_model_system_text_and_tools_whoever_asks() {
    let prefix = |request: ModelRequest, session_id: Option<&str>| {
        xai_key(&[], request, |o| {
            o.xai_responses_cache_scope = Some("prefix".into());
            o.session_id = session_id.map(str::to_owned);
        })
    };
    let base = || request("grok-4", RequestOptions::default());
    let key = prefix(base(), Some("s1")).expect("a prefix key needs no session");
    assert_eq!(prefix(base(), Some("s2")), Some(key.clone()), "one-shot roles share it across sessions");
    assert_eq!(prefix(base(), None), Some(key.clone()));
    assert_eq!(xai_key(&[], base(), |o| o.prompt_cache_scope = Some("shared".into())), Some(key.clone()), "a shared request is a prefix request");
    let mut user_text = base();
    user_text.messages[1] = Message::new(Role::User, Content::Text("a different question".into()));
    assert_eq!(prefix(user_text, Some("s1")), Some(key.clone()), "the question is not part of the prefix");
    let mut system = base();
    system.messages[0] = Message::new(Role::System, Content::Text("another system prompt".into()));
    assert_ne!(prefix(system, Some("s1")), Some(key.clone()), "system text");
    let mut tools = base();
    tools.tools[0].description = "Read a different value".into();
    assert_ne!(prefix(tools, Some("s1")), Some(key.clone()), "tool descriptions");
    let mut schema = base();
    schema.tools[0].input_schema = json!({"type": "object", "properties": {"other": {"type": "string"}}});
    assert_ne!(prefix(schema, Some("s1")), Some(key.clone()), "tool schemas");
    let mut no_tools = base();
    no_tools.tools.clear();
    assert_ne!(prefix(no_tools, Some("s1")), Some(key.clone()), "the tool list");
    assert_ne!(prefix(request("grok-4.3", RequestOptions::default()), Some("s1")), Some(key.clone()), "model");
    assert_ne!(prefix(base(), Some("s1")), xai_key(&[], base(), session("s1")), "a prefix key and a session key are different keys");
}

#[test]
fn the_scope_comes_from_the_request_then_the_shared_flag_then_the_environment() {
    let base = || request("grok-4", RequestOptions::default());
    let env = [("MIXDOG_XAI_RESPONSES_CACHE_SCOPE", "prefix")];
    let by_env = xai_key(&env, base(), session("s1")).unwrap();
    assert_eq!(xai_key(&env, base(), session("s2")), Some(by_env.clone()), "the environment's prefix scope ignores the session");
    // The request's own scope outranks the environment.
    assert_ne!(
        xai_key(&env, base(), |o| {
            o.session_id = Some("s1".into());
            o.xai_responses_cache_scope = Some("session".into());
        }),
        Some(by_env.clone())
    );
    // An empty request scope falls through.
    assert_eq!(
        xai_key(&env, base(), |o| {
            o.session_id = Some("s1".into());
            o.xai_responses_cache_scope = Some(String::new());
        }),
        Some(by_env)
    );
    // `shared` outranks the environment's session scope.
    let shared = xai_key(&[("MIXDOG_XAI_RESPONSES_CACHE_SCOPE", "session")], base(), |o| {
        o.session_id = Some("s1".into());
        o.prompt_cache_scope = Some("shared".into());
    });
    assert_eq!(shared, xai_key(&[], base(), |o| o.xai_responses_cache_scope = Some("prefix".into())));
}

#[test]
fn a_prefix_key_can_be_sharded_into_lanes_by_the_environment_and_the_unbounded_lane_numbers_sessions_in_turn() {
    let prefix = |env: &[(&str, &str)], codec_requests: &[&str]| -> Vec<String> {
        // One codec for the whole list: the unbounded lane numbers the sessions it has seen.
        let codec = CompatResponsesCodec::new(CompatProfile::xai(), config(env), TransportKind::Http1);
        codec_requests
            .iter()
            .map(|id| {
                let mut r = request("grok-4", RequestOptions::default());
                r.options.xai_responses_cache_scope = Some("prefix".into());
                r.options.session_id = Some((*id).into());
                let body: Value = serde_json::from_slice(&codec.encode(&r).unwrap().body).unwrap();
                body["prompt_cache_key"].as_str().unwrap().to_owned()
            })
            .collect()
    };
    let sessions: Vec<String> = (0..12).map(|n| format!("session-{n}")).collect();
    let ids: Vec<&str> = sessions.iter().map(String::as_str).collect();
    // One shard (the default): every session shares the key.
    let single = prefix(&[], &ids);
    assert!(single.iter().all(|k| *k == single[0]));
    assert!(prefix(&[("MIXDOG_XAI_RESPONSES_CACHE_LANE_SHARDS", "1")], &ids).iter().all(|k| *k == single[0]), "one shard is the plain prefix key");
    // Two shards: a session keeps its lane, and twelve sessions use both.
    let sharded = prefix(&[("MIXDOG_XAI_RESPONSES_CACHE_LANE_SHARDS", "2")], &ids);
    let again = prefix(&[("MIXDOG_XAI_RESPONSES_CACHE_LANE_SHARDS", "2")], &ids);
    assert_eq!(sharded, again, "a session's lane is derived from it, so a restart keeps it");
    let distinct: std::collections::BTreeSet<&String> = sharded.iter().collect();
    assert_eq!(distinct.len(), 2, "two shards give two keys: {distinct:?}");
    assert!(!distinct.contains(&single[0]), "a sharded key differs from the unsharded one");
    // The alias names are read too, the first one set winning.
    assert_eq!(prefix(&[("MIXDOG_GROK_CACHE_LANE_SHARDS", "2")], &ids), sharded);
    // Unbounded: each new session takes the next lane, and the same session keeps its own.
    let auto = prefix(&[("MIXDOG_XAI_RESPONSES_CACHE_LANE_AUTO", "auto")], &["a", "b", "a", "c"]);
    assert_eq!(auto[0], auto[2]);
    let lanes: std::collections::BTreeSet<&String> = auto.iter().collect();
    assert_eq!(lanes.len(), 3, "a, b and c are three lanes: {auto:?}");
}
