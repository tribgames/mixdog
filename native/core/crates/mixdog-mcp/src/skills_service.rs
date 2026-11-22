//! The skill methods of the runtime API (Node `session-runtime/skills-api.mjs` and
//! `resource-skills-api.mjs`), served as one [`DomainService`]: the status list, a skill's text,
//! creating, editing and removing the user's own skills, and the list of switched-off skills.
//!
//! Only skills under the global skills folder can be written; plugin and bundled skills are
//! read-only. `SKILL.md` is written atomically with the replaced copy kept as `SKILL.md.bak`.
//! What a change does to the live process (announcing it, dropping caches) is the host's
//! ([`ExtensionHost`]); the disabled list lives in the config ([`ExtensionConfig`]).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_js::value_to_string;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::extension_service::ExtensionConfig;
use crate::extension_service::ExtensionHost;
use crate::extension_service::decorate_skills;
use crate::scopes::ExtensionScopes;
use crate::skill_catalog::SkillCatalog;
use crate::skill_catalog::SkillSettingsSource;
use crate::skill_deps::DependencySource;
use crate::skill_deps::normalize_dependencies;
use crate::skill_deps::save_skill_tool_dependencies;
use crate::skill_frontmatter::Fields;
use crate::skill_frontmatter::checked_description;
use crate::skill_frontmatter::checked_name;
use crate::skill_frontmatter::checked_when_to_use;
use crate::skill_frontmatter::create_document;
use crate::skill_frontmatter::update_document;
use crate::skills::Skill;
use crate::skills::SkillSource;
use crate::skills::SkillState;
use crate::skills::entry_key;
use crate::skills::parse_document;
use crate::skills::source_key;

const METHODS: &[&str] = &[
    "skills/skillsStatus",
    "skills/skillContent",
    "skills/getDisabledSkills",
    "skills/addSkill",
    "skills/saveSkill",
    "skills/removeSkill",
    "skills/reloadSkills",
    "skills/setDisabledSkills",
    "skills/setSkillEnabled",
];

const DEFAULT_SKILL_BODY: &str = "# Instructions\n\nDescribe how to use this skill.";

pub struct SkillsService {
    catalog: Arc<SkillCatalog>,
    settings: Arc<dyn SkillSettingsSource>,
    config: Arc<dyn ExtensionConfig>,
    host: Arc<dyn ExtensionHost>,
    projects: Arc<dyn ProjectWorkspaces>,
    maintenance: MaintenanceIo,
    durability: DurabilityIo,
    data_dir: PathBuf,
    /// Held across every read-change-write of the disabled list, so two changes never lose each other.
    #[allow(clippy::disallowed_types, reason = "one change of the disabled list at a time, across the reads and the write it awaits")]
    list_lock: tokio::sync::Mutex<()>,
}

/// The folder a task opened in a Project runs in (Node `SessionHost.resolveSessionWorkspace`): a registered
/// Project, or a managed worktree of one, anything else refused; no Project is the task workspace. The
/// desktop's new-task draft asks the skill status for it by `projectPath`.
#[async_trait]
pub trait ProjectWorkspaces: Send + Sync {
    /// The folder's real path, or the text of the refusal.
    async fn workspace_cwd(&self, project_path: &str) -> Result<PathBuf, String>;
}

/// A failure worded as Node's `error.message`.
type Failure = String;

fn domain_error(message: String) -> CoreError {
    CoreError::DomainError { domain: "skills".into(), code: None, message: Some(message.into()), detail: None }
}

/// `String(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => value_to_string(other),
    }
}

/// `String(a || b || '')`.
fn first_text(input: &Value, keys: [&str; 2]) -> String {
    keys.iter().map(|k| text_or_empty(input.get(k))).find(|t| !t.is_empty()).unwrap_or_default()
}

fn source_name(source: SkillSource) -> &'static str {
    match source {
        SkillSource::Global => "global",
        SkillSource::Plugin => "plugin",
        SkillSource::Builtin => "builtin",
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `normalizeSkillsConfig(...).disabled`: trimmed, unique as [`entry_key`], sorted by locale.
pub fn normalize_disabled(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = js_trim(&name).to_owned();
        if !name.is_empty() && !listed(&out, &name) {
            out.push(name);
        }
    }
    out.sort_by(|a, b| locale_compare(a, b));
    out
}

/// Whether `list` holds `entry`, as the gate matches entries.
fn listed(list: &[String], entry: &str) -> bool {
    list.iter().any(|listed| entry_key(listed) == entry_key(entry))
}

fn without(list: Vec<String>, entry: &str) -> Vec<String> {
    list.into_iter().filter(|listed| entry_key(listed) != entry_key(entry)).collect()
}

/// The key of the user's own skill `name`.
fn own_key(name: &str) -> String {
    format!("{}:{name}", source_key(SkillSource::Global, None))
}

/// A bare entry for `name` gives way to the keys of the name's skills other than `except`, which it kept off (a built-in
/// that follows its feature has no key the gate reads).
fn expand_bare(list: Vec<String>, skills: &[Skill], name: &str, except: &str) -> Vec<String> {
    if !listed(&list, name) {
        return list;
    }
    let mut list = without(list, name);
    for skill in skills.iter().filter(|s| entry_key(&s.name) == entry_key(name) && entry_key(&s.key()) != entry_key(except) && !s.follows_feature()) {
        let key = skill.key();
        if !listed(&list, &key) {
            list.push(key);
        }
    }
    list
}

fn name_key(name: &str) -> String {
    js_trim(name).to_lowercase()
}

/// The skill a request names in `field`: a status row's key as given (trimmed), else a checked name.
fn skill_reference(input: &Value, field: &str) -> Result<String, Failure> {
    let value = js_trim(&text_or_empty(input.get(field))).to_owned();
    if value.contains(':') { Ok(value) } else { checked_name(&value).map_err(|e| e.to_string()) }
}

/// How a save changes the skill's tool dependencies.
enum Deps {
    Untouched,
    /// Back to what the skill declares.
    Clear,
    Set(Value),
}

fn deps_of(input: &Value, strict_null_clears: bool) -> Result<Deps, Failure> {
    match input.get("toolDependencies") {
        None => Ok(Deps::Untouched),
        Some(Value::Null) if strict_null_clears => Ok(Deps::Clear),
        Some(value) => Ok(Deps::Set(Value::Array(normalize_dependencies(value, true)?))),
    }
}

impl SkillsService {
    #[allow(clippy::too_many_arguments, reason = "Explicit composition dependencies retain the existing public service constructor")]
    #[allow(clippy::disallowed_types, reason = "see `list_lock`")]
    pub fn new(
        catalog: Arc<SkillCatalog>,
        settings: Arc<dyn SkillSettingsSource>,
        config: Arc<dyn ExtensionConfig>,
        host: Arc<dyn ExtensionHost>,
        projects: Arc<dyn ProjectWorkspaces>,
        maintenance: MaintenanceIo,
        durability: DurabilityIo,
        data_dir: PathBuf,
    ) -> Self {
        Self { catalog, settings, config, host, projects, maintenance, durability, data_dir, list_lock: tokio::sync::Mutex::new(()) }
    }

    fn global_root(&self) -> PathBuf {
        self.data_dir.join("skills")
    }

    fn scopes(&self) -> ExtensionScopes {
        ExtensionScopes::from_config(self.config.agent().get("extensionScopes").unwrap_or(&Value::Null))
    }

    async fn on_lane<T: Send + 'static>(&self, job: impl FnOnce(&InLane<MaintenanceIo>) -> T + Send + 'static) -> Result<T, Failure> {
        let handle = self.maintenance.submit_wait(&CancellationToken::new(), job).await.map_err(|e| e.to_string())?;
        handle.await.map_err(|e| e.to_string())
    }

    async fn every_skill(&self) -> Result<Arc<Vec<Skill>>, Failure> {
        self.catalog.every_skill().await.map_err(|e| e.to_string())
    }

    async fn resource(&self, value: &str) -> Result<Option<crate::skill_catalog::SkillResource>, Failure> {
        self.catalog.resource(value).await.map_err(|e| e.to_string())
    }

    /// `getDisabledSkills().disabled`.
    fn disabled(&self) -> Vec<String> {
        let agent = self.config.agent();
        let list = agent.get("skills").and_then(|s| s.get("disabled")).and_then(Value::as_array);
        normalize_disabled(list.map(|l| l.iter().map(value_to_string).collect::<Vec<_>>()).unwrap_or_default())
    }

    /// `invalidateSkills` of the skills API: this process's skill list is collected again.
    fn invalidate(&self) {
        self.catalog.invalidate();
    }

    /// `skillsStatus({ cwd })`, undecorated: a row for every source's skill, in source order, with
    /// its disabled-list `key`, its `state` (`inUse`, `off`, `hidden`), the source in use instead
    /// (`hiddenBy`), what turns it off (`offBy`: its own key `source`, a bare `name` entry, a
    /// missing `feature`, or the project `scope` of `cwd`), and whether it is in use in place of a
    /// built-in of its name (`replacesBuiltin`), and whether the disabled list can switch it
    /// (`switchable`). Unscoped: the winner of a name is chosen without regard to project scope.
    pub async fn status(&self, cwd: &Path) -> Result<Value, Failure> {
        self.status_in(cwd, false).await
    }

    /// [`status`](Self::status); `scoped`, the winner of a name is chosen as for a session in `cwd`: among the skills its
    /// project scope admits there, the others reporting `offBy: "scope"`.
    async fn status_in(&self, cwd: &Path, scoped: bool) -> Result<Value, Failure> {
        let skills = self.catalog.every_skill().await.map_err(|e| e.to_string())?;
        let settings = self.settings.current();
        let gate = &settings.gate;
        let states = gate.states_where(&skills, |s| !scoped || settings.scopes.skill_allowed_for_cwd(s, cwd));
        let tools: Vec<Value> = self.host.tool_names().await?.into_iter().map(|name| json!({"name": name})).collect();
        let rows: Vec<Value> = skills
            .iter()
            .enumerate()
            .map(|(index, skill)| {
                let state = states[index];
                let off_by = (state == SkillState::Off).then(|| gate.off_by(&skills, index));
                let enabled = state != SkillState::Off && gate.refusal(skill).is_none();
                // A built-in that follows its feature has no key the gate reads; a row off for its feature or scope is
                // not the list's to switch.
                let switchable = !skill.follows_feature() && !matches!(off_by, Some("feature" | "scope"));
                let replaces_builtin = state == SkillState::InUse
                    && skill.source != SkillSource::Builtin
                    && skills.iter().any(|other| other.source == SkillSource::Builtin && name_key(&other.name) == name_key(&skill.name));
                let owner = match skill.source {
                    SkillSource::Plugin => json!({"kind": "plugin", "id": skill.plugin}),
                    SkillSource::Builtin => json!({"kind": "builtin", "feature": skill.requires.first()}),
                    SkillSource::Global => json!({"kind": "user"}),
                };
                json!({
                    "name": skill.name,
                    "key": skill.key(),
                    "sourceKey": skill.source_key(),
                    "state": match state {
                        SkillState::InUse => "inUse",
                        SkillState::Off => "off",
                        SkillState::Hidden { .. } => "hidden",
                    },
                    "hiddenBy": match state {
                        SkillState::Hidden { by } => json!(skills[by].source_key()),
                        _ => Value::Null,
                    },
                    "offBy": off_by,
                    "switchable": switchable,
                    "replacesBuiltin": replaces_builtin,
                    "enabled": enabled,
                    "description": skill.description,
                    "whenToUse": skill.when_to_use,
                    "filePath": path_text(&skill.file_path),
                    "source": source_name(skill.source),
                    "owner": owner,
                    "editable": skill.source == SkillSource::Global,
                    "toolDependencies": skill.tool_dependencies.tool_dependencies,
                    "declaredToolDependencies": skill.tool_dependencies.declared,
                    "dependencySource": skill.tool_dependencies.source.name(),
                    "dependencyIssues": skill.tool_dependencies.issues,
                })
            })
            .collect();
        Ok(json!({"cwd": path_text(cwd), "count": rows.len(), "tools": tools, "skills": rows}))
    }

    async fn current_cwd(&self, params: &Value) -> Result<PathBuf, Failure> {
        self.host.current_cwd(params.get("threadId").and_then(Value::as_str)).await
    }

    /// `statusCwd`: the folder a caller asked the status for, if it asked. The wire carries Node's `options`
    /// argument as `params.options`. A new-task draft names a `projectPath` instead of a folder: the folder the
    /// task would run in (`forwardedArgs` of the Node desktop host); the renderer never names the folder itself.
    async fn requested_cwd(&self, options: &Value) -> Result<Option<PathBuf>, Failure> {
        if let Some(project) = options.get("projectPath") {
            let project = match project {
                Value::String(path) => path.as_str(),
                Value::Null => "",
                _ => return Err("projectPath must be a string.".to_owned()),
            };
            return self.projects.workspace_cwd(project).await.map(Some);
        }
        let Some(value) = options.get("cwd").filter(|v| !v.is_null()) else { return Ok(None) };
        let absolute = value.as_str().filter(|s| !s.is_empty() && !s.contains('\0') && Path::new(s).is_absolute());
        let Some(cwd) = absolute else { return Err("skillsStatus cwd must be an absolute path.".to_owned()) };
        let cwd = PathBuf::from(cwd);
        let probe = cwd.clone();
        if !self.on_lane(move |lane| is_directory(lane, &probe)).await? {
            return Err("skillsStatus cwd is not a directory.".to_owned());
        }
        Ok(Some(cwd))
    }

    /// Scoped only when the caller names what it asks about: a folder or Project (`options.cwd`, `options.projectPath`), or
    /// `options.scoped: true` from a session asking about itself (the setup tool's status, the doctor), scoped to its
    /// thread's folder. A thread id alone is the transport's route and leaves the status unscoped.
    async fn skills_status(&self, params: &Value) -> Result<Value, Failure> {
        let options = params.get("options").unwrap_or(&Value::Null);
        let requested = self.requested_cwd(options).await?;
        let scoped = requested.is_some() || options.get("scoped") == Some(&Value::Bool(true));
        let cwd = match requested {
            Some(cwd) => cwd,
            None => self.current_cwd(params).await?,
        };
        let status = self.status_in(&cwd, scoped).await?;
        Ok(decorate_skills(&status, &self.scopes(), &cwd))
    }

    async fn skill_content(&self, params: &Value) -> Result<Value, Failure> {
        let name = js_trim(&text_or_empty(params.get("name"))).to_owned();
        if name.is_empty() {
            return Err("skill name is required".to_owned());
        }
        let Some(resource) = self.resource(&name).await? else { return Err(format!("skill not found: {name}")) };
        let skill = &resource.skill;
        let name = if name.contains(':') { skill.name.clone() } else { name };
        Ok(json!({
            "key": skill.key(),
            "content": resource.body,
            "dir": resource.dir,
            "filePath": path_text(&skill.file_path),
            "source": source_name(skill.source),
            "toolDependencies": skill.tool_dependencies.tool_dependencies,
            "declaredToolDependencies": skill.tool_dependencies.declared,
            "dependencySource": skill.tool_dependencies.source.name(),
            "dependencyIssues": skill.tool_dependencies.issues,
            "name": name,
        }))
    }

    async fn save_dependencies(&self, file_path: &Path, deps: &Deps) -> Result<(), Failure> {
        let value = match deps {
            Deps::Untouched => return Ok(()),
            Deps::Clear => None,
            Deps::Set(value) => Some(value),
        };
        save_skill_tool_dependencies(self.durability, &self.data_dir, file_path, value).await.map_err(|e| e.to_string())
    }

    /// `addGlobalSkill`.
    async fn add_global_skill(&self, input: &Value) -> Result<Value, Failure> {
        let name = checked_name(&text_or_empty(input.get("name"))).map_err(|e| e.to_string())?;
        let description = checked_description(&text_or_empty(input.get("description"))).map_err(|e| e.to_string())?;
        let when_to_use = checked_when_to_use(&text_or_empty(input.get("whenToUse"))).map_err(|e| e.to_string())?;
        let body = Some(first_text(input, ["instructions", "body"])).filter(|b| !b.is_empty()).unwrap_or_else(|| DEFAULT_SKILL_BODY.to_owned());
        let deps = match input.get("toolDependencies") {
            None => Deps::Untouched,
            Some(value) => Deps::Set(Value::Array(normalize_dependencies(value, true)?)),
        };
        let dir = self.global_root().join(&name);
        let file_path = dir.join("SKILL.md");
        let job_path = file_path.clone();
        let job_dir = dir.clone();
        let job_name = name.clone();
        self.on_lane(move |lane| write_new_skill(lane, &job_dir, &job_path, &job_name, &description, &when_to_use, &body)).await??;
        self.save_dependencies(&file_path, &deps).await?;
        self.invalidate();
        Ok(json!({"name": name, "filePath": path_text(&file_path)}))
    }

    /// `saveSkillDocument`.
    async fn save_skill_document(&self, input: &Value) -> Result<Value, Failure> {
        let original = skill_reference(input, "originalName")?;
        let Some(resource) = self.resource(&original).await? else { return Err(format!("skill not found: {original}")) };
        let original = resource.skill.name.clone();
        let file_path = resource.skill.file_path.clone();
        let deps = deps_of(input, true)?;
        if input.get("dependenciesOnly") == Some(&Value::Bool(true)) {
            if matches!(deps, Deps::Untouched) {
                return Err("Skill tool dependencies are required.".to_owned());
            }
            self.save_dependencies(&file_path, &deps).await?;
            self.invalidate();
            return Ok(json!({"originalName": original, "name": original, "filePath": path_text(&file_path)}));
        }
        let name = checked_name(&text_or_empty(input.get("name"))).map_err(|e| e.to_string())?;
        let description = checked_description(&text_or_empty(input.get("description"))).map_err(|e| e.to_string())?;
        let when_to_use = checked_when_to_use(&text_or_empty(input.get("whenToUse"))).map_err(|e| e.to_string())?;
        let body = first_text(input, ["instructions", "body"]);
        let root = self.global_root();
        if file_path.strip_prefix(&root).map_or(true, |relative| relative.as_os_str().is_empty()) {
            return Err(format!("plugin skill is read-only: {original}"));
        }
        // Only another skill of the user's own folder can stand at the destination name.
        let every = self.every_skill().await?;
        if every.iter().any(|s| s.source == SkillSource::Global && s.name == name && s.file_path != file_path) {
            return Err(format!("skill already exists: {name}"));
        }
        let (job_file, job_original, job_name) = (file_path.clone(), original.clone(), name.clone());
        let outcome = self.on_lane(move |lane| rewrite_skill(lane, &job_file, &job_original, &job_name, &description, &when_to_use, &body)).await??;
        match outcome {
            Rewrite::Unchanged => {
                self.save_dependencies(&file_path, &deps).await?;
            }
            Rewrite::Written(new_path) => {
                if matches!(deps, Deps::Untouched) {
                    if new_path != file_path && resource.skill.tool_dependencies.source == DependencySource::Override {
                        let kept = Deps::Set(Value::Array(resource.skill.tool_dependencies.tool_dependencies.clone()));
                        self.save_dependencies(&new_path, &kept).await?;
                    }
                } else {
                    self.save_dependencies(&new_path, &deps).await?;
                }
                self.invalidate();
                return Ok(json!({"originalName": original, "name": name, "filePath": path_text(&new_path)}));
            }
        }
        self.invalidate();
        Ok(json!({"originalName": original, "name": name, "filePath": path_text(&file_path)}))
    }

    /// `removeGlobalSkill`.
    async fn remove_global_skill(&self, input: &Value) -> Result<Value, Failure> {
        let name = skill_reference(input, "name")?;
        let Some(resource) = self.resource(&name).await? else { return Err(format!("skill not found: {name}")) };
        let name = resource.skill.name.clone();
        let dir = resource.skill.file_path.parent().unwrap_or(Path::new("")).to_path_buf();
        let inside = dir.strip_prefix(self.global_root()).is_ok_and(|relative| !relative.as_os_str().is_empty());
        if !inside || dir.file_name().and_then(|n| n.to_str()) != Some(name.as_str()) {
            return Err(format!("only your own skills can be removed: {name}"));
        }
        self.on_lane(move |lane| remove_dir(lane, &dir)).await??;
        self.invalidate();
        Ok(json!({"name": name}))
    }

    async fn set_disabled(&self, names: Vec<String>) -> Vec<String> {
        let normalized = normalize_disabled(names);
        self.config.set_disabled_skills(&normalized);
        normalized
    }

    /// Stores `names` as the disabled list and has every reader see it: the reply of `setDisabledSkills`.
    async fn adopt_disabled(&self, names: Vec<String>) -> Value {
        let disabled = self.set_disabled(names).await;
        self.host.flush_skills_save().await;
        self.host.invalidate_skills();
        self.invalidate();
        self.host.announce_without_invalidating("skills").await;
        json!({"disabled": disabled})
    }

    /// `setSkillEnabled(key, enabled)`: switches the one source's skill a status row's key names. Switching it back on
    /// from a bare name entry replaces that entry by the keys of the name's other skills, which stay off.
    async fn set_skill_enabled(&self, params: &Value) -> Result<Value, Failure> {
        let key = js_trim(&text_or_empty(params.get("key"))).to_owned();
        if key.is_empty() {
            return Err("skill key is required".to_owned());
        }
        let Some(enabled) = params.get("enabled").and_then(Value::as_bool) else { return Err("enabled (boolean) is required".to_owned()) };
        let _list = self.list_lock.lock().await;
        let Some(skill) = self.catalog.named(&key).await.map_err(|e| e.to_string())? else { return Err(format!("skill not found: {key}")) };
        if skill.follows_feature() {
            return Err(format!("skill \"{}\" follows its built-in feature and has no switch", skill.key()));
        }
        let own = skill.key();
        let list = self.disabled();
        let next = if enabled {
            expand_bare(without(list, &own), &self.every_skill().await?, &skill.name, &own)
        } else if listed(&list, &own) {
            list
        } else {
            list.into_iter().chain([own]).collect()
        };
        Ok(self.adopt_disabled(next).await)
    }

    async fn add_skill(&self, params: &Value) -> Result<Value, Failure> {
        let skill = self.add_global_skill(params.get("input").unwrap_or(&json!({}))).await?;
        self.host.announce("skills").await;
        Ok(json!({"skill": skill, "status": self.status(&self.current_cwd(params).await?).await?}))
    }

    async fn save_skill(&self, params: &Value) -> Result<Value, Failure> {
        let list_lock = self.list_lock.lock().await;
        let skill = self.save_skill_document(params.get("input").unwrap_or(&json!({}))).await?;
        let (original, name) = (skill["originalName"].as_str().unwrap_or_default().to_owned(), skill["name"].as_str().unwrap_or_default().to_owned());
        // A renamed own skill keeps its off state as its own key under the new name; a bare entry stays with the old name,
        // where it keeps the other sources' skills off.
        if original != name {
            let every = self.every_skill().await?;
            let (own_original, own_name) = (own_key(&original), own_key(&name));
            let before = self.disabled();
            let was_off = listed(&before, &own_original) || listed(&before, &original);
            let mut next = expand_bare(without(before.clone(), &own_original), &every, &original, &own_original);
            if was_off && !listed(&next, &own_name) {
                next.push(own_name);
            }
            if next != before {
                self.set_disabled(next).await;
                self.host.flush_skills_save().await;
            }
        }
        drop(list_lock);
        self.host.announce_without_invalidating("skills").await;
        Ok(json!({"skill": skill, "status": self.status(&self.current_cwd(params).await?).await?}))
    }

    async fn remove_skill(&self, params: &Value) -> Result<Value, Failure> {
        let list_lock = self.list_lock.lock().await;
        let removed = self.remove_global_skill(params.get("input").unwrap_or(&json!({}))).await?;
        let name = removed["name"].as_str().unwrap_or_default().to_owned();
        // A removed skill leaves no entry of its own behind; a bare entry of its name keeps only the other sources' skills off.
        let every = self.every_skill().await?;
        let own = own_key(&name);
        let before = self.disabled();
        let next = expand_bare(without(before.clone(), &own), &every, &name, &own);
        if next != before {
            self.set_disabled(next).await;
            self.host.flush_skills_save().await;
        }
        drop(list_lock);
        self.host.announce("skills").await;
        Ok(json!({"skill": removed, "status": self.status(&self.current_cwd(params).await?).await?}))
    }
}

/// `mkdirSync` and the first write of a new skill; a `SKILL.md` that holds no data (empty, NUL
/// filled by a crash) is no skill, so creating over it is allowed.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn write_new_skill(
    lane: &InLane<MaintenanceIo>,
    dir: &Path,
    file_path: &Path,
    name: &str,
    description: &str,
    when_to_use: &str,
    body: &str,
) -> Result<(), Failure> {
    if let Ok(existing) = std::fs::read(file_path)
        && !mixdog_statefile::holds_no_data(&existing)
    {
        return Err(format!("skill already exists: {name}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = create_document(&Fields { name, description, when_to_use }, body).map_err(|e| e.to_string())?;
    write_skill_file(lane, file_path, &text)
}

/// `writeSkillFile`: atomic, the replaced copy kept as `SKILL.md.bak`.
fn write_skill_file(lane: &InLane<MaintenanceIo>, path: &Path, text: &str) -> Result<(), Failure> {
    let opts = mixdog_statefile::Opts { backup: true, mode: 0o644, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::write_file(lane, path, text.as_bytes(), &opts).map(drop).map_err(|e| e.to_string())
}

enum Rewrite {
    Unchanged,
    Written(PathBuf),
}

/// The file work of a save: rename the skill's folder when its name changed and write the new
/// document, undoing the rename when the write fails.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn rewrite_skill(
    lane: &InLane<MaintenanceIo>,
    file_path: &Path,
    original: &str,
    name: &str,
    description: &str,
    when_to_use: &str,
    body: &str,
) -> Result<Rewrite, Failure> {
    let current_dir = file_path.parent().unwrap_or(Path::new("")).to_path_buf();
    if current_dir.file_name().and_then(|n| n.to_str()) != Some(original) {
        return Err(format!("skill folder does not match its name: {original}"));
    }
    let next_dir = current_dir.parent().unwrap_or(Path::new("")).join(name);
    if next_dir != current_dir && next_dir.exists() {
        return Err(format!("skill folder already exists: {name}"));
    }
    let source = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let parsed = parse_document(&source).map_err(|e| e.to_string())?;
    if name == original && description == parsed.description && when_to_use == parsed.when_to_use && js_trim(body) == js_trim(&parsed.body) {
        return Ok(Rewrite::Unchanged);
    }
    let updated = update_document(&source, &Fields { name, description, when_to_use }, body).map_err(|e| e.to_string())?;
    if next_dir == current_dir {
        write_skill_file(lane, file_path, &updated)?;
        return Ok(Rewrite::Written(file_path.to_path_buf()));
    }
    std::fs::rename(&current_dir, &next_dir).map_err(|e| e.to_string())?;
    let new_path = next_dir.join("SKILL.md");
    if let Err(error) = write_skill_file(lane, &new_path, &updated) {
        std::fs::rename(&next_dir, &current_dir).map_err(|e| e.to_string())?;
        return Err(error);
    }
    Ok(Rewrite::Written(new_path))
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn is_directory(_lane: &InLane<MaintenanceIo>, path: &Path) -> bool {
    path.is_dir()
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn remove_dir(_lane: &InLane<MaintenanceIo>, dir: &Path) -> Result<(), Failure> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[async_trait]
impl DomainService for SkillsService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params = &req.params;
        let value = match req.method.as_str() {
            "skills/skillsStatus" => self.skills_status(params).await,
            "skills/skillContent" => self.skill_content(params).await,
            "skills/getDisabledSkills" => Ok(json!({"disabled": self.disabled()})),
            "skills/addSkill" => self.add_skill(params).await,
            "skills/saveSkill" => self.save_skill(params).await,
            "skills/removeSkill" => self.remove_skill(params).await,
            "skills/reloadSkills" => {
                self.host.announce("skills").await;
                // The `String` failure ends as the skills `DomainError` through `domain_error` below.
                match self.current_cwd(params).await {
                    Ok(cwd) => self.status(&cwd).await,
                    Err(failure) => Err(failure),
                }
            }
            "skills/setDisabledSkills" => {
                let names: Vec<String> = params.get("names").and_then(Value::as_array).map(|l| l.iter().map(value_to_string).collect()).unwrap_or_default();
                let _list = self.list_lock.lock().await;
                Ok(self.adopt_disabled(names).await)
            }
            "skills/setSkillEnabled" => self.set_skill_enabled(params).await,
            other => {
                return Err(CoreError::CapabilityUnavailable { capability: other.into(), detail: "not served by the skills service".into() });
            }
        };
        value.map(Reply::Value).map_err(domain_error)
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
