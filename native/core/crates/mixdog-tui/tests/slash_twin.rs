//! The Rust slash code against what the Node code does (tests/goldens/slash.json, recorded by
//! tests/recorders/record-slash.mjs): the command registry and its helpers, the palettes of every prefix of every command and
//! alias, `$skill` completion at every caret, the argument parsers, and the event logs of whole scenarios (slash dispatch,
//! prompt submit, the Tab workflow cycle, the setup open request) driven by the same scripted store.
//!
//! The recorder is run on a Node checkout (`node tests/recorders/record-slash.mjs --tree <checkout> --check
//! tests/goldens/slash.json`); this test only reads the recording.

mod slash_support;

use mixdog_tui::slash::commands::{
    OverlayOwner, SLASH_COMMANDS, normalize_slash_command_name, overlay_blocks_global_transcript_scroll,
    recognised_agent_room_slash, recognised_slash_token, slash_argument_hint, slash_command_matches,
    slash_command_token_for_palette_accept, slash_query,
};
use mixdog_tui::slash::palette::{
    PaletteInputs, PaletteItem, PaletteKind, SlashPalette, complete_skill_mention, derive_slash_palette,
    skill_mention_items, skill_mention_query,
};
use mixdog_tui::slash::parsers::{
    memory_core_result_error_text, parse_mcp_server_input, parse_memory_command, parse_memory_core_rows,
    parse_skill_input,
};
use mixdog_tui::slash::text_entry::{can_submit_text_entry, text_entry_clears_by_empty};
use serde_json::{Value, json};
use slash_support::play;

const GOLDEN: &str = include_str!("goldens/slash.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("slash.json is valid JSON")
}

/// Collects the first mismatches of a group of cases.
#[derive(Default)]
struct Mismatches(Vec<String>);

impl Mismatches {
    fn expect<T: PartialEq + std::fmt::Debug>(&mut self, what: impl FnOnce() -> String, got: T, want: T) {
        if got != want && self.0.len() < 12 {
            self.0.push(format!("{}: got {got:?}, want {want:?}", what()));
        }
    }

    fn finish(self, group: &str) {
        assert!(self.0.is_empty(), "{group}: {} mismatches, first:\n{}", self.0.len(), self.0.join("\n"));
    }
}

fn str_of(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn caret_of(value: &Value) -> Option<i64> {
    value.as_i64()
}

fn string_or_null(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

fn item_json(item: &PaletteItem) -> Value {
    match item {
        PaletteItem::Command(command) => json!({"name": command.name}),
        PaletteItem::Skill { name, label, description } => {
            json!({"kind": "skill", "name": name, "label": label, "description": description})
        }
    }
}

fn palette_json(palette: &SlashPalette) -> Value {
    json!({
        "query": string_or_null(palette.active_slash_query.clone()),
        "items": palette.slash_commands.iter().map(item_json).collect::<Vec<_>>(),
        "open": palette.slash_palette_open,
        "kind": match palette.palette_kind { PaletteKind::Commands => "commands", PaletteKind::Skills => "skills" },
    })
}

fn flags_of(flags: &Value, skills: &[Value], draft: &str, dismissed: &str, caret: Option<i64>) -> SlashPalette {
    let on = |key: &str| flags.get(key).and_then(Value::as_bool).unwrap_or(false);
    derive_slash_palette(&PaletteInputs {
        provider_prompt: on("providerPrompt"),
        settings_prompt: on("settingsPrompt"),
        tool_approval: on("toolApproval"),
        context_panel: on("contextPanel"),
        usage_panel: on("usagePanel"),
        picker: on("picker"),
        exiting: on("exiting"),
        command_busy: on("commandBusy"),
        prompt_draft: draft,
        slash_dismissed_for: dismissed,
        skills,
        prompt_caret: caret,
    })
}

#[test]
fn the_registry_is_the_node_registry() {
    let golden = golden();
    let rows = golden["registry"]["commands"].as_array().expect("commands");
    assert_eq!(rows.len(), SLASH_COMMANDS.len());
    let mut m = Mismatches::default();
    for (row, command) in rows.iter().zip(SLASH_COMMANDS) {
        let name = command.name;
        m.expect(|| format!("{name} name"), command.name, str_of(&row["name"]));
        m.expect(|| format!("{name} usage"), command.usage, str_of(&row["usage"]));
        m.expect(|| format!("{name} description"), command.description, str_of(&row["description"]));
        m.expect(|| format!("{name} params"), command.params, row["params"].as_str());
        let strings = |key: &str| {
            row[key]
                .as_array()
                .map(|items| items.iter().map(|item| str_of(item).to_owned()).collect::<Vec<_>>())
                .unwrap_or_default()
        };
        m.expect(
            || format!("{name} aliases"),
            command.aliases.iter().map(|alias| (*alias).to_owned()).collect::<Vec<_>>(),
            strings("aliases"),
        );
        m.expect(
            || format!("{name} aliasUsage"),
            command.alias_usage.iter().map(|alias| (*alias).to_owned()).collect::<Vec<_>>(),
            strings("aliasUsage"),
        );
        m.expect(|| format!("{name} showAliasUsage"), command.show_alias_usage, row["showAliasUsage"].as_bool());
    }
    m.finish("registry");
}

#[test]
fn the_registry_helpers_agree_with_node() {
    let golden = golden();
    let registry = &golden["registry"];
    let mut m = Mismatches::default();
    for case in registry["normalize"].as_array().expect("normalize") {
        let token = str_of(&case["token"]);
        m.expect(
            || format!("normalize {token:?}"),
            normalize_slash_command_name(token),
            str_of(&case["out"]).to_owned(),
        );
    }
    for case in registry["slashQuery"].as_array().expect("slashQuery") {
        let draft = str_of(&case["draft"]);
        m.expect(|| format!("slashQuery {draft:?}"), string_or_null(slash_query(draft)), case["out"].clone());
    }
    for case in registry["matches"].as_array().expect("matches") {
        let (name, query) = (str_of(&case["command"]), str_of(&case["query"]));
        let command = SLASH_COMMANDS.iter().find(|entry| entry.name == name).expect("a registered command");
        m.expect(
            || format!("matches {name} {query:?}"),
            slash_command_matches(command, query),
            case["out"].as_bool().unwrap_or(false),
        );
    }
    for case in registry["accept"].as_array().expect("accept") {
        let (name, draft) = (str_of(&case["command"]), str_of(&case["draft"]));
        let command = SLASH_COMMANDS.iter().find(|entry| entry.name == name).expect("a registered command");
        m.expect(
            || format!("accept {name} {draft:?}"),
            slash_command_token_for_palette_accept(command, draft),
            str_of(&case["out"]).to_owned(),
        );
    }
    for case in registry["hints"].as_array().expect("hints") {
        let draft = str_of(&case["draft"]);
        m.expect(|| format!("hint {draft:?}"), slash_argument_hint(draft), str_of(&case["out"]).to_owned());
    }
    for case in registry["recognised"].as_array().expect("recognised") {
        let text = str_of(&case["text"]);
        m.expect(|| format!("token {text:?}"), string_or_null(recognised_slash_token(text)), case["token"].clone());
        m.expect(
            || format!("room {text:?}"),
            recognised_agent_room_slash(text),
            case["room"].as_bool().unwrap_or(false),
        );
    }
    for case in registry["overlays"].as_array().expect("overlays") {
        let on = |key: &str| case["owner"].get(key).and_then(Value::as_bool).unwrap_or(false);
        let owner = OverlayOwner {
            slash_palette_open: on("slashPaletteOpen"),
            picker: on("picker"),
            tool_approval: on("toolApproval"),
            context_panel: on("contextPanel"),
            usage_panel: on("usagePanel"),
            btw_panel: on("btwPanel"),
            provider_prompt: on("providerPrompt"),
            settings_prompt: on("settingsPrompt"),
        };
        m.expect(
            || format!("overlay {}", case["owner"]),
            overlay_blocks_global_transcript_scroll(owner),
            case["out"].as_bool().unwrap_or(false),
        );
    }
    m.finish("registry helpers");
}

#[test]
fn the_command_palette_agrees_with_node_for_every_prefix_and_surface() {
    let golden = golden();
    let mut m = Mismatches::default();
    for case in golden["registry"]["prefixPalette"].as_array().expect("prefixPalette") {
        let draft = str_of(&case["draft"]);
        m.expect(
            || format!("palette {draft:?}"),
            palette_json(&flags_of(&json!({}), &[], draft, "", None)),
            case["out"].clone(),
        );
    }
    for case in golden["registry"]["suppressed"].as_array().expect("suppressed") {
        let (draft, dismissed) = (str_of(&case["draft"]), str_of(&case["dismissed"]));
        m.expect(
            || format!("palette {draft:?} {} dismissed {dismissed:?}", case["flags"]),
            palette_json(&flags_of(&case["flags"], &[], draft, dismissed, None)),
            case["out"].clone(),
        );
    }
    m.finish("command palette");
}

#[test]
fn skill_mentions_agree_with_node_at_every_caret() {
    let golden = golden();
    let skills = &golden["skills"];
    let fixture: Vec<Value> = skills["fixture"].as_array().expect("fixture").clone();
    let mut m = Mismatches::default();
    for case in skills["query"].as_array().expect("query") {
        let (draft, caret) = (str_of(&case["draft"]), caret_of(&case["caret"]));
        let got = skill_mention_query(draft, caret)
            .map_or(Value::Null, |q| json!({"query": q.query, "start": q.start, "end": q.end}));
        m.expect(|| format!("query {draft:?} {caret:?}"), got, case["out"].clone());
    }
    for case in skills["items"].as_array().expect("items") {
        let query = str_of(&case["query"]);
        let got: Vec<Value> = skill_mention_items(&fixture, query).iter().map(item_json).collect();
        m.expect(|| format!("items {query:?}"), Value::Array(got), case["out"].clone());
    }
    for case in skills["complete"].as_array().expect("complete") {
        let (draft, name, caret) = (str_of(&case["draft"]), str_of(&case["name"]), caret_of(&case["caret"]));
        let got = complete_skill_mention(draft, name, caret)
            .map_or(Value::Null, |c| json!({"value": c.value, "cursor": c.cursor}));
        let want = case.get("out").cloned().unwrap_or(Value::Null);
        m.expect(|| format!("complete {draft:?} {name:?} {caret:?}"), got, want);
    }
    for case in skills["palette"].as_array().expect("palette") {
        let (draft, dismissed, caret) = (str_of(&case["draft"]), str_of(&case["dismissed"]), caret_of(&case["caret"]));
        m.expect(
            || format!("palette {draft:?} {caret:?} dismissed {dismissed:?}"),
            palette_json(&flags_of(&json!({}), &fixture, draft, dismissed, caret)),
            case["out"].clone(),
        );
    }
    for case in skills["paletteSuppressed"].as_array().expect("paletteSuppressed") {
        let draft = str_of(&case["draft"]);
        m.expect(
            || format!("palette {draft:?} {}", case["flags"]),
            palette_json(&flags_of(&case["flags"], &fixture, draft, "", None)),
            case["out"].clone(),
        );
    }
    m.finish("skill mentions");
}

#[test]
fn the_parsers_agree_with_node() {
    let golden = golden();
    let parsers = &golden["parsers"];
    let text_of = |case: &Value| str_of(&case["text"]).to_owned();
    let mut m = Mismatches::default();
    for case in parsers["mcp"].as_array().expect("mcp") {
        let got = match parse_mcp_server_input(&text_of(case)) {
            Ok(server) => json!({"server": server}),
            Err(error) => json!({"error": error}),
        };
        m.expect(|| format!("mcp {}", case["text"]), got, case["out"].clone());
    }
    for case in parsers["skill"].as_array().expect("skill") {
        let got = match parse_skill_input(&text_of(case)) {
            Ok(skill) => json!({"skill": skill}),
            Err(error) => json!({"error": error}),
        };
        m.expect(|| format!("skill {}", case["text"]), got, case["out"].clone());
    }
    for case in parsers["memoryCommand"].as_array().expect("memoryCommand") {
        m.expect(|| format!("memory {}", case["text"]), parse_memory_command(&text_of(case)), case["out"].clone());
    }
    for case in parsers["memoryRows"].as_array().expect("memoryRows") {
        m.expect(
            || format!("rows {}", case["text"]),
            Value::Array(parse_memory_core_rows(&text_of(case))),
            case["out"].clone(),
        );
    }
    for case in parsers["coreError"].as_array().expect("coreError") {
        m.expect(
            || format!("core error {}", case["text"]),
            string_or_null(memory_core_result_error_text(&text_of(case))),
            case["out"].clone(),
        );
    }
    for case in parsers["textEntry"].as_array().expect("textEntry") {
        m.expect(
            || format!("clears by empty {}", case["kind"]),
            text_entry_clears_by_empty(str_of(&case["kind"])),
            case["out"].as_bool().unwrap_or(false),
        );
    }
    for case in parsers["canSubmit"].as_array().expect("canSubmit") {
        let allow = case["allowEmpty"].as_bool().unwrap_or(false);
        m.expect(
            || format!("can submit {} {}", case["value"], case["allowEmpty"]),
            can_submit_text_entry(str_of(&case["value"]), allow),
            case["out"].as_bool().unwrap_or(false),
        );
    }
    m.finish("parsers");
}

#[test]
fn every_scenario_makes_the_same_calls_notices_and_prompt_changes_as_node() {
    let golden = golden();
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() > 100);
    let mut m = Mismatches::default();
    for scenario in scenarios {
        let name = str_of(&scenario["name"]).to_owned();
        let spec = &scenario["spec"];
        let outcome = play(spec);
        let unordered = spec.get("unordered").and_then(Value::as_bool).unwrap_or(false);
        let canonical = |mut entries: Vec<Value>| {
            if unordered {
                entries.sort_by_key(Value::to_string);
            }
            entries
        };
        let want_log = canonical(scenario["log"].as_array().cloned().unwrap_or_default());
        let got_log = canonical(outcome.log);
        // The first differing entry says more than two whole logs.
        let first_difference = got_log.iter().zip(&want_log).position(|(got, want)| got != want);
        m.expect(
            || {
                format!(
                    "{name} log (first difference at {first_difference:?}: got {:?}, want {:?})",
                    first_difference.map(|at| &got_log[at]),
                    first_difference.map(|at| &want_log[at])
                )
            },
            got_log.len(),
            want_log.len(),
        );
        m.expect(|| format!("{name} log entries"), first_difference, None);
        m.expect(|| format!("{name} paste"), Value::Array(outcome.paste), scenario["paste"].clone());
        m.expect(|| format!("{name} returns"), Value::Array(outcome.returns), scenario["returns"].clone());
    }
    m.finish("scenarios");
}
