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
pub const LEAD_DISALLOWED_TOOLS: [&str; 4] = ["get_goal", "create_goal", "set_goal_tasks", "update_goal"];

/// `CODING_LEAD_PROFILE_REVISION` (`role-instructions.mjs:384`).
const CODING_LEAD_PROFILE_REVISION: &str = "coding-lead";

/// The header key of `autoWakeCompletions: false` (Node's `onCompletionQueued: null`).
pub const AUTO_WAKE_COMPLETIONS: &str = "autoWakeCompletions";
/// The header key of the session's memory switch (`MIXDOG_FEATURE_MEMORY`).
pub const MEMORY: &str = "memory";

fn names(list: &[&str]) -> Value {
    json!(list)
}

/// `modelToolSchemaAllowlist(profile)`: the tools a narrowed profile's schema holds; `None` for the
/// interactive profile.
pub fn model_tool_allowlist(profile: ToolProfile) -> Option<&'static [&'static str]> {
    match profile {
        ToolProfile::Headless => Some(&HEADLESS_MODEL_TOOL_NAMES),
        ToolProfile::Heartbeat => Some(&HEARTBEAT_MODEL_TOOL_NAMES),
        ToolProfile::Interactive => None,
    }
}

/// The allowlist of the profile a thread was started under (`toolProfile` on its header), which fences the
/// standalone tools (`filterModelToolsForProfile`); a caller's own `schemaAllowedTools` does not.
pub fn header_profile_allowlist(header: &Header) -> Option<&'static [&'static str]> {
    header_tool_profile(header).and_then(model_tool_allowlist)
}

/// The narrowed profile a thread was started under (`toolProfile` on its header); `None` for the interactive one.
pub fn header_tool_profile(header: &Header) -> Option<ToolProfile> {
    match header.get("toolProfile").and_then(Value::as_str) {
        Some("headless") => Some(ToolProfile::Headless),
        Some("heartbeat") => Some(ToolProfile::Heartbeat),
        _ => None,
    }
}

/// Writes the session's options into its new header. A user session (`thread/start` is never
/// agent-owned) denies the Lead-only goal tools and, without delegation, `agent`; a narrowed
/// profile persists its schema allowlist; `toolSpecForMode` gives the tool spec; a switched-off
/// feature denies its tools as a settings gate does.
pub fn write_header(options: &ThreadSessionOptions, header: &mut Header) {
    let profile = options.tool_profile.unwrap_or(ToolProfile::Interactive);
    // `modelToolSchemaAllowlist(rt.toolProfile)` (`boot/apis.mjs:429`).
    if let Some(allowed) = model_tool_allowlist(profile) {
        header.insert("schemaAllowedTools".into(), names(allowed));
        header.insert("toolProfile".into(), json!(if profile == ToolProfile::Headless { "headless" } else { "heartbeat" }));
    }
    // `toolSpecForMode(mode)` (`effort.mjs:165`), and Node's `rt.mode` (`normalizeToolMode(params.toolMode)`)
    // which `thread/setToolMode` moves.
    let (mode, tool_spec) = match options.tool_mode.unwrap_or(SessionToolMode::Full) {
        SessionToolMode::Readonly => ("readonly", json!(["tools:readonly"])),
        SessionToolMode::Full => ("full", json!("full")),
        SessionToolMode::Lead => ("lead", json!("full")),
    };
    header.insert("toolSpec".into(), tool_spec);
    header.insert("toolMode".into(), json!(mode));
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
    // `featureDeniedTools` is not written here: only the first turn's gate staging sets it (`stageToolAvailability`), so a
    // call to a switched-off tool before then is refused as unavailable in the session, as Node's exec recording shows.
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

/// The record fields `buildSessionRecord` (`session-record.mjs:121`), `sessionOriginFields` (`:57`) and
/// the store's save defaults (`store/serialize.mjs:111`) give a user's Lead that no option
/// decides: `sessionOptions` (`session-options.mjs:47`) with no `sessionProfile` makes it the
/// `lead` agent on the `cli` lane, owned by `cli`, source `main`, started by this process; the counters
/// begin at zero and the lifecycle at generation 0, open. `pid` is `process.pid`, which is both the
/// runtime's `mcpPid` and, with no session profile, the `clientHostPid`.
///
/// A key the header already holds (a caller allowlist) is left as it is. Not written here: the route's
/// fields (provider, model, windows, cache), the MCP scope (`NewThreadTools::seed` mints it and opens
/// it on the hub) and the title, which a first turn sets.
pub fn write_lead_record(header: &mut Header, now_ms: i64, pid: u32) {
    let lead_fields = [
        ("agent", json!("lead")),
        ("owner", json!("cli")),
        ("lane", json!("cli")),
        ("sourceName", json!("main")),
        ("clientHostPid", json!(pid)),
        ("mcpPid", json!(pid)),
        ("scopeKey", Value::Null),
        ("desktopSession", Value::Null),
        ("taskType", Value::Null),
        ("agentTag", Value::Null),
        ("permission", Value::Null),
        ("toolPermission", Value::Null),
        ("permissionMode", Value::Null),
        ("schemaAllowedTools", Value::Null),
        ("parentSessionId", Value::Null),
        ("ownerSessionId", Value::Null),
        ("visibility", Value::Null),
        ("profileId", Value::Null),
        ("skipInstructionFiles", json!(false)),
        ("providerCacheOptsOverride", json!(false)),
        // Resolved and pinned before the first request: null marks a session created under the per-model wire table.
        ("wireRoute", Value::Null),
        ("lastHeartbeatAt", Value::Null),
        ("lastUsedAt", json!(now_ms)),
        ("totalInputTokens", json!(0)),
        ("totalOutputTokens", json!(0)),
        ("totalToolCalls", json!(0)),
        ("tokensCumulative", json!(0)),
        ("generation", json!(0)),
        ("closed", json!(false)),
        // A coding Lead embeds no profile file, so its stamp is a constant (`agentProfileRevision`).
        ("agentProfileRevision", json!(CODING_LEAD_PROFILE_REVISION)),
    ];
    for (key, value) in lead_fields {
        header.entry(key).or_insert(value);
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

    /// Every narrowed-profile session Node recorded (`fixtures/tool-resolution/golden.json`) carries the allowlist of
    /// its profile; the one `write_header` persists is exactly that list, in that order.
    #[test]
    fn the_profile_allowlists_are_the_ones_node_recorded() {
        let golden: Value = mixdog_js::fixture_tools::parse_golden(include_str!("../../../../fixtures/tool-resolution/golden.json")).expect("golden");
        let mut seen = std::collections::BTreeMap::new();
        for case in golden["cases"].as_array().expect("cases") {
            let input = &case["input"];
            let profile = match input["toolProfile"].as_str() {
                Some("headless") => ToolProfile::Headless,
                Some("heartbeat") => ToolProfile::Heartbeat,
                _ => continue,
            };
            let recorded = input["schemaAllowedTools"].clone();
            assert_eq!(names(model_tool_allowlist(profile).expect("narrowed")), recorded, "{}", case["name"]);
            *seen.entry(input["toolProfile"].as_str().unwrap().to_owned()).or_insert(0) += 1;
        }
        assert_eq!(seen, [("headless".to_owned(), 8), ("heartbeat".to_owned(), 8)].into());
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
            Some("Error: tool \"web_search\" is not available in this session.")
        );
    }

    /// The record of a user's Lead (`create_goldens/lead.json`, recorded from Node's `sessionOptions`,
    /// `buildSessionRecord` and `sessionOriginFields` by `record.mjs`): every field it lists, but the
    /// roster stamp (the prompt's), is what `write_header` + `write_lead_record` leave in the header.
    #[test]
    fn a_lead_record_has_the_fields_node_gives_it() {
        const PID: u32 = 4242;
        const NOW: i64 = 1_700_000_000_000;
        let golden: Value = serde_json::from_str(include_str!("create_goldens/lead.json")).expect("golden");
        let mut header = Header::new();
        write_header(&ThreadSessionOptions::default(), &mut header);
        write_lead_record(&mut header, NOW, PID);
        for (key, expected) in golden["record"].as_object().expect("record") {
            match (key.as_str(), expected.as_str()) {
                ("agentRosterRevision", _) => assert!(header.get(key).is_none(), "{key} is the prompt's"),
                (_, Some("<pid>")) => assert_eq!(header[key.as_str()], json!(PID), "{key}"),
                (_, Some("<ts>")) => assert_eq!(header[key.as_str()], json!(NOW), "{key}"),
                _ => assert_eq!(&header[key.as_str()], expected, "{key}"),
            }
        }
    }

    #[test]
    fn a_lead_record_keeps_the_schema_allowlist_a_profile_wrote() {
        let mut header = Header::new();
        write_header(&headless(), &mut header);
        write_lead_record(&mut header, 1, 1);
        assert_eq!(header["schemaAllowedTools"], json!(HEADLESS_MODEL_TOOL_NAMES));
        assert_eq!(header["sourceType"], "exec");
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
