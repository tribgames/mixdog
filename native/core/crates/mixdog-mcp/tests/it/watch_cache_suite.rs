//! The plugin declaration digest cache and the push-based skills watcher on real directories.
#![allow(clippy::disallowed_methods, reason = "test fixtures write and inspect directories directly")]

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::plugins::PluginMcpDeclarations;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_rt::LaneToken;
use mixdog_workspace::watcher::FolderWatcher;
use tokio_util::sync::CancellationToken;

async fn load(cache: &Arc<DeclarationCache>, root: &Path) -> PluginMcpDeclarations {
    let tokens = mixdog_rt::testing::tokens();
    let (cache, root) = (Arc::clone(cache), root.to_path_buf());
    tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| cache.load(lane, &root))
        .unwrap()
        .await
        .unwrap()
}

#[tokio::test]
async fn unchanged_files_serve_the_cache_and_any_edit_rereads() {
    let dir = tempfile::tempdir().unwrap();
    let mcp = dir.path().join(".mcp.json");
    std::fs::write(&mcp, r#"{"mcpServers":{"a":{"command":"x"}}}"#).unwrap();
    let cache = Arc::new(DeclarationCache::new());
    let first = load(&cache, dir.path()).await;
    assert_eq!(first.servers.len(), 1);
    assert_eq!(load(&cache, dir.path()).await, first);
    std::fs::write(&mcp, r#"{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}"#).unwrap();
    assert_eq!(load(&cache, dir.path()).await.servers.len(), 2);
    std::fs::remove_file(&mcp).unwrap();
    assert!(load(&cache, dir.path()).await.servers.is_empty());
}

#[tokio::test]
async fn a_file_the_manifest_points_at_appearing_later_invalidates() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugin.json"), r#"{"name":"p","mcpServers":"servers.json"}"#).unwrap();
    let cache = Arc::new(DeclarationCache::new());
    assert_eq!(load(&cache, dir.path()).await.errors.len(), 1);
    std::fs::write(dir.path().join("servers.json"), r#"{"s":{"command":"x"}}"#).unwrap();
    let after = load(&cache, dir.path()).await;
    assert!(after.errors.is_empty() && after.servers.len() == 1);
}

struct NoGit;

impl mixdog_mcp::plugin_admin::GitRunner for NoGit {
    fn run(&self, _: &[String], _: Duration) -> Result<String, String> {
        Err("git is not used".to_owned())
    }
}

struct NoSettings;

impl mixdog_mcp::skill_catalog::SkillSettingsSource for NoSettings {
    fn current(&self) -> mixdog_mcp::skill_catalog::SkillSettings {
        mixdog_mcp::skill_catalog::SkillSettings::default()
    }
}

/// The skill list follows outside edits: a skills root that does not exist when the list is first read, then a skill
/// created, edited and deleted by hand, with nothing but the watcher telling the catalog.
#[tokio::test(flavor = "multi_thread")]
async fn the_skill_list_follows_edits_made_outside_the_app() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let data = base.join("data");
    let admin = Arc::new(mixdog_mcp::plugin_admin::PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let defaults = base.join("defaults");
    let skills = Arc::new(SkillsWatch::new());
    let catalog = mixdog_mcp::skill_catalog::SkillCatalog::new(
        data.clone(),
        mixdog_rt::testing::tokens().maintenance_io,
        mixdog_mcp::mcp_glue::McpGlue::skill_roots(admin.clone(), defaults.clone()),
        Arc::new(NoSettings),
        &skills,
    );
    catalog.watch_roots(skills.clone(), mixdog_mcp::mcp_glue::McpGlue::skill_watch_targets(admin, defaults));
    skills.attach(Arc::new(FolderWatcher::new(skills.sink()).unwrap()));
    let mut changes = skills.subscribe();
    assert!(catalog.skills().await.unwrap().is_empty());

    let file = data.join("skills").join("alpha").join("SKILL.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "---\nname: alpha\ndescription: first\n---\nbody\n").unwrap();
    alpha_becomes(&catalog, &mut changes, Some("first")).await;
    std::fs::write(&file, "---\nname: alpha\ndescription: second\n---\nbody\n").unwrap();
    alpha_becomes(&catalog, &mut changes, Some("second")).await;
    // A peer writes an override without calling this service's cache invalidation.
    mixdog_mcp::skill_deps::save_skill_tool_dependencies(
        mixdog_rt::testing::tokens().durability_io,
        &data,
        &file,
        Some(&serde_json::json!([{"type": "tool", "value": "read"}])),
    ).await.unwrap();
    mixdog_rt::time::timeout(Duration::from_secs(10), async {
        while !catalog.skills().await.unwrap().iter().any(|s| s.tool_dependencies.manifest_names() == ["read"]) {
            changes.changed().await.unwrap();
        }
    }).await.expect("the peer's tool-link override is seen");
    std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    alpha_becomes(&catalog, &mut changes, None).await;
}

#[tokio::test]
async fn an_unwatched_catalog_rechecks_the_disk_on_its_next_read() {
    let base = tempfile::tempdir().unwrap();
    let data = base.path().join("data");
    let defaults = base.path().join("defaults");
    let admin = Arc::new(mixdog_mcp::plugin_admin::PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let watch = Arc::new(SkillsWatch::new());
    let catalog = mixdog_mcp::skill_catalog::SkillCatalog::new(
        data.clone(),
        mixdog_rt::testing::tokens().maintenance_io,
        mixdog_mcp::mcp_glue::McpGlue::skill_roots(admin.clone(), defaults.clone()),
        Arc::new(NoSettings),
        &watch,
    );
    catalog.watch_roots(watch, mixdog_mcp::mcp_glue::McpGlue::skill_watch_targets(admin, defaults));
    assert!(catalog.skills().await.unwrap().is_empty());
    let folder = data.join("skills").join("alpha");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("SKILL.md"), "---\nname: alpha\ndescription: first\n---\nbody\n").unwrap();
    let skills = catalog.skills().await.unwrap();
    assert_eq!(skills.iter().map(|skill| skill.name.as_str()).collect::<Vec<_>>(), ["alpha"]);
}

#[tokio::test]
async fn an_unconfigured_catalog_does_not_keep_a_stale_snapshot() {
    let base = tempfile::tempdir().unwrap();
    let data = base.path().join("data");
    let admin = Arc::new(mixdog_mcp::plugin_admin::PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let catalog = mixdog_mcp::skill_catalog::SkillCatalog::new(
        data.clone(),
        mixdog_rt::testing::tokens().maintenance_io,
        mixdog_mcp::mcp_glue::McpGlue::skill_roots(admin, base.path().join("defaults")),
        Arc::new(NoSettings),
        &SkillsWatch::new(),
    );
    assert!(catalog.skills().await.unwrap().is_empty());
    let folder = data.join("skills").join("alpha");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("SKILL.md"), "---\nname: alpha\ndescription: first\n---\nbody\n").unwrap();
    assert_eq!(catalog.skills().await.unwrap()[0].name, "alpha");
}

#[tokio::test]
async fn an_override_root_created_during_registration_does_not_leave_a_stale_catalog() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let base = tempfile::tempdir().unwrap();
    let data = base.path().canonicalize().unwrap().join("data");
    let folder = data.join("skills").join("alpha");
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join("SKILL.md");
    std::fs::write(&file, "---\nname: alpha\ndescription: alpha\n---\nbody\n").unwrap();
    let overrides = mixdog_mcp::skill_deps::dependencies_root(&data);
    let admin = Arc::new(mixdog_mcp::plugin_admin::PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let defaults = data.join("defaults");
    let watch = Arc::new(SkillsWatch::new());
    let tokens = mixdog_rt::testing::tokens();
    let catalog = mixdog_mcp::skill_catalog::SkillCatalog::new(
        data.clone(), tokens.maintenance_io,
        mixdog_mcp::mcp_glue::McpGlue::skill_roots(admin.clone(), defaults.clone()), Arc::new(NoSettings), &watch,
    );
    watch.attach(Arc::new(FolderWatcher::new(watch.sink()).unwrap()));
    let targets = mixdog_mcp::mcp_glue::McpGlue::skill_watch_targets(admin, defaults);
    let first = AtomicBool::new(true);
    catalog.watch_roots(watch, Arc::new(move |lane| {
        let sampled = targets(lane);
        if first.swap(false, Ordering::Relaxed) {
            std::fs::create_dir(&overrides).unwrap();
        }
        sampled
    }));
    assert!(catalog.skills().await.unwrap()[0].tool_dependencies.manifest_names().is_empty());
    mixdog_mcp::skill_deps::save_skill_tool_dependencies(
        tokens.durability_io, &data, &file, Some(&serde_json::json!([{"type": "tool", "value": "read"}])),
    ).await.unwrap();
    assert_eq!(catalog.skills().await.unwrap()[0].tool_dependencies.manifest_names(), ["read"]);
}

/// Editing a plugin's nested manifest (`.codex-plugin/plugin.json`) to add a skills root is seen: the manifest's folder is watched.
#[tokio::test(flavor = "multi_thread")]
async fn a_nested_manifest_edit_adding_a_skills_root_is_seen() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let data = base.join("data");
    let plugin = base.join("plug");
    let manifest = plugin.join(".codex-plugin").join("plugin.json");
    std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    std::fs::write(&manifest, r#"{"name":"p"}"#).unwrap();
    let skill = plugin.join("extra").join("beta").join("SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::write(&skill, "---\nname: beta\ndescription: b\n---\nbody\n").unwrap();
    std::fs::create_dir_all(data.join("plugins")).unwrap();
    std::fs::write(data.join("plugins").join("registry.json"), serde_json::json!({"plugins": [{"id": "p", "root": plugin.to_string_lossy(), "enabled": true}]}).to_string()).unwrap();
    let admin = Arc::new(mixdog_mcp::plugin_admin::PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let defaults = base.join("defaults");
    let skills = Arc::new(SkillsWatch::new());
    let catalog = mixdog_mcp::skill_catalog::SkillCatalog::new(
        data.clone(),
        mixdog_rt::testing::tokens().maintenance_io,
        mixdog_mcp::mcp_glue::McpGlue::skill_roots(admin.clone(), defaults.clone()),
        Arc::new(NoSettings),
        &skills,
    );
    catalog.watch_roots(skills.clone(), mixdog_mcp::mcp_glue::McpGlue::skill_watch_targets(admin, defaults));
    skills.attach(Arc::new(FolderWatcher::new(skills.sink()).unwrap()));
    let mut changes = skills.subscribe();
    assert!(catalog.skills().await.unwrap().is_empty());
    std::fs::write(&manifest, r#"{"name":"p","skills":"./extra/"}"#).unwrap();
    mixdog_rt::time::timeout(Duration::from_secs(10), async {
        while !catalog.skills().await.unwrap().iter().any(|s| s.name == "beta") {
            changes.changed().await.unwrap();
        }
    })
    .await
    .expect("the manifest edit is seen");
}

/// Reads the list (never the watcher's own state) until `alpha` has `description`, waiting for a pushed change between reads.
async fn alpha_becomes(catalog: &mixdog_mcp::skill_catalog::SkillCatalog, changes: &mut tokio::sync::watch::Receiver<u64>, description: Option<&str>) {
    mixdog_rt::time::timeout(Duration::from_secs(10), async {
        loop {
            let found = catalog.skills().await.unwrap().iter().find(|s| s.name == "alpha").map(|s| s.description.clone());
            if found.as_deref() == description {
                return;
            }
            changes.changed().await.unwrap();
        }
    })
    .await
    .expect("the catalog follows the change");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_written_under_a_watched_root_pushes_a_change() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let skills = SkillsWatch::new();
    let watcher = Arc::new(FolderWatcher::new(skills.sink()).unwrap());
    skills.attach(Arc::clone(&watcher));
    skills.set_roots(std::slice::from_ref(&root));
    let mut changes = skills.subscribe();
    std::fs::create_dir_all(root.join("alpha")).unwrap();
    std::fs::write(root.join("alpha").join("SKILL.md"), "---\nname: alpha\n---\n").unwrap();
    mixdog_rt::time::timeout(Duration::from_secs(10), changes.changed())
        .await
        .expect("the change is pushed")
        .unwrap();
    assert!(*changes.borrow() > 0);
}
