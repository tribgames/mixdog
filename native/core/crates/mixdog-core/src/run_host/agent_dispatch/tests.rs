/// A hidden role's configured fallback chain survives the route's normalization into the preset the session is made from.
#[test]
fn a_hidden_roles_fallback_chain_reaches_its_preset() {
    let route = serde_json::json!({
        "provider": "openai", "model": "gpt",
        "fallbacks": [{ "provider": "anthropic", "model": "opus" }, { "provider": "openai", "model": "gpt" }]
    });
    let candidate = super::normalize_candidate(&route).expect("a complete route");
    let preset = super::route_to_preset(&candidate, "explore").expect("a preset");
    assert_eq!(preset["fallbacks"], serde_json::json!([{ "provider": "anthropic", "model": "opus" }]));
}

/// The factory's permission wins for a public agent, a hidden role asks for its own (`read` when it
/// declares none) and an empty option is as good as none.
#[test]
fn the_dispatch_permission_is_the_options_else_the_hidden_roles() {
    let hidden = serde_json::json!({ "permission": "full" });
    assert_eq!(super::session_permission("my-agent", None, Some("mcp")), Some("mcp".to_owned()));
    assert_eq!(super::session_permission("my-agent", None, None), None);
    assert_eq!(super::session_permission("my-agent", Some(&hidden), None), Some("full".to_owned()));
    assert_eq!(super::session_permission("my-agent", Some(&serde_json::json!({})), None), Some("read".to_owned()));
    // `??` keeps an empty string, which `resolveAgentSessionPermission` then ignores: only the
    // internal agent's own declaration (none for `my-agent`) is left.
    assert_eq!(super::session_permission("my-agent", Some(&hidden), Some("")), None);
}
