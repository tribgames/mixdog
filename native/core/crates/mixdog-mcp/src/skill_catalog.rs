//! The skill list the session reads: collected from the skill roots once, reused until the
//! workspace watcher reports a change (no polling), plus the single-skill load the `Skill`
//! tool delivers (Node `collectSkillsCached`, `skillLoadRefusal`, `loadSkillResource`).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

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
use crate::skills::parse_document;
use crate::skills_watch::SkillsWatch;

/// The skill roots, in precedence order (global, plugins, bundled).
pub type SkillRoots = Arc<dyn Fn() -> Vec<SkillRoot> + Send + Sync>;

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
pub enum SkillLoad {
    Refused(SkillRefusal),
    NotFound,
    Loaded(SkillResource),
}

/// `MIXDOG_DISABLE_SKILLS`: `1`, `true`, `on` or `yes`.
pub fn skills_disabled_by_env() -> bool {
    let value = std::env::var("MIXDOG_DISABLE_SKILLS").unwrap_or_default().to_ascii_lowercase();
    matches!(value.as_str(), "1" | "true" | "on" | "yes")
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
    skills: Arc<Vec<Skill>>,
}

pub struct SkillCatalog {
    data_dir: PathBuf,
    maintenance: MaintenanceIo,
    roots: SkillRoots,
    settings: Arc<dyn SkillSettingsSource>,
    changes: watch::Receiver<u64>,
    cache: ArcSwap<Option<Cached>>,
}

impl SkillCatalog {
    pub fn new(
        data_dir: PathBuf,
        maintenance: MaintenanceIo,
        roots: SkillRoots,
        settings: Arc<dyn SkillSettingsSource>,
        watch: &SkillsWatch,
    ) -> Arc<Self> {
        Arc::new(Self { data_dir, maintenance, roots, settings, changes: watch.subscribe(), cache: ArcSwap::from_pointee(None) })
    }

    /// Drops the list so the next read collects it again (every write the app makes itself).
    pub fn invalidate(&self) {
        self.cache.store(Arc::new(None));
    }

    /// Every installed skill, first of a name winning; empty while skills are switched off by
    /// the environment.
    pub async fn skills(&self) -> Arc<Vec<Skill>> {
        if skills_disabled_by_env() {
            return Arc::new(Vec::new());
        }
        let generation = *self.changes.borrow();
        if let Some(cached) = &**self.cache.load()
            && cached.generation == generation
        {
            return Arc::clone(&cached.skills);
        }
        let (data_dir, roots) = (self.data_dir.clone(), (self.roots)());
        let collected = match self.maintenance.submit(&CancellationToken::new(), move |lane| collect_skills(lane, &data_dir, &roots)) {
            Ok(job) => job.await.unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        let skills = Arc::new(collected);
        self.cache.store(Arc::new(Some(Cached { generation, skills: Arc::clone(&skills) })));
        skills
    }

    /// The skills a session in `cwd` may see: not switched off, feature available, inside the
    /// skill's (and its plugin's) project scope.
    pub async fn visible(&self, cwd: &Path) -> Vec<Skill> {
        let settings = self.settings.current();
        self.skills()
            .await
            .iter()
            .filter(|s| !js_trim(&s.name).is_empty())
            .filter(|s| settings.gate.refusal(s).is_none() && settings.scopes.skill_allowed_for_cwd(s, cwd))
            .cloned()
            .collect()
    }

    /// Why the `Skill` tool refuses `name` at `cwd`, or `None`.
    fn refusal(&self, skills: &[Skill], name: &str, cwd: &Path) -> Option<SkillRefusal> {
        let settings = self.settings.current();
        let key = key_of(name);
        let skill = skills.iter().find(|s| key_of(&s.name) == key)?;
        if let Some(refusal) = settings.gate.refusal_named(skill, name) {
            return Some(refusal);
        }
        (!settings.scopes.skill_allowed_for_cwd(skill, cwd)).then(|| SkillRefusal::OutsideScope(name.to_owned()))
    }

    /// What the `Skill` tool delivers for `name` at `cwd`.
    pub async fn load(&self, name: &str, cwd: &Path) -> SkillLoad {
        let skills = self.skills().await;
        if let Some(refusal) = self.refusal(&skills, name, cwd) {
            return SkillLoad::Refused(refusal);
        }
        let wanted = js_trim(name);
        let Some(skill) = skills.iter().find(|s| s.name == wanted).cloned() else { return SkillLoad::NotFound };
        let path = skill.file_path.clone();
        let text = match self.maintenance.submit(&CancellationToken::new(), move |lane| read_text(lane, &path)) {
            Ok(job) => job.await.ok().flatten(),
            Err(_) => None,
        };
        let Some(text) = text else { return SkillLoad::NotFound };
        let Ok(document) = parse_document(&text) else { return SkillLoad::NotFound };
        let parent = skill.file_path.parent().unwrap_or_else(|| Path::new(""));
        let dir = skill_execution_dir(parent, skill.source);
        SkillLoad::Loaded(SkillResource { body: document.body, dir, skill })
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn read_text(_lane: &mixdog_rt::InLane<MaintenanceIo>, path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
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
