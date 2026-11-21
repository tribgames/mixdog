use std::path::Path;
use std::path::PathBuf;
use std::sync::LazyLock;

use mixdog_core_prompt::prompt::source_files::LiveFiles;
use mixdog_core_prompt::prompt::source_files::PromptFiles;
use mixdog_js::{JsRegex, js_trim};
use serde_json::Value;

use super::tool_pool::model_surface::workflow_disallows_agent_tool;
use super::tool_surface::unused_model_edit_tool_name;
use mixdog_core_config::config::hidden_agents::hidden_agents;
use mixdog_store::agent_mode::session_mode_of;

static FRONTMATTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)", ""));
static FRONTMATTER_STRIP: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)", ""));
static LINE_BREAK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\r?\n", ""));
static TOOL_MARKER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[ \t]*<!--[ \t]*tools:[ \t]*([^>]*?)[ \t]*-->[ \t]*$", ""));
static FIRST_NON_SPACE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\S", ""));
static TRAILING_BLANKS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[ \t]+\n", "g"));
static BLANK_RUNS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\n{3,}", "g"));
static KEY_VALUE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$", ""));
static QUOTE_EDGES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"^['"]|['"]$"#, "g"));
static LEAD_IDENTITY_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^- (You are Mixdog, a coding agent\.)\n", "m"));
static LEAD_PROGRESS_PASSAGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r" (Before your first tool call, briefly state[\s\S]*?narration or plan repeats\.)", ""));
static LEAD_REPORT_PASSAGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r" (On\s+an\s+agent\s+report[\s\S]*?never\s+report\s+it\s+as\s+done\.)", ""));

const AGENT_MODE_PROGRESS: &str = "- Just answer conversation. Quick tool use (checking memory, a lookup,\n  leaving a reaction) needs no announcement. When starting longer work\n  (research, delegation, multi-step tasks), say in one line what you are\n  doing, stay quiet between tool calls, and share the result when it\n  finishes.";
const AGENT_MODE_REPORT: &str = "- Relay agent reports faithfully. Code: one fresh Reviewer per non-trivial\n  feature after its last worker, any author (Lead if none); docs/copy/style:\n  read the diff. Recheck only concrete fixes, never rerun passing checks\n  without new evidence; at request end check feature seams.";

/// `readOptional`: the trimmed file, `""` when it cannot be read.
pub(super) fn read_optional(files: &dyn PromptFiles, path: &Path) -> String {
    files.read(path).map(|bytes| js_trim(&String::from_utf8_lossy(&bytes)).to_owned()).unwrap_or_default()
}

/// The file names of `dir` that are valid UTF-8, in listing order; `None` when the directory is unreadable.
pub(super) fn file_names(files: &dyn PromptFiles, dir: &Path) -> Option<Vec<String>> {
    Some(files.entries(dir)?.into_iter().filter_map(|e| e.name.into_string().ok()).collect())
}

/// The `.md` file names of `dir`, sorted; `None` when the directory is unreadable.
fn markdown_names(files: &dyn PromptFiles, dir: &Path) -> Option<Vec<String>> {
    let mut names: Vec<String> = file_names(files, dir)?.into_iter().filter(|n| n.ends_with(".md")).collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Some(names)
}

/// `readMarkdownDirectory`.
fn read_markdown_directory(files: &dyn PromptFiles, dir: &Path) -> String {
    let Some(names) = markdown_names(files, dir) else { return String::new() };
    names.iter().map(|n| read_optional(files, &dir.join(n))).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// Reads, through `files`, the rule files [`build_base_rules`] asks for.
pub fn read_base_rule_files(files: &dyn PromptFiles, plugin_root: &Path) {
    let rules = plugin_root.join("rules");
    for dir in [rules.join("shared"), rules.join("routes")] {
        for name in markdown_names(files, &dir).unwrap_or_default() {
            files.read(&dir.join(name));
        }
    }
}

/// The file [`build_lead_role_content`] reads.
pub fn lead_role_file(plugin_root: &Path) -> PathBuf {
    plugin_root.join("rules").join("lead").join("LEAD.md")
}

/// The file [`build_agent_mode_content`] reads for `part`; an unknown name reads as `conduct`.
pub fn agent_mode_file(plugin_root: &Path, part: &str) -> PathBuf {
    plugin_root.join("rules").join("agent-mode").join(if part == "mixy" { "MIXY.md" } else { "AGENT_MODE.md" })
}

/// The file [`build_agent_role_content`] reads.
pub fn agent_role_file(plugin_root: &Path) -> PathBuf {
    plugin_root.join("rules").join("agent").join("AGENT.md")
}

/// `stripFrontmatter`.
pub(super) fn strip_frontmatter(markdown: &str) -> String {
    let stripped = match FRONTMATTER_STRIP.find(markdown) {
        Some(range) => &markdown[range.end..],
        None => markdown,
    };
    js_trim(stripped).to_owned()
}

pub(super) fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut from = 0;
    for range in LINE_BREAK.find_iter(text) {
        lines.push(&text[from..range.start]);
        from = range.end;
    }
    lines.push(&text[from..]);
    lines
}

/// `markerTools`: the tools a `<!-- tools: … -->` line names, `None` for any other line.
fn marker_tools(line: &str) -> Option<Vec<String>> {
    let caps = TOOL_MARKER.captures(line)?;
    Some(caps.get(1).unwrap_or_default().split(',').map(|n| js_trim(n).to_lowercase()).filter(|n| !n.is_empty()).collect())
}

/// `lines[start].search(/\S/)`.
fn indent_of(line: &str) -> Option<usize> {
    FIRST_NON_SPACE.find(line).map(|r| r.start)
}

fn marked_block_end(lines: &[&str], start: usize) -> usize {
    let indent = indent_of(lines[start]);
    let mut end = start + 1;
    while end < lines.len() {
        let line = lines[end];
        if js_trim(line).is_empty() || marker_tools(line).is_some() {
            break;
        }
        // `search` answers -1 for a blank line, which the check above already ended on.
        if indent_of(line) <= indent {
            break;
        }
        end += 1;
    }
    end
}

/// `String(name || '').toLowerCase()` over a JSON element.
fn lowered(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::String(s) => s.to_lowercase(),
        Value::Number(n) if n.as_f64() == Some(0.0) => String::new(),
        other => mixdog_js::value_to_string(other).to_lowercase(),
    }
}

fn key_set(names: &[String]) -> std::collections::HashSet<String> {
    names.iter().map(|n| n.to_lowercase()).filter(|n| !n.is_empty()).collect()
}

/// `omitToolRoutes`: drops the marked blocks none of whose tools the session may call.
pub fn omit_tool_routes(text: &str, omit_tools: &[String], allow_tools: Option<&[String]>, owner_is_agent: bool) -> String {
    let deny = key_set(omit_tools);
    let allow = allow_tools.map(key_set);
    let permitted = |name: &str| if name == "lead" { !owner_is_agent } else { !deny.contains(name) && allow.as_ref().is_none_or(|a| a.contains(name)) };
    let lines = split_lines(text);
    let mut kept: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let Some(tools) = marker_tools(lines[index]) else {
            kept.push(lines[index]);
            index += 1;
            continue;
        };
        index += 1;
        if index >= lines.len() {
            break;
        }
        let end = marked_block_end(&lines, index);
        if tools.is_empty() || tools.iter().any(|t| permitted(t)) {
            kept.extend_from_slice(&lines[index..end]);
        }
        index = end;
    }
    let joined = kept.join("\n");
    let joined = TRAILING_BLANKS.replace_all_with(&joined, |_| "\n".to_owned());
    let joined = BLANK_RUNS.replace_all_with(&joined, |_| "\n\n".to_owned());
    js_trim(&joined).to_owned()
}

/// `buildSharedToolContent`.
pub fn build_shared_tool_content(
    files: &dyn PromptFiles,
    plugin_root: &Path,
    omit_tools: &[String],
    allow_tools: Option<&[String]>,
    owner_is_agent: bool,
) -> String {
    omit_tool_routes(&read_markdown_directory(files, &plugin_root.join("rules").join("shared")), omit_tools, allow_tools, owner_is_agent)
}

/// `parseRouteFrontmatter`: lower-cased keys to raw values.
fn parse_route_frontmatter(markdown: &str) -> Vec<(String, String)> {
    let Some(caps) = FRONTMATTER.captures(markdown) else { return Vec::new() };
    let block = caps.get(1).unwrap_or_default();
    split_lines(block)
        .into_iter()
        .filter_map(|line| {
            let kv = KEY_VALUE.captures(line)?;
            Some((kv.get(1)?.to_lowercase(), kv.get(2).unwrap_or_default().to_owned()))
        })
        .collect()
}

/// `routeList`.
fn route_list(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(|item| {
            let item = js_trim(item);
            QUOTE_EDGES.replace_all_with(item, |_| String::new()).to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// `routePatternMatches`: `*` is any run of characters, the rest is literal.
fn route_pattern_matches(pattern: &str, value: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if parts.len() == 1 {
        return pattern == value;
    }
    let Some(mut rest) = value.strip_prefix(first) else { return false };
    let Some(tail_free) = rest.len().checked_sub(last.len()).filter(|_| rest.ends_with(last)) else { return false };
    rest = &rest[..tail_free];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    true
}

fn route_rules_apply(meta: &[(String, String)], provider: &str, model: &str) -> bool {
    let field = |key: &str| meta.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    let providers = route_list(field("providers"));
    let models = route_list(field("models"));
    let provider_id = js_trim(provider).to_lowercase();
    let model_id = js_trim(model).to_lowercase();
    let leaf = model_id.rsplit('/').next().unwrap_or_default();
    if !providers.is_empty() && !providers.contains(&provider_id) {
        return false;
    }
    !(!models.is_empty() && !models.iter().any(|p| route_pattern_matches(p, &model_id) || route_pattern_matches(p, leaf)))
}

/// `buildRouteRulesContent`: the `rules/routes/*.md` files bound to this provider and model.
pub fn build_route_rules_content(
    files: &dyn PromptFiles,
    plugin_root: &Path,
    provider: &str,
    model: &str,
    omit_tools: &[String],
    allow_tools: Option<&[String]>,
) -> String {
    let dir = plugin_root.join("rules").join("routes");
    let mut parts = Vec::new();
    for name in markdown_names(files, &dir).unwrap_or_default() {
        let raw = read_optional(files, &dir.join(&name));
        if raw.is_empty() || !route_rules_apply(&parse_route_frontmatter(&raw), provider, model) {
            continue;
        }
        let body = strip_frontmatter(&raw);
        if !body.is_empty() {
            parts.push(body);
        }
    }
    omit_tool_routes(&parts.join("\n"), omit_tools, allow_tools, false)
}

/// `_buildBaseRules` (BP1): the shared tool policy, then this route's rules.
pub fn build_base_rules(
    files: &dyn PromptFiles,
    plugin_root: &Path,
    provider: &str,
    model: &str,
    omit_tools: &[String],
    allow_tools: Option<&[String]>,
    owner_is_agent: bool,
) -> String {
    [
        build_shared_tool_content(files, plugin_root, omit_tools, allow_tools, owner_is_agent),
        build_route_rules_content(files, plugin_root, provider, model, omit_tools, allow_tools),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n---\n\n")
}

/// `buildLeadRoleContent`'s `part`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LeadPart {
    Common,
    Identity,
    Coding,
    Agent,
}

/// `buildLeadRoleContent`: LEAD.md split for BP3 prefix sharing.
pub fn build_lead_role_content(files: &dyn PromptFiles, plugin_root: &Path, include_lead_brief: bool, part: LeadPart) -> String {
    let raw = read_optional(files, &lead_role_file(plugin_root));
    if raw.is_empty() {
        return String::new();
    }
    let omit: Vec<String> = if include_lead_brief { Vec::new() } else { vec!["agent".to_owned()] };
    let lead = omit_tool_routes(&raw, &omit, None, false);
    if part == LeadPart::Identity {
        return LEAD_IDENTITY_LINE.captures(&lead).and_then(|c| c.get(1)).unwrap_or_default().to_owned();
    }
    let progress = LEAD_PROGRESS_PASSAGE.captures(&lead);
    let report = LEAD_REPORT_PASSAGE.captures(&lead);
    if matches!(part, LeadPart::Coding | LeadPart::Agent) {
        let agent_mode = part == LeadPart::Agent;
        let bullets: Vec<String> = [
            progress.as_ref().map(|p| if agent_mode { AGENT_MODE_PROGRESS.to_owned() } else { format!("- {}", p.get(1).unwrap_or_default()) }),
            report.as_ref().map(|r| if agent_mode { AGENT_MODE_REPORT.to_owned() } else { format!("- {}", r.get(1).unwrap_or_default()) }),
        ]
        .into_iter()
        .flatten()
        .collect();
        return if bullets.is_empty() { String::new() } else { format!("# Progress and Reports\n\n{}", bullets.join("\n")) };
    }
    // `String.replace` with a string pattern-free regex: the first match of each, in turn.
    let mut out = lead;
    for re in [&*LEAD_IDENTITY_LINE, &*LEAD_PROGRESS_PASSAGE, &*LEAD_REPORT_PASSAGE] {
        if let Some(range) = re.find(&out) {
            out.replace_range(range, "");
        }
    }
    out
}

/// `buildAgentModeContent`'s `part`; an unknown name reads as `conduct`.
pub fn build_agent_mode_content(files: &dyn PromptFiles, plugin_root: &Path, part: &str) -> String {
    let heading = if part == "mixy" { "# Your Role\n\n" } else { "" };
    let body = read_optional(files, &agent_mode_file(plugin_root, part));
    if body.is_empty() { String::new() } else { format!("{heading}{body}") }
}

/// `buildAgentRoleContent`.
pub fn build_agent_role_content(files: &dyn PromptFiles, plugin_root: &Path) -> String {
    read_optional(files, &agent_role_file(plugin_root))
}

// ---- the rules variant -----------------------------------------------------------------------------

/// What `_refreshSessionRuleVariantsForModel` reads from the runtime around the session.
pub trait RulesPolicy: Send + Sync {
    /// `getHiddenAgent(agent)`.
    fn hidden_agent(&self, agent: Option<&str>) -> bool;
    /// `delegationDisabled(session, ownerIsAgent)`.
    fn delegation_disabled(&self, session: &Value, owner_is_agent: bool) -> bool;
}

/// The runtime's [RulesPolicy]: the hidden-agent table (getHiddenAgent) and the workflow the session holds now.
pub struct ConfigRulesPolicy;

impl RulesPolicy for ConfigRulesPolicy {
    fn hidden_agent(&self, agent: Option<&str>) -> bool {
        agent.is_some_and(|agent| hidden_agents().contains(agent))
    }

    /// `!ownerIsAgent && workflowDisallowsAgentTool(source?.workflow, { agentMode: Boolean(source) && isAgentModeSession(source) })`
    /// (`session-tool-surface.mjs:23-28`); a session with no workflow object allows the tool, as `workflowDisallowsAgentTool(undefined)` does.
    fn delegation_disabled(&self, session: &Value, owner_is_agent: bool) -> bool {
        let agent_mode = session.as_object().is_some_and(|header| session_mode_of(header) == "agent");
        !owner_is_agent && session.get("workflow").is_some_and(|workflow| workflow_disallows_agent_tool(workflow, agent_mode))
    }
}

fn truthy_text(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

fn is_agent_owner(session: &Value) -> bool {
    session.get("owner").is_some_and(|o| js_trim(&mixdog_js::value_to_string(o)).to_lowercase() == "agent")
}

/// `_refreshSessionRuleVariantsForModel`: the BP1 block is identified by its exact previous
/// content (rebuilt from the same inputs) and replaced by the new route's variant; a custom prompt
/// without that block, and a same-variant switch, are left alone. Whether a message was replaced.
pub fn refresh_rule_variants(session: &mut Value, plugin_root: &Path, previous_model: &str, previous_provider: Option<&str>, policy: &dyn RulesPolicy) -> bool {
    let owner_is_agent = is_agent_owner(session);
    let agent = session.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty()).map(str::to_owned);
    let mut deny: Vec<String> = session.get("disallowedTools").and_then(Value::as_array).map_or_else(Vec::new, |d| d.iter().map(lowered_keep).collect());
    if policy.hidden_agent(agent.as_deref()) {
        deny.push("Skill".to_owned());
    }
    if policy.delegation_disabled(session, owner_is_agent) {
        deny.push("agent".to_owned());
    }
    let allow: Option<Vec<String>> = session
        .get("schemaAllowedTools")
        .and_then(Value::as_array)
        .filter(|_| !(owner_is_agent && !policy.hidden_agent(agent.as_deref())))
        .map(|a| a.iter().map(lowered_keep).collect());
    let text = |key: &str| session.get(key).filter(|v| truthy_text(Some(v))).map(mixdog_js::value_to_string).unwrap_or_default();
    let (provider, model) = (text("provider"), text("model"));
    let previous_provider = previous_provider.map_or_else(|| provider.clone(), str::to_owned);
    let omit = |model: &str| -> Vec<String> { deny.iter().cloned().chain(std::iter::once(unused_model_edit_tool_name(model).to_owned())).collect() };
    let previous = build_base_rules(&LiveFiles, plugin_root, &previous_provider, previous_model, &omit(previous_model), allow.as_deref(), owner_is_agent);
    let next = build_base_rules(&LiveFiles, plugin_root, &provider, &model, &omit(&model), allow.as_deref(), owner_is_agent);
    if previous.is_empty() || previous == next {
        return false;
    }
    let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) else { return false };
    let Some(message) = messages.iter_mut().find(|m| {
        m.get("role").and_then(Value::as_str) == Some("system")
            && !truthy_text(m.get("cacheTier"))
            && m.get("content").and_then(Value::as_str) == Some(previous.as_str())
    }) else {
        return false;
    };
    message["content"] = Value::String(next);
    true
}

/// A list element as the name `omitKeySet` would read (it lower-cases again itself).
fn lowered_keep(value: &Value) -> String {
    lowered(value)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup builds fixture trees")]
mod tests {

    use serde_json::json;

    use super::*;
    /// `delegationDisabled`: a lead whose workflow names no agent has no `agent` tool; an agent-owned session is never asked, and a session with no workflow keeps it.
    #[test]
    fn delegation_is_disabled_by_the_workflow_the_session_holds() {
        let none = json!({ "workflow": { "agentsConfigured": true, "agents": [] } });
        assert!(ConfigRulesPolicy.delegation_disabled(&none, false));
        assert!(!ConfigRulesPolicy.delegation_disabled(&none, true));
        assert!(!ConfigRulesPolicy.delegation_disabled(&json!({ "workflow": { "agentsConfigured": true, "agents": ["a"] } }), false));
        assert!(!ConfigRulesPolicy.delegation_disabled(&json!({}), false));
        // Agent mode with a workflow that delegates to no one.
        let solo = json!({ "sessionMode": "agent", "workflow": { "delegatesAgents": false } });
        assert!(ConfigRulesPolicy.delegation_disabled(&solo, false));
        assert!(!ConfigRulesPolicy.delegation_disabled(&json!({ "sessionMode": "coding", "workflow": { "delegatesAgents": false } }), false));
    }

    #[test]
    fn a_hidden_agent_is_one_the_table_lists() {
        let listed = hidden_agents().into_iter().next().expect("the table lists hidden agents");
        assert!(ConfigRulesPolicy.hidden_agent(Some(&listed)));
        assert!(!ConfigRulesPolicy.hidden_agent(Some("no-such-agent")));
        assert!(!ConfigRulesPolicy.hidden_agent(None));
    }
}
