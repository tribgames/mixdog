//! The registered-plugin status list (Node `session-runtime/cwd-plugins/plugin-status.mjs`
//! `pluginsStatus()`): one row per registered plugin whose root exists, with its manifest fields,
//! skill count, hook files, MCP declaration (`discoverPluginMcp`) and the live state of the servers
//! it declares (`pluginMcpSummary`, which the host answers); the plugins whose root is gone are
//! `missing`. Skill count, MCP discovery and hook files are read on every call, so a file added or
//! removed shows at once. The registry entries come enriched from [`crate::plugin_admin`]; the
//! reads here go through the maintenance lane the caller holds.

use std::io;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use mixdog_statefile::list_dir;
use mixdog_statefile::metadata;
use mixdog_statefile::read_content;
use mixdog_statefile::symlink_metadata;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::declaration_cache::DeclarationCache;
use crate::extension_service::field;
use crate::hooks::PLUGIN_HOOK_FILES;
use crate::plugin_admin::clean;
use crate::plugin_admin::plugin_metadata;
use crate::plugin_admin::truthy;
use crate::plugins::MANIFEST_FILES;
use crate::plugins::PluginMcpDeclarations;
use crate::plugins::manifest;
use crate::plugins::resolve_contained;
use crate::plugins::skills_roots;

/// `join(root, ...rel.split('/'))`.
fn in_root(root: &Path, relative: &str) -> PathBuf {
    relative.split('/').fold(root.to_path_buf(), |path, part| path.join(part))
}

fn present(lane: &InLane<MaintenanceIo>, path: &Path) -> bool {
    metadata(lane, path).is_ok()
}

/// `/^(SKILL|skill)\.md$/i`.
fn is_skill_md(name: &str) -> bool {
    name.eq_ignore_ascii_case("skill.md")
}

/// The `SKILL.md` files under `dir`; a directory that cannot be read ends the walk (Node's throw).
fn walk(lane: &InLane<MaintenanceIo>, dir: &Path, count: &mut usize) -> io::Result<()> {
    for name in list_dir(lane, dir)? {
        let full = dir.join(&name);
        if symlink_metadata(lane, &full)?.is_dir() {
            walk(lane, &full, count)?;
        } else if is_skill_md(&name) {
            *count += 1;
        }
    }
    Ok(())
}

/// `countSkillFiles(root)`: the skill files under every skill root of the plugin. A root that is
/// a file counts when it is one; one that cannot be read keeps what was counted before the failure.
pub fn count_skill_files(lane: &InLane<MaintenanceIo>, root: &Path) -> usize {
    let mut count = 0;
    for skills_root in skills_roots(lane, root) {
        let Ok(meta) = metadata(lane, &skills_root) else { continue };
        if meta.is_file() {
            if skills_root.file_name().is_some_and(|name| is_skill_md(&name.to_string_lossy())) {
                count += 1;
            }
        } else if meta.is_dir() {
            // Node's try/catch: an unreadable directory is not an error of the status.
            let _ = walk(lane, &skills_root, &mut count);
        }
    }
    count
}

/// A manifest file that exists but is not a JSON object is breakage.
fn manifest_invalid(lane: &InLane<MaintenanceIo>, root: &Path) -> bool {
    MANIFEST_FILES.iter().any(|relative| {
        let file = in_root(root, relative);
        present(lane, &file)
            && !matches!(
                read_content(&file),
                Ok(Some(bytes)) if matches!(serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)), Ok(Value::Object(_)))
            )
    })
}

/// The manifest `mcpServers` when it is a path: read from the first manifest file that exists.
fn declared_path(lane: &InLane<MaintenanceIo>, root: &Path) -> Option<String> {
    let file = MANIFEST_FILES.iter().map(|relative| in_root(root, relative)).find(|file| present(lane, file))?;
    let bytes = read_content(&file).ok().flatten()?;
    let doc: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    doc.get("mcpServers")?.as_str().map(str::to_owned)
}

/// `discoverPluginMcp(root)`: where the declarations live, `(mcpScript, mcpInline)`.
fn discover_plugin_mcp(lane: &InLane<MaintenanceIo>, root: &Path, declared: &PluginMcpDeclarations) -> (Value, bool) {
    let servers = &declared.servers;
    if servers.is_empty() {
        return (Value::Null, false);
    }
    let manifests: Vec<PathBuf> = MANIFEST_FILES.iter().map(|relative| in_root(root, relative)).collect();
    if servers.iter().any(|server| manifests.contains(&server.source)) {
        return (Value::Null, true);
    }
    if let Some(path) = declared_path(lane, root).filter(|path| !js_trim(path).is_empty()) {
        let contained = resolve_contained(root, &path);
        if servers.iter().any(|server| contained.as_ref() == Some(&server.source)) {
            return (json!(js_trim(&path)), false);
        }
    }
    let mcp_json = root.join(".mcp.json");
    let file = servers.iter().find(|server| server.source != mcp_json).unwrap_or(&servers[0]);
    let relative = file.source.strip_prefix(root).unwrap_or_else(|_| unreachable!("a declaration source lies inside its plugin root"));
    let parts: Vec<String> = relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
    (json!(parts.join("/")), false)
}

/// The first of `candidates` that is not empty.
fn first<S: AsRef<str>>(candidates: &[S]) -> String {
    candidates.iter().find(|candidate| !candidate.as_ref().is_empty()).map(|candidate| candidate.as_ref().to_owned()).unwrap_or_default()
}

/// One server row of `pluginMcpSummary()` as the plugin row lists it.
fn server_row(row: &Value) -> Value {
    let owner = field(row, "owner");
    let key = field(owner, "key");
    let mut out = Map::new();
    out.insert("name".to_owned(), field(row, "name").clone());
    out.insert("key".to_owned(), if truthy(key) { key.clone() } else { json!("") });
    out.insert("enabled".to_owned(), json!(field(row, "enabled") != &Value::Bool(false)));
    out.insert("serverEnabled".to_owned(), json!(field(row, "serverEnabled") != &Value::Bool(false)));
    out.insert("connected".to_owned(), json!(field(row, "connected") == &Value::Bool(true)));
    if let Some(status) = row.get("status") {
        out.insert("status".to_owned(), status.clone());
    }
    let error = field(row, "error");
    out.insert("error".to_owned(), if truthy(error) { error.clone() } else { Value::Null });
    let warnings = field(row, "warnings");
    out.insert("warnings".to_owned(), if truthy(warnings) { warnings.clone() } else { json!([]) });
    out.insert("cwdDependent".to_owned(), json!(field(owner, "cwdDependent") == &Value::Bool(true)));
    Value::Object(out)
}

enum Registered {
    /// No root recorded: not listed at all.
    Skipped,
    Missing { id: String, name: String },
    Plugin(Map<String, Value>),
}

/// `registeredPlugin(entry, mcpByPlugin)`.
fn registered_plugin(lane: &InLane<MaintenanceIo>, declarations: &DeclarationCache, entry: &Value, summary: &Value) -> Registered {
    let root = clean(field(entry, "root"));
    if root.is_empty() {
        return Registered::Skipped;
    }
    let entry_id = clean(field(entry, "id"));
    let entry_name = clean(field(entry, "name"));
    let tail = root.rsplit(['/', '\\']).next().unwrap_or_default().to_owned();
    if field(entry, "exists") != &Value::Bool(true) {
        return Registered::Missing {
            id: first(&[&entry_id, &entry_name, &root]),
            name: first(&[&entry_name, &entry_id, &tail, &root]),
        };
    }
    let root_path = Path::new(&root);
    let (_, manifest_doc) = manifest(lane, root_path);
    let invalid = manifest_invalid(lane, root_path);
    let of_manifest = |key: &str| clean(field(&manifest_doc, key));
    let name = first(&[&of_manifest("name"), &of_manifest("id"), &entry_name, &tail, &root]);
    let id = first(&[&entry_id, &name]);
    let title = first(&[&of_manifest("title"), &of_manifest("displayName"), &clean(field(entry, "title")), &name]);
    let version = first(&[&of_manifest("version"), &clean(field(entry, "version"))]);
    let description = first(&[&of_manifest("description"), &clean(field(entry, "description"))]);
    let source_type = clean(field(entry, "sourceType"));
    let declared = declarations.load(lane, root_path);
    let (mcp_script, mcp_inline) = discover_plugin_mcp(lane, root_path, &declared);
    let skill_count = count_skill_files(lane, root_path);
    let hooks = PLUGIN_HOOK_FILES.iter().any(|relative| present(lane, &in_root(root_path, relative)));
    let enabled = field(entry, "enabled") != &Value::Bool(false);
    let or_null = |key: &str| {
        let value = field(entry, key);
        if truthy(value) { value.clone() } else { Value::Null }
    };

    let mut plugin = Map::new();
    plugin.insert("id".to_owned(), json!(id));
    plugin.insert("name".to_owned(), json!(name));
    plugin.insert("title".to_owned(), json!(title));
    plugin.insert("version".to_owned(), if version.is_empty() { Value::Null } else { json!(version) });
    plugin.insert("description".to_owned(), json!(description));
    for (key, value) in plugin_metadata(&manifest_doc) {
        plugin.insert(key.to_owned(), value);
    }
    plugin.insert("marketplace".to_owned(), Value::Null);
    plugin.insert("source".to_owned(), json!(if source_type == "local" { "local" } else { "registry" }));
    plugin.insert("sourceUrl".to_owned(), json!(clean(field(entry, "source"))));
    plugin.insert("sourceType".to_owned(), json!(if source_type.is_empty() { "git" } else { source_type.as_str() }));
    plugin.insert("managed".to_owned(), json!(field(entry, "managed") != &Value::Bool(false)));
    plugin.insert("enabled".to_owned(), json!(enabled));
    plugin.insert("root".to_owned(), json!(root));
    plugin.insert("installedAt".to_owned(), or_null("installedAt"));
    plugin.insert("updatedAt".to_owned(), or_null("updatedAt"));
    plugin.insert("skillCount".to_owned(), json!(skill_count));
    plugin.insert("hooks".to_owned(), json!(hooks));
    plugin.insert("mcpScript".to_owned(), mcp_script.clone());
    plugin.insert("mcpInline".to_owned(), json!(mcp_inline));
    if invalid {
        plugin.insert("invalid".to_owned(), json!(true));
    }
    if enabled && skill_count == 0 && mcp_script.is_null() && !mcp_inline && !hooks {
        let searched: Vec<String> = skills_roots(lane, root_path).iter().map(|path| path.to_string_lossy().into_owned()).collect();
        plugin.insert("searchedSkillRoots".to_owned(), json!(searched));
        plugin.insert("warning".to_owned(), json!(format!("No skills or MCP server found. Searched skill roots: {}", searched.join(", "))));
    }
    // The servers the plugin declares, live: name, declared key, intent/effective state, connection,
    // and declaration problems.
    let mcp = summary.get(&id).cloned().unwrap_or_else(|| json!({"format": "none", "errors": [], "servers": []}));
    plugin.insert("mcpFormat".to_owned(), field(&mcp, "format").clone());
    plugin.insert("mcpErrors".to_owned(), field(&mcp, "errors").clone());
    let servers: Vec<Value> = field(&mcp, "servers").as_array().into_iter().flatten().filter(|row| truthy(row)).map(server_row).collect();
    let first_name = servers.first().map(|server| field(server, "name")).filter(|name| truthy(name)).cloned().unwrap_or_else(|| json!(""));
    let any_enabled = servers.iter().any(|server| field(server, "serverEnabled") == &Value::Bool(true));
    plugin.insert("mcpServers".to_owned(), Value::Array(servers));
    plugin.insert("mcpServerName".to_owned(), first_name);
    plugin.insert("mcpEnabled".to_owned(), json!(any_enabled));
    Registered::Plugin(plugin)
}

/// `pluginsStatus()` over the registry status `admin` (`pluginAdminStatus`) and the MCP summary the
/// host read (`{ [pluginId]: { format, errors, servers } }`): `{ count, plugins, missing, roots }`,
/// the rows sorted by source then name.
pub fn plugins_status(lane: &InLane<MaintenanceIo>, declarations: &DeclarationCache, admin: &Value, summary: &Value) -> Value {
    let mut plugins: Vec<Map<String, Value>> = Vec::new();
    let mut missing = Vec::new();
    for entry in admin.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        match registered_plugin(lane, declarations, entry, summary) {
            Registered::Skipped => {}
            Registered::Missing { id, name } => missing.push(json!({"id": id, "name": name, "enabled": field(entry, "enabled") != &Value::Bool(false)})),
            Registered::Plugin(plugin) => plugins.push(plugin),
        }
    }
    let text = |plugin: &Map<String, Value>, key: &str| plugin.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    plugins.sort_by(|a, b| {
        let (source_a, source_b) = (text(a, "source"), text(b, "source"));
        if source_a != source_b { locale_compare(&source_a, &source_b) } else { locale_compare(&text(a, "name"), &text(b, "name")) }
    });
    json!({
        "count": plugins.len(),
        "plugins": plugins,
        "missing": missing,
        "roots": { "registry": field(admin, "registryPath"), "installed": field(admin, "installRoot") },
    })
}
