//! The `/command` registry and the pure string and matching helpers over it (`src/tui/app/slash-commands.mjs`).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{is_js_space, js_to_lowercase, js_trim, js_trim_start, locale_compare_en_base};

/// One registered command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: &'static str,
    pub usage: &'static str,
    pub aliases: &'static [&'static str],
    /// The alias spellings the help lists (`aliasUsage`).
    pub alias_usage: &'static [&'static str],
    /// `showAliasUsage: false` hides the alias spellings in the help; absent means shown.
    pub show_alias_usage: Option<bool>,
    pub params: Option<&'static str>,
    pub description: &'static str,
}

const fn command(name: &'static str, usage: &'static str, description: &'static str) -> SlashCommand {
    SlashCommand { name, usage, aliases: &[], alias_usage: &[], show_alias_usage: None, params: None, description }
}

const fn with_params(mut entry: SlashCommand, params: &'static str) -> SlashCommand {
    entry.params = Some(params);
    entry
}

const fn with_aliases(
    mut entry: SlashCommand,
    aliases: &'static [&'static str],
    alias_usage: &'static [&'static str],
    show_alias_usage: Option<bool>,
) -> SlashCommand {
    entry.aliases = aliases;
    entry.alias_usage = alias_usage;
    entry.show_alias_usage = show_alias_usage;
    entry
}

/// The registry, in the order of `SLASH_COMMANDS`.
pub static SLASH_COMMANDS: &[SlashCommand] = &[
    with_aliases(command("clear", "/clear", "Start a fresh chat"), &["new"], &["new"], None),
    with_params(
        with_aliases(
            command("project", "/project", "Switch working directory (project)"),
            &["projects"],
            &["projects"],
            Some(false),
        ),
        "[path]",
    ),
    command("compact", "/compact", "Compact older conversation context"),
    with_params(
        command("btw", "/btw", "Ask a quick side question without interrupting the current work"),
        "<question>",
    ),
    with_params(
        command("goal", "/goal", "Run and manage a durable session Goal"),
        "[objective --time 1h|status|pause|resume|edit|stop]",
    ),
    with_params(
        command("autoclear", "/autoclear", "Reduce cache-miss cost after long idle gaps"),
        "[on|off|duration|unlimited]",
    ),
    with_params(command("resume", "/resume", "Resume a saved chat"), "[id]"),
    command("context", "/context", "Show current context surface"),
    with_params(
        command("shells", "/shells", "List shells; release one whose termination is unconfirmed"),
        "[release <task_id> [--confirm]]",
    ),
    command("stop", "/stop", "Stop every background shell of this session"),
    with_aliases(
        command("fork", "/fork", "Fork this conversation into a new session on the current model"),
        &["inherit"],
        &["inherit"],
        Some(false),
    ),
    with_params(command("usage", "/usage", "Show total provider quota / balance"), "[refresh]"),
    with_params(command("model", "/model", "Switch model for subsequent turns"), "[name|refresh]"),
    command("websearch", "/websearch", "Set the web search provider/model"),
    with_params(command("workflow", "/workflow", "Switch the active workflow"), "[name]"),
    with_params(
        with_aliases(
            command("outputstyle", "/OutputStyle", "Switch Lead output style"),
            &["output-style", "style"],
            &["style"],
            Some(false),
        ),
        "[name]",
    ),
    with_params(command("theme", "/theme", "Change the TUI color theme"), "[id]"),
    with_params(command("agents", "/agents", "Show available workflow agents"), "[refresh]"),
    with_params(command("effort", "/effort", "Set reasoning effort for the current model"), "[level]"),
    with_params(command("fast", "/fast", "Set Fast or Ultrafast mode for the current model"), "[on|off|ultra]"),
    with_params(command("mcp", "/mcp", "Manage MCP servers and tools"), "[login|logout <name>]"),
    command("skills", "/skills", "Choose a skill for the next request"),
    with_params(command("memory", "/memory", "List and edit core memories"), "[status|core ...]"),
    command("plugins", "/plugins", "Manage local plugin integrations"),
    command("providers", "/providers", "Manage auth, API keys, OAuth, and local endpoints"),
    with_aliases(
        command("settings", "/setting", "Open runtime settings"),
        &["setting", "config"],
        &["settings", "config"],
        Some(false),
    ),
    command("profile", "/profile", "Set your title, development experience, and response language"),
    command("update", "/update", "Check version and update mixdog"),
    command("doctor", "/doctor", "Diagnose installation health"),
    with_aliases(command("quit", "/quit", "Quit the TUI"), &["exit", "q"], &["exit", "q"], None),
];

/// `slashQuery(value)`: the lowercased text after the `/` when the whole value is one `/token`, else `None`.
pub fn slash_query(value: &str) -> Option<String> {
    let rest = value.strip_prefix('/')?;
    if rest.chars().any(is_js_space) {
        return None;
    }
    Some(js_to_lowercase(rest))
}

/// `slashCommandMatches(command, query)`: the name or an alias starts with the query (every command for an empty query).
pub fn slash_command_matches(command: &SlashCommand, query: &str) -> bool {
    let needle = js_to_lowercase(query);
    if needle.is_empty() {
        return true;
    }
    if js_to_lowercase(command.name).starts_with(&needle) {
        return true;
    }
    command.aliases.iter().any(|alias| js_to_lowercase(alias).starts_with(&needle))
}

/// `compareSlashCommands(a, b)`: the palette order, `localeCompare('en', { sensitivity: 'base' })` on the names.
pub fn compare_slash_commands(a: &SlashCommand, b: &SlashCommand) -> Ordering {
    locale_compare_en_base(a.name, b.name)
}

/// What owns the floating area (`overlayBlocksGlobalTranscriptScroll`'s argument).
#[derive(Clone, Copy, Debug, Default)]
pub struct OverlayOwner {
    pub slash_palette_open: bool,
    pub picker: bool,
    pub tool_approval: bool,
    pub context_panel: bool,
    pub usage_panel: bool,
    pub btw_panel: bool,
    pub provider_prompt: bool,
    pub settings_prompt: bool,
}

/// Prompt-owned overlays absorb PageUp/PageDown and wheel scroll instead of the transcript.
pub fn overlay_blocks_global_transcript_scroll(owner: OverlayOwner) -> bool {
    owner.slash_palette_open
        || owner.picker
        || owner.tool_approval
        || owner.context_panel
        || owner.usage_panel
        || owner.btw_panel
        || owner.provider_prompt
        || owner.settings_prompt
}

// Name/alias lookups run per keystroke, so the registry is indexed once. First registration wins.
static BY_NAME: LazyLock<HashMap<&'static str, &'static SlashCommand>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    for entry in SLASH_COMMANDS {
        map.entry(entry.name).or_insert(entry);
    }
    map
});

static BY_TOKEN: LazyLock<HashMap<&'static str, &'static SlashCommand>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    for entry in SLASH_COMMANDS {
        for token in std::iter::once(&entry.name).chain(entry.aliases.iter()) {
            map.entry(*token).or_insert(entry);
        }
    }
    map
});

/// `recognisedSlashToken(text)`: the lowercased first token of the text (leading white space allowed) when it begins with `/`
/// and names a command or alias; any other leading `/` is ordinary message text.
pub fn recognised_slash_token(text: &str) -> Option<String> {
    let rest = js_trim_start(text).strip_prefix('/')?;
    let token: String = rest.chars().take_while(|c| !is_js_space(*c)).collect();
    if token.is_empty() {
        return None;
    }
    let token = js_to_lowercase(&token);
    BY_TOKEN.contains_key(token.as_str()).then_some(token)
}

/// `recognisedAgentRoomSlash(text)`: the only commands a bot's conversation room runs, by their literal name.
pub fn recognised_agent_room_slash(text: &str) -> bool {
    matches!(recognised_slash_token(text).as_deref(), Some("compact" | "clear"))
}

/// `normalizeSlashCommandName(cmd)`: the canonical name of a command or alias; an unknown name stays as typed (lowercased).
pub fn normalize_slash_command_name(cmd: &str) -> String {
    let name = js_to_lowercase(cmd);
    BY_TOKEN.get(name.as_str()).map_or(name, |entry| entry.name.to_owned())
}

/// `slashCommandTokenForPaletteAccept(command, draftValue)`: the token a palette accept inserts: the spelling already typed
/// when it is the name or an alias (so `/new` stays `/new`), else the canonical name.
pub fn slash_command_token_for_palette_accept(command: &SlashCommand, draft_value: &str) -> String {
    let text = js_trim(draft_value);
    let typed = text
        .strip_prefix('/')
        .map(|rest| js_to_lowercase(rest.split(is_js_space).next().unwrap_or("")))
        .unwrap_or_default();
    let canonical = js_to_lowercase(command.name);
    if !typed.is_empty() && (typed == canonical || command.aliases.iter().any(|alias| js_to_lowercase(alias) == typed))
    {
        return typed;
    }
    command.name.to_owned()
}

/// The registered command a canonical-or-alias name resolves to.
pub fn slash_command_for_name(cmd: &str) -> Option<&'static SlashCommand> {
    BY_NAME.get(normalize_slash_command_name(cmd).as_str()).copied()
}

/// `slashArgumentHint(value)`: `/usage params` when the value is exactly `/command` and white space.
pub fn slash_argument_hint(value: &str) -> String {
    let Some(rest) = value.strip_prefix('/') else { return String::new() };
    let name: String = rest.chars().take_while(|c| !is_js_space(*c)).collect();
    let tail = &rest[name.len()..];
    if name.is_empty() || tail.is_empty() || !tail.chars().all(is_js_space) {
        return String::new();
    }
    match slash_command_for_name(&name).and_then(|entry| entry.params.map(|params| (entry, params))) {
        Some((entry, params)) => format!("{} {}", entry.usage, params),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_name_resolves_through_its_aliases_and_an_unknown_one_stays_as_typed() {
        assert_eq!(normalize_slash_command_name("clear"), "clear");
        assert_eq!(normalize_slash_command_name("NEW"), "clear");
        assert_eq!(normalize_slash_command_name("Projects"), "project");
        assert_eq!(normalize_slash_command_name("nope"), "nope");
        assert_eq!(normalize_slash_command_name(""), "");
    }

    #[test]
    fn an_open_btw_panel_owns_paging_and_wheel_scroll() {
        assert!(overlay_blocks_global_transcript_scroll(OverlayOwner { btw_panel: true, ..OverlayOwner::default() }));
        assert!(!overlay_blocks_global_transcript_scroll(OverlayOwner::default()));
    }

    #[test]
    fn the_argument_hint_comes_from_the_resolved_command_only_after_a_trailing_space() {
        assert_eq!(slash_argument_hint("/model "), "/model [name|refresh]");
        assert_eq!(slash_argument_hint("/autoclear "), "/autoclear [on|off|duration|unlimited]");
        assert_eq!(slash_argument_hint("/projects "), "/project [path]");
        assert_eq!(slash_argument_hint("/clear "), "");
        assert_eq!(slash_argument_hint("/nope "), "");
        assert_eq!(slash_argument_hint("/model"), "");
        assert_eq!(slash_argument_hint("/model x "), "");
        assert_eq!(slash_argument_hint(""), "");
    }

    #[test]
    fn the_registry_has_unique_tokens_and_the_palette_order_is_alphabetical() {
        let mut seen = std::collections::HashSet::new();
        for entry in SLASH_COMMANDS {
            for token in std::iter::once(&entry.name).chain(entry.aliases.iter()) {
                assert!(seen.insert(*token), "{token}");
            }
        }
        let mut sorted: Vec<&SlashCommand> = SLASH_COMMANDS.iter().collect();
        sorted.sort_by(|a, b| compare_slash_commands(a, b));
        assert_eq!(SLASH_COMMANDS.len(), 30);
        assert_eq!(sorted[0].name, "agents");
        assert_eq!(sorted[sorted.len() - 1].name, "workflow");
    }

    #[test]
    fn the_recognised_token_follows_the_renderer_rule() {
        assert_eq!(recognised_slash_token("  /NEW now").as_deref(), Some("new"));
        assert_eq!(recognised_slash_token("/usr/bin/x"), None);
        assert_eq!(recognised_slash_token("plain"), None);
        assert!(recognised_agent_room_slash("/compact"));
        assert!(recognised_agent_room_slash("/clear x"));
        assert!(!recognised_agent_room_slash("/new"));
    }

    #[test]
    fn palette_accept_keeps_the_typed_alias_and_otherwise_the_canonical_name() {
        let clear = &SLASH_COMMANDS[0];
        assert_eq!(slash_command_token_for_palette_accept(clear, "/NEW"), "new");
        assert_eq!(slash_command_token_for_palette_accept(clear, "/ne"), "clear");
        assert_eq!(slash_command_token_for_palette_accept(clear, ""), "clear");
    }

    #[test]
    fn slash_query_needs_one_token() {
        assert_eq!(slash_query("/Mo").as_deref(), Some("mo"));
        assert_eq!(slash_query("/"), Some(String::new()));
        assert_eq!(slash_query("/a b"), None);
        assert_eq!(slash_query("a"), None);
    }
}
