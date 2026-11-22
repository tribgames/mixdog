//! The skill methods of the runtime API over a data folder in a temp dir: what creating, saving, removing and listing skills answers
//! and leaves on disk, which names move with a rename, and the words of each refusal. Plugin and bundled skills are read-only.
//! (Node `session-runtime/skills-api.mjs`, whose answers these keep.)
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out skill folders")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillLoad;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills::SkillGate;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_service::ProjectWorkspaces;
use mixdog_mcp::skills_service::SkillsService;
use mixdog_mcp::skills_watch::SkillsWatch;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

struct Config {
    agent: Mutex<Map<String, Value>>,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }

    fn set_disabled_skills(&self, names: &[String]) {
        self.agent.lock().unwrap().insert("skills".to_owned(), json!({"disabled": names}));
    }
}

struct Host {
    log: Mutex<Vec<String>>,
    cwd: PathBuf,
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}

    async fn announce(&self, kind: &str) {
        self.log.lock().unwrap().push(format!("announce:{kind}"));
    }

    async fn announce_without_invalidating(&self, kind: &str) {
        self.log.lock().unwrap().push(format!("announce:{kind}:keep"));
    }

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(vec!["read".to_owned()])
    }

    async fn reconnect_mcp_and_announce(&self, _: Option<&str>, _: bool, _: &[String]) -> Value {
        Value::Null
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        Value::Null
    }

    async fn schedule_mcp_toggle(&self, _: &str, _: bool) -> Value {
        Value::Null
    }

    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        Value::Null
    }

    fn invalidate_skills(&self) {
        self.log.lock().unwrap().push("invalidateSkills".to_owned());
    }

    async fn flush_skills_save(&self) {
        self.log.lock().unwrap().push("flushSkills".to_owned());
    }

    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(self.cwd.clone())
    }

    async fn plugin_mcp_summary(&self, _: Option<&str>) -> Result<Value, String> {
        Ok(Value::Object(Map::new()))
    }

    async fn skills_status(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

struct Settings(SkillSettings);

impl SkillSettingsSource for Settings {
    fn current(&self) -> SkillSettings {
        self.0.clone()
    }
}

struct Projects;

#[async_trait]
impl ProjectWorkspaces for Projects {
    async fn workspace_cwd(&self, project_path: &str) -> Result<PathBuf, String> {
        if project_path == "unknown" { Err("Project is not available.".to_owned()) } else { Ok(PathBuf::from("/resolved")) }
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    data: PathBuf,
    cwd: PathBuf,
    service: SkillsService,
    config: Arc<Config>,
    host: Arc<Host>,
}

fn fixture(existing: &[(&str, &str)]) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    for (name, text) in existing {
        let folder = data.join("skills").join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("SKILL.md"), text).unwrap();
    }
    let config = Arc::new(Config { agent: Mutex::default() });
    let host = Arc::new(Host { log: Mutex::default(), cwd: cwd.clone() });
    let settings: Arc<dyn SkillSettingsSource> = Arc::new(Settings(SkillSettings {
        gate: SkillGate { disabled: Default::default(), active_features: Default::default() },
        scopes: ExtensionScopes::from_config(&Value::Null),
    }));
    let tokens = mixdog_rt::testing::tokens();
    let root = SkillRoot { dir: data.join("skills"), source: SkillSource::Global, plugin: None };
    let catalog =
        SkillCatalog::new(data.clone(), tokens.maintenance_io.clone(), Arc::new(move |_| vec![root.clone()]), Arc::clone(&settings), &SkillsWatch::new());
    let service =
        SkillsService::new(catalog, settings, config.clone(), host.clone(), Arc::new(Projects), tokens.maintenance_io, tokens.durability_io, data.clone());
    Fixture { _dir: dir, data, cwd, service, config, host }
}

async fn call(service: &SkillsService, method: &'static str, params: Value) -> Result<Value, String> {
    match service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await {
        Ok(Reply::Value(value)) => Ok(value),
        Ok(_) => panic!("not a value"),
        Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
        Err(other) => panic!("{other:?}"),
    }
}

fn names(status: &Value) -> Vec<String> {
    status["skills"].as_array().unwrap().iter().map(|row| row["name"].as_str().unwrap().to_owned()).collect()
}

const DEMO: &str = "---\nname: demo\ndescription: Does a thing.\n---\n\nStep one.\n";

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_added_is_written_listed_as_the_users_own_and_announced() {
    let f = fixture(&[]);
    let added =
        call(&f.service, "skills/addSkill", json!({"input": {"name": "demo", "description": "Does a thing.", "instructions": "Step one."}})).await.unwrap();
    assert_eq!(added["skill"]["name"], "demo");
    let file = f.data.join("skills").join("demo").join("SKILL.md");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "---\nname: demo\ndescription: Does a thing.\n---\n\nStep one.\n");
    assert_eq!(names(&added["status"]), ["demo"]);
    let row = &added["status"]["skills"][0];
    assert_eq!(
        (row["editable"].clone(), row["source"].clone(), row["owner"].clone(), row["enabled"].clone()),
        (json!(true), json!("global"), json!({"kind": "user"}), json!(true))
    );
    assert_eq!(added["status"]["cwd"], f.cwd.to_string_lossy().as_ref());
    assert_eq!(added["status"]["tools"], json!([{"name": "read"}]));
    assert_eq!(*f.host.log.lock().unwrap(), ["announce:skills"]);

    let again = call(&f.service, "skills/addSkill", json!({"input": {"name": "demo", "description": "Other."}})).await;
    assert_eq!(again.unwrap_err(), "skill already exists: demo");
    let content = call(&f.service, "skills/skillContent", json!({"name": "  demo "})).await.unwrap();
    assert_eq!((content["content"].as_str(), content["name"].as_str(), content["source"].as_str()), (Some("Step one."), Some("demo"), Some("global")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_without_instructions_gets_the_placeholder_text() {
    let f = fixture(&[]);
    call(&f.service, "skills/addSkill", json!({"input": {"name": "bare", "description": "Bare."}})).await.unwrap();
    let text = std::fs::read_to_string(f.data.join("skills").join("bare").join("SKILL.md")).unwrap();
    assert!(text.ends_with("\n\n# Instructions\n\nDescribe how to use this skill.\n"), "{text:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lookup_with_no_name_or_an_unknown_name_is_refused_in_words() {
    let f = fixture(&[("demo", DEMO)]);
    assert_eq!(call(&f.service, "skills/skillContent", json!({"name": "  "})).await.unwrap_err(), "skill name is required");
    assert_eq!(call(&f.service, "skills/skillContent", json!({"name": " nope "})).await.unwrap_err(), "skill not found: nope");
    assert_eq!(call(&f.service, "skills/removeSkill", json!({"input": {"name": "nope"}})).await.unwrap_err(), "skill not found: nope");
    assert_eq!(
        call(&f.service, "skills/saveSkill", json!({"input": {"originalName": "nope", "name": "nope", "description": "d"}})).await.unwrap_err(),
        "skill not found: nope"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rename_moves_the_folder_and_the_switched_off_state_to_the_new_name_and_a_taken_name_is_refused() {
    let f = fixture(&[("demo", DEMO), ("other", "---\nname: other\ndescription: Another.\n---\n\nBody\n")]);
    call(&f.service, "skills/setDisabledSkills", json!({"names": ["demo"]})).await.unwrap();

    let taken = call(
        &f.service,
        "skills/saveSkill",
        json!({"input": {"originalName": "demo", "name": "other", "description": "Does a thing.", "instructions": "Step one."}}),
    )
    .await;
    assert_eq!(taken.unwrap_err(), "skill already exists: other");
    assert!(f.data.join("skills").join("demo").is_dir());

    let saved = call(
        &f.service,
        "skills/saveSkill",
        json!({"input": {"originalName": "demo", "name": "renamed", "description": "Does a thing.", "instructions": "Step one."}}),
    )
    .await
    .unwrap();
    assert_eq!((saved["skill"]["originalName"].as_str(), saved["skill"]["name"].as_str()), (Some("demo"), Some("renamed")));
    assert!(!f.data.join("skills").join("demo").exists());
    let text = std::fs::read_to_string(f.data.join("skills").join("renamed").join("SKILL.md")).unwrap();
    assert!(text.starts_with("---\nname: renamed\n"), "{text:?}");
    assert_eq!(call(&f.service, "skills/getDisabledSkills", json!({})).await.unwrap(), json!({"disabled": ["global:renamed"]}));
    assert!(f.host.log.lock().unwrap().contains(&"announce:skills:keep".to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_skill_deletes_its_folder_and_its_switched_off_entry() {
    let f = fixture(&[("demo", DEMO)]);
    call(&f.service, "skills/setDisabledSkills", json!({"names": ["demo", "kept"]})).await.unwrap();
    let removed = call(&f.service, "skills/removeSkill", json!({"input": {"name": "demo"}})).await.unwrap();
    assert_eq!(removed["skill"], json!({"name": "demo"}));
    assert!(!f.data.join("skills").join("demo").exists());
    assert_eq!(names(&removed["status"]), Vec::<String>::new());
    assert_eq!(f.config.agent()["skills"]["disabled"], json!(["kept"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_switched_off_list_is_trimmed_unique_and_sorted() {
    let f = fixture(&[]);
    let set = call(&f.service, "skills/setDisabledSkills", json!({"names": ["b", " a ", "b", "", "c"]})).await.unwrap();
    assert_eq!(set, json!({"disabled": ["a", "b", "c"]}));
    assert_eq!(call(&f.service, "skills/getDisabledSkills", json!({})).await.unwrap(), set);
    assert_eq!(*f.host.log.lock().unwrap(), ["flushSkills", "invalidateSkills", "announce:skills:keep"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_status_is_of_the_folder_asked_for_and_a_bad_ask_is_refused_in_words() {
    let f = fixture(&[("demo", DEMO)]);
    let ask = |options: Value| call(&f.service, "skills/skillsStatus", json!({"options": options}));
    assert_eq!(ask(Value::Null).await.unwrap()["cwd"], f.cwd.to_string_lossy().as_ref());
    let here = f.data.to_string_lossy().into_owned();
    assert_eq!(ask(json!({"cwd": here})).await.unwrap()["cwd"], here.as_str());
    assert_eq!(ask(json!({"cwd": "relative/dir"})).await.unwrap_err(), "skillsStatus cwd must be an absolute path.");
    let missing = Path::new(&here).join("no-such-folder");
    assert_eq!(ask(json!({"cwd": missing})).await.unwrap_err(), "skillsStatus cwd is not a directory.");
    assert_eq!(ask(json!({"projectPath": "/p"})).await.unwrap()["cwd"], "/resolved");
    assert_eq!(ask(json!({"projectPath": "unknown"})).await.unwrap_err(), "Project is not available.");
    assert_eq!(ask(json!({"projectPath": 3})).await.unwrap_err(), "projectPath must be a string.");
}

/// The disabled list as the daemon's settings read it: the config's entries, trimmed and lower-cased, on every call.
struct ConfigGate {
    config: Arc<Config>,
    features: HashSet<String>,
}

impl SkillSettingsSource for ConfigGate {
    fn current(&self) -> SkillSettings {
        let agent = self.config.agent();
        let list = agent.get("skills").and_then(|s| s.get("disabled")).and_then(Value::as_array).cloned().unwrap_or_default();
        let disabled = SkillGate::disabled_set(list.iter().filter_map(Value::as_str));
        let scopes = ExtensionScopes::from_config(agent.get("extensionScopes").unwrap_or(&Value::Null));
        SkillSettings { gate: SkillGate { disabled, active_features: self.features.clone() }, scopes }
    }
}

struct Sources {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    config: Arc<Config>,
    catalog: Arc<SkillCatalog>,
    service: SkillsService,
}

fn skill_doc(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\nBody of {description}\n")
}

/// The user's own skills, plugin `acme`'s and the built-ins (`builtin`, or the shipped folder), with the disabled list in the config.
fn sources(own: &[(&str, &str)], plugin: &[(&str, &str)], builtin: &[(&str, &str)], shipped: Option<PathBuf>, features: &[&str]) -> Sources {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let (plugin_root, builtin_root) = (dir.path().join("acme").join("skills"), shipped.unwrap_or_else(|| dir.path().join("builtin")));
    for (root, skills) in [(data.join("skills"), own), (plugin_root.clone(), plugin), (builtin_root.clone(), builtin)] {
        for (name, description) in skills {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("SKILL.md"), skill_doc(name, description)).unwrap();
        }
    }
    let config = Arc::new(Config { agent: Mutex::default() });
    let host = Arc::new(Host { log: Mutex::default(), cwd: cwd.clone() });
    let settings: Arc<dyn SkillSettingsSource> =
        Arc::new(ConfigGate { config: config.clone(), features: features.iter().map(|f| (*f).to_owned()).collect() });
    let roots = vec![
        SkillRoot { dir: data.join("skills"), source: SkillSource::Global, plugin: None },
        SkillRoot { dir: plugin_root, source: SkillSource::Plugin, plugin: Some("acme".to_owned()) },
        SkillRoot { dir: builtin_root, source: SkillSource::Builtin, plugin: None },
    ];
    let tokens = mixdog_rt::testing::tokens();
    let catalog = SkillCatalog::new(data.clone(), tokens.maintenance_io.clone(), Arc::new(move |_| roots.clone()), Arc::clone(&settings), &SkillsWatch::new());
    let service =
        SkillsService::new(Arc::clone(&catalog), settings, config.clone(), host, Arc::new(Projects), tokens.maintenance_io, tokens.durability_io, data);
    Sources { _dir: dir, cwd, config, catalog, service }
}

impl Sources {
    async fn disable(&self, entries: &[&str]) {
        call(&self.service, "skills/setDisabledSkills", json!({"names": entries})).await.unwrap();
    }

    /// `(key, state, hiddenBy, offBy, replacesBuiltin)` of the status rows named `name`, in source order.
    async fn rows(&self, name: &str) -> Vec<(String, String, Value, Value, bool)> {
        self.rows_in(json!({}), name).await
    }

    /// [`rows`](Self::rows) of a status asked with `params`.
    async fn rows_in(&self, params: Value, name: &str) -> Vec<(String, String, Value, Value, bool)> {
        let status = call(&self.service, "skills/skillsStatus", params).await.unwrap();
        status["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["name"] == name)
            .map(|row| {
                let text = |key: &str| row[key].as_str().unwrap().to_owned();
                (text("key"), text("state"), row["hiddenBy"].clone(), row["offBy"].clone(), row["replacesBuiltin"] == true)
            })
            .collect()
    }

    /// What the `Skill` tool delivers for `name`: the body, or the refusal.
    async fn loaded(&self, name: &str) -> String {
        match self.catalog.load(name, &self.cwd).await.unwrap() {
            SkillLoad::Loaded(resource) => resource.body.trim().to_owned(),
            SkillLoad::Refused(refusal) => refusal.to_string(),
            SkillLoad::NotFound => "not found".to_owned(),
        }
    }

    async fn offered(&self) -> Vec<String> {
        self.catalog.visible(&self.cwd).await.unwrap().into_iter().map(|s| s.key()).collect()
    }
}

fn row(key: &str, state: &str, hidden_by: Option<&str>, off_by: Option<&str>, replaces_builtin: bool) -> (String, String, Value, Value, bool) {
    (key.to_owned(), state.to_owned(), json!(hidden_by), json!(off_by), replaces_builtin)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_skill_hides_the_builtin_of_its_name_until_it_alone_is_switched_off() {
    let s = sources(&[], &[("setup", "the plugin")], &[("setup", "the builtin")], None, &[]);
    assert_eq!(s.rows("setup").await, [row("plugin:acme:setup", "inUse", None, None, true), row("builtin:setup", "hidden", Some("plugin:acme"), None, false)]);
    assert_eq!(s.loaded("setup").await, "Body of the plugin");

    s.disable(&["plugin:acme:setup"]).await;
    assert_eq!(s.rows("setup").await, [row("plugin:acme:setup", "off", None, Some("source"), false), row("builtin:setup", "inUse", None, None, false)]);
    assert_eq!(s.loaded("setup").await, "Body of the builtin");
    assert_eq!(s.offered().await, ["builtin:setup"]);

    s.disable(&[]).await;
    assert_eq!(s.loaded("setup").await, "Body of the plugin");
    assert_eq!(s.offered().await, ["plugin:acme:setup"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_users_own_skill_hides_the_plugins_and_switching_each_off_moves_down_the_sources() {
    let s = sources(&[("demo", "mine")], &[("demo", "the plugin")], &[], None, &[]);
    assert_eq!(s.rows("demo").await, [row("global:demo", "inUse", None, None, false), row("plugin:acme:demo", "hidden", Some("global"), None, false)]);
    assert_eq!(s.loaded("demo").await, "Body of mine");

    s.disable(&["global:demo"]).await;
    assert_eq!(s.rows("demo").await, [row("global:demo", "off", None, Some("source"), false), row("plugin:acme:demo", "inUse", None, None, false)]);
    assert_eq!(s.loaded("demo").await, "Body of the plugin");

    s.disable(&["global:demo", "plugin:acme:demo"]).await;
    assert_eq!(s.loaded("demo").await, "Error: skill \"demo\" is disabled");
    assert!(s.offered().await.is_empty());

    s.disable(&["plugin:acme:demo"]).await;
    assert_eq!(s.rows("demo").await, [row("global:demo", "inUse", None, None, false), row("plugin:acme:demo", "off", None, Some("source"), false)]);
    assert_eq!(s.loaded("demo").await, "Body of mine");
}

/// `skillContent` of a status row's `key` reads that source's skill, hidden or not; a bare name reads as before.
#[tokio::test(flavor = "multi_thread")]
async fn a_skills_content_asked_by_its_key_is_that_sources() {
    let s = sources(&[("setup", "mine")], &[("setup", "the plugin")], &[("setup", "the builtin")], None, &[]);
    let content = |name: &'static str| call(&s.service, "skills/skillContent", json!({"name": name}));
    let read = |value: Value| (value["content"].as_str().unwrap().trim().to_owned(), value["name"].clone(), value["key"].clone(), value["source"].clone());
    assert_eq!(read(content(" plugin:acme:setup ").await.unwrap()), ("Body of the plugin".to_owned(), json!("setup"), json!("plugin:acme:setup"), json!("plugin")));
    assert_eq!(read(content("builtin:setup").await.unwrap()).0, "Body of the builtin");
    assert_eq!(read(content("setup").await.unwrap()), ("Body of mine".to_owned(), json!("setup"), json!("global:setup"), json!("global")));
    assert_eq!(content("plugin:other:setup").await.unwrap_err(), "skill not found: plugin:other:setup");
}

/// A name-only entry of an earlier version, where only the first skill of a name was kept: the name stays off in every source, and a
/// name without one keeps the skill that was used.
#[tokio::test(flavor = "multi_thread")]
async fn a_name_only_entry_keeps_every_skill_of_the_name_off_as_before() {
    let s = sources(&[("demo", "mine")], &[("demo", "the plugin"), ("setup", "the plugin")], &[("demo", "the builtin"), ("setup", "the builtin")], None, &[]);
    s.disable(&["demo"]).await;
    let off = |key: &str| row(key, "off", None, Some("name"), false);
    assert_eq!(s.rows("demo").await, [off("global:demo"), off("plugin:acme:demo"), off("builtin:demo")]);
    assert_eq!(s.loaded("demo").await, "Error: skill \"demo\" is disabled");
    assert_eq!(s.loaded("setup").await, "Body of the plugin");
    assert_eq!(s.offered().await, ["plugin:acme:setup"]);
}

/// The ten shipped built-ins that need a feature follow it: no entry, name-only or of their source, turns them off.
#[tokio::test(flavor = "multi_thread")]
async fn the_feature_bound_builtins_ignore_the_disabled_list() {
    const BOUND: [&str; 10] = ["browser-use", "code-tidy", "computer-use", "docx", "image", "pdf", "pptx", "video", "visualize", "xlsx"];
    let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src/defaults/skills");
    let s = sources(&[], &[], &[], Some(shipped), &["browser", "tidy", "computer", "office", "media", "visualize"]);
    let entries: Vec<String> = BOUND.iter().flat_map(|name| [(*name).to_owned(), format!("builtin:{name}")]).collect();
    s.disable(&entries.iter().map(String::as_str).collect::<Vec<_>>()).await;
    let offered = s.offered().await;
    for name in BOUND {
        assert_eq!(s.rows(name).await, [row(&format!("builtin:{name}"), "inUse", None, None, false)]);
        assert!(offered.contains(&format!("builtin:{name}")), "{name} is offered");
    }
}

impl Sources {
    async fn disabled(&self) -> Value {
        call(&self.service, "skills/getDisabledSkills", json!({})).await.unwrap()["disabled"].clone()
    }

    async fn switch(&self, key: &str, enabled: bool) -> Result<Value, String> {
        call(&self.service, "skills/setSkillEnabled", json!({"key": key, "enabled": enabled})).await
    }

    /// Writes `SKILL.md` of `name` under `folder` (relative to the fixture's folder) with extra frontmatter.
    fn write(&self, folder: &str, name: &str, description: &str, extra: &str) {
        let dir = self._dir.path().join(folder).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: {description}\n{extra}---\n\nBody of {description}\n")).unwrap();
    }
}

/// Two switches made at once from a bare name entry both hold: the core changes the stored list under its own lock, the
/// bare entry expanded there.
#[tokio::test(flavor = "multi_thread")]
async fn two_switches_at_once_keep_each_others_change() {
    let s = sources(&[("lint", "mine")], &[("setup", "the plugin")], &[("setup", "the builtin")], None, &[]);
    s.disable(&["setup"]).await;
    let (on, off) = tokio::join!(s.switch("plugin:acme:setup", true), s.switch("global:lint", false));
    let (on, off) = (on.unwrap(), off.unwrap());
    assert!(on["disabled"].is_array() && off["disabled"].is_array());
    assert_eq!(s.disabled().await, json!(["builtin:setup", "global:lint"]));
    assert_eq!(s.rows("setup").await, [row("plugin:acme:setup", "inUse", None, None, true), row("builtin:setup", "off", None, Some("source"), false)]);
    assert_eq!(s.rows("lint").await, [row("global:lint", "off", None, Some("source"), false)]);
    assert_eq!(s.switch("plugin:other:setup", true).await.unwrap_err(), "skill not found: plugin:other:setup");
}

/// Saving the tools a plugin row needs, named by the row's key, writes that skill's override and leaves the user's own skill
/// of the name alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_dependencies_save_by_a_rows_key_reaches_that_sources_skill() {
    let s = sources(&[("setup", "mine")], &[("setup", "the plugin")], &[], None, &[]);
    let input = json!({"originalName": "plugin:acme:setup", "dependenciesOnly": true, "toolDependencies": [{"type": "tool", "value": "read"}]});
    call(&s.service, "skills/saveSkill", json!({"input": input})).await.unwrap();
    let content = |key: &'static str| call(&s.service, "skills/skillContent", json!({"name": key}));
    let plugin = content("plugin:acme:setup").await.unwrap();
    assert_eq!((plugin["dependencySource"].clone(), plugin["toolDependencies"][0]["value"].clone()), (json!("override"), json!("read")));
    assert_ne!(content("global:setup").await.unwrap()["dependencySource"], json!("override"));
}

/// The user's own skill that is off while a plugin's skill of its name is in use can be edited and renamed onto a name a
/// plugin ships: only another of the user's own skills stands in the way.
#[tokio::test(flavor = "multi_thread")]
async fn an_own_skill_off_behind_a_plugins_saves_and_renames_past_other_sources() {
    let s = sources(&[("demo", "mine")], &[("demo", "the plugin"), ("other", "the plugin")], &[], None, &[]);
    s.disable(&["global:demo"]).await;
    let save = |name: &'static str| {
        call(&s.service, "skills/saveSkill", json!({"input": {"originalName": "demo", "name": name, "description": "Edited.", "instructions": "Step."}}))
    };
    save("demo").await.unwrap();
    let renamed = call(&s.service, "skills/saveSkill", json!({"input": {"originalName": "demo", "name": "other", "description": "Edited.", "instructions": "Step."}}))
        .await
        .unwrap();
    assert_eq!(renamed["skill"]["name"], "other");
    assert_eq!(s.rows("other").await[0], row("global:other", "off", None, Some("source"), false));
}

/// Entries are one entry whatever their case: deleting the user's own skill drops `GLOBAL:DEMO`, so a skill made again
/// under the name is on; renaming one a bare entry turned off moves its own off state as its key and leaves the bare entry's
/// hold on the other sources' skills.
#[tokio::test(flavor = "multi_thread")]
async fn an_own_skills_entries_follow_it_by_the_gates_identity() {
    let s = sources(&[("demo", "mine")], &[], &[], None, &[]);
    s.disable(&["GLOBAL:DEMO"]).await;
    call(&s.service, "skills/removeSkill", json!({"input": {"name": "demo"}})).await.unwrap();
    assert_eq!(s.disabled().await, json!([]));
    call(&s.service, "skills/addSkill", json!({"input": {"name": "demo", "description": "Again."}})).await.unwrap();
    assert_eq!(s.rows("demo").await, [row("global:demo", "inUse", None, None, false)]);

    let s = sources(&[("demo", "mine")], &[("demo", "the plugin")], &[], None, &[]);
    s.disable(&["demo"]).await;
    let input = json!({"originalName": "demo", "name": "fresh", "description": "Mine.", "instructions": "Step."});
    call(&s.service, "skills/saveSkill", json!({"input": input})).await.unwrap();
    assert_eq!(s.disabled().await, json!(["global:fresh", "plugin:acme:demo"]));
    assert_eq!(s.rows("demo").await, [row("plugin:acme:demo", "off", None, Some("source"), false)]);
    assert_eq!(s.rows("fresh").await, [row("global:fresh", "off", None, Some("source"), false)]);
}

/// A skill missing a feature it needs is never the one in use: the next source's skill of the name is, and the agent's
/// list and the `Skill` tool agree with the status.
#[tokio::test(flavor = "multi_thread")]
async fn a_skill_missing_its_feature_gives_way_to_the_next_source() {
    let s = sources(&[], &[], &[("setup", "the builtin")], None, &[]);
    s.write("acme/skills", "setup", "the plugin", "metadata:\n  requires: [git]\n");
    s.write("builtin", "pdf", "the pdf", "metadata:\n  requires: [office]\n");
    assert_eq!(s.rows("setup").await, [row("plugin:acme:setup", "off", None, Some("feature"), false), row("builtin:setup", "inUse", None, None, false)]);
    assert_eq!(s.rows("pdf").await, [row("builtin:pdf", "off", None, Some("feature"), false)]);
    assert_eq!(s.loaded("setup").await, "Body of the builtin");
    assert_eq!(s.offered().await, ["builtin:setup"]);
}

impl Sources {
    /// Scopes plugin `acme` to a project folder other than the session's, and answers that folder.
    fn scope_plugin_elsewhere(&self) -> String {
        let project = self._dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.to_string_lossy().into_owned();
        self.config.agent.lock().unwrap().insert("extensionScopes".to_owned(), json!({"plugins": {"acme": [project]}}));
        project
    }
}

/// A status is scoped only when its caller names what it asks about: a folder (`options.cwd`) or a session asking about
/// itself (`options.scoped`); then a plugin skill its project scope excludes is off `scope` and the next source's skill is in
/// use, as for the agent's list and the `Skill` tool in that folder. Asked with neither, a thread id included, the status is
/// unscoped: the plugin's skill is in use and no row is off for scope.
#[tokio::test(flavor = "multi_thread")]
async fn a_status_is_scoped_only_when_it_names_what_it_asks_about() {
    let s = sources(&[], &[("setup", "the plugin")], &[("setup", "the builtin")], None, &[]);
    let project = s.scope_plugin_elsewhere();
    let unscoped = [row("plugin:acme:setup", "inUse", None, None, true), row("builtin:setup", "hidden", Some("plugin:acme"), None, false)];
    assert_eq!(s.rows("setup").await, unscoped);
    assert_eq!(s.rows_in(json!({"threadId": "control"}), "setup").await, unscoped);
    let session = s.rows_in(json!({"threadId": "t1", "options": {"scoped": true}}), "setup").await;
    assert_eq!(session, [row("plugin:acme:setup", "off", None, Some("scope"), false), row("builtin:setup", "inUse", None, None, false)]);
    assert_eq!(s.loaded("setup").await, "Body of the builtin");
    assert_eq!(s.offered().await, ["builtin:setup"]);
    assert_eq!(s.rows_in(json!({"options": {"cwd": project}}), "setup").await, unscoped);
}

/// A row the disabled list cannot switch says so (`switchable: false`), and the core refuses a switch of a built-in that
/// follows its feature rather than storing a key the gate ignores.
#[tokio::test(flavor = "multi_thread")]
async fn a_builtin_that_follows_its_feature_has_no_switch() {
    let s = sources(&[], &[], &[], None, &["office"]);
    s.write("builtin", "pdf", "the pdf", "metadata:\n  requires: [office]\n");
    assert_eq!(s.switch("builtin:pdf", false).await.unwrap_err(), "skill \"builtin:pdf\" follows its built-in feature and has no switch");
    assert_eq!(s.disabled().await, json!([]));
    let status = call(&s.service, "skills/skillsStatus", json!({})).await.unwrap();
    assert_eq!((status["skills"][0]["state"].clone(), status["skills"][0]["switchable"].clone()), (json!("inUse"), json!(false)));
}

/// Switching on a plugin skill the list turned off, out of the scope of the folder asked about, leaves it off there for the
/// scope: the refreshed status alone tells the client, its `offBy` moving from `source` to `scope` and its switch gone.
#[tokio::test(flavor = "multi_thread")]
async fn switching_on_a_skill_out_of_scope_leaves_it_off_for_the_scope() {
    let s = sources(&[], &[("setup", "the plugin")], &[("setup", "the builtin")], None, &[]);
    s.scope_plugin_elsewhere();
    s.disable(&["plugin:acme:setup"]).await;
    let here = || call(&s.service, "skills/skillsStatus", json!({"options": {"scoped": true}}));
    let plugin = |status: &Value| (status["skills"][0]["state"].clone(), status["skills"][0]["offBy"].clone(), status["skills"][0]["switchable"].clone());
    assert_eq!(plugin(&here().await.unwrap()), (json!("off"), json!("source"), json!(true)));
    assert_eq!(s.switch("plugin:acme:setup", true).await.unwrap(), json!({"disabled": []}));
    assert_eq!(plugin(&here().await.unwrap()), (json!("off"), json!("scope"), json!(false)));
}

/// The rows are enough to list exactly the built-ins the disabled list turns off: `sourceKey` `builtin`, `state` `off` and
/// `offBy` `source` or `name` — not one whose feature is off, not one another source's skill hides.
#[tokio::test(flavor = "multi_thread")]
async fn the_builtins_the_list_turns_off_are_told_apart_by_their_rows() {
    let s = sources(&[("lint", "mine")], &[("review", "the plugin")], &[("setup", "b"), ("review", "b"), ("lint", "b"), ("tidy", "b")], None, &[]);
    s.write("builtin", "pdf", "the pdf", "metadata:\n  requires: [office]\n");
    s.disable(&["builtin:setup", "BUILTIN:REVIEW", "tidy"]).await;
    let status = call(&s.service, "skills/skillsStatus", json!({})).await.unwrap();
    let listed: Vec<&str> = status["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["sourceKey"] == "builtin" && row["state"] == "off" && (row["offBy"] == "source" || row["offBy"] == "name"))
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    assert_eq!(listed, ["review", "setup", "tidy"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_method_the_service_does_not_serve_is_unavailable() {
    let f = fixture(&[]);
    let request = CoreRequest { method: Method("skills/unheard"), params: json!({}), op: None, ctx: CallContext::internal("test") };
    assert!(matches!(f.service.call(request).await, Err(CoreError::CapabilityUnavailable { .. })));
}
