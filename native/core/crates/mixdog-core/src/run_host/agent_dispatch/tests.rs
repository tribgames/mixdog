//! The permission a dispatched agent session is given.
/// `session-prep.mjs:75-78`: `opts.permission ?? (isPoolC ? hidden.permission || 'read' : null)`, resolved
/// like `prepareAgentSession`: the factory's permission wins for a public agent, a hidden role asks for its
/// own (`read` when it declares none) and an empty option is as good as none.
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

