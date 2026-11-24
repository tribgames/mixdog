//! The skill list the session reads: collected from the skill roots once, reused until the
//! workspace watcher reports a change (no polling), plus the single-skill load the `Skill`
//! tool delivers (Node `collectSkillsCached`, `skillLoadRefusal`, `loadSkillResource`).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use arc_swap::ArcSwap;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::scopes::ExtensionScopes;
use crate::skills::Skill;
use crate::skills::SkillGate;
use crate::skills::SkillRefusal;
use crate::skills::SkillRoot;
use crate::skills::SkillSource;
use crate::skills::collect_skills;
use crate::skills::entry_key;
use crate::skills::parse_document;
use crate::skills_watch::SkillsWatch;
use crate::skills_watch::WatchTargets;

/// The skill roots, in precedence order (global, plugins, bundled).
///
/// Evaluated on the maintenance lane: the plugin roots come from the registry file.
pub type SkillRoots = Arc<dyn Fn(&mixdog_rt::InLane<MaintenanceIo>) -> Vec<SkillRoot> + Send + Sync>;

/// What gates a skill right now: the disabled names and active features, and the project
/// scopes.
#[derive(Clone, Default, Debug)]
pub struct SkillSettings {
    pub gate: SkillGate,
    pub scopes: ExtensionScopes,
}

/// The current gate settings (read from the configuration on every call).
pub trait SkillSettingsSource: Send + Sync {
    fn current(&self) -> SkillSettings;
}

/// A skill the `Skill` tool delivers.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SkillResource {
    pub skill: Skill,
    pub body: String,
    /// The directory the model hands to external processes.
    pub dir: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
#[allow(clippy::large_enum_variant, reason = "Keep the public skill result and by-value resource ownership without a new per-load allocation")]
pub enum SkillLoad {
    Refused(SkillRefusal),
    NotFound,
    Loaded(SkillResource),
}

/// Why the catalog could not answer. Never folded into "no skills" or "not found".
#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("maintenance lane unavailable: {0}")]
    Lane(mixdog_rt::SubmitWaitError),
    #[error("maintenance job did not finish: {0}")]
    Dropped(mixdog_rt::JobDropped),
    #[error("skill file unreadable: {0}")]
    Read(std::io::Error),
}

/// The directory a skill runs from: a packaged desktop runtime reads built-in skills from
/// inside `runtime.asar`, which only Electron can open, so the build ships them as real files
/// beside the archive under `runtime.asar.unpacked`.
pub fn skill_execution_dir(dir: &Path, source: SkillSource) -> String {
    let text = dir.to_string_lossy().into_owned();
    if source != SkillSource::Builtin {
        return text;
    }
    let pattern = JsRegex::new_static(r"([\\/])runtime\.asar(?=[\\/]|$)", "");
    let Some(caps) = pattern.captures(&text) else { return text };
    let whole = caps.range();
    format!("{}{}runtime.asar.unpacked{}", &text[..whole.start], caps.get(1).unwrap_or_default(), &text[whole.end..])
}

fn key_of(name: &str) -> String {
    js_trim(name).to_lowercase()
}

struct Cached {
    generation: u64,
    /// Each skill behind its own count: every list handed out shares them.
    skills: Arc<Vec<Arc<Skill>>>,
}

pub struct SkillCatalog {
    data_dir: PathBuf,
    maintenance: MaintenanceIo,
    roots: SkillRoots,
    settings: Arc<dyn SkillSettingsSource>,
    changes: watch::Receiver<u64>,
    cache: ArcSwap<Option<Cached>>,
    /// What the watcher watches, re-registered with every collection (set once at composition).
    watching: OnceLock<(Arc<SkillsWatch>, SkillWatchTargets)>,
    /// Held by the collection a miss runs: a read that misses meanwhile waits for it and takes what it collected.
    #[allow(clippy::disallowed_types, reason = "one collection at a time, across the lane job it awaits")]
    collecting: tokio::sync::Mutex<()>,
}

/// The directories the skill list depends on, evaluated on the maintenance lane.
pub type SkillWatchTargets = Arc<dyn Fn(&mixdog_rt::InLane<MaintenanceIo>) -> WatchTargets + Send + Sync>;

fn read_text(_lane: &mixdog_rt::InLane<MaintenanceIo>, path: &Path) -> std::io::Result<Option<String>> {
    mixdog_statefile::read_content(path)?
        .map(|bytes| String::from_utf8(bytes).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_skills_in_the_archive_run_from_the_unpacked_copy() {
        let dir = Path::new("/app/resources/runtime.asar/src/skills/demo");
        assert_eq!(skill_execution_dir(dir, SkillSource::Builtin), "/app/resources/runtime.asar.unpacked/src/skills/demo");
        assert_eq!(skill_execution_dir(dir, SkillSource::Global), dir.to_string_lossy());
        let plain = Path::new("/app/runtime.asarx/demo");
        assert_eq!(skill_execution_dir(plain, SkillSource::Builtin), plain.to_string_lossy());
    }
}

/// `MIXDOG_DISABLE_SKILLS`:`1`, `true`, `on` or `yes`.
pub fn skills_disabled_by_env() -> bool {
    std::env::var("MIXDOG_DISABLE_SKILLS").is_ok_and(|value| skills_disabled(&value))
}

pub fn skills_disabled(value: &str) -> bool {
    ["1", "true", "on", "yes"].iter().any(|flag| value.eq_ignore_ascii_case(flag))
}
impl SkillCatalog {
    #[allow(clippy::disallowed_types, reason = "see SkillCatalog::collecting")]
    pub fn new(data_dir: PathBuf, maintenance: MaintenanceIo, roots: SkillRoots, settings: Arc<dyn SkillSettingsSource>, watch: &SkillsWatch) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            maintenance,
            roots,
            settings,
            changes: watch.subscribe(),
            cache: ArcSwap::from_pointee(None),
            watching: OnceLock::new(),
            collecting: tokio::sync::Mutex::new(()),
        })
    }

    /// Has `watch` follow the skill and plugin roots: each collection registers `targets` on it first,
    /// so a change after the scan is never missed, and a root created later is seen through its
    /// nearest existing ancestor and picked up by the collection that change causes.
    pub fn watch_roots(&self, watch: Arc<SkillsWatch>, targets: SkillWatchTargets) {
        let _ = self.watching.set((watch, targets));
    }

    /// Drops the list so the next read collects it again (every write the app makes itself).
    pub fn invalidate(&self) {
        self.cache.store(Arc::new(None));
    }

    /// One installed skill of each name: the one in use ([`SkillGate::in_use`] under the current
    /// settings, no project scope applied; a session's is [`skills_at`](Self::skills_at)); empty
    /// while skills are switched off by the environment.
    pub async fn skills(&self) -> Result<Vec<Arc<Skill>>, CatalogError> {
        let every = self.every_skill().await?;
        Ok(self.in_use(&every))
    }

    fn in_use(&self, every: &[Arc<Skill>]) -> Vec<Arc<Skill>> {
        self.settings.current().gate.in_use(every).into_iter().cloned().collect()
    }

    /// One skill of each name as a session in `cwd` has it: the one in use among those the project scope admits there.
    pub async fn skills_at(&self, cwd: &Path) -> Result<Vec<Arc<Skill>>, CatalogError> {
        let every = self.every_skill().await?;
        let settings = self.settings.current();
        Ok(settings.gate.in_use_where(&every, |s| settings.scopes.skill_allowed_for_cwd(s, cwd)).into_iter().cloned().collect())
    }

    /// The collected list, when nothing has changed since it was collected.
    fn fresh(&self) -> Option<Arc<Vec<Arc<Skill>>>> {
        let generation = *self.changes.borrow();
        match &**self.cache.load() {
            Some(cached) if cached.generation == generation => Some(Arc::clone(&cached.skills)),
            _ => None,
        }
    }

    /// Every installed skill of every source, in source order; empty while skills are switched
    /// off by the environment.
    pub async fn every_skill(&self) -> Result<Arc<Vec<Arc<Skill>>>, CatalogError> {
        if skills_disabled_by_env() {
            return Ok(Arc::default());
        }
        if let Some(skills) = self.fresh() {
            return Ok(skills);
        }
        let _collecting = self.collecting.lock().await;
        // The collection this one waited for answers it, unless something changed since.
        if let Some(skills) = self.fresh() {
            return Ok(skills);
        }
        let generation = *self.changes.borrow();
        let before = self.cache.load_full();
        let (data_dir, roots) = (self.data_dir.clone(), Arc::clone(&self.roots));
        let watching = self.watching.get().cloned();
        let (collected, watch_complete) = self
            .run(move |lane| {
                let registered = watching.as_ref().and_then(|(watch, targets)| {
                    let before = targets(lane);
                    watch.set_targets(&before).then_some((before, targets))
                });
                let skills = collect_skills(lane, &data_dir, &roots(lane));
                // An ancestor alone may have missed a root created before registration.
                let complete = registered.is_some_and(|(before, targets)| before == targets(lane));
                (skills, complete)
            })
            .await?;
        let skills = Arc::new(collected.into_iter().map(Arc::new).collect::<Vec<_>>());
        if watch_complete {
            let _ = self.cache.compare_and_swap(&before, Arc::new(Some(Cached { generation, skills: Arc::clone(&skills) })));
        }
        Ok(skills)
    }

    /// The list [`skills`](Self::skills) last collected, when nothing has changed since: no lane job, no wait. For readers that
    /// cannot await (Node's `skillsStatus()` is an in-memory read); `None` while the list is cold or stale, never a guess.
    pub fn cached(&self) -> Option<Vec<Arc<Skill>>> {
        if skills_disabled_by_env() {
            return Some(Vec::new());
        }
        self.fresh().map(|every| self.in_use(&every))
    }

    /// Runs `job` on the maintenance lane, waiting for room when the lane is full. A job the
    /// lane could not take or finish is an error, never an empty answer.
    async fn run<R, F>(&self, job: F) -> Result<R, CatalogError>
    where
        F: FnOnce(&mixdog_rt::InLane<MaintenanceIo>) -> R + Send + 'static,
        R: Send + 'static,
    {
        let cancel = CancellationToken::new();
        let handle = self.maintenance.submit_wait(&cancel, job).await.map_err(CatalogError::Lane)?;
        handle.await.map_err(CatalogError::Dropped)
    }

    /// The skills a session in `cwd` may see: not switched off, feature available, inside the
    /// skill's (and its plugin's) project scope.
    pub async fn visible_skills(&self, cwd: &Path) -> Result<Vec<Arc<Skill>>, CatalogError> {
        Ok(self.filter_visible(&self.skills_at(cwd).await?, cwd))
    }

    /// [`visible_skills`](Self::visible_skills), each skill copied, for a caller that needs the skills themselves.
    pub async fn visible(&self, cwd: &Path) -> Result<Vec<Skill>, CatalogError> {
        Ok(self.visible_skills(cwd).await?.iter().map(|skill| Skill::clone(skill)).collect())
    }

    fn filter_visible(&self, skills: &[Arc<Skill>], cwd: &Path) -> Vec<Arc<Skill>> {
        let settings = self.settings.current();
        skills
            .iter()
            .filter(|s| !js_trim(&s.name).is_empty())
            .filter(|s| settings.gate.refusal(s).is_none() && settings.scopes.skill_allowed_for_cwd(s, cwd))
            .cloned()
            .collect()
    }

    /// Why the `Skill` tool refuses `name` at `cwd`, or `None`.
    fn refusal(&self, skills: &[Arc<Skill>], name: &str, cwd: &Path) -> Option<SkillRefusal> {
        let settings = self.settings.current();
        let key = key_of(name);
        let skill = skills.iter().find(|s| key_of(&s.name) == key)?;
        if let Some(refusal) = settings.gate.refusal_named(skill, name) {
            return Some(refusal);
        }
        (!settings.scopes.skill_allowed_for_cwd(skill, cwd)).then(|| SkillRefusal::OutsideScope(name.to_owned()))
    }

    /// What the `Skill` tool delivers for `name` at `cwd`.
    pub async fn load(&self, name: &str, cwd: &Path) -> Result<SkillLoad, CatalogError> {
        let skills = self.skills_at(cwd).await?;
        if let Some(refusal) = self.refusal(&skills, name, cwd) {
            return Ok(SkillLoad::Refused(refusal));
        }
        Ok(match self.resource_from(&skills, name).await? {
            Some(resource) => SkillLoad::Loaded(resource),
            None => SkillLoad::NotFound,
        })
    }

    /// The one skill a request names, whether or not settings or scope would hide it from the model.
    /// A status row's key (`<sourceKey>:<name>`; a skill name holds no `:`) is that source's skill,
    /// matched as [`entry_key`]. A name (exactly, once trimmed) is the user's own skill of the name
    /// when there is one (the one the editor writes), else the one in use.
    pub async fn named(&self, value: &str) -> Result<Option<Skill>, CatalogError> {
        let every = self.every_skill().await?;
        Ok(self.named_shared(&every, js_trim(value)).map(|skill| Skill::clone(&skill)))
    }

    fn named_shared(&self, every: &[Arc<Skill>], wanted: &str) -> Option<Arc<Skill>> {
        if wanted.contains(':') {
            return every.iter().find(|s| entry_key(&s.key()) == entry_key(wanted)).cloned();
        }
        if let Some(own) = every.iter().find(|s| s.source == SkillSource::Global && s.name == wanted) {
            return Some(Arc::clone(own));
        }
        self.in_use(every).into_iter().find(|s| s.name == wanted)
    }

    /// `loadSkillResource`: the skill [`named`](Self::named) by `value`, with its body.
    pub async fn resource(&self, value: &str) -> Result<Option<SkillResource>, CatalogError> {
        let every = self.every_skill().await?;
        let Some(skill) = self.named_shared(&every, js_trim(value)) else { return Ok(None) };
        let name = skill.name.clone();
        self.resource_from(&[skill], &name).await
    }

    async fn resource_from(&self, skills: &[Arc<Skill>], name: &str) -> Result<Option<SkillResource>, CatalogError> {
        let wanted = js_trim(name);
        let Some(skill) = skills.iter().find(|s| s.name == wanted).cloned() else { return Ok(None) };
        let path = skill.file_path.clone();
        // A file removed since the scan is a skill that no longer loads (Node answers null);
        // any other read failure is a real failure.
        let Some(text) = self.run(move |lane| read_text(lane, &path)).await?.map_err(CatalogError::Read)? else {
            return Ok(None);
        };
        // `readSafe`: the file's text is trimmed, and an empty file is no skill.
        let text = js_trim(&text);
        if text.is_empty() {
            return Ok(None);
        }
        let Ok(document) = parse_document(text) else { return Ok(None) };
        let parent = skill.file_path.parent().unwrap_or_else(|| Path::new(""));
        let dir = skill_execution_dir(parent, skill.source);
        Ok(Some(SkillResource { body: document.body, dir, skill: Skill::clone(&skill) }))
    }
}
