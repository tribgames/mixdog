//! The prompt against Node: `fixtures/prompt/scenarios.json`, recorded by
//! `benchmarks/rust-core/recorders/record-prompt.mjs` from Node's own functions. Every scenario
//! replays creation (`composeSessionSystem` + seed), the deferred manifest, the `# Session`
//! block, a route change, a cleared conversation and a staged working-folder change, and each
//! step's system messages must equal Node's byte for byte.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and recorded fixtures")]

use std::fs;
use std::path::PathBuf;

use mixdog_agent::env::Clock;
use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;

use mixdog_core_prompt::prompt::blocks::SystemBlocks;
use mixdog_core_prompt::prompt::blocks::request_system_messages;
use mixdog_core_prompt::prompt::compose::ProfileSkip;
use crate::run_host::prompt_session::PromptPaths;
use crate::run_host::prompt_session::PromptPatch;
use crate::run_host::prompt_session::SessionPrompt;
use crate::run_host::prompt_session::SessionPromptInput;
use crate::run_host::prompt_session::compose_session_prompt;
use crate::run_host::prompt_session::refresh_environment;
use crate::run_host::prompt_session::reset_environment;
use crate::run_host::prompt_session::route_prompt;
use mixdog_core_prompt::prompt::sources::PromptSources;
use crate::run_host::deferred_manifest::apply_initial_manifest;
use crate::run_host::rules::RulesPolicy;
use crate::run_host::rules::refresh_rule_variants;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/prompt")
}

fn scenarios() -> Vec<Value> {
    let text = fs::read_to_string(fixtures().join("scenarios.json")).expect("fixtures/prompt/scenarios.json");
    serde_json::from_str::<Value>(&text).expect("json")["scenarios"].as_array().expect("scenarios").clone()
}

/// What Node's loaders answered while it composed; the composition replays them.
struct Facts<'a>(&'a Value);

impl Facts<'_> {
    fn text(&self, key: &str) -> String {
        self.0[key].as_str().unwrap_or_default().to_owned()
    }
}

impl PromptSources for Facts<'_> {
    fn role_catalog(&self, _: Option<&str>, _: Option<&str>) -> String {
        self.text("roleCatalog")
    }
    fn mixy_role_section(&self) -> String {
        self.text("mixyRoleSection")
    }
    fn persona_section(&self, _: &str) -> String {
        self.text("persona")
    }
    fn agent_mode_identity_line(&self, _: &str) -> String {
        self.text("identityLine")
    }
    fn shell_name(&self) -> &'static str {
        if self.0["shellName"] == "PowerShell" { "PowerShell" } else { "Bash" }
    }
    fn scratch_dir(&self, _: &str) -> Option<String> {
        Some(self.text("scratch")).filter(|dir| !dir.is_empty())
    }
    fn shell_tools_line(&self) -> String {
        self.text("shellTools")
    }
    fn git_line(&self, _: Option<&str>) -> String {
        self.text("git")
    }
    fn cwd_entries(&self, _: &str) -> String {
        self.text("cwdEntries")
    }
    fn instruction_files(&self, _: Option<&Value>, _: Option<&str>) -> String {
        self.text("instructionFiles")
    }
    fn instruction_files_mode(&self, _: Option<&Value>) -> String {
        self.text("instructionFilesMode")
    }
    fn system_locale(&self) -> String {
        self.text("locale")
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

struct Fixed;

impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        1
    }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn compose(case: &Value) -> SessionPrompt {
    let input = &case["input"];
    let text = |key: &str| input[key].as_str().unwrap_or_default();
    let omit = strings(&input["ruleOmitTools"]);
    let allow = input["allowTools"].is_array().then(|| strings(&input["allowTools"]));
    let flag = |key: &str| input[key].as_bool().unwrap_or(false);
    let skip = |key: &str| input["profileSkip"][key].as_bool().unwrap_or(false);
    let facts = Facts(&case["facts"]);
    let plugin = fixtures().join("plugin");
    let data = fixtures().join("data");
    let config = input["config"].is_object().then(|| input["config"].clone());
    let input = SessionPromptInput {
        session_id: text("sessionId"),
        provider: text("provider"),
        model: text("model"),
        agent_mode: flag("agentMode"),
        owner_is_agent: flag("ownerIsAgent"),
        agent: input["agent"].as_str(),
        tool_free_role: flag("toolFreeRole"),
        skip_agent_rules: flag("skipAgentRules"),
        rule_omit_tools: &omit,
        allow_tools: allow.as_deref(),
        has_git_tool: flag("hasGitTool"),
        delegation_free: flag("delegationFree"),
        system_prompt: text("systemPrompt"),
        profile_skip: ProfileSkip { skills: skip("skills"), claudemd: skip("claudemd"), memory: skip("memory") },
        cwd: input["cwd"].as_str(),
        cwd_startup_entries: None,
        config: config.as_ref(),
        workflow_context: text("workflowContext"),
        orchestration_context: text("orchestrationContext"),
        agent_catalog_context: text("agentCatalogContext"),
        contact_catalog_context: text("contactCatalogContext"),
        orchestration_mode: text("orchestrationMode"),
        core_memory_context: text("coreMemoryContext"),
        instruction_files_context: input["instructionFilesContext"].as_str(),
        skill_manifest: text("skillManifest"),
    };
    compose_session_prompt(&input, &PromptPaths { plugin_root: &plugin, data_dir: &data }, &facts)
}

fn blocks_of(messages: &Value, combined: bool) -> SystemBlocks {
    let mut blocks = SystemBlocks::from_node_messages(messages.as_array().expect("messages")).expect("a system prefix");
    blocks.combined = combined;
    blocks
}

fn apply(header: &mut Header, change: &HeaderChange) {
    for key in &change.unset {
        header.shift_remove(key);
    }
    for (key, value) in &change.set {
        header.insert(key.clone(), value.clone());
    }
}

/// The header with the blocks written into it, as the session stores it.
fn header_with(base: &Header, blocks: &SystemBlocks) -> Header {
    let mut header = base.clone();
    if !blocks.combined {
        header.shift_remove("bp3CoreContext");
    }
    blocks.write(&mut header);
    header
}

/// A patch lands in one header change: applying it leaves the header holding exactly the
/// patch's blocks, and the header fields Node's session kept equal Node's.
fn lands(name: &str, header: &Header, blocks: &SystemBlocks, patch: &PromptPatch, node: &Value) -> Header {
    let mut next = header_with(header, blocks);
    apply(&mut next, &patch.change);
    assert_eq!(SystemBlocks::from_header(&next), patch.blocks, "{name}: the change carries every changed block");
    assert_eq!(Value::Array(patch.blocks.node_messages()), node["messages"], "{name}: messages");
    for key in ["bp3EnvironmentContext", "sessionStartMetaInjected", "workspaceReroot"] {
        assert_eq!(next.get(key), node["header"].get(key), "{name}: {key}");
    }
    if let Some(core) = node["header"].get("bp3CoreContext") {
        if patch.blocks.combined {
            assert_eq!(next.get("bp3CoreContext"), Some(core), "{name}: bp3CoreContext");
        } else {
            assert_eq!(patch.blocks.core.as_deref(), core.as_str(), "{name}: bp3CoreContext");
        }
    }
    assert_eq!(next.get("bp3EnvSplit").is_none(), patch.blocks.combined, "{name}: the layout flag");
    next
}

fn some(value: &Value) -> Option<String> {
    value.as_str().filter(|text| !text.is_empty()).map(str::to_owned)
}

#[test]
fn creation_composes_the_blocks_and_fields_nodes_session_starts_with() {
    for case in scenarios() {
        let name = case["name"].as_str().unwrap();
        let node = &case["node"];
        let prompt = compose(&case);
        let blocks = &node["blocks"];
        assert_eq!(prompt.blocks.base, some(&blocks["baseRules"]), "{name}: BP1");
        assert_eq!(prompt.blocks.stable, some(&blocks["stableSystemContext"]), "{name}: BP2");
        assert_eq!(prompt.blocks.core, some(&blocks["sessionMarkerCore"]), "{name}: BP3");
        assert_eq!(prompt.blocks.env, some(&blocks["sessionEnvironment"]), "{name}: env");
        assert_eq!(prompt.environment_tail, node["environmentTailContext"], "{name}: environment tail");
        assert_eq!(prompt.prompt_identity, node["promptIdentity"], "{name}: promptIdentity");
        assert_eq!(prompt.prompt_settings, node["promptSettings"], "{name}: promptSettings");
        assert_eq!(prompt.response_language, node["responseLanguage"], "{name}: responseLanguage");
        assert_eq!(Value::Array(prompt.blocks.node_messages()), node["steps"]["seeded"], "{name}: seeded messages");
    }
}

#[test]
fn the_request_reads_the_blocks_from_the_header_in_nodes_order_and_tiers() {
    for case in scenarios() {
        let name = case["name"].as_str().unwrap();
        let mut header = Header::new();
        compose(&case).write(&mut header);
        let sent = request_system_messages(&header);
        let node = case["node"]["steps"]["seeded"].as_array().unwrap();
        assert_eq!(sent.len(), node.len(), "{name}");
        for (message, expected) in sent.iter().zip(node) {
            assert_eq!(message.content, Content::Text(expected["content"].as_str().unwrap().to_owned()), "{name}");
            let tier = match expected["cacheTier"].as_str() {
                Some("tier3") => Some(CacheTier::Tier3),
                Some("env") => Some(CacheTier::Env),
                _ => None,
            };
            assert_eq!(message.cache_tier, tier, "{name}");
        }
        assert_eq!(header["bp3EnvSplit"], true);
        assert_eq!(header["sessionStartMetaInjected"], false);
    }
}

#[test]
fn every_step_of_a_session_leaves_the_system_messages_nodes_leave() {
    for case in scenarios() {
        let name = case["name"].as_str().unwrap();
        let steps = &case["node"]["steps"];
        let base = case["header"].as_object().unwrap().clone();
        let pool = strings(&case["pool"]);
        replay(name, &base, steps, &pool, false);
    }
}

/// A session without `bp3EnvSplit` keeps its one combined `tier3` message through every step, as
/// Node keeps it (it never converts the session).
#[test]
fn a_combined_layout_session_stays_combined_through_every_step() {
    let mut replayed = 0;
    for case in scenarios() {
        let Some(steps) = case["node"]["steps"].get("combined") else { continue };
        let mut base = case["header"].as_object().unwrap().clone();
        base.shift_remove("bp3EnvSplit");
        replay(&format!("{} (combined)", case["name"].as_str().unwrap()), &base, steps, &strings(&case["pool"]), true);
        replayed += 1;
    }
    assert!(replayed >= 3);
}

fn replay(name: &str, base: &Header, steps: &Value, pool: &[String], combined: bool) {
    let plugin = fixtures().join("plugin");
    {
        // The deferred manifest in BP2 (`applyInitialDeferredToolManifestToBp2`).
        let seeded = blocks_of(&steps["seeded"], combined);
        let mut session = Value::Object(header_with(base, &seeded));
        session["messages"] = Value::Array(seeded.node_messages());
        apply_initial_manifest(&mut session, pool, false, &Fixed);
        let manifested = blocks_of(&session["messages"], combined);
        assert_eq!(Value::Array(manifested.node_messages()), steps["afterManifest"], "{name}: manifest");

        // The `# Session` block right after creation.
        let header = header_with(base, &manifested);
        let patch = refresh_environment(&header, &manifested);
        let refreshed = lands(&format!("{name}: refresh"), &header, &manifested, &patch, &steps["afterRefresh"]);
        let blocks = patch.blocks;
        let Some(route) = steps.get("afterRoute") else { return };

        // A route change with no conversation: the rules variant, then the `# Session` block.
        let routed = |header: &Header, blocks: &SystemBlocks, from: &Value, to: &Value, name: &str, node: &Value| {
            let mut session = Value::Object(header_with(header, blocks));
            session["provider"] = to["provider"].clone();
            session["model"] = to["model"].clone();
            session["messages"] = Value::Array(blocks.node_messages());
            refresh_rule_variants(&mut session, &plugin, from["model"].as_str().unwrap(), from["provider"].as_str(), &Policy);
            let rules = blocks_of(&session["messages"], combined);
            let mut moved = header_with(header, &rules);
            moved.insert("provider".into(), to["provider"].clone());
            moved.insert("model".into(), to["model"].clone());
            let patch = route_prompt(&moved, &rules, true);
            lands(name, &moved, &rules, &patch, node);
        };
        routed(&refreshed, &blocks, &route["from"], &route["to"], &format!("{name}: route"), route);

        // A cleared conversation.
        let patch = reset_environment(&refreshed, &blocks);
        lands(&format!("{name}: reset"), &refreshed, &blocks, &patch, &steps["afterReset"]);

        // A staged working-folder change, then a reset and a route change.
        let Some(staged) = steps.get("staged") else { return };
        let staged_blocks = blocks_of(&staged["messages"], combined);
        let mut staged_header = refreshed.clone();
        for (key, value) in staged["header"].as_object().unwrap() {
            if combined || key != "bp3CoreContext" {
                staged_header.insert(key.clone(), value.clone());
            }
        }
        let patch = reset_environment(&staged_header, &staged_blocks);
        lands(&format!("{name}: staged then reset"), &staged_header, &staged_blocks, &patch, &steps["stagedThenReset"]);
        routed(&staged_header, &staged_blocks, &route["from"], &route["to"], &format!("{name}: staged then route"), &steps["stagedThenRoute"]);
    }
}