//! The prompt rules builder (Node `lib/rules-builder.cjs`: `buildSharedToolContent`,
//! `buildRouteRulesContent`, `buildLeadRoleContent`, `buildAgentModeContent`,
//! `buildAgentRoleContent`, `omitToolRoutes`, with the BP1 composition `_buildBaseRules` of
//! `session/manager/rules-cache.mjs`) and the rules variant a route change re-renders
//! (`_refreshSessionRuleVariantsForModel`).
//!
//! `plugin_root` is Node's `PLUGIN_ROOT` (the directory holding `rules/`). Nothing is memoised:
//! Node's source-revision cache returns exactly what a fresh build would.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use mixdog_js::{js_trim, JsRegex};
use serde_json::Value;

use super::tool_surface::unused_model_edit_tool_name;

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
static LEAD_PROGRESS_PASSAGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r" (Before your first tool call, briefly state[\s\S]*?narration or plan repeats\.)", ""));
static LEAD_REPORT_PASSAGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r" (On\s+an\s+agent\s+report[\s\S]*?never\s+report\s+it\s+as\s+done\.)", ""));

const AGENT_MODE_PROGRESS: &str = "- Just answer conversation. Quick tool use (checking memory, a lookup,\n  leaving a reaction) needs no announcement. When starting longer work\n  (research, delegation, multi-step tasks), say in one line what you are\n  doing, stay quiet between tool calls, and share the result when it\n  finishes.";
const AGENT_MODE_REPORT: &str = "- Relay agent reports faithfully. Code: one fresh Reviewer per non-trivial\n  feature after its last worker, any author (Lead if none); docs/copy/style:\n  read the diff. Recheck only concrete fixes, never rerun passing checks\n  without new evidence; at request end check feature seams.";

/// `readOptional`: the trimmed file, `""` when it cannot be read.
fn read_optional(path: &Path) -> String {
    fs::read(path).map(|bytes| js_trim(&String::from_utf8_lossy(&bytes)).to_owned()).unwrap_or_default()
}

/// The `.md` file names of `dir`, sorted; `None` when the directory is unreadable.
fn markdown_names(dir: &Path) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir).ok()?.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.ends_with(".md")).collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Some(names)
}

/// `readMarkdownDirectory`.
fn read_markdown_directory(dir: &Path) -> String {
    let Some(names) = markdown_names(dir) else { return String::new() };
    names.iter().map(|n| read_optional(&dir.join(n))).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// `stripFrontmatter`.
fn strip_frontmatter(markdown: &str) -> String {
    let stripped = match FRONTMATTER_STRIP.find(markdown) {
        Some(range) => &markdown[range.end..],
        None => markdown,
    };
    js_trim(stripped).to_owned()
}

fn split_lines(text: &str) -> Vec<&str> {
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
pub fn build_shared_tool_content(plugin_root: &Path, omit_tools: &[String], allow_tools: Option<&[String]>, owner_is_agent: bool) -> String {
    omit_tool_routes(&read_markdown_directory(&plugin_root.join("rules").join("shared")), omit_tools, allow_tools, owner_is_agent)
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
pub fn build_route_rules_content(plugin_root: &Path, provider: &str, model: &str, omit_tools: &[String], allow_tools: Option<&[String]>) -> String {
    let dir = plugin_root.join("rules").join("routes");
    let mut parts = Vec::new();
    for name in markdown_names(&dir).unwrap_or_default() {
        let raw = read_optional(&dir.join(&name));
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
pub fn build_base_rules(plugin_root: &Path, provider: &str, model: &str, omit_tools: &[String], allow_tools: Option<&[String]>, owner_is_agent: bool) -> String {
    [build_shared_tool_content(plugin_root, omit_tools, allow_tools, owner_is_agent), build_route_rules_content(plugin_root, provider, model, omit_tools, allow_tools)]
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
pub fn build_lead_role_content(plugin_root: &Path, include_lead_brief: bool, part: LeadPart) -> String {
    let raw = read_optional(&plugin_root.join("rules").join("lead").join("LEAD.md"));
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
pub fn build_agent_mode_content(plugin_root: &Path, part: &str) -> String {
    let (file, heading) = if part == "mixy" { ("MIXY.md", "# Your Role\n\n") } else { ("AGENT_MODE.md", "") };
    let body = read_optional(&plugin_root.join("rules").join("agent-mode").join(file));
    if body.is_empty() { String::new() } else { format!("{heading}{body}") }
}

/// `buildAgentRoleContent`.
pub fn build_agent_role_content(plugin_root: &Path) -> String {
    read_optional(&plugin_root.join("rules").join("agent").join("AGENT.md"))
}

// ---- the rules variant -----------------------------------------------------------------------------

/// What `_refreshSessionRuleVariantsForModel` reads from the runtime around the session.
pub trait RulesPolicy: Send + Sync {
    /// `getHiddenAgent(agent)`.
    fn hidden_agent(&self, agent: Option<&str>) -> bool;
    /// `delegationDisabled(session, ownerIsAgent)`.
    fn delegation_disabled(&self, session: &Value, owner_is_agent: bool) -> bool;
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
    let text = |key: &str| session.get(key).filter(|v| truthy_text(Some(v))).map(|v| mixdog_js::value_to_string(v)).unwrap_or_default();
    let (provider, model) = (text("provider"), text("model"));
    let previous_provider = previous_provider.map_or_else(|| provider.clone(), str::to_owned);
    let omit = |model: &str| -> Vec<String> { deny.iter().cloned().chain(std::iter::once(unused_model_edit_tool_name(model).to_owned())).collect() };
    let previous = build_base_rules(plugin_root, &previous_provider, previous_model, &omit(previous_model), allow.as_deref(), owner_is_agent);
    let next = build_base_rules(plugin_root, &provider, &model, &omit(&model), allow.as_deref(), owner_is_agent);
    if previous.is_empty() || previous == next {
        return false;
    }
    let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) else { return false };
    let Some(message) = messages.iter_mut().find(|m| {
        m.get("role").and_then(Value::as_str) == Some("system") && !truthy_text(m.get("cacheTier")) && m.get("content").and_then(Value::as_str) == Some(previous.as_str())
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
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    fn fixture() -> (PathBuf, Vec<Value>) {
        let golden: Value = serde_json::from_str(include_str!("golden/rules_builder.json")).expect("fixture");
        let root = PathBuf::from(std::env::var("TEMP").unwrap_or_else(|_| ".".into())).join(format!("rules-golden-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for (rel, body) in golden["files"].as_object().unwrap() {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body.as_str().unwrap()).unwrap();
        }
        (root, golden["cases"].as_array().unwrap().clone())
    }

    fn names(value: &Value) -> Vec<String> {
        value.as_array().map_or_else(Vec::new, |a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
    }

    /// Node's builders over a synthetic rules tree: markers, allow/deny sets, CRLF files,
    /// frontmatter routes with quoted and globbed models, and the LEAD.md split.
    #[test]
    fn the_builders_follow_node() {
        let (root, cases) = fixture();
        for case in &cases {
            let a = &case["args"];
            let allow = a.get("allowTools").filter(|v| v.is_array()).map(names);
            let omit = names(&a["omitTools"]);
            let owner = a["ownerIsAgent"].as_bool().unwrap_or(false);
            let got = match case["fn"].as_str().unwrap() {
                "shared" => build_shared_tool_content(&root, &omit, allow.as_deref(), owner),
                "route" => build_route_rules_content(&root, a["provider"].as_str().unwrap_or(""), a["model"].as_str().unwrap_or(""), &omit, allow.as_deref()),
                "lead" => {
                    let part = match a["part"].as_str().unwrap() {
                        "identity" => LeadPart::Identity,
                        "coding" => LeadPart::Coding,
                        "agent" => LeadPart::Agent,
                        _ => LeadPart::Common,
                    };
                    build_lead_role_content(&root, a["includeLeadBrief"].as_bool().unwrap(), part)
                }
                "agentMode" => build_agent_mode_content(&root, a["part"].as_str().unwrap()),
                "agentRole" => build_agent_role_content(&root),
                "omit" => omit_tool_routes(a["text"].as_str().unwrap(), &omit, allow.as_deref(), owner),
                other => panic!("{other}"),
            };
            assert_eq!(got, case["out"].as_str().unwrap(), "{case}");
        }
    }

    struct Policy;
    impl RulesPolicy for Policy {
        fn hidden_agent(&self, _: Option<&str>) -> bool {
            false
        }
        fn delegation_disabled(&self, _: &Value, _: bool) -> bool {
            false
        }
    }

    #[test]
    fn a_route_switch_rerenders_only_the_exact_base_block() {
        let (root, _) = fixture();
        let base = |provider: &str, model: &str| {
            let tool = unused_model_edit_tool_name(model).to_owned();
            build_base_rules(&root, provider, model, &[tool], None, false)
        };
        let mut session = json!({
            "provider": "anthropic", "model": "claude-3-5-sonnet",
            "messages": [
                { "role": "system", "content": base("openai", "gpt-5"), "cacheTier": "tier1" },
                { "role": "system", "content": base("openai", "gpt-5") },
                { "role": "user", "content": "hi" }
            ]
        });
        assert!(refresh_rule_variants(&mut session, &root, "gpt-5", Some("openai"), &Policy));
        assert_eq!(session["messages"][0]["content"], base("openai", "gpt-5"));
        assert_eq!(session["messages"][1]["content"], base("anthropic", "claude-3-5-sonnet"));
        assert!(!refresh_rule_variants(&mut session, &root, "claude-3-5-sonnet", Some("anthropic"), &Policy));
    }
}
