//! The slash command registry (`SLASH_COMMANDS`, `tui/app/slash-commands.mjs`) and the pure lookups over it: the
//! token a prompt runs, the canonical name of an alias and the argument hint of the resolved command, plus the
//! `/btw` panel's scroll rules (`tui/app/btw-controller.mjs`).

// Only the token lookup is called by the core's queue; the hint, alias and `/btw` rules are the Node client's behaviour that its
// recording pins (`slash_commands_tests.rs`), kept here so a Rust client has one implementation.
#![cfg_attr(not(test), allow(dead_code))]

use serde_json::Value;

pub(crate) struct Command {
    pub name: &'static str,
    pub usage: &'static str,
    pub aliases: &'static [&'static str],
    pub params: Option<&'static str>,
}

const fn command(name: &'static str, usage: &'static str, aliases: &'static [&'static str], params: Option<&'static str>) -> Command {
    Command { name, usage, aliases, params }
}

pub(crate) const COMMANDS: &[Command] = &[
    command("clear", "/clear", &["new"], None),
    command("project", "/project", &["projects"], Some("[path]")),
    command("compact", "/compact", &[], None),
    command("btw", "/btw", &[], Some("<question>")),
    command("goal", "/goal", &[], Some("[objective --time 1h|status|pause|resume|edit|stop]")),
    command("autoclear", "/autoclear", &[], Some("[on|off|duration|unlimited]")),
    command("resume", "/resume", &[], Some("[id]")),
    command("context", "/context", &[], None),
    command("shells", "/shells", &[], Some("[release <task_id> [--confirm]]")),
    command("stop", "/stop", &[], None),
    command("fork", "/fork", &["inherit"], None),
    command("usage", "/usage", &[], Some("[refresh]")),
    command("model", "/model", &[], Some("[name|refresh]")),
    command("websearch", "/websearch", &[], None),
    command("workflow", "/workflow", &[], Some("[name]")),
    command("outputstyle", "/OutputStyle", &["output-style", "style"], Some("[name]")),
    command("theme", "/theme", &[], Some("[id]")),
    command("agents", "/agents", &[], Some("[refresh]")),
    command("effort", "/effort", &[], Some("[level]")),
    command("fast", "/fast", &[], Some("[on|off|ultra]")),
    command("mcp", "/mcp", &[], Some("[login|logout <name>]")),
    command("skills", "/skills", &[], None),
    command("memory", "/memory", &[], Some("[status|core ...]")),
    command("plugins", "/plugins", &[], None),
    command("providers", "/providers", &[], None),
    command("settings", "/setting", &["setting", "config"], None),
    command("profile", "/profile", &[], None),
    command("update", "/update", &[], None),
    command("doctor", "/doctor", &[], None),
    command("quit", "/quit", &["exit", "q"], None),
];

/// `SLASH_COMMAND_BY_TOKEN`: the first registered command whose name or alias is `token`.
fn by_token(token: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == token || c.aliases.contains(&token))
}

/// Whether `token` names a registered command or alias.
pub(crate) fn is_token(token: &str) -> bool {
    by_token(token).is_some()
}

/// `normalizeSlashCommandName`: the canonical name of a command or alias, lower-cased; an unknown name stays as typed (lower-cased).
pub(crate) fn normalize_slash_command_name(name: &str) -> String {
    let name = mixdog_js::js_to_lowercase(name);
    by_token(&name).map_or(name, |c| c.name.to_owned())
}

/// `slashArgumentHint`: for `/name ` (a trailing space, nothing after it) the usage and parameters of the resolved command.
pub(crate) fn slash_argument_hint(value: &str) -> String {
    let Some(rest) = value.strip_prefix('/') else { return String::new() };
    let name_end = rest.find(mixdog_js::is_js_space).unwrap_or(rest.len());
    let (name, tail) = rest.split_at(name_end);
    if name.is_empty() || tail.is_empty() || !tail.chars().all(mixdog_js::is_js_space) {
        return String::new();
    }
    let canonical = normalize_slash_command_name(name);
    COMMANDS
        .iter()
        .find(|c| c.name == canonical)
        .and_then(|c| c.params.map(|params| format!("{} {params}", c.usage)))
        .unwrap_or_default()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `overlayBlocksGlobalTranscriptScroll`: a prompt-owned overlay absorbs PageUp/PageDown and wheel scroll.
pub(crate) fn overlay_blocks_global_transcript_scroll(owner: &Value) -> bool {
    ["slashPaletteOpen", "picker", "toolApproval", "contextPanel", "usagePanel", "btwPanel", "providerPrompt", "settingsPrompt"]
        .iter()
        .any(|key| truthy(owner.get(*key)))
}

/// `BTW_CHROME_ROWS`: border (2) + header (1) + footer (1).
pub(crate) const BTW_CHROME_ROWS: i64 = 4;

const BTW_MAX_BODY_ROWS: i64 = 10;

/// `btwPanelRows` of a panel whose answer body takes `content_rows` rendered rows (the markdown measurement is the TUI's).
pub(crate) fn btw_panel_rows(content_rows: i64) -> i64 {
    BTW_CHROME_ROWS + content_rows.min(BTW_MAX_BODY_ROWS)
}

/// `btwScrollMax`: the largest scroll offset for `total` content rows shown through `visible` rows.
pub(crate) fn btw_scroll_max(total: i64, visible: i64) -> i64 {
    (total - visible.max(1)).max(0)
}

/// `btwScrollOffset`: the next offset for a key (`pageUp` and `pageDown` truthy as in the key object; other keys keep it).
pub(crate) fn btw_scroll_offset(key: &Value, offset: i64, visible: i64, total: i64) -> i64 {
    let max = btw_scroll_max(total, visible);
    let page = (visible - 1).max(1);
    if truthy(key.get("pageUp")) {
        return (offset.min(max) - page).max(0);
    }
    if truthy(key.get("pageDown")) {
        return max.min(offset + page);
    }
    max.min(offset)
}
