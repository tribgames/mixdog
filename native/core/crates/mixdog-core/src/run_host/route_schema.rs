//! `routeToolExclusionReason(session, tool)`'s schema rule (Node `session/loop/provider-tool-
//! exclusions.mjs`): whether the route's wire would leave a tool out of every request because it
//! cannot accept its input schema, decided from the schema alone, before the tool was ever sent.
//!
//! The rule of each wire family is the one its adapter applies when it builds a request, so the
//! answer here and the tools a request leaves out are the same decision, worded as Node words it
//! (Ajv's text, V8's for a bad `pattern`, see `mixdog_ai::providers::compat::ajv_meta`):
//! `openai` (Responses, Codex and every OpenAI-compatible chat route) is
//! `compat::schema::wire_input_schema`, `gemini` is `geminiToolExclusion`, `anthropic` is
//! `anthropicToolExclusion` and `antigravity-claude` is the Claude bridge's rule
//! (`claudeBridgeInputSchema` over `actionInputUnionFor`).

use mixdog_ai::providers::anthropic::anthropic_tool_exclusion;
use mixdog_ai::providers::compat::schema::Rule;
use mixdog_ai::providers::compat::schema::wire_input_schema;
use mixdog_ai::providers::google::tool_accept::claude_bridge_tool_exclusion;
use mixdog_ai::providers::google::tool_accept::gemini_schema_exclusion;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_session::session::ExcludedTool;
use mixdog_core_session::session::route_schema_family;
use mixdog_store::schema::record::Header;
use serde_json::Value;

#[derive(PartialEq, Eq, Debug)]
pub enum Verdict {
    /// The wire sends the tool.
    Sent,
    /// The wire leaves it out; the text is what a call to it is answered with.
    Excluded(String),
}

/// `isResponsesFreeformTool`.
fn freeform(tool: &Value) -> bool {
    let Some(grammar) = tool.get("freeform").filter(|f| f.is_object()) else { return false };
    grammar.get("type").and_then(Value::as_str) == Some("grammar") && grammar.get("syntax").is_some_and(Value::is_string) && grammar.get("definition").is_some_and(Value::is_string)
}

/// `schemaExclusion(session, routeSchemaFamily(session), tool)` as the model-facing text.
pub fn schema_verdict(header: &Header, tool: &Value) -> Verdict {
    let name = tool.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
    let family = route_schema_family(header);
    let definition = ToolDefinition {
        name: name.clone(),
        description: tool.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
        input_schema: tool.get("inputSchema").cloned().unwrap_or(Value::Null),
        defer_loading: false,
        freeform: None,
    };
    // `{ name, pointer, reason }`: where the wire's rule refuses the tool's schema, if it does.
    // Gemini tells an absent `inputSchema` (the tool is sent without one) from an explicit null
    // (refused as a non-object), so it takes the tool's value as it is held.
    let found = match family {
        "gemini" => gemini_schema_exclusion(&name, tool.get("inputSchema")).map(|e| (e.pointer, e.reason)),
        "anthropic" => {
            // `String(session?.provider || 'anthropic').toLowerCase()`.
            let provider = if provider.is_empty() { "anthropic".to_owned() } else { provider.to_lowercase() };
            anthropic_tool_exclusion(&definition, &provider).map(|e| (e.pointer, e.reason))
        }
        "antigravity-claude" => claude_bridge_tool_exclusion(&definition).map(|e| (e.pointer, e.reason)),
        _ => {
            // `tool.inputSchema == null`: no schema, nothing to validate.
            let Some(schema) = tool.get("inputSchema").filter(|s| !s.is_null()) else { return Verdict::Sent };
            if matches!(provider, "openai" | "openai-oauth") && freeform(tool) {
                return Verdict::Sent;
            }
            wire_input_schema(schema, Rule::OpenAi).err().map(|problem| (problem.pointer, problem.reason))
        }
    };
    match found {
        None => Verdict::Sent,
        Some((pointer, reason)) => Verdict::Excluded(ExcludedTool { name, pointer, reason }.unavailable_text()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `routeToolExclusionReason` on these routes and tools
    /// (`fixtures/tool-pool/route-schema.json`), whole text: every family answers as Node does,
    /// including Ajv's wording of a schema the 2020-12 meta-schema refuses (`unknown_type`).
    #[test]
    fn every_wire_leaves_out_the_tools_node_leaves_out() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/tool-pool/route-schema.json")).expect("fixture");
        let tools = golden["tools"].as_array().expect("tools");
        for session in golden["sessions"].as_array().expect("sessions") {
            let header: Header = session["session"].as_object().expect("session").clone();
            for (tool, want) in tools.iter().zip(session["tools"].as_array().expect("answers")) {
                let got = schema_verdict(&header, tool);
                let expected = match want["reason"].as_str() {
                    Some(reason) => Verdict::Excluded(reason.to_owned()),
                    None => Verdict::Sent,
                };
                assert_eq!(got, expected, "{} / {}", session["name"], tool["name"]);
            }
        }
        // The families really are the ones the golden names.
        let families: Vec<&str> = golden["sessions"].as_array().expect("sessions").iter().map(|s| route_schema_family(s["session"].as_object().expect("session"))).collect();
        assert_eq!(families, ["openai", "openai", "openai", "anthropic", "anthropic", "gemini", "antigravity-claude"]);
    }
}
