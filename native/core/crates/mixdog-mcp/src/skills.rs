//! Skills (T §5): `SKILL.md` documents under the global, plugin and bundled roots, the prompt
//! manifest, and the envelope delivered by the `Skill` tool. A skill that `requires` a feature
//! (for example `jsRuntime`, the bundled script runtime) is offered only while that feature is
//! active. Project-local `.mixdog/skills` is intentionally not read.

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
        if is_fence(line.trim_end_matches('\n')) {
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
            serde_yaml::from_str(&neutral).map_err(|_| SkillDocumentError::InvalidYaml(first.to_string()))?
        }
    };
    if !yaml.is_mapping() {
        return Err(SkillDocumentError::NotMapping);
    }
    Ok(front)
}

pub fn parse_document(markdown: &str) -> Result<SkillDocument, SkillDocumentError> {
    let (front, body) = split_frontmatter(markdown)?;
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(front).map_err(|e| SkillDocumentError::InvalidYaml(e.to_string()))?;
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

fn required_features(frontmatter: &Value) -> Vec<String> {
    let raw = frontmatter.get("metadata").and_then(|m| m.get("requires"));
    let items: Vec<String> = match raw {
        Some(Value::Array(list)) => list.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect(),
        Some(Value::String(s)) => s.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    items.into_iter().map(|s| js_trim(&s).to_owned()).filter(|s| !s.is_empty()).collect()
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn skill_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => skill_files(&path, out),
            Ok(t) if t.is_file() && entry.file_name() == "SKILL.md" => out.push(path),
            _ => {}
        }
    }
}

/// Collects skills from `roots` in order (global, plugins, bundled): the first skill of a name
/// wins. A non-plugin skill's folder name must equal its name; plugins ship nested layouts and
/// load by their declared name. Unparseable documents are skipped.
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
            if !seen.insert(document.name.clone()) {
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

/// What decides whether a skill is offered.
#[derive(Clone, Debug, Default)]
pub struct SkillGate {
    /// Lower-cased names switched off in settings.
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

    /// A bundled skill that requires a feature follows that feature, not the disabled list.
    fn follows_feature(skill: &Skill) -> bool {
        skill.source == SkillSource::Builtin && !skill.requires.is_empty()
    }

    pub fn refusal(&self, skill: &Skill) -> Option<SkillRefusal> {
        self.refusal_named(skill, &skill.name)
    }

    /// [`refusal`](Self::refusal) with the refusal naming the skill as the caller wrote it.
    pub fn refusal_named(&self, skill: &Skill, requested: &str) -> Option<SkillRefusal> {
        if let Some(feature) = self.missing_feature(skill) {
            return Some(SkillRefusal::MissingFeature { skill: requested.to_owned(), feature: feature.to_owned() });
        }
        (!Self::follows_feature(skill) && self.disabled.contains(&skill.name.to_lowercase()))
            .then(|| SkillRefusal::Disabled(requested.to_owned()))
    }

    pub fn offered<'a>(&self, skills: &'a [Skill]) -> Vec<&'a Skill> {
        skills.iter().filter(|s| self.refusal(s).is_none()).collect()
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

    #[test]
    fn rejects_bad_documents() {
        assert_eq!(parse_document("no front").unwrap_err(), SkillDocumentError::NoFrontmatter);
        assert_eq!(
            parse_document("---\nname: Bad_Name\ndescription: d\n---\n").unwrap_err(),
            SkillDocumentError::NameCharset
        );
        assert_eq!(
            parse_document("---\nname: a--b\ndescription: d\n---\n").unwrap_err(),
            SkillDocumentError::NameHyphens
        );
        assert_eq!(
            parse_document("---\nname: a\n---\n").unwrap_err(),
            SkillDocumentError::NotString("description")
        );
        assert!(matches!(
            parse_document("---\nname: a\nname: b\ndescription: d\n---\n").unwrap_err(),
            SkillDocumentError::InvalidYaml(_)
        ));
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

    #[test]
    fn envelope_resolves_placeholders() {
        let out = result_envelope("a<b", "run ${MIXDOG_SKILL_NODE} in ${MIXDOG_SKILL_DIR}", Some(Path::new("C:\\s\\d")));
        assert!(out.contains("<name>a&lt;b</name>"));
        assert!(out.contains("<base-dir>C:/s/d</base-dir>"));
        assert!(out.contains("run mixdog-skill-node in C:/s/d"));
    }
}
