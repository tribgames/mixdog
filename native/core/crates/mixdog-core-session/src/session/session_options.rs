//! `thread/start`'s `session` options as Node's session record persists them
//! (`session-create/session-options.mjs` `sessionOptions`, `session-record.mjs`
//! `buildSessionRecord`, `headless-exec.mjs` `createHeadlessSessionRuntime`): the tool
//! policy fields the session's surface reads (`SessionSurface::from_header`), the
//! approval mode, and the switches the runtime applies to the session.

use mixdog_app_protocol::v2::thread::ApprovalMode;
use mixdog_app_protocol::v2::thread::SessionToolMode;
use mixdog_app_protocol::v2::thread::ThreadSessionOptions;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

/// `HEADLESS_MODEL_TOOL_NAMES` (`tool-profile.mjs:10`).
const HEADLESS_MODEL_TOOL_NAMES: [&str; 17] = [
    "find",
    "glob",
    "list",
    "grep",
    "code_graph",
    "read",
    "edit",
    "apply_patch",
    "git",
    "github",
    "shell",
    "task",
    "load_tool",
    "web_search",
    "web_fetch",
    "office",
    "tidy",
];

/// `HEARTBEAT_MODEL_TOOL_NAMES` (`tool-profile.mjs:31`).
const HEARTBEAT_MODEL_TOOL_NAMES: [&str; 3] = ["session", "setup", "load_tool"];

/// `LEAD_DISALLOWED_TOOLS` (`tool-defs.mjs:228`).
const LEAD_DISALLOWED_TOOLS: [&str; 4] = ["get_goal", "create_goal", "set_goal_tasks", "update_goal"];

/// The header key of `autoWakeCompletions: false` (Node's `onCompletionQueued: null`).
pub const AUTO_WAKE_COMPLETIONS: &str = "autoWakeCompletions";
/// The header key of the session's memory switch (`MIXDOG_FEATURE_MEMORY`).
pub const MEMORY: &str = "memory";

fn names(list: &[&str]) -> Value {
    json!(list)
}

/// Writes the session's options into its new header. A user session (`thread/start` is never
/// agent-owned) denies the Lead-only goal tools and, without delegation, `agent`; a narrowed
/// profile persists its schema allowlist; `toolSpecForMode` gives the tool spec; a switched-off
/// feature denies its tools as a settings gate does.
pub fn write_header(options: &ThreadSessionOptions, header: &mut Header) {
    let profile = options.tool_profile.unwrap_or(ToolProfile::Interactive);
    // `modelToolSchemaAllowlist(rt.toolProfile)` (`boot/apis.mjs:429`).
    match profile {
        ToolProfile::Headless => header.insert("schemaAllowedTools".into(), names(&HEADLESS_MODEL_TOOL_NAMES)),
        ToolProfile::Heartbeat => header.insert("schemaAllowedTools".into(), names(&HEARTBEAT_MODEL_TOOL_NAMES)),
        ToolProfile::Interactive => None,
    };
    // `toolSpecForMode(mode)` (`effort.mjs:165`).
    let tool_spec = match options.tool_mode.unwrap_or(SessionToolMode::Full) {
        SessionToolMode::Readonly => json!(["tools:readonly"]),
        SessionToolMode::Full | SessionToolMode::Lead => json!("full"),
    };
    header.insert("toolSpec".into(), tool_spec);
    let mut caller: Vec<&str> = LEAD_DISALLOWED_TOOLS.to_vec();
    if options.disallow_delegation == Some(true) {
        caller.push("agent");
    }
    // `featureDisallowedToolsFor`: the session's own feature switches.
    let mut features: Vec<&str> = Vec::new();
    if options.web_search == Some(false) {
        features.extend(["web_search", "web_fetch"]);
    }
    if options.memory == Some(false) {
        features.extend(["memory", "recall"]);
    }
    header.insert("callerDisallowedTools".into(), names(&caller));
    header.insert("disallowedTools".into(), names(&[caller.as_slice(), features.as_slice()].concat()));
    if !features.is_empty() {
        header.insert("featureDeniedTools".into(), names(&features));
    }
    // `sourceType`: a headless run is an exec run, kept out of the resumable list.
    header.insert(
        "sourceType".into(),
        json!(if profile == ToolProfile::Headless { "exec" } else { "lead" }),
    );
    if options.approval_mode == Some(ApprovalMode::Implicit) {
        header.insert("approvalMode".into(), json!("implicit"));
    }
    if options.auto_wake_completions == Some(false) {
        header.insert(AUTO_WAKE_COMPLETIONS.into(), json!(false));
    }
    if let Some(memory) = options.memory {
        header.insert(MEMORY.into(), json!(memory));
    }
    if let Some(web_search) = options.web_search {
        header.insert("webSearch".into(), json!(web_search));
    }
}

/// `approvalMode: "implicit"`: the session has no approval surface.
pub fn approval_implicit(header: &Header) -> bool {
    header.get("approvalMode").and_then(Value::as_str) == Some("implicit")
}

/// Whether the session's memory is switched off (`MIXDOG_FEATURE_MEMORY=0`): its memory
/// module never starts, so nothing is ingested when it closes.
pub fn memory_off(header: &Header) -> bool {
    header.get(MEMORY) == Some(&Value::Bool(false))
}

#[cfg(test)]
mod tests {
    use mixdog_tools::policy::surface::SessionSurface;

    use super::*;

    fn headless() -> ThreadSessionOptions {
        serde_json::from_value(json!({
            "toolProfile": "headless",
            "toolMode": "full",
            "approvalMode": "implicit",
            "disallowDelegation": true,
            "autoWakeCompletions": false,
            "webSearch": false,
            "memory": false,
        }))
        .expect("options")
    }

    fn refusal(surface: &SessionSurface, name: &str) -> Option<String> {
        surface.refusal(name, None).map(|error| error.message_for_model)
    }

    #[test]
    fn a_headless_session_is_fenced_to_its_tools_as_nodes_header_makes_it() {
        let mut header = Header::new();
        write_header(&headless(), &mut header);
        assert_eq!(header["sourceType"], "exec");
        assert_eq!(header["approvalMode"], "implicit");
        assert_eq!(header["toolSpec"], "full");
        assert_eq!(header[AUTO_WAKE_COMPLETIONS], false);
        assert!(memory_off(&header));
        let surface = SessionSurface::from_header(&header, Vec::new());
        assert_eq!(refusal(&surface, "read"), None);
        assert_eq!(
            refusal(&surface, "browser").as_deref(),
            Some("Error: tool \"browser\" is not available on this session's schema allowlist.")
        );
        assert_eq!(
            refusal(&surface, "web_search").as_deref(),
            Some(
                "Error: tool \"web_search\" is disabled in settings by the user. Do not retry unless the user turns it back on."
            )
        );
    }

    #[test]
    fn delegation_and_goal_tools_are_denied_and_readonly_comes_from_the_tool_mode() {
        let mut header = Header::new();
        let options: ThreadSessionOptions =
            serde_json::from_value(json!({ "toolMode": "readonly", "disallowDelegation": true })).expect("options");
        write_header(&options, &mut header);
        assert_eq!(header["toolSpec"], json!(["tools:readonly"]));
        assert_eq!(header["sourceType"], "lead");
        assert!(header.get("schemaAllowedTools").is_none() && header.get("approvalMode").is_none());
        let surface = SessionSurface::from_header(&header, Vec::new());
        assert!(surface.readonly);
        for tool in ["agent", "create_goal"] {
            assert_eq!(
                refusal(&surface, tool),
                Some(format!("Error: tool \"{tool}\" is not available in this session."))
            );
        }
    }
}
