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

/// A skills root added ahead of another (plugin A's manifest gains one before plugin B's) leaves B's registration as it was: its
/// OS watch is never closed and reopened.
#[test]
fn a_root_added_ahead_of_another_keeps_the_other_watch() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let (a, added, b) = (base.join("a"), base.join("a-extra"), base.join("b"));
    for folder in [&a, &added, &b] {
        std::fs::create_dir_all(folder).unwrap();
    }
    let skills = SkillsWatch::new();
    let watcher = Arc::new(FolderWatcher::new(skills.sink()).unwrap());
    skills.attach(Arc::clone(&watcher));
    let targets = |deep: Vec<std::path::PathBuf>| mixdog_mcp::skills_watch::WatchTargets { deep, shallow: Vec::new() };
    assert!(skills.set_targets(&targets(vec![a.clone(), b.clone()])));
    let before = watcher.recursive_revision(&b).expect("b is watched");
    assert!(skills.set_targets(&targets(vec![a.clone(), added.clone(), b.clone()])));
    assert!(watcher.recursive_revision(&added).is_some());
    assert!(Arc::ptr_eq(&before, &watcher.recursive_revision(&b).expect("b is watched")), "b's watch was reopened");
}

/// A `git clone` that writes a plugin with one skill, named after the repository, into the target folder.
struct CloneGit;

impl mixdog_mcp::plugin_admin::GitRunner for CloneGit {
    fn run(&self, args: &[String], _: Duration) -> Result<String, String> {
        if let ["clone", .., url, temp] = args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
            let name = url.rsplit('/').next().unwrap().trim_end_matches(".git");
            let skill = Path::new(temp).join("skills").join(name);
            std::fs::create_dir_all(&skill).map_err(|e| e.to_string())?;
            std::fs::write(skill.join("SKILL.md"), format!("---\nname: {name}\ndescription: cloned\n---\nbody\n")).map_err(|e| e.to_string())?;
            std::fs::write(Path::new(temp).join("plugin.json"), format!(r#"{{"name":"{name}"}}"#)).map_err(|e| e.to_string())?;
        }
        Ok(String::new())
    }
}

type Seen = tokio::sync::mpsc::UnboundedReceiver<(String, Vec<String>, mixdog_workspace::watcher::ChangeKind)>;

/// The one watcher's sink, as the core composes it: the skills watch and every other user of the watcher (here a recorder).
struct FanOut(Arc<dyn mixdog_workspace::watcher::ChangeSink>, tokio::sync::mpsc::UnboundedSender<(String, Vec<String>, mixdog_workspace::watcher::ChangeKind)>);

impl mixdog_workspace::watcher::ChangeSink for FanOut {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: mixdog_workspace::watcher::ChangeKind) {
        self.0.changed(watch_id, paths.clone(), kind);
        let _ = self.1.send((watch_id.to_owned(), paths, kind));
    }
}

/// The revision of the recursive watch covering `path`, once no change is waiting to be applied.
async fn revision(watcher: &FolderWatcher, path: &Path) -> Arc<()> {
    mixdog_rt::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(revision) = watcher.recursive_revision(path) {
                return revision;
            }
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the folder is watched")
}

/// Windows refuses to rename a folder with a handle open inside it (EPERM, issue #328). The production update swaps the folder of
/// an enabled plugin while the skills watch and a session's own watch of its `skills` folder are both registered on the shared
/// watcher; afterwards both watch the new folder, and the other plugin's watch was never reopened.
#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_watched_by_the_catalog_and_a_session_is_updated_and_watched_again() {
    use mixdog_workspace::watcher::ChangeKind;
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let data = base.join("data");
    let admin = Arc::new(mixdog_mcp::plugin_admin::PluginAdmin::new(data.clone(), Arc::new(CloneGit), Arc::new(|| {})));
    let defaults = base.join("defaults");
    let skills = Arc::new(SkillsWatch::new());
    let tokens = mixdog_rt::testing::tokens();
    let catalog = mixdog_mcp::skill_catalog::SkillCatalog::new(
        data.clone(),
        tokens.maintenance_io,
        mixdog_mcp::mcp_glue::McpGlue::skill_roots(admin.clone(), defaults.clone()),
        Arc::new(NoSettings),
        &skills,
    );
    catalog.watch_roots(skills.clone(), mixdog_mcp::mcp_glue::McpGlue::skill_watch_targets(admin.clone(), defaults));
    let (record, mut seen): (_, Seen) = tokio::sync::mpsc::unbounded_channel();
    let watcher = Arc::new(FolderWatcher::new(Arc::new(FanOut(skills.sink(), record))).unwrap());
    skills.attach(Arc::clone(&watcher));
    let mut changes = skills.subscribe();
    let on_lane = |work: Box<dyn FnOnce(&mixdog_rt::InLane<mixdog_rt::MaintenanceIo>) -> serde_json::Value + Send>| async move {
        tokens.maintenance_io.submit(&CancellationToken::new(), work).unwrap().await.unwrap()
    };
    let mut roots = Vec::new();
    for source in ["acme/demo", "acme/other"] {
        let adding = Arc::clone(&admin);
        let plugin = on_lane(Box::new(move |lane| adding.add_plugin(lane, &serde_json::json!(source), None).unwrap())).await;
        roots.push((plugin["id"].clone(), std::path::PathBuf::from(plugin["root"].as_str().unwrap())));
    }
    let [(id, root), (_, other)] = &roots[..] else { unreachable!() };
    let has = |list: &[mixdog_mcp::skills::Skill], name: &str, description: &str| list.iter().any(|s| s.name == name && s.description == description);
    let listed = catalog.skills().await.unwrap();
    assert!(has(listed.as_slice(), "demo", "cloned") && has(listed.as_slice(), "other", "cloned"));
    assert!(catalog.cached().is_some(), "the catalog registered every skills folder");
    let untouched = revision(&watcher, &other.join("skills")).await;
    // A session's own watch of the plugin's skills folder, on the same watcher.
    watcher.watch("session", &root.join("skills"), true).unwrap();

    let updating = Arc::clone(&admin);
    let plugin = id.clone();
    let updated = on_lane(Box::new(move |lane| serde_json::json!(updating.update_plugin(lane, &plugin).map_err(|e| e.0)))).await;
    assert_eq!(updated["Ok"]["id"], *id, "{updated}");

    // A warm catalog: a list that stays cached past the batch window of the update's own writes.
    mixdog_rt::time::timeout(Duration::from_secs(10), async {
        loop {
            catalog.skills().await.unwrap();
            mixdog_rt::time::sleep(Duration::from_millis(600)).await;
            if catalog.cached().is_some() {
                return;
            }
        }
    })
    .await
    .expect("the catalog settles");
    assert!(Arc::ptr_eq(&untouched, &revision(&watcher, &other.join("skills")).await), "the other plugin's watch was reopened");
    changes.borrow_and_update();
    while seen.try_recv().is_ok() {}

    let file = root.join("skills").join("demo").join("SKILL.md");
    std::fs::write(&file, "---\nname: demo\ndescription: edited\n---\nbody\n").unwrap();
    let mut notified = (false, false);
    mixdog_rt::time::timeout(Duration::from_secs(10), async {
        while notified != (true, true) {
            let (watch_id, paths, kind) = seen.recv().await.unwrap();
            if kind != ChangeKind::Overflow && paths.iter().any(|p| Path::new(p) == file) {
                notified.0 |= watch_id == "session";
                notified.1 |= watch_id.starts_with("mcp.skills:");
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("both watches see the new folder (session, skills): {notified:?}"));
    mixdog_rt::time::timeout(Duration::from_secs(10), changes.changed()).await.expect("the catalog is told").unwrap();
    assert!(has(catalog.skills().await.unwrap().as_slice(), "demo", "edited"));
}
