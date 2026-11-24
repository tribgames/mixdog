//! Skills (T §5): `SKILL.md` documents under the global, plugin and bundled roots, the prompt
//! manifest, and the envelope delivered by the `Skill` tool. A skill that `requires` a feature
//! (for example `jsRuntime`, the bundled script runtime) is offered only while that feature is
//! active. Project-local `.mixdog/skills` is intentionally not read.

use std::borrow::Borrow;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::locale_compare;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;

use crate::skill_deps::SkillToolDependencies;
use crate::skill_deps::read_skill_tool_dependencies;

pub const NAME_MAX: usize = 64;
pub const DESCRIPTION_MAX: usize = 1024;
pub const WHEN_TO_USE_MAX: usize = 1024;
/// A trigger is cut at this many characters in the model's listing, and shrinks evenly down to
/// the floor when many skills share the budget.
pub const TRIGGER_LISTING_MAX: usize = 100;
pub const TRIGGER_LISTING_MIN: usize = 60;
/// The feature name of the bundled script runtime.
pub const FEATURE_JS_RUNTIME: &str = "jsRuntime";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SkillDocumentError {
    #[error("SKILL.md must start with YAML frontmatter.")]
    NoFrontmatter,
    #[error("Invalid SKILL.md frontmatter: {0}")]
    InvalidYaml(String),
    #[error("SKILL.md frontmatter must be a YAML mapping.")]
    NotMapping,
    #[error("Skill {0} must be a string.")]
    NotString(&'static str),
    #[error("Skill name is required.")]
    NameRequired,
    #[error("Skill name must be 64 characters or fewer.")]
    NameTooLong,
    #[error("Skill name may contain only lowercase letters, numbers, and hyphens.")]
    NameCharset,
    #[error("Skill name cannot start or end with a hyphen or contain consecutive hyphens.")]
    NameHyphens,
    #[error("Skill description is required.")]
    DescriptionRequired,
    #[error("Skill description must be 1024 characters or fewer.")]
    DescriptionTooLong,
    #[error("Skill trigger must be 1024 characters or fewer.")]
    WhenToUseTooLong,
    #[error("Skill instructions are required.")]
    InstructionsRequired,
    /// The YAML writer failed on a value the document's tag cannot hold (Node's own error text).
    #[error("{0}")]
    Writer(String),
}

#[derive(Clone, PartialEq, Debug)]
pub struct SkillDocument {
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub body: String,
    pub frontmatter: Value,
}

/// Splits `---` frontmatter from the body.
fn split_frontmatter(markdown: &str) -> Result<(&str, &str), SkillDocumentError> {
    let text = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let is_fence = |line: &str| line.trim_end_matches(['\r']).trim_end_matches([' ', '\t']) == "---";
    let first_end = text.find('\n').ok_or(SkillDocumentError::NoFrontmatter)?;
    if !is_fence(&text[..first_end]) {
        return Err(SkillDocumentError::NoFrontmatter);
    }
    let front_start = first_end + 1;
    let mut offset = front_start;
    for line in text[front_start..].split_inclusive('\n') {
        // The closing fence follows a line break of its own: a fence right after the opening one is content.
        if offset > front_start && is_fence(line.trim_end_matches('\n')) {
            let front = text[front_start..offset].trim_end_matches('\n').trim_end_matches('\r');
            return Ok((front, &text[offset + line.len()..]));
        }
        offset += line.len();
    }
    Err(SkillDocumentError::NoFrontmatter)
}

fn text_field(map: &Value, field: &'static str, required: bool) -> Result<String, SkillDocumentError> {
    match map.get(field) {
        None | Some(Value::Null) if !required => Ok(String::new()),
        Some(Value::String(s)) => Ok(js_trim(s).to_owned()),
        _ => Err(SkillDocumentError::NotString(field)),
    }
}

pub fn validate_name(value: &str) -> Result<(), SkillDocumentError> {
    if value.is_empty() {
        return Err(SkillDocumentError::NameRequired);
    }
    if utf16_len(value) > NAME_MAX {
        return Err(SkillDocumentError::NameTooLong);
    }
    if !value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(SkillDocumentError::NameCharset);
    }
    if value.starts_with('-') || value.ends_with('-') || value.contains("--") {
        return Err(SkillDocumentError::NameHyphens);
    }
    Ok(())
}

/// The text of a YAML error as the `yaml` package of Node words it. A flow collection left open reads there as
/// "Flow sequence must end with a ]" at the root of the document and as "... in block collection must be
/// sufficiently indented and end with a ]" inside a block collection; any other error keeps the parser's words.
fn yaml_error_text(front: &str, error: &serde_yaml::Error) -> String {
    let text = error.to_string();
    for (opens, name, end) in [("flow sequence", "sequence", ']'), ("flow mapping", "map", '}')] {
        let Some((_, at)) = text.split_once(&format!("while parsing a {opens} at line ")) else { continue };
        if !text.contains(&format!("did not find expected ',' or '{end}'")) {
            continue;
        }
        let Some((line, column)) = at.split_once(" column ") else { continue };
        let (Ok(line), Ok(column)) = (line.trim().parse::<usize>(), column.trim().parse::<usize>()) else { continue };
        let before_on_line: String = front.lines().nth(line - 1).unwrap_or("").chars().take(column - 1).collect();
        let blank_before = before_on_line.trim().is_empty() && front.lines().take(line - 1).all(|l| l.trim().is_empty() || l.trim_start().starts_with('#'));
        return if blank_before {
            format!("Flow {name} must end with a {end}")
        } else {
            format!("Flow {name} in block collection must be sufficiently indented and end with a {end}")
        };
    }
    text
}

/// The frontmatter text of `markdown`, once it is known to parse as a YAML mapping.
pub(crate) fn frontmatter_of(markdown: &str) -> Result<&str, SkillDocumentError> {
    let (front, _) = split_frontmatter(markdown)?;
    let yaml: serde_yaml::Value = match serde_yaml::from_str(front) {
        Ok(yaml) => yaml,
        Err(first) => {
            // serde_yaml insists a `!!null`, `!!int`, `!!float` or `!!bool` tag holds such a
            // value; the `yaml` package of Node reads any other text as a string under the tag.
            static CORE_TAG: std::sync::LazyLock<mixdog_js::JsRegex> =
                std::sync::LazyLock::new(|| mixdog_js::JsRegex::new_static(r"!!(null|bool|int|float)(?=[ \t\r\n,\]}]|$)", "g"));
            let neutral = CORE_TAG.replace_all_with(front, |c| format!("!core-{}", c.get(1).unwrap_or_default()));
            serde_yaml::from_str(&neutral).map_err(|_| SkillDocumentError::InvalidYaml(yaml_error_text(front, &first)))?
        }
    };
    if !yaml.is_mapping() {
        return Err(SkillDocumentError::NotMapping);
    }
    Ok(front)
}

pub fn parse_document(markdown: &str) -> Result<SkillDocument, SkillDocumentError> {
    let (front, body) = split_frontmatter(markdown)?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(front).map_err(|e| SkillDocumentError::InvalidYaml(yaml_error_text(front, &e)))?;
    if !yaml.is_mapping() {
        return Err(SkillDocumentError::NotMapping);
    }
    let frontmatter = serde_json::to_value(&yaml).map_err(|e| SkillDocumentError::InvalidYaml(e.to_string()))?;
    let name = text_field(&frontmatter, "name", true)?;
    validate_name(&name)?;
    let description = text_field(&frontmatter, "description", true)?;
    if description.is_empty() {
        return Err(SkillDocumentError::DescriptionRequired);
    }
    if utf16_len(&description) > DESCRIPTION_MAX {
        return Err(SkillDocumentError::DescriptionTooLong);
    }
    let when_to_use = text_field(&frontmatter, "when_to_use", false)?;
    if utf16_len(&when_to_use) > WHEN_TO_USE_MAX {
        return Err(SkillDocumentError::WhenToUseTooLong);
    }
    let body = body.strip_prefix("\r\n").or_else(|| body.strip_prefix('\n')).unwrap_or(body).to_owned();
    Ok(SkillDocument { name, description, when_to_use, body, frontmatter })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SkillSource {
    Global,
    Plugin,
    Builtin,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SkillRoot {
    pub dir: PathBuf,
    pub source: SkillSource,
    pub plugin: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub file_path: PathBuf,
    pub source: SkillSource,
    pub plugin: Option<String>,
    /// `metadata.requires`: features that must be active for the skill to be offered.
    pub requires: Vec<String>,
    pub tool_dependencies: SkillToolDependencies,
}

/// The source part of a disabled-list entry: `global`, `plugin:<id>` or `builtin`.
pub fn source_key(source: SkillSource, plugin: Option<&str>) -> String {
    match source {
        SkillSource::Global => "global".to_owned(),
        SkillSource::Plugin => format!("plugin:{}", plugin.unwrap_or_default()),
        SkillSource::Builtin => "builtin".to_owned(),
    }
}

impl Skill {
    pub fn source_key(&self) -> String {
        source_key(self.source, self.plugin.as_deref())
    }

    /// The disabled-list entry that turns off this source's skill only: `<source>:<name>`.
    pub fn key(&self) -> String {
        format!("{}:{}", self.source_key(), self.name)
    }

    /// A built-in that requires a feature follows that feature, not the disabled list.
    pub fn follows_feature(&self) -> bool {
        self.source == SkillSource::Builtin && !self.requires.is_empty()
    }
}

/// The identity of a disabled-list entry (a key or a bare name): two entries are the same entry when these are equal.
pub fn entry_key(entry: &str) -> String {
    js_trim(entry).to_lowercase()
}

fn required_features(frontmatter: &Value) -> Vec<String> {
    let raw = frontmatter.get("metadata").and_then(|m| m.get("requires"));
    let items: Vec<String> = match raw {
        Some(Value::Array(list)) => list.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect(),
        Some(Value::String(s)) => s.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    items.into_iter().map(|s| js_trim(&s).to_owned()).filter(|s| !s.is_empty()).collect()
}

fn skill_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut queue = std::collections::VecDeque::from([(dir.to_path_buf(), Vec::<PathBuf>::new())]);
    while let Some((dir, mut ancestors)) = queue.pop_front() {
        walk_skill_dir(&dir, out, &mut ancestors, &mut queue);
    }
}

/// Lists one directory: its `SKILL.md` files go to `out`, its subfolders to the back of `queue`.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn walk_skill_dir(dir: &Path, out: &mut Vec<PathBuf>, ancestors: &mut Vec<PathBuf>, queue: &mut std::collections::VecDeque<(PathBuf, Vec<PathBuf>)>) {
    let Ok(real) = std::fs::canonicalize(dir) else { return };
    if ancestors.contains(&real) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    ancestors.push(real);
    for entry in entries {
        let path = entry.path();
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_dir() => queue.push_back((path, ancestors.clone())),
            Ok(meta) if meta.is_file() && entry.file_name() == "SKILL.md" => out.push(path),
            _ => {}
        }
    }
}

/// Collects skills from `roots` in order (global, plugins, bundled), every source's skill of a
/// name included; within one source the first skill of a name wins. Which one of a name is in
/// use is [`SkillGate::states`]. A non-plugin skill's folder name must equal its name; plugins
/// ship nested layouts and load by their declared name. Unparseable documents are skipped.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub fn collect_skills(lane: &InLane<MaintenanceIo>, data_dir: &Path, roots: &[SkillRoot]) -> Vec<Skill> {
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for root in roots {
        let mut files = Vec::new();
        skill_files(&root.dir, &mut files);
        for file in files {
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let Ok(document) = parse_document(js_trim(&text)) else { continue };
            let folder = file.parent().and_then(Path::file_name).and_then(|n| n.to_str());
            if root.source != SkillSource::Plugin && folder != Some(document.name.as_str()) {
                continue;
            }
            if !seen.insert((source_key(root.source, root.plugin.as_deref()), document.name.clone())) {
                continue;
            }
            skills.push(Skill {
                requires: required_features(&document.frontmatter),
                tool_dependencies: read_skill_tool_dependencies(lane, data_dir, &file, &document.frontmatter),
                name: document.name,
                description: document.description,
                when_to_use: document.when_to_use,
                file_path: file,
                source: root.source,
                plugin: root.plugin.clone(),
            });
        }
    }
    skills
}

/// Where a skill stands among the skills of its name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SkillState {
    InUse,
    Off,
    /// Another source's skill of the name, at this index of the list, is in use instead.
    Hidden {
        by: usize,
    },
}

/// What decides whether a skill is offered.
#[derive(Clone, Debug, Default)]
pub struct SkillGate {
    /// The disabled list's entries, each as [`entry_key`]. `<source>:<name>` ([`Skill::key`]) turns off that
    /// source's skill. A bare `<name>`, as earlier versions wrote it, turns off every skill of the
    /// name, unless the only one is a built-in that follows its feature: under first-of-name-wins
    /// the shadowed ones were never offered either.
    pub disabled: HashSet<String>,
    /// Features that are installed and on (`jsRuntime` while the bundled runtime exists).
    pub active_features: HashSet<String>,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum SkillRefusal {
    #[error("Error: skill \"{skill}\" needs the {feature} built-in feature, which is not installed or is switched off in Extensions → Plugin → Built-in")]
    MissingFeature { skill: String, feature: String },
    #[error("Error: skill \"{0}\" is disabled")]
    Disabled(String),
    #[error("Error: skill \"{0}\" is not available in this project (its project scope excludes the current folder)")]
    OutsideScope(String),
}

impl SkillGate {
    fn missing_feature<'a>(&self, skill: &'a Skill) -> Option<&'a str> {
        skill.requires.iter().find(|f| !self.active_features.contains(*f)).map(String::as_str)
    }

    /// The gate of a disabled list as the settings hold it.
    pub fn disabled_set<'a>(entries: impl IntoIterator<Item = &'a str>) -> HashSet<String> {
        entries.into_iter().map(entry_key).filter(|entry| !entry.is_empty()).collect()
    }

    pub fn refusal(&self, skill: &Skill) -> Option<SkillRefusal> {
        self.refusal_named(skill, &skill.name)
    }

    /// [`refusal`](Self::refusal) with the refusal naming the skill as the caller wrote it.
    pub fn refusal_named(&self, skill: &Skill, requested: &str) -> Option<SkillRefusal> {
        if let Some(feature) = self.missing_feature(skill) {
            return Some(SkillRefusal::MissingFeature { skill: requested.to_owned(), feature: feature.to_owned() });
        }
        self.turned_off(skill).then(|| SkillRefusal::Disabled(requested.to_owned()))
    }

    fn turned_off(&self, skill: &Skill) -> bool {
        !skill.follows_feature() && (self.disabled.contains(&entry_key(&skill.key())) || self.disabled.contains(&entry_key(&skill.name)))
    }

    /// Whether a bare entry turns off the whole group (the first of the name decides, as it did when it alone was kept).
    fn name_off(&self, first: &Skill) -> bool {
        !first.follows_feature() && self.disabled.contains(&entry_key(&first.name))
    }

    /// Indexes of `skills` by name, in order of each name's first appearance.
    fn groups<S: Borrow<Skill>>(skills: &[S]) -> Vec<Vec<usize>> {
        let mut at: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut groups: Vec<Vec<usize>> = Vec::new();
        for (index, skill) in skills.iter().enumerate() {
            let slot = *at.entry(entry_key(&skill.borrow().name)).or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
            groups[slot].push(index);
        }
        groups
    }

    /// [`states_where`](Self::states_where) with every skill in scope.
    pub fn states<S: Borrow<Skill>>(&self, skills: &[S]) -> Vec<SkillState> {
        self.states_where(skills, |_| true)
    }

    /// The state of each of `skills` (in source order) where `in_scope` tells the skills the caller's project scope admits:
    /// of a name, the first that is not turned off, has its required features and is in scope is in use and the rest of
    /// those are hidden by it; the others are off.
    pub fn states_where<S: Borrow<Skill>>(&self, skills: &[S], in_scope: impl Fn(&Skill) -> bool) -> Vec<SkillState> {
        let mut states = vec![SkillState::Off; skills.len()];
        for group in Self::groups(skills) {
            if self.name_off(skills[group[0]].borrow()) {
                continue;
            }
            let mut used = None;
            for index in group {
                let skill = skills[index].borrow();
                if self.turned_off(skill) || self.missing_feature(skill).is_some() || !in_scope(skill) {
                    continue;
                }
                states[index] = match used {
                    None => {
                        used = Some(index);
                        SkillState::InUse
                    }
                    Some(by) => SkillState::Hidden { by },
                };
            }
        }
        states
    }

    /// One skill of each name: the one in use, or the first of the name when every one is turned off (it reads as disabled).
    pub fn in_use<'a, S: Borrow<Skill>>(&self, skills: &'a [S]) -> Vec<&'a S> {
        self.in_use_where(skills, |_| true)
    }

    /// [`in_use`](Self::in_use) among the skills `in_scope` admits.
    pub fn in_use_where<'a, S: Borrow<Skill>>(&self, skills: &'a [S], in_scope: impl Fn(&Skill) -> bool) -> Vec<&'a S> {
        let states = self.states_where(skills, in_scope);
        Self::groups(skills).into_iter().map(|group| &skills[group.iter().copied().find(|&i| states[i] == SkillState::InUse).unwrap_or(group[0])]).collect()
    }

    pub fn offered<'a, S: Borrow<Skill>>(&self, skills: &'a [S]) -> Vec<&'a S> {
        self.in_use(skills).into_iter().filter(|s| self.refusal((*s).borrow()).is_none()).collect()
    }

    /// Why an off skill is off: `"name"` when a bare entry covers its name, `"source"` when its own key is listed,
    /// `"feature"` when a required feature is missing, else `"scope"` (the caller's project scope excludes it).
    pub fn off_by<S: Borrow<Skill>>(&self, skills: &[S], index: usize) -> &'static str {
        let skill = skills[index].borrow();
        let first = skills.iter().map(|s| -> &Skill { s.borrow() }).find(|s| entry_key(&s.name) == entry_key(&skill.name)).unwrap_or(skill);
        if self.name_off(first) {
            "name"
        } else if self.turned_off(skill) {
            "source"
        } else if self.missing_feature(skill).is_some() {
            "feature"
        } else {
            "scope"
        }
    }
}

/// Most skills the manifest lists; the rest are counted in a closing line.
pub const MANIFEST_LIMIT: usize = 80;
/// Whole-manifest ceiling (~1% of a 200k-token window at 4 chars/token).
pub const MANIFEST_CHAR_BUDGET: usize = 8_000;

/// One line of prompt text: whitespace folded, cut at a word boundary with `...`.
pub fn compact_manifest_text(value: &str, max: usize) -> String {
    let text = js_words(value).collect::<Vec<_>>().join(" ");
    let limit = max.max(1);
    if utf16_len(&text) <= limit {
        return text;
    }
    let head = slice_utf16(&text, (limit - 1).max(1));
    let cut = match head.rfind(' ') {
        Some(at) if utf16_len(&head[..at]) >= limit * 6 / 10 => &head[..at],
        _ => head.as_str(),
    };
    let trimmed = cut.trim_end_matches(|c: char| is_js_space(c) || ",.;:!?/-".contains(c));
    format!("{trimmed}...")
}

/// The compact skill manifest for the prompt, as Node builds it. Names are never cut; the shared
/// budget only shrinks triggers, evenly, down to the readable floor. A skill with linked tools
/// is followed by ` [tools: …]`.
pub fn build_manifest(skills: &[&Skill], limit: usize, char_budget: usize) -> String {
    let mut list: Vec<&Skill> = skills.iter().copied().filter(|s| !js_trim(&s.name).is_empty()).collect();
    if list.is_empty() {
        return String::new();
    }
    list.sort_by(|a, b| locale_compare(js_trim(&a.name), js_trim(&b.name)));
    let visible = &list[..list.len().min(limit.max(1))];
    let budget = if char_budget == 0 { MANIFEST_CHAR_BUDGET } else { char_budget }.max(1_000);
    let suffix = |skill: &Skill| {
        let names = skill.tool_dependencies.manifest_names();
        if names.is_empty() { String::new() } else { format!(" [tools: {}]", names.join(", ")) }
    };
    let overhead: usize = visible.iter().map(|s| utf16_len(js_trim(&s.name)) + utf16_len(&suffix(s)) + 4).sum();
    let per_entry = (budget as i64 - overhead as i64).div_euclid(visible.len() as i64);
    let trigger_cap = per_entry.clamp(TRIGGER_LISTING_MIN as i64, TRIGGER_LISTING_MAX as i64) as usize;
    let any_mcp = visible.iter().any(|s| s.tool_dependencies.manifest_names().iter().any(|n| n.starts_with("mcp:")));
    let mut lines = vec![
        "# available-skills".to_owned(),
        if any_mcp {
            "Selection triggers and linked tools. mcp:<server> denotes that server’s tools.".to_owned()
        } else {
            "Selection triggers and linked tools.".to_owned()
        },
        "<available_skills>".to_owned(),
    ];
    for skill in visible {
        let trigger = compact_manifest_text(&skill.when_to_use, trigger_cap);
        let name = js_trim(&skill.name);
        let head = if trigger.is_empty() { format!("- {name}") } else { format!("- {name}: {trigger}") };
        lines.push(format!("{head}{}", suffix(skill)));
    }
    if list.len() > visible.len() {
        lines.push(format!("- ... {} more skills omitted", list.len() - visible.len()));
    }
    lines.push("</available_skills>".to_owned());
    lines.join("\n")
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "---\nname: demo-skill\ndescription: Does a thing\nwhen_to_use: when asked\nmetadata:\n  requires: [jsRuntime, git]\n---\n\nBody ${MIXDOG_SKILL_NODE} ${MIXDOG_SKILL_DIR}\n";

    #[test]
    fn parses_frontmatter_and_body() {
        let doc = parse_document(DOC).unwrap();
        assert_eq!(doc.name, "demo-skill");
        assert_eq!(doc.when_to_use, "when asked");
        assert!(doc.body.starts_with("\nBody") || doc.body.starts_with("Body"));
        assert_eq!(required_features(&doc.frontmatter), vec!["jsRuntime", "git"]);
    }

    /// Makes `link` a link to the directory `target`: a symlink, or a junction where symlinks need a privilege.
    #[allow(clippy::disallowed_methods, reason = "a test fixture on a scratch directory")]
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap().status.success());
    }

    /// Node's recursive listing follows a link to a directory and reads a `SKILL.md` that is a link; a link back to an
    /// ancestor is entered once and ends.
    #[test]
    #[allow(clippy::disallowed_methods, reason = "a test fixture on a scratch directory")]
    fn skills_are_found_through_links_and_a_cycle_ends() {
        let root = tempfile::tempdir().unwrap();
        let skills = root.path().join("skills");
        let outside = root.path().join("outside").join("linked");
        std::fs::create_dir_all(skills.join("plain")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(skills.join("plain").join("SKILL.md"), "plain").unwrap();
        std::fs::write(outside.join("SKILL.md"), "linked").unwrap();
        link_dir(&outside, &skills.join("linked"));
        link_dir(&skills, &skills.join("plain").join("back"));
        let mut found = Vec::new();
        skill_files(&skills, &mut found);
        let names: Vec<String> = found
            .iter()
            .map(|p| p.strip_prefix(&skills).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
            .collect();
        assert_eq!(names, ["linked/SKILL.md", "plain/SKILL.md"]);
    }

    /// Node's listing is breadth-first: a shallower `SKILL.md` precedes a deeper one that sorts earlier, so a name
    /// declared by both keeps the shallower.
    #[test]
    #[allow(clippy::disallowed_methods, reason = "a test fixture on a scratch directory")]
    fn the_listing_is_breadth_first() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a").join("b")).unwrap();
        std::fs::create_dir_all(root.path().join("z")).unwrap();
        std::fs::write(root.path().join("a").join("b").join("SKILL.md"), "deep").unwrap();
        std::fs::write(root.path().join("z").join("SKILL.md"), "shallow").unwrap();
        let mut found = Vec::new();
        skill_files(root.path(), &mut found);
        assert_eq!(found, [root.path().join("z").join("SKILL.md"), root.path().join("a").join("b").join("SKILL.md")]);
    }

    #[cfg(unix)]
    #[test]
    #[allow(clippy::disallowed_methods, reason = "a test fixture on a scratch directory")]
    fn a_skill_file_that_is_a_symlink_is_listed() {
        let root = tempfile::tempdir().unwrap();
        let skill = root.path().join("skills").join("dev");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(root.path().join("real.md"), "body").unwrap();
        std::os::unix::fs::symlink(root.path().join("real.md"), skill.join("SKILL.md")).unwrap();
        let mut found = Vec::new();
        skill_files(&root.path().join("skills"), &mut found);
        assert_eq!(found, [skill.join("SKILL.md")]);
    }

    #[test]
    fn rejects_bad_documents() {
        assert_eq!(parse_document("no front").unwrap_err(), SkillDocumentError::NoFrontmatter);
        assert_eq!(parse_document("---\nname: Bad_Name\ndescription: d\n---\n").unwrap_err(), SkillDocumentError::NameCharset);
        assert_eq!(parse_document("---\nname: a--b\ndescription: d\n---\n").unwrap_err(), SkillDocumentError::NameHyphens);
        assert_eq!(parse_document("---\nname: a\n---\n").unwrap_err(), SkillDocumentError::NotString("description"));
        assert!(matches!(parse_document("---\nname: a\nname: b\ndescription: d\n---\n").unwrap_err(), SkillDocumentError::InvalidYaml(_)));
    }

    #[test]
    fn gate_refuses_missing_feature_and_disabled() {
        let doc = parse_document(DOC).unwrap();
        let skill = Skill {
            name: doc.name,
            description: doc.description,
            when_to_use: doc.when_to_use,
            file_path: PathBuf::from("x"),
            source: SkillSource::Global,
            plugin: None,
            requires: vec![FEATURE_JS_RUNTIME.to_owned()],
            tool_dependencies: SkillToolDependencies::none(),
        };
        let mut gate = SkillGate::default();
        assert!(matches!(gate.refusal(&skill), Some(SkillRefusal::MissingFeature { .. })));
        gate.active_features.insert(FEATURE_JS_RUNTIME.to_owned());
        assert_eq!(gate.refusal(&skill), None);
        gate.disabled.insert("demo-skill".to_owned());
        assert_eq!(gate.refusal(&skill), Some(SkillRefusal::Disabled("demo-skill".to_owned())));
    }

    #[test]
    fn manifest_counts_what_is_not_listed() {
        let make = |n: usize| Skill {
            name: format!("skill-{n:03}"),
            description: String::new(),
            when_to_use: "use it when the user asks for this particular thing".to_owned(),
            file_path: PathBuf::new(),
            source: SkillSource::Global,
            plugin: None,
            requires: Vec::new(),
            tool_dependencies: SkillToolDependencies::none(),
        };
        let skills: Vec<Skill> = (0..90).map(make).collect();
        let refs: Vec<&Skill> = skills.iter().collect();
        let manifest = build_manifest(&refs, MANIFEST_LIMIT, MANIFEST_CHAR_BUDGET);
        assert!(manifest.contains("- ... 10 more skills omitted"));
        assert!(!manifest.contains("skill-089"));
    }

    const BROWSER_USE: &str = include_str!("../../../../../src/defaults/skills/browser-use/SKILL.md");
    const BROWSER_TOOL: &str = include_str!("../../mixdog-tools/src/desktop/defs/browser.json");
    const BROWSER_DEVTOOLS_TOOL: &str = include_str!("../../mixdog-tools/src/desktop/defs/browser_devtools.json");

    #[test]
    fn envelope_resolves_placeholders() {
        let out = result_envelope("a<b", "run ${MIXDOG_SKILL_NODE} in ${MIXDOG_SKILL_DIR}", Some(Path::new("C:\\s\\d")));
        assert!(out.contains("<name>a&lt;b</name>"));
        assert!(out.contains("<base-dir>C:/s/d</base-dir>"));
        assert!(out.contains("run mixdog-skill-node in C:/s/d"));
    }
    /// The step that gets the bundled browser-use skill in front of the model before its first browser call: both browser tool
    /// definitions tell it to load the skill, the skill is offered (named in the prompt manifest with the tools it arms) exactly while the
    /// browser feature is active, and loading it delivers its body, which the next provider request carries.
    #[test]
    fn browser_use_is_offered_while_the_browser_is_active_and_delivers_its_body() {
        for definition in [BROWSER_TOOL, BROWSER_DEVTOOLS_TOOL] {
            assert!(definition.contains("Load the browser-use skill before first use"));
        }
        let document = parse_document(js_trim(BROWSER_USE)).unwrap();
        assert_eq!(document.name, "browser-use");
        let dependencies = crate::skill_deps::normalize_dependencies(&document.frontmatter["dependencies"]["tools"], false).unwrap();
        let skill = Skill {
            name: document.name.clone(),
            description: document.description.clone(),
            when_to_use: document.when_to_use.clone(),
            file_path: PathBuf::from("browser-use/SKILL.md"),
            source: SkillSource::Builtin,
            plugin: None,
            requires: required_features(&document.frontmatter),
            tool_dependencies: SkillToolDependencies {
                tool_dependencies: dependencies.clone(),
                declared: dependencies,
                source: crate::skill_deps::DependencySource::Declaration,
                issues: Vec::new(),
            },
        };
        assert_eq!(skill.requires, vec!["browser"]);
        let mut gate = SkillGate::default();
        assert!(gate.offered(std::slice::from_ref(&skill)).is_empty());
        assert!(matches!(gate.refusal(&skill), Some(SkillRefusal::MissingFeature { feature, .. }) if feature == "browser"));
        gate.active_features.insert("browser".to_owned());
        let offered = gate.offered(std::slice::from_ref(&skill));
        assert_eq!(offered.len(), 1);
        let manifest = build_manifest(&offered, MANIFEST_LIMIT, MANIFEST_CHAR_BUDGET);
        assert!(manifest.contains("- browser-use: ") && manifest.contains("[tools: browser, handoff_user]"), "{manifest}");
        let envelope = result_envelope(&skill.name, &document.body, Some(Path::new("C:/s/browser-use")));
        assert!(envelope.starts_with("<skill>\n<name>browser-use</name>\n<base-dir>C:/s/browser-use</base-dir>\n"));
        assert!(envelope.contains("# Browser Use"));
    }
}

/// The `<skill>` envelope a `Skill` call delivers; `${MIXDOG_SKILL_NODE}` and
/// `${MIXDOG_SKILL_DIR}` in the body are resolved here.
pub fn result_envelope(name: &str, body: &str, skill_dir: Option<&Path>) -> String {
    let mut body = body.replace("${MIXDOG_SKILL_NODE}", crate::launcher::SKILL_LAUNCHER_COMMAND);
    let mut dir_line = String::new();
    if let Some(dir) = skill_dir {
        let normalized = dir.to_string_lossy().replace('\\', "/");
        body = body.replace("${MIXDOG_SKILL_DIR}", &normalized);
        dir_line = format!("<base-dir>{}</base-dir>\n", escape_xml(&normalized));
    }
    format!("<skill>\n<name>{}</name>\n{dir_line}{body}\n</skill>", escape_xml(name))
}
