//! The hook-rule setup actions through their service: rules saved and deleted while a session is open change what the hook bus
//! answers for the next tool call, the hooks file holds them, and a bad request is refused with its reason.
#![allow(clippy::disallowed_methods, reason = "test: reads the hooks file the actions wrote")]

use std::path::Path;
use std::sync::Arc;

use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::hook_bus::ToolCall;
use mixdog_protocol::ThreadId;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::domain_seams::hook_status::HookEventLog;
use crate::domain_seams::hook_status::HookStatus;

struct World {
    setup: HookRuleSetup,
    bus: Arc<HookBus>,
    data: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn world() -> World {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let log = HookEventLog::new(data.clone());
    let status = HookStatus::new(data.clone(), tokens.maintenance_io, log.clone(), log.clone());
    let setup = HookRuleSetup::new(data.join("hooks.json"), tokens.maintenance_io, status, log);
    let bus =
        HookBus::new(data.clone(), tokens.maintenance_io, Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())), None, None, None);
    World { setup, bus, data, _dir: dir }
}

impl World {
    async fn run(&self, action: &'static str, args: Value) -> Result<Value, String> {
        let thread = ThreadId::from("sess_open");
        self.setup.run(&SetupCall { action, args: &args, thread: &thread }).await.map_err(|error| match error {
            PortError::Failed { message, .. } => message,
            other => format!("{other:?}"),
        })
    }

    async fn add(&self, rule: Value) -> Result<Value, String> {
        self.run("add_hook_rule", json!({ "action": "add_hook_rule", "hookRule": rule })).await
    }

    /// The hook bus's answer for a `tool` call: the action it decides, or null when no hook has an opinion.
    async fn decision(&self, tool: &str) -> Value {
        let (common, args, thread) = (HookCommon::default(), json!({}), ThreadId::from("sess_open"));
        let call = ToolCall { session_id: thread.as_str(), call_id: "", name: tool, args: &args, cwd: &self.data, common: &common };
        self.bus.before_tool(&call).await.map_or(Value::Null, |outcome| json!(outcome.action))
    }

    fn file(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.data.join("hooks.json")).unwrap()).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rule_saved_while_a_session_is_open_decides_the_next_call_and_deleting_it_ends_that() {
    let world = world();
    assert_eq!(world.decision("shell").await, Value::Null, "no rule, no opinion");
    let added = world.add(json!({ "tool": "shell", "action": "deny", "reason": "no shell here" })).await.unwrap();
    let row = &added["rules"][0];
    assert_eq!(
        (row["index"].clone(), row["tool"].clone(), row["action"].clone(), row["enabled"].clone()),
        (json!(0), json!("shell"), json!("deny"), json!(true))
    );
    assert_eq!(row["hasArgumentEdit"], false);
    assert_eq!(world.file()["toolBefore"][0]["tool"], "shell");
    assert_eq!(world.decision("shell").await, json!("deny"));
    assert_eq!(world.decision("read").await, Value::Null, "a rule for shell says nothing of read");

    let deleted = world.run("delete_hook_rule", json!({ "action": "delete_hook_rule", "ruleIndex": 0 })).await.unwrap();
    assert_eq!(deleted["deleted"]["tool"], "shell");
    assert_eq!(deleted["rules"], json!([]));
    assert_eq!(deleted["recovery"], "The rule is removed from the hook rules file; re-adding it with add_hook_rule restores it.");
    assert_eq!(world.decision("shell").await, Value::Null);
    assert!(
        Path::new(&world.data.join("hooks.json.bak")).exists()
            || std::fs::read_dir(&world.data).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().contains("bak")),
        "the replaced file is kept as a backup"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rule_switched_off_says_nothing_and_switched_on_decides_again() {
    let world = world();
    world.add(json!({ "tool": "shell", "action": "ask" })).await.unwrap();
    assert_eq!(world.decision("shell").await, json!("ask"));
    let off = world.run("set_hook_rule_enabled", json!({ "action": "set_hook_rule_enabled", "ruleIndex": 0, "enabled": false })).await.unwrap();
    assert_eq!(off["rules"][0]["enabled"], false);
    assert_eq!(world.file()["toolBefore"][0]["enabled"], false, "the toggle is written");
    assert_eq!(world.decision("shell").await, Value::Null);
    world.run("set_hook_rule_enabled", json!({ "action": "set_hook_rule_enabled", "ruleIndex": 0, "enabled": true })).await.unwrap();
    assert_eq!(world.decision("shell").await, json!("ask"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bad_rule_or_an_unknown_index_is_refused_with_its_reason() {
    let world = world();
    let refused = |result: Result<Value, String>| result.expect_err("refused");
    assert!(
        refused(world.add(json!({ "tool": "shell", "action": "maybe" })).await)
            .contains("hook rule action must be allow, deny, block, modify, rewrite, or ask")
    );
    assert!(refused(world.add(json!({ "tool": "shell", "action": "modify" })).await).contains("hookRule.modify requires exactly one of patch or args"));
    assert!(
        refused(world.add(json!({ "tool": "shell", "action": "allow", "patch": {} })).await).contains("hookRule.patch applies only to modify or rewrite rules")
    );
    assert!(!world.data.join("hooks.json").exists(), "a refused rule writes nothing");
    assert!(
        refused(world.run("delete_hook_rule", json!({ "action": "delete_hook_rule", "ruleIndex": 5 })).await)
            .contains("hook rule 5 not found; read status hooks")
    );
    assert!(
        refused(world.run("set_hook_rule_enabled", json!({ "action": "set_hook_rule_enabled", "ruleIndex": -1, "enabled": true })).await)
            .contains("hook rule -1 not found")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewrite_rule_reports_that_it_edits_arguments_and_not_what_they_hold() {
    let world = world();
    let added = world.add(json!({ "tool": "shell", "action": "modify", "patch": { "command": "echo secret-value" } })).await.unwrap();
    assert_eq!(added["rules"][0]["hasArgumentEdit"], true);
    assert!(!added.to_string().contains("secret-value"), "the answer carries no argument contents: {added}");
}

impl World {
    fn start_from(&self, text: &str) {
        std::fs::write(self.data.join("hooks.json"), text).unwrap();
    }

    async fn toggle(&self, index: i64, enabled: bool) -> Result<Value, String> {
        self.run("set_hook_rule_enabled", json!({ "action": "set_hook_rule_enabled", "ruleIndex": index, "enabled": enabled })).await
    }

    async fn delete(&self, index: i64) -> Result<Value, String> {
        self.run("delete_hook_rule", json!({ "action": "delete_hook_rule", "ruleIndex": index })).await
    }
}

/// The rows an answer lists: index, enabled, tool, action.
fn listed(answer: &Value) -> Vec<(i64, bool, String, String)> {
    answer["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (r["index"].as_i64().unwrap(), r["enabled"].as_bool().unwrap(), r["tool"].as_str().unwrap().to_owned(), r["action"].as_str().unwrap().to_owned())
        })
        .collect()
}

fn row(index: i64, enabled: bool, tool: &str, action: &str) -> (i64, bool, String, String) {
    (index, enabled, tool.to_owned(), action.to_owned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hooks_file_that_is_a_list_of_rules_is_read_toggled_and_written_back_as_a_list() {
    let world = world();
    world.start_from(r#"[{"tool":"read","action":"deny","reason":"no reads"},{"tool":"bash*","action":"modify","match":"rm -rf","patch":{"dry":true,"apiToken":"sekret"},"enabled":false},{"name":"edit","decision":"ask","contains":["a","b"],"message":"check edits","cwd":"/work"}]"#);
    let off = world.toggle(0, false).await.unwrap();
    assert_eq!(
        listed(&off),
        vec![row(0, false, "read", "deny"), row(1, false, "bash*", "modify"), row(2, true, "edit", "ask")],
        "a rule may name its tool `name` and its action `decision`"
    );
    assert_eq!(off["rules"][1]["hasArgumentEdit"], true);
    assert!(!off.to_string().contains("sekret"), "an argument edit's contents are never shown");
    assert_eq!(
        world.file()[0],
        json!({ "tool": "read", "action": "deny", "reason": "no reads", "enabled": false }),
        "the file stays a list and the toggle is written in place"
    );
    assert_eq!(world.file().as_array().unwrap().len(), 3);
    assert_eq!(listed(&world.toggle(0, true).await.unwrap())[0], row(0, true, "read", "deny"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hooks_file_with_no_usable_rule_list_gets_one_and_keeps_the_rest_of_its_document() {
    for start in ["5", "", "\u{0}\u{0}\u{0}", "{ not json"] {
        let world = world();
        world.start_from(start);
        assert!(world.toggle(0, true).await.unwrap_err().contains("hook rule 0 not found; read status hooks"), "{start:?}: nothing to toggle");
        let added = world.add(json!({ "action": "deny" })).await.unwrap();
        assert_eq!(listed(&added), vec![row(0, true, "*", "deny")], "{start:?}: the first rule, for every tool");
        assert_eq!(world.file(), json!({ "toolBefore": [{ "tool": "*", "action": "deny", "enabled": true }] }), "{start:?}");
    }
    let world = world();
    let standard = r#"{"hooks":{"PreToolUse":[{"matcher":"bash","hooks":[{"type":"command","command":"echo"}]}]}}"#;
    world.start_from(standard);
    world.add(json!({ "tool": "bash", "action": "deny" })).await.unwrap();
    let kept = world.file();
    assert_eq!(kept["hooks"], serde_json::from_str::<Value>(standard).unwrap()["hooks"], "the command hooks stay as they were");
    assert_eq!(kept["toolBefore"], json!([{ "tool": "bash", "action": "deny", "enabled": true }]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_rule_list_in_force_is_the_first_of_toolbefore_beforetool_and_hooks_toolbefore_and_the_others_stay_untouched() {
    let world = world();
    world.start_from(
        r#"{"toolBefore":[{"action":"deny","tool":"a"}],"beforeTool":[{"action":"deny","tool":"b"}],"hooks":{"toolBefore":[{"action":"deny","tool":"c"}]}}"#,
    );
    let added = world.add(json!({ "action": "allow" })).await.unwrap();
    assert_eq!(listed(&added), vec![row(0, true, "a", "deny"), row(1, true, "*", "allow")]);
    assert_eq!(listed(&world.delete(0).await.unwrap()), vec![row(0, true, "*", "allow")]);
    let file = world.file();
    assert_eq!(file["beforeTool"], json!([{ "action": "deny", "tool": "b" }]), "the lists not in force are not rewritten");
    assert_eq!(file["hooks"]["toolBefore"], json!([{ "action": "deny", "tool": "c" }]));

    let world = world_with(r#"{"beforeTool":[{"action":"deny","tool":"b"}],"hooks":{"toolBefore":[{"action":"deny","tool":"c"}]}}"#);
    assert_eq!(
        listed(&world.add(json!({ "action": "allow" })).await.unwrap()),
        vec![row(0, true, "b", "deny"), row(1, true, "*", "allow")],
        "beforeTool wins over hooks.toolBefore"
    );
}

fn world_with(text: &str) -> World {
    let world = world();
    world.start_from(text);
    world
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn entries_of_a_rule_list_that_are_not_objects_are_not_counted_and_a_write_drops_them() {
    let world = world_with(r#"[1,"x",null,{"tool":"one","action":"deny"},[2],{"tool":"two","action":"ask"}]"#);
    let off = world.toggle(1, false).await.unwrap();
    assert_eq!(listed(&off).iter().map(|r| r.2.as_str()).collect::<Vec<_>>(), vec!["one", "*", "two"], "three rules are counted, not six entries");
    assert_eq!(world.file().as_array().unwrap().len(), 3, "the write dropped what was not a rule");
    let added = world.add(json!({ "action": "deny" })).await.unwrap();
    assert_eq!(listed(&added).last(), Some(&row(3, true, "*", "deny")));
    assert_eq!(listed(&world.delete(0).await.unwrap()).len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_modify_or_rewrite_rule_needs_exactly_one_edit_and_the_other_actions_take_none() {
    let world = world();
    let refused = |result: Result<Value, String>| result.unwrap_err();
    assert!(refused(world.add(json!({ "action": "modify" })).await).contains("requires exactly one of patch or args"));
    assert!(refused(world.add(json!({ "action": "rewrite" })).await).contains("requires exactly one of patch or args"));
    assert!(refused(world.add(json!({ "action": "modify", "patch": { "a": 1 }, "args": { "b": 2 } })).await).contains("requires exactly one of patch or args"));
    assert!(refused(world.add(json!({ "action": "ask", "patch": {} })).await).contains("applies only to modify or rewrite rules"));
    assert!(refused(world.add(json!({ "action": "allow", "args": { "a": 1 } })).await).contains("applies only to modify or rewrite rules"));
    assert!(!world.data.join("hooks.json").exists(), "none of them wrote anything");
    world.add(json!({ "action": "rewrite", "args": { "b": 2 } })).await.unwrap();
    world.add(json!({ "action": "modify", "patch": { "a": 1 } })).await.unwrap();
    let added = world.add(json!({ "action": "block" })).await.unwrap();
    let edits: Vec<bool> = added["rules"].as_array().unwrap().iter().map(|r| r["hasArgumentEdit"].as_bool().unwrap()).collect();
    assert_eq!(edits, vec![true, true, false]);
    assert_eq!(world.file()["toolBefore"][0], json!({ "tool": "*", "action": "rewrite", "enabled": true, "args": { "b": 2 } }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_toggle_that_cannot_be_written_is_refused_and_leaves_the_file_as_it_was() {
    let world = world_with(r#"[{"tool":"a","action":"deny"}]"#);
    // A directory where the backup of the replaced file goes makes the write fail.
    std::fs::create_dir(world.data.join("hooks.json.bak")).unwrap();
    let refused = world.toggle(0, false).await;
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(world.file(), json!([{ "tool": "a", "action": "deny" }]), "the file is as it was");
}

/// The mapping is `summarize_rule` (`domain_seams/hook_status.rs`): `enabled` is `enabled != false`; `tool` the first present of `tool`, `name`,
/// `tools` else `*`; `action` the first truthy of `action`, `decision` else `allow`; `match` the first present of `match`, `contains`;
/// `reason` the first truthy of `reason`, `message`; an argument edit is any non-null `patch` or `args` (`public_rule` reports only that).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rules_with_unusual_fields_are_summarised_as_the_summary_reads_them() {
    let world = world_with(
        r#"[{"tools":["a","b"],"decision":"deny","contains":"x","message":"m"},{"action":"","tool":""},{"enabled":0,"action":"deny"},{"enabled":false}]"#,
    );
    let blank = |index: i64, enabled: bool, tool: Value, action: &str| json!({ "index": index, "enabled": enabled, "tool": tool, "action": action, "match": null, "cwd": null, "reason": null, "hasArgumentEdit": false });
    let rows = world.toggle(0, false).await.unwrap()["rules"].clone();
    assert_eq!(
        rows,
        json!([
            { "index": 0, "enabled": false, "tool": ["a", "b"], "action": "deny", "match": "x", "cwd": null, "reason": "m", "hasArgumentEdit": false },
            blank(1, true, json!(""), "allow"),
            blank(2, true, json!("*"), "deny"),
            blank(3, false, json!("*"), "allow"),
        ]),
        "`tools` is the tool, `decision` the action, `contains` the match, `message` the reason; an empty action is allow, an empty tool stays empty, `enabled: 0` is not false, and a rule with nothing else is `*` allow"
    );
    let on = world.toggle(3, true).await.unwrap();
    assert_eq!(on["rules"][3]["enabled"], true);
    let deleted = world.delete(1).await.unwrap();
    assert_eq!(deleted["rules"].as_array().unwrap().len(), 3);
    assert_eq!(deleted["rules"][1], blank(1, true, json!("*"), "deny"), "the rules after the deleted one move up");
}
