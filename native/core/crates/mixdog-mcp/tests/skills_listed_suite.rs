//! Whether a session's tool list offers `Skill` (`skills.length` of Node's `resolveSessionTools`):
//! the catalog collects before it filters, as `collectSkillsCached` does.
#![allow(clippy::disallowed_methods, reason = "test fixtures write skill folders directly")]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::scopes::ScopeKind;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_watch::SkillsWatch;

#[derive(Default)]
struct Settings(Mutex<SkillSettings>);

impl SkillSettingsSource for Settings {
    fn current(&self) -> SkillSettings {
        self.0.lock().unwrap().clone()
    }
}

fn add_skill(root: &Path, name: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: Use when {name}.\n---\n\nbody\n")).unwrap();
}

/// What a session's tool list asks: is any skill visible at `cwd` (Node collects, then filters).
async fn listed(catalog: &SkillCatalog, cwd: &Path) -> bool {
    !catalog.visible(cwd).await.unwrap().is_empty()
}

fn catalog_over(dir: &Path, settings: Arc<Settings>) -> (Arc<SkillCatalog>, std::path::PathBuf) {
    let tokens = mixdog_rt::testing::tokens();
    let root = dir.join("skills");
    std::fs::create_dir_all(&root).unwrap();
    let roots = SkillRoot { dir: root.clone(), source: SkillSource::Global, plugin: None };
    let catalog = SkillCatalog::new(dir.to_path_buf(), tokens.maintenance_io, Arc::new(move || vec![roots.clone()]), settings, &SkillsWatch::new());
    (catalog, root)
}

/// A cold start: the first question collects, so a skill already installed is listed at once.
#[tokio::test(flavor = "multi_thread")]
async fn a_cold_start_collects_before_it_answers() {
    let dir = tempfile::tempdir().unwrap();
    let (catalog, root) = catalog_over(dir.path(), Arc::new(Settings::default()));
    add_skill(&root, "alpha");
    assert!(listed(&catalog, &dir.path().join("project")).await);
}

/// A skill added through the app invalidates the list; the very next read sees it, and a removed
/// one is gone on the next read after invalidation.
#[tokio::test(flavor = "multi_thread")]
async fn the_next_read_after_invalidation_recollects() {
    let dir = tempfile::tempdir().unwrap();
    let (catalog, root) = catalog_over(dir.path(), Arc::new(Settings::default()));
    let cwd = dir.path().join("project");
    assert!(!listed(&catalog, &cwd).await);
    add_skill(&root, "alpha");
    catalog.invalidate();
    assert!(listed(&catalog, &cwd).await);
    std::fs::remove_dir_all(root.join("alpha")).unwrap();
    catalog.invalidate();
    assert!(!listed(&catalog, &cwd).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_answer_follows_settings_and_scope() {
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(Settings::default());
    let (catalog, root) = catalog_over(dir.path(), settings.clone());
    let cwd = dir.path().join("project");
    add_skill(&root, "alpha");
    assert!(listed(&catalog, &cwd).await);

    // Switched off in settings: hidden at once.
    settings.0.lock().unwrap().gate.disabled.insert("alpha".to_owned());
    assert!(!listed(&catalog, &cwd).await);
    settings.0.lock().unwrap().gate.disabled.clear();
    assert!(listed(&catalog, &cwd).await);

    // Limited to another project: hidden here, seen there.
    let mut scopes = ExtensionScopes::default();
    scopes.set(ScopeKind::Skills, "alpha", vec![dir.path().join("elsewhere").to_string_lossy().into_owned()]);
    settings.0.lock().unwrap().scopes = scopes;
    assert!(!listed(&catalog, &cwd).await);
    assert!(listed(&catalog, &dir.path().join("elsewhere").join("sub")).await);
}
