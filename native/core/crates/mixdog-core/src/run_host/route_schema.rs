//! `routeToolExclusionReason(session, tool)`'s schema rule (Node `session/loop/provider-tool-
//! exclusions.mjs`): whether the route's wire would leave a tool out of every request because it
//! cannot accept its input schema, decided from the schema alone, before the tool was ever sent.
//!
//! Ported for the OpenAI family (Responses, Codex and every OpenAI-compatible chat route), which
//! is the validation `mixdog_ai::providers::compat::schema` already runs on that wire. The other
//! families need pieces nothing in Rust has yet and report [`Verdict::Unported`] instead of a
//! guess: `gemini` (`geminiAcceptedTools`, `gemini-schema.mjs`), `anthropic` (the compound-schema
//! flattening `sanitizeAnthropicInputSchema` and the nested-union registry `actionInputUnionFor`)
//! and `antigravity-claude` (the same registry).

use mixdog_ai::providers::compat::schema::Rule;
use mixdog_ai::providers::compat::schema::wire_input_schema;
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
    /// The route's family has no Rust port of its schema rule yet.
    Unported(&'static str),
}

/// `isResponsesFreeformTool`.
fn freeform(tool: &Value) -> bool {
    let Some(grammar) = tool.get("freeform").filter(|f| f.is_object()) else { return false };
    grammar.get("type").and_then(Value::as_str) == Some("grammar") && grammar.get("syntax").is_some_and(Value::is_string) && grammar.get("definition").is_some_and(Value::is_string)
}

/// `schemaExclusion(session, routeSchemaFamily(session), tool)` as the model-facing text.
pub fn schema_verdict(header: &Header, tool: &Value) -> Verdict {
    match route_schema_family(header) {
        "openai" => {}
        family => return Verdict::Unported(family),
    }
    // `tool.inputSchema == null`: no schema, nothing to validate.
    let Some(schema) = tool.get("inputSchema").filter(|s| !s.is_null()) else { return Verdict::Sent };
    let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
    if matches!(provider, "openai" | "openai-oauth") && freeform(tool) {
        return Verdict::Sent;
    }
    match wire_input_schema(schema, Rule::OpenAi) {
        Ok(_) => Verdict::Sent,
        Err(problem) => Verdict::Excluded(
            ExcludedTool {
                name: tool.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                pointer: problem.pointer,
                reason: problem.reason,
            }
            .unavailable_text(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `routeToolExclusionReason` on these routes and tools
    /// (`fixtures/tool-pool/route-schema.json`): the OpenAI family answers as Node does, every
    /// other family says it is not ported.
    #[test]
    fn the_openai_wire_leaves_out_the_tools_node_leaves_out() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/tool-pool/route-schema.json")).expect("fixture");
        let tools = golden["tools"].as_array().expect("tools");
        for session in golden["sessions"].as_array().expect("sessions") {
            let header: Header = session["session"].as_object().expect("session").clone();
            let family = route_schema_family(&header);
            for (tool, want) in tools.iter().zip(session["tools"].as_array().expect("answers")) {
                let got = schema_verdict(&header, tool);
                let expected = match (family, want["reason"].as_str()) {
                    ("openai", Some(reason)) => Verdict::Excluded(reason.to_owned()),
                    ("openai", None) => Verdict::Sent,
                    (other, _) => Verdict::Unported(other),
                };
                assert_eq!(got, expected, "{} / {}", session["name"], tool["name"]);
            }
        }
        // The families really are the ones the golden names.
        let families: Vec<&str> = golden["sessions"].as_array().expect("sessions").iter().map(|s| route_schema_family(s["session"].as_object().expect("session"))).collect();
        assert_eq!(families, ["openai", "openai", "openai", "anthropic", "anthropic", "gemini", "antigravity-claude"]);
    }
}
