//! The effective MCP server set: the servers a user configured plus the servers each registered plugin declares, under the names the
//! plugins give them, with the plugin's folders filled into their placeholders, and the intent a user records (off, an alias) kept in
//! the config apart from what the plugin declares.

use std::path::PathBuf;

use mixdog_mcp::plugin_servers::Declared;
use mixdog_mcp::plugin_servers::declared_mcp_transport;
use mixdog_mcp::plugin_servers::plugin_mcp_server_base_name;
use mixdog_mcp::plugin_servers::plugin_server_env;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use mixdog_mcp::plugin_servers::resolve_plugin_placeholders;
use mixdog_mcp::plugin_servers::with_plugin_server_intent;
use mixdog_mcp::plugin_servers::without_plugin_intents;
use mixdog_mcp::plugins::DeclaredServer;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn plugin(id: &str, name: &str, root: &str, enabled: bool) -> Value {
    json!({"id": id, "name": name, "root": root, "enabled": enabled})
}

fn declaring(plugin: Value, format: &'static str, servers: &[(&str, Value)]) -> Declared {
    let servers = servers
        .iter()
        .map(|(key, config)| DeclaredServer { key: (*key).to_owned(), config: config.clone(), source: PathBuf::from("/plugins/alpha/.mcp.json") })
        .collect();
    Declared { plugin, missing: false, format, servers, errors: Vec::new() }
}

#[test]
fn a_plugin_servers_name_is_its_plugin_and_its_key_without_the_hash_of_its_source() {
    assert_eq!(plugin_mcp_server_base_name("alpha-plugin-536a8a2d", "search"), "plugin-alpha-plugin-search");
    assert_eq!(plugin_mcp_server_base_name("beta", "b"), "plugin-beta-b", "an id with no hash is used whole");
    assert_eq!(plugin_mcp_server_base_name("alpha-536a8a2d", "alpha"), "plugin-alpha", "a key that repeats the plugin is dropped");
    assert_eq!(plugin_mcp_server_base_name("alpha-536a8a2d", ""), "plugin-alpha-mcp");
    assert_eq!(plugin_mcp_server_base_name("My Plugin!!-0123abcd", "Tool.One"), "plugin-my-plugin-tool-one");
}

#[test]
fn a_name_over_thirty_two_characters_is_cut_and_ends_in_a_hash_of_its_plugin_and_key() {
    let long = plugin_mcp_server_base_name("a-very-long-plugin-name-here-536a8a2d", "an-equally-long-server-key");
    assert!(long.len() <= 32, "{long}");
    assert!(long.starts_with("plugin-a-very-long-plug"), "{long}");
    let (head, hash) = long.rsplit_once('-').unwrap();
    assert!(hash.len() == 8 && hash.chars().all(|c| c.is_ascii_hexdigit()) && !head.ends_with('-'), "{long}");
    assert_eq!(
        long,
        plugin_mcp_server_base_name("a-very-long-plugin-name-here-536a8a2d", "an-equally-long-server-key"),
        "the same plugin and key give the same name"
    );
    assert_ne!(long, plugin_mcp_server_base_name("a-very-long-plugin-name-here-536a8a2d", "an-equally-long-server-kez"));
}

#[test]
fn a_servers_transport_is_the_one_it_names_or_http_for_a_url_and_stdio_otherwise() {
    let kind = |config: Value| declared_mcp_transport(&object(config));
    assert_eq!(kind(json!({"command": "x"})).as_deref(), Some("stdio"));
    assert_eq!(kind(json!({"url": "https://x.example"})).as_deref(), Some("http"));
    assert_eq!(kind(json!({"transport": "http", "command": "x"})).as_deref(), Some("http"));
    assert_eq!(kind(json!({"url": "https://x.example", "command": "x"})).as_deref(), Some("stdio"), "a command wins over a url when no type is given");
    assert_eq!(kind(json!({})).as_deref(), Some("stdio"));
    assert_eq!(kind(json!({"type": "SSE", "url": "u"})).as_deref(), Some("sse"));
    assert_eq!(kind(json!({"type": "streamableHttp"})).as_deref(), Some("streamable-http"));
    assert_eq!(kind(json!({"type": "carrier-pigeon"})), None);
}

#[test]
fn plugin_folders_are_filled_into_the_placeholders_of_the_launch_fields_only() {
    let config = object(json!({
        "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/s.js", "${PLUGIN_DATA}/x", "${UNKNOWN}"], "cwd": "${MIXDOG_PLUGIN_ROOT}",
        "env": {"HOME_DIR": "${CODEX_PLUGIN_ROOT}"}, "url": "https://x/${PLUGIN_ROOT}", "headers": {"X": "${CLAUDE_PLUGIN_DATA}"}, "name": "${CLAUDE_PLUGIN_ROOT}"
    }));
    let resolved = resolve_plugin_placeholders(&config, "/plugins/alpha", "/data/alpha");
    assert_eq!(resolved["args"], json!(["/plugins/alpha/s.js", "/data/alpha/x", "${UNKNOWN}"]));
    assert_eq!(resolved["cwd"], "/plugins/alpha");
    assert_eq!(resolved["env"], json!({"HOME_DIR": "/plugins/alpha"}));
    assert_eq!((resolved["url"].as_str(), resolved["headers"].clone()), (Some("https://x//plugins/alpha"), json!({"X": "/data/alpha"})));
    assert_eq!(resolved["name"], "${CLAUDE_PLUGIN_ROOT}", "a field that is not a launch field is left as written");
    // A folder that is not supplied leaves its placeholders as written.
    let no_data = resolve_plugin_placeholders(&object(json!({"command": "${CLAUDE_PLUGIN_DATA}/run"})), "/plugins/alpha", "");
    assert_eq!(no_data["command"], "${CLAUDE_PLUGIN_DATA}/run");
}

#[test]
fn a_plugin_server_process_is_told_its_plugin_and_data_folders_in_three_spellings_each() {
    let env = plugin_server_env("/plugins/alpha", "/data/alpha");
    for name in ["CLAUDE_PLUGIN_ROOT", "MIXDOG_PLUGIN_ROOT", "PLUGIN_ROOT"] {
        assert_eq!(env[name], "/plugins/alpha", "{name}");
    }
    for name in ["CLAUDE_PLUGIN_DATA", "MIXDOG_PLUGIN_DATA", "PLUGIN_DATA"] {
        assert_eq!(env[name], "/data/alpha", "{name}");
    }
    assert_eq!(plugin_server_env("", "").len(), 0);
}

#[test]
fn the_catalog_lists_configured_servers_first_then_each_plugins_under_its_generated_name() {
    let config = json!({"mcpServers": {"plain": {"command": "z"}}});
    let declared = [declaring(
        plugin("alpha-plugin-536a8a2d", "alpha-plugin", "/plugins/alpha", true),
        "claude",
        &[("search", json!({"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/s.js"]}))],
    )];
    let catalog = resolve_mcp_server_catalog(&config, &declared, "/work", "/data");
    let names: Vec<&str> = catalog.servers.keys().map(String::as_str).collect();
    assert_eq!(names, ["plain", "plugin-alpha-plugin-search"]);
    assert_eq!((catalog.sources["plain"].as_str(), catalog.sources["plugin-alpha-plugin-search"].as_str()), (Some("config"), Some("plugin")));
    let server = &catalog.servers["plugin-alpha-plugin-search"];
    assert_eq!(server["args"], json!(["/plugins/alpha/s.js"]));
    assert_eq!(server["enabled"], true);
    assert_eq!(server["cwd"], "/work", "a plugin that does not set its folder works where the session does");
    assert_eq!(server["env"]["CLAUDE_PLUGIN_ROOT"], "/plugins/alpha");
    assert_eq!((server["_mixdogPlugin"]["id"].as_str(), server["_mixdogPlugin"]["key"].as_str()), (Some("alpha-plugin-536a8a2d"), Some("search")));
    assert_eq!(catalog.entries["plain"]["owner"], Value::Null);
    assert_eq!(catalog.entries["plugin-alpha-plugin-search"]["owner"]["kind"], "plugin");
    assert_eq!(catalog.plugins["alpha-plugin-536a8a2d"]["servers"], json!(["plugin-alpha-plugin-search"]));
}

#[test]
fn a_mixdog_plugin_server_runs_in_its_plugin_folder() {
    let declared = [declaring(plugin("alpha-536a8a2d", "alpha", "/plugins/alpha", true), "mixdog", &[("tool", json!({"command": "node"}))])];
    let catalog = resolve_mcp_server_catalog(&json!({}), &declared, "/work", "/data");
    assert_eq!(catalog.servers["plugin-alpha-tool"]["cwd"], "/plugins/alpha");
}

#[test]
fn a_disabled_plugin_or_a_server_the_user_switched_off_is_listed_as_disabled_and_the_intent_comes_and_goes_with_the_config() {
    let config = json!({});
    let declared = |enabled: bool| [declaring(plugin("alpha-536a8a2d", "alpha", "/plugins/alpha", enabled), "claude", &[("tool", json!({"command": "node"}))])];
    assert_eq!(resolve_mcp_server_catalog(&config, &declared(false), "/work", "/data").servers["plugin-alpha-tool"]["enabled"], false);

    let off = with_plugin_server_intent(&config, "alpha-536a8a2d", "tool", |mut intent| {
        intent.insert("enabled".to_owned(), json!(false));
        intent
    });
    assert_eq!(resolve_mcp_server_catalog(&off, &declared(true), "/work", "/data").servers["plugin-alpha-tool"]["enabled"], false);
    let restored = without_plugin_intents(&off, "alpha-536a8a2d");
    assert_eq!(resolve_mcp_server_catalog(&restored, &declared(true), "/work", "/data").servers["plugin-alpha-tool"]["enabled"], true);
    assert_eq!(off["mcpServers"], config["mcpServers"], "an intent changes nothing else in the config");
}

#[test]
fn a_server_whose_generated_name_is_taken_gets_a_hash_suffix_and_a_warning_and_the_configured_one_keeps_its_name() {
    let config = json!({"mcpServers": {"plugin-alpha-tool": {"command": "mine"}}});
    let declared = [declaring(plugin("alpha-536a8a2d", "alpha", "/plugins/alpha", true), "claude", &[("tool", json!({"command": "node"}))])];
    let catalog = resolve_mcp_server_catalog(&config, &declared, "/work", "/data");
    assert_eq!(catalog.servers["plugin-alpha-tool"]["command"], "mine");
    let renamed: Vec<&str> = catalog.servers.keys().map(String::as_str).filter(|name| *name != "plugin-alpha-tool").collect();
    let [name] = renamed.as_slice() else { panic!("{:?}", catalog.servers.keys().collect::<Vec<_>>()) };
    assert!(name.starts_with("plugin-alpha-tool-") && name.len() <= 32, "{name}");
    assert!(!catalog.warnings.is_empty(), "the clash is reported");
}
