//! Plumbing shared by the orchestration, state and desktop tool front ends: embedded tool
//! definitions, the one mapping from a port failure to a typed tool error, and the argument
//! readers every front end uses.

use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolGroup;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use serde_json::Value;

/// Builds a [`ToolSpec`] from an embedded definition document (`defs/<tool>.json`: name, title,
/// trigger, description, annotations, inputSchema), generated from the live tool-definition
/// modules. Every hint is the definition's own: a hint it does not state stays unset.
pub(crate) fn spec_from_def(
    def: &'static str,
    parallel_safe: bool,
    exclusive_with: &[&str],
) -> ToolSpec {
    let doc: Value = serde_json::from_str(def).expect("embedded tool definition is valid JSON");
    let hints = &doc["annotations"];
    let flag = |key: &str| hints.get(key).and_then(Value::as_bool);
    ToolSpec {
        name: doc["name"].as_str().unwrap_or_default().to_owned(),
        title: doc.get("title").and_then(Value::as_str).map(str::to_owned),
        trigger: doc.get("trigger").and_then(Value::as_str).map(str::to_owned),
        public: doc.get("public") != Some(&Value::Bool(false)),
        aliases: Vec::new(),
        description: doc["description"].as_str().unwrap_or_default().to_owned(),
        input_schema: doc["inputSchema"].clone(),
        annotations: ToolAnnotations {
            title: hints.get("title").and_then(Value::as_str).map(str::to_owned),
            read_only_hint: flag("readOnlyHint"),
            destructive_hint: flag("destructiveHint"),
            idempotent_hint: flag("idempotentHint"),
            open_world_hint: flag("openWorldHint"),
            compressible: flag("compressible"),
            compressible_lossless: flag("compressibleLossless"),
            agent_hidden: flag("agentHidden"),
        },
        parallel_safe,
        exclusive_with: exclusive_with
            .iter()
            .map(|group| ToolGroup((*group).to_owned()))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    /// Every embedded definition is Node's definition object, key for key
    /// (`fixtures/tool-defs/definitions.json`, `record-tool-definitions.mjs`): title, trigger,
    /// description, inputSchema and every hint as the definition states it, `idempotentHint` and an
    /// explicit `agentHidden: false` included (`ask_user` reads read-only but not idempotent).
    #[test]
    fn the_embedded_definitions_are_nodes_definitions() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/tool-defs/definitions.json")).expect("the golden is JSON");
        let nodes = golden["definitions"].as_array().expect("definitions");
        let defs: [&'static str; 22] = [
            include_str!("defs/memory.json"), include_str!("defs/recall.json"),
            include_str!("defs/agent.json"), include_str!("defs/call_tool.json"), include_str!("defs/explore.json"),
            include_str!("defs/load_tool.json"), include_str!("defs/media.json"), include_str!("defs/office.json"),
            include_str!("defs/session.json"), include_str!("defs/setup.json"), include_str!("defs/Skill.json"),
            include_str!("defs/tidy.json"), include_str!("../state/defs/ask_user.json"), include_str!("../state/defs/goal.json"),
            include_str!("../state/defs/handoff_user.json"), include_str!("../state/defs/react.json"), include_str!("../state/defs/todo.json"),
            include_str!("../desktop/defs/browser.json"), include_str!("../desktop/defs/browser_devtools.json"),
            include_str!("../desktop/defs/computer.json"), include_str!("../desktop/defs/terminal.json"), include_str!("../desktop/defs/visualize.json"),
        ];
        for def in defs {
            let spec = super::spec_from_def(def, false, &[]);
            let node = nodes.iter().find(|node| node["name"] == spec.name.as_str()).expect("a Node definition");
            let got = spec.definition();
            assert_eq!(&got, node, "{}", spec.name);
            assert_eq!(got["annotations"].to_string(), node["annotations"].to_string(), "{} annotations", spec.name);
        }
        let ask = defs.iter().map(|def| super::spec_from_def(def, false, &[])).find(|spec| spec.name == "ask_user").expect("ask_user");
        assert_eq!((ask.annotations.read_only_hint, ask.annotations.idempotent_hint, ask.annotations.agent_hidden), (Some(true), Some(false), Some(true)));
    }

    #[test]
    fn the_hints_the_sandbox_reads_are_the_definitions_own() {
        let defs: [&'static str; 22] = [
            include_str!("defs/memory.json"), include_str!("defs/recall.json"),
            include_str!("defs/agent.json"), include_str!("defs/call_tool.json"), include_str!("defs/explore.json"),
            include_str!("defs/load_tool.json"), include_str!("defs/media.json"), include_str!("defs/office.json"),
            include_str!("defs/session.json"), include_str!("defs/setup.json"), include_str!("defs/Skill.json"),
            include_str!("defs/tidy.json"), include_str!("../state/defs/ask_user.json"), include_str!("../state/defs/goal.json"),
            include_str!("../state/defs/handoff_user.json"), include_str!("../state/defs/react.json"), include_str!("../state/defs/todo.json"),
            include_str!("../desktop/defs/browser.json"), include_str!("../desktop/defs/browser_devtools.json"),
            include_str!("../desktop/defs/computer.json"), include_str!("../desktop/defs/terminal.json"), include_str!("../desktop/defs/visualize.json"),
        ];
        for def in defs {
            let spec = super::spec_from_def(def, false, &[]);
            // Policy flags, as in the Node snapshot (`tool-schemas.json`): the sandbox reads
            // `agentHidden` and `readOnlyHint` from here.
            let (hidden, read_only) = match spec.name.as_str() {
                "load_tool" | "ask_user" | "handoff_user" => (Some(true), Some(true)),
                "call_tool" | "session" | "goal" | "react" | "setup" => (Some(true), Some(false)),
                "Skill" => (Some(false), Some(true)),
                "todo" | "agent" => (Some(false), Some(false)),
                "explore" | "recall" => (None, Some(true)),
                "memory" => (None, Some(false)),
                _ => continue,
            };
            assert_eq!(read_only, spec.annotations.read_only_hint, "{} readOnlyHint", spec.name);
            if let Some(hidden) = hidden {
                assert_eq!(Some(hidden), spec.annotations.agent_hidden, "{} agentHidden", spec.name);
            }
        }
    }
}
/// A failure reported by a port (the session, agent, catalog, host and service seams a tool
/// front end sits on). Mapped to a typed [`ToolError`] in exactly one place.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PortError {
    /// The request itself is malformed for the owner of the operation.
    Invalid { field: String, reason: String },
    /// The caller is not allowed to do this from here (surface, ownership).
    Denied(String),
    /// A rule refuses it.
    Refused { rule: String, message: String },
    /// A capability is missing on this machine or in this session.
    Unavailable { capability: String, message: String },
    NotFound { target: String, message: String },
    /// The operation ran and failed; `capability` names what could not complete it.
    Failed { capability: String, message: String },
    Cancelled,
}

impl From<PortError> for ToolError {
    fn from(error: PortError) -> Self {
        match error {
            PortError::Invalid { field, reason } => invalid(&field, reason),
            PortError::Denied(message) => denied(message),
            PortError::Refused { rule, message } => refused(rule, message),
            PortError::Unavailable {
                capability,
                message,
            } => unavailable(capability, message),
            PortError::NotFound { target, message } => ToolError::new(ToolErrorCode::NotFound { target }, message),
            PortError::Failed { capability, message } => action_failed(capability, message),
            PortError::Cancelled => ToolError::new(ToolErrorCode::Cancelled, "cancelled"),
        }
    }
}

// Model text of an error is the tool's existing wording without the `Error:` lead-in: the
// pipeline marks failure with the typed code, not with a prefix.

pub(crate) fn invalid(field: &str, reason: impl Into<String>) -> ToolError {
    let reason = reason.into();
    ToolError::new(
        ToolErrorCode::InvalidArgs {
            field: field.to_owned(),
            reason: reason.clone(),
        },
        reason,
    )
}

pub(crate) fn denied(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::PermissionDenied, message)
}

pub(crate) fn refused(rule: impl Into<String>, message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::DeniedByPolicy { rule: rule.into() }, message)
}

pub(crate) fn unavailable(capability: impl Into<String>, message: impl Into<String>) -> ToolError {
    let message = message.into();
    ToolError::new(
        ToolErrorCode::Unavailable {
            capability: capability.into(),
            reason: message.clone(),
        },
        message,
    )
}

/// An operation that ran and failed for a reason of its own (not a core defect, not a missing
/// capability), with the existing wording.
pub(crate) fn action_failed(_capability: impl Into<String>, message: impl Into<String>) -> ToolError {
    let message = message.into();
    ToolError::new(ToolErrorCode::Failed { reason: message.clone() }, message)
}

pub(crate) fn not_found(target: &str, message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::NotFound { target: target.to_owned() }, message)
}

pub(crate) fn cancelled() -> ToolError {
    ToolError::new(ToolErrorCode::Cancelled, "cancelled")
}

pub(crate) fn text_output(text: impl Into<String>) -> ToolOutput {
    ToolOutput {
        parts: vec![ToolPart::Text(text.into())],
        ..ToolOutput::default()
    }
}

pub(crate) fn text(text: impl Into<String>) -> ToolOutcome {
    Ok(text_output(text))
}

/// The JavaScript string operations a port must not do with Rust's `str::trim` (which trims a
/// different set of characters) or `chars().count()` (code points, not UTF-16 units).
pub(crate) trait JsStr {
    fn js_trim(&self) -> &str;
    fn js_trim_start(&self) -> &str;
    fn js_trim_end(&self) -> &str;
    /// `value.length`.
    fn js_len(&self) -> usize;
}

impl JsStr for str {
    fn js_trim(&self) -> &str {
        mixdog_js::js_trim(self)
    }

    fn js_trim_start(&self) -> &str {
        mixdog_js::js_trim_start(self)
    }

    fn js_trim_end(&self) -> &str {
        mixdog_js::js_trim_end(self)
    }

    fn js_len(&self) -> usize {
        mixdog_js::utf16_len(self)
    }
}

/// JS `String(value ?? '').trim()` for the scalar shapes a schema-validated argument takes.
pub(crate) fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => mixdog_js::js_trim(s).to_owned(),
        Some(other) => mixdog_js::js_trim(&other.to_string()).to_owned(),
    }
}

pub(crate) fn field(args: &Value, key: &str) -> String {
    clean(args.get(key))
}

/// Whitespace runs collapsed to one space and trimmed (JS `\s+` → ' ').
pub(crate) fn one_line(value: &str) -> String {
    value
        .split(mixdog_js::is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Pretty JSON with two-space indent, as `JSON.stringify(value, null, 2)`.
pub(crate) fn pretty<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string_pretty(value).expect("in-memory values serialize")
}

pub(crate) fn compact<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("in-memory values serialize")
}

/// The arguments as an object; the pipeline already validated them against the schema.
pub(crate) fn object(args: &Value) -> Result<&serde_json::Map<String, Value>, ToolError> {
    args.as_object()
        .ok_or_else(|| invalid("", "arguments must be an object"))
}
