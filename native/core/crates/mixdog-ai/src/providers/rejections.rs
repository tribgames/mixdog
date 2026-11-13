//! The two deterministic 400s a changed request clears, typed at the adapter boundary so the agent loop reads a kind
//! and a field instead of a message:
//!
//! - a reasoning replay the API refuses to take back (`isThinkingReplayRejection`,
//!   session/thinking-replay-recovery.mjs) becomes [`ErrorKind::ReplayRejected`];
//! - a 400 that names one tool's input schema (`rejectedToolSchema`, session/tool-schema-rejection.mjs) becomes
//!   [`ErrorKind::ToolSchemaRejected`] with the tool's name in [`ProviderError::rejected_tool`].
//!
//! Node decides both in its loop from the error's text; the adapter holds the same text (the refusal's body) and the
//! tool list the request went out with, so the same decision is made here once.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use regex::Regex;
use serde_json::Value;

static REPLAY_MODIFIED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)blocks in the latest assistant message cannot be modified").expect("a valid pattern"));
static REPLAY_EMPTY_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)text content blocks must be non-empty").expect("a valid pattern"));

static ANTHROPIC_SCHEMA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\btools\.(\d+)\.(?:custom\.)?input_schema").expect("a valid pattern"));
static OPENAI_PARAMETERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\btools(?:\[(\d+)\]|\.(\d+))\.(?:function\.)?parameters").expect("a valid pattern"));
static GEMINI_DECLARATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:function_declarations|functionDeclarations)(?:\[(\d+)\]|\.(\d+))").expect("a valid pattern"));
static OPENAI_FUNCTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"Invalid schema for function ['"`]([^'"`]+)['"`]"#).expect("a valid pattern"));

/// `isThinkingReplayRejection`: the 400s a replay repair clears. "must start with a thinking block" is not one of them
/// (it asks for more reasoning replay, not less).
pub(crate) fn is_thinking_replay_rejection(status: Option<u16>, text: &str) -> bool {
    status == Some(400) && (REPLAY_MODIFIED.is_match(text) || REPLAY_EMPTY_TEXT.is_match(text))
}

/// Types `err` as [`ErrorKind::ReplayRejected`] when its status and message are a thinking-replay refusal.
pub(crate) fn mark_replay_rejection(err: &mut ProviderError) {
    if is_thinking_replay_rejection(err.status, &err.message) {
        err.kind = ErrorKind::ReplayRejected;
    }
}

/// Which tool one piece of evidence names (`target`): a position in the request's tool list, or a function name.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Index(usize),
    Name(String),
}

fn index_of(captures: &regex::Captures<'_>) -> Option<Target> {
    let digits = captures.get(1).or_else(|| captures.get(2))?;
    digits.as_str().parse().ok().map(Target::Index)
}

/// `target`, in Node's order: Anthropic `tools.3.custom.input_schema`, OpenAI `tools[3].parameters`, Gemini
/// `function_declarations[3]`, then OpenAI `Invalid schema for function 'x'`.
pub(crate) fn target(entry: &str) -> Option<Target> {
    for pattern in [&*ANTHROPIC_SCHEMA, &*OPENAI_PARAMETERS, &*GEMINI_DECLARATION] {
        if let Some(found) = pattern.captures(entry) {
            return index_of(&found);
        }
    }
    OPENAI_FUNCTION.captures(entry).map(|found| Target::Name(found[1].to_owned()))
}

/// `evidence`: the places a refusal names its field, best first: `param` (also under `error`), the body's messages,
/// Google's `details[].fieldViolations[]`, the body's text, then the error's own message.
fn evidence(body: &[u8], message: &str) -> Vec<String> {
    let text = String::from_utf8_lossy(body);
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let string = |value: Option<&Value>| value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let mut entries: Vec<Option<String>> = vec![
        string(parsed.get("param")),
        string(parsed.pointer("/error/param")),
        string(parsed.pointer("/error/message")),
        string(parsed.get("message")),
    ];
    for details in [parsed.get("details"), parsed.pointer("/error/details")] {
        for violation in details
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|detail| detail.get("fieldViolations").and_then(Value::as_array))
            .flatten()
        {
            entries.push(string(violation.get("field")));
            entries.push(string(violation.get("description")));
        }
    }
    if parsed.is_null() && !text.is_empty() {
        entries.push(Some(text.into_owned()));
    }
    entries.push(Some(message.to_owned()).filter(|m| !m.is_empty()));
    entries.into_iter().flatten().collect()
}

/// The names of a request body's `tools`, in wire order: a function's own name (`name`, or Chat Completions'
/// `function.name`), `None` for an entry that has none (a hosted tool). A Gemini body's declarations are flattened in
/// order (`tools[].functionDeclarations[]`). The index a refusal states is an index into this list, so the hosted tools
/// Node offsets by (`shifted`) are already in their place.
pub(crate) fn wire_tool_names(body: &[u8]) -> Vec<Option<String>> {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let name = |tool: &Value| {
        tool.get("name").or_else(|| tool.pointer("/function/name")).and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_owned)
    };
    let tools = parsed.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    let declared =
        |tool: &Value| tool.get("functionDeclarations").or_else(|| tool.get("function_declarations")).and_then(Value::as_array).cloned();
    if tools.iter().any(|tool| declared(tool).is_some()) {
        return tools.iter().filter_map(declared).flatten().map(|declaration| name(&declaration)).collect();
    }
    tools.iter().map(name).collect()
}

/// `rejectedToolSchema`: types a 400 that names one of the request's tools as [`ErrorKind::ToolSchemaRejected`] and
/// records the tool. `refusal` is the response body, `tools` the request's tools in wire order ([`wire_tool_names`]).
/// Any other error, and a 400 that names no tool of the request, is left as it was.
pub(crate) fn mark_tool_schema(err: &mut ProviderError, refusal: &[u8], tools: &[Option<String>]) {
    if err.status != Some(400) {
        return;
    }
    for entry in evidence(refusal, &err.message) {
        let named = match target(&entry) {
            Some(Target::Index(index)) => tools.get(index).cloned().flatten(),
            Some(Target::Name(name)) => tools.iter().flatten().find(|tool| **tool == name).cloned(),
            None => continue,
        };
        if let Some(name) = named {
            err.kind = ErrorKind::ToolSchemaRejected;
            err.rejected_tool = Some(name.into_boxed_str());
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::DeliveryState;
    use serde_json::json;

    use super::*;

    fn refused(status: u16, message: &str) -> ProviderError {
        let mut err = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
        err.status = Some(status);
        err.message = message.to_owned();
        err
    }

    /// `isThinkingReplayRejection` (thinking-replay-recovery.mjs:29-37): status 400 and one of the two texts, in any
    /// case; "must start with a thinking block" and every other status stay as they are.
    #[test]
    fn the_two_replay_refusals_are_typed_and_nothing_else_is() {
        for text in [
            "messages.3.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
            "messages: Text Content Blocks Must Be Non-Empty",
        ] {
            let mut err = refused(400, text);
            mark_replay_rejection(&mut err);
            assert_eq!(err.kind, ErrorKind::ReplayRejected, "{text}");
            let mut other = refused(500, text);
            mark_replay_rejection(&mut other);
            assert_eq!(other.kind, ErrorKind::InvalidRequest, "a 500 is not a replay refusal");
        }
        let mut more = refused(400, "Expected `thinking` or `redacted_thinking`: the final assistant message must start with a thinking block");
        mark_replay_rejection(&mut more);
        assert_eq!(more.kind, ErrorKind::InvalidRequest);
    }

    /// `target` (tool-schema-rejection.mjs:44-54), one entry per wire shape.
    #[test]
    fn each_wire_names_its_tool_as_node_reads_it() {
        assert_eq!(target("tools.3.custom.input_schema: JSON schema is invalid"), Some(Target::Index(3)));
        assert_eq!(target("tools.0.input_schema: bad"), Some(Target::Index(0)));
        assert_eq!(target("tools[2].parameters"), Some(Target::Index(2)));
        assert_eq!(target("tools.4.function.parameters"), Some(Target::Index(4)));
        assert_eq!(target("request.tools[0].function_declarations[1].parameters"), Some(Target::Index(1)));
        assert_eq!(target("tools.0.functionDeclarations.5"), Some(Target::Index(5)));
        assert_eq!(target("Invalid schema for function 'echo': bad"), Some(Target::Name("echo".into())));
        assert_eq!(target("the model does not exist"), None);
    }

    #[test]
    fn a_400_naming_a_request_tool_is_typed_with_its_name() {
        let anthropic = serde_json::to_vec(&json!({ "tools": [{ "name": "read" }, { "name": "echo" }] })).unwrap();
        let body = br#"{"type":"error","error":{"type":"invalid_request_error","message":"tools.1.custom.input_schema: JSON schema is invalid"}}"#;
        let mut err = refused(400, "Anthropic API 400: tools.1.custom.input_schema: JSON schema is invalid");
        mark_tool_schema(&mut err, body, &wire_tool_names(&anthropic));
        assert_eq!((err.kind, err.rejected_tool.as_deref()), (ErrorKind::ToolSchemaRejected, Some("echo")));

        // A Responses body lists its hosted tools first: the stated index is the wire's own.
        let responses = serde_json::to_vec(&json!({ "tools": [{ "type": "web_search" }, { "type": "function", "name": "echo" }] })).unwrap();
        let body = br#"{"error":{"message":"Invalid schema","param":"tools[1].parameters","code":"invalid_function_parameters"}}"#;
        let mut err = refused(400, "x");
        mark_tool_schema(&mut err, body, &wire_tool_names(&responses));
        assert_eq!(err.rejected_tool.as_deref(), Some("echo"));

        // Chat Completions nests the name; the function is named in the message.
        let chat = serde_json::to_vec(&json!({ "tools": [{ "type": "function", "function": { "name": "echo" } }] })).unwrap();
        let body = br#"{"error":{"message":"Invalid schema for function 'echo': 'object' is not valid"}}"#;
        let mut err = refused(400, "x");
        mark_tool_schema(&mut err, body, &wire_tool_names(&chat));
        assert_eq!(err.rejected_tool.as_deref(), Some("echo"));

        let gemini = serde_json::to_vec(&json!({ "tools": [{ "functionDeclarations": [{ "name": "read" }, { "name": "echo" }] }] })).unwrap();
        let body = br#"{"error":{"code":400,"message":"Invalid JSON payload","details":[{"fieldViolations":[{"field":"tools[0].function_declarations[1].parameters","description":"bad"}]}]}}"#;
        let mut err = refused(400, "x");
        mark_tool_schema(&mut err, body, &wire_tool_names(&gemini));
        assert_eq!(err.rejected_tool.as_deref(), Some("echo"));
    }

    /// `rejectedToolSchema` returns null for another status, an index outside the request and a hosted tool.
    #[test]
    fn other_refusals_stay_as_they_were() {
        let tools = vec![None, Some("echo".to_owned())];
        for (status, text) in [(500, "tools.1.custom.input_schema"), (400, "tools.7.custom.input_schema"), (400, "tools.0.custom.input_schema"), (400, "bad request")] {
            let mut err = refused(status, text);
            mark_tool_schema(&mut err, b"", &tools);
            assert_eq!((err.kind, err.rejected_tool.as_deref()), (ErrorKind::InvalidRequest, None), "{status} {text}");
        }
    }
}
