//! `skill-creator/scripts/validate-skill.mjs`: the checks a skill folder must pass, their messages and order,
//! and the command line around them (warnings and errors on stderr, `Valid skill: <name>` on stdout, exit
//! code 0 or 1). The document is parsed by `mixdog-mcp`, which is proven equal to the Node parser.

use std::collections::HashSet;
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::JsRegex;
use mixdog_js::js_object_keys;
use mixdog_js::js_trim;
use mixdog_js::nodepath;
use mixdog_js::utf16_len;
use mixdog_mcp::skill_deps::normalize_dependencies;
use mixdog_mcp::skills::TRIGGER_LISTING_MAX;
use mixdog_mcp::skills::parse_document;
use serde_json::Value;

use crate::Outcome;
use crate::node_fs_message;

const ALLOWED_FIELDS: &[&str] =
    &["name", "description", "when_to_use", "license", "compatibility", "metadata", "allowed-tools", "dependencies"];

/// The UI description and the model's trigger have separate budgets: only `when_to_use` enters the model's
/// listing, and instructions live in the body.
const DESCRIPTION_MAX: usize = 100;
const COMPATIBILITY_MAX: usize = 500;
const BODY_LINES_MAX: usize = 500;

/// The skill a passing validation names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub directory: String,
}

/// `{ ok, errors, warnings, skill }` of `validateSkillDirectory`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Validation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub skill: Option<SkillSummary>,
}

impl Validation {
    fn failed(message: String) -> Self {
        Self { ok: false, errors: vec![message], warnings: Vec::new(), skill: None }
    }
}

/// The paths the body names inside `references/`, `scripts/` and `assets/`: first the ones in backticks, then
/// the ones in link targets, each once.
fn referenced_paths(body: &str) -> Vec<String> {
    static PATTERNS: std::sync::LazyLock<[JsRegex; 2]> = std::sync::LazyLock::new(|| {
        [
            JsRegex::new_static(r"`((?:references|scripts|assets)/[A-Za-z0-9._/-]+)`", "g"),
            JsRegex::new_static(r"\]\(((?:references|scripts|assets)/[A-Za-z0-9._/-]+)\)", "g"),
        ]
    });
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for pattern in PATTERNS.iter() {
        for path in pattern.captures_iter(body).filter_map(|caps| caps.get(1)) {
            if seen.insert(path) {
                found.push(path.to_owned());
            }
        }
    }
    found
}

/// `path.basename` of a resolved path.
fn basename(path: &str) -> &str {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let trimmed = path.trim_end_matches(is_sep);
    let name = trimmed.rsplit(is_sep).next().unwrap_or_default();
    // A drive root (`C:\`) has no base name.
    if cfg!(windows) && name.len() == trimmed.len() && name.len() == 2 && name.ends_with(':') { "" } else { name }
}

fn exists<P: ReadProof>(proof: &P, path: &str) -> bool {
    mixdog_fsio::metadata(proof, Path::new(path)).is_ok()
}

fn is_dir<P: ReadProof>(proof: &P, path: &str) -> bool {
    mixdog_fsio::metadata(proof, Path::new(path)).is_ok_and(|meta| meta.is_dir())
}

fn is_file<P: ReadProof>(proof: &P, path: &str) -> bool {
    mixdog_fsio::metadata(proof, Path::new(path)).is_ok_and(|meta| meta.is_file())
}

/// Resolves, reads and parses `SKILL.md`; a failure is the finished validation result.
fn load_skill_document<P: ReadProof>(
    proof: &P,
    input: Option<&str>,
) -> Result<(String, mixdog_mcp::skills::SkillDocument), Validation> {
    let Some(input) = input.filter(|input| !input.is_empty()) else {
        return Err(Validation::failed("A skill directory path is required.".to_owned()));
    };
    let skill_dir = nodepath::resolve_host(&[input]);
    let skill_file = nodepath::resolve_host(&[&skill_dir, "SKILL.md"]);
    if !is_dir(proof, &skill_dir) {
        return Err(Validation::failed(format!("Skill directory not found: {skill_dir}")));
    }
    if !is_file(proof, &skill_file) {
        return Err(Validation::failed(format!("SKILL.md not found: {skill_file}")));
    }
    let bytes = mixdog_fsio::read(proof, Path::new(&skill_file))
        .map_err(|error| Validation::failed(format!("Could not read SKILL.md: {}", node_fs_message(&error, "open", &skill_file))))?;
    let source = String::from_utf8_lossy(&bytes);
    match parse_document(&source) {
        Ok(parsed) => Ok((skill_dir, parsed)),
        Err(error) => Err(Validation::failed(error.to_string())),
    }
}

fn check_referenced_resources<P: ReadProof>(
    proof: &P,
    skill_dir: &str,
    body: &str,
    errors: &mut Vec<String>,
    warnings: &mut Vec<String>,
) {
    for resource in referenced_paths(body) {
        let resource_path = nodepath::resolve_host(&[skill_dir, &resource]);
        let rel = nodepath::relative_host(skill_dir, &resource_path);
        if rel.is_empty() || rel.starts_with("..") || nodepath::is_absolute_host(&rel) {
            errors.push(format!("Referenced resource escapes the skill directory: {resource}."));
        } else if !exists(proof, &resource_path) {
            // A skill that bundles no folder of that kind is usually naming a repository path of the target repo,
            // which this validator cannot resolve; a missing file inside a bundled folder is a broken link.
            let kind = resource.split('/').next().unwrap_or_default();
            if exists(proof, &nodepath::resolve_host(&[skill_dir, kind])) {
                errors.push(format!("Referenced resource does not exist: {resource}."));
            } else {
                warnings.push(format!(
                    "{resource} is not bundled with the skill; if it is a repository path, prefer a repo-relative form the reader can resolve, or bundle it."
                ));
            }
        }
    }
}

/// `validateSkillDirectory(inputPath)`.
pub fn validate_skill_directory<P: ReadProof>(proof: &P, input: Option<&str>) -> Validation {
    let (skill_dir, parsed) = match load_skill_document(proof, input) {
        Ok(loaded) => loaded,
        Err(failure) => return failure,
    };
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let mapping = parsed.frontmatter.as_object();
    if let Some(map) = mapping {
        for key in js_object_keys(map) {
            if !ALLOWED_FIELDS.contains(&key.as_str()) {
                errors.push(format!("Unsupported frontmatter field: {key}."));
            }
        }
    }
    let field = |name: &str| mapping.and_then(|map| map.get(name)).filter(|value| !value.is_null());
    if let Some(dependencies) = field("dependencies") {
        match dependencies.as_object() {
            None => errors.push("dependencies must be a mapping.".to_owned()),
            Some(map) => {
                if let Err(message) = normalize_dependencies(map.get("tools").unwrap_or(&Value::Null), false) {
                    errors.push(message);
                }
            }
        }
    }

    let (name, description, when_to_use, body) = (&parsed.name, &parsed.description, &parsed.when_to_use, &parsed.body);
    if basename(&skill_dir) != name {
        errors.push(format!("Folder name \"{}\" must match skill name \"{name}\".", basename(&skill_dir)));
    }
    if description.contains(['<', '>']) || when_to_use.contains(['<', '>']) {
        errors.push("description and when_to_use cannot contain angle brackets.".to_owned());
    }
    if utf16_len(description) > DESCRIPTION_MAX {
        warnings.push(format!(
            "description is {} characters; keep this UI summary within {DESCRIPTION_MAX} and put operating details in the instructions.",
            utf16_len(description)
        ));
    }
    if utf16_len(when_to_use) > TRIGGER_LISTING_MAX {
        warnings.push(format!(
            "when_to_use is {} characters; the model's trigger cuts at {TRIGGER_LISTING_MAX}, so text past that never routes the skill.",
            utf16_len(when_to_use)
        ));
    }
    if when_to_use.is_empty() {
        warnings.push(
            "when_to_use is empty; the model sees only the name, not the UI description. Add selection conditions and relevant boundaries."
                .to_owned(),
        );
    }
    if let Some(compatibility) = field("compatibility") {
        match compatibility.as_str() {
            None => errors.push("compatibility must be a string.".to_owned()),
            Some(text) if utf16_len(js_trim(text)) > COMPATIBILITY_MAX => {
                errors.push("compatibility must be 500 characters or fewer.".to_owned());
            }
            Some(_) => {}
        }
    }
    if field("metadata").is_some_and(|metadata| !metadata.is_object()) {
        errors.push("metadata must be a mapping.".to_owned());
    }
    if body.is_empty() {
        errors.push("SKILL.md must contain non-empty instructions after frontmatter.".to_owned());
    }
    let fence_lines = if body.is_empty() { 0 } else { body.split('\n').filter(|line| opens_fence(line)).count() };
    if fence_lines % 2 == 1 {
        errors.push("SKILL.md has an unclosed code fence; every ``` must start its own line.".to_owned());
    }
    let body_lines = if body.is_empty() { 0 } else { body.split('\n').count() };
    if body_lines > BODY_LINES_MAX {
        warnings.push(format!("SKILL.md body has {body_lines} lines; progressive disclosure is recommended above 500."));
    }

    check_referenced_resources(proof, &skill_dir, body, &mut errors, &mut warnings);

    Validation {
        ok: errors.is_empty(),
        errors,
        warnings,
        skill: Some(SkillSummary {
            name: name.clone(),
            description: description.clone(),
            when_to_use: when_to_use.clone(),
            directory: skill_dir,
        }),
    }
}

/// `/^ {0,3}(```|~~~)/.test(line)`.
fn opens_fence(line: &str) -> bool {
    let rest = line.trim_start_matches(' ');
    line.len() - rest.len() <= 3 && (rest.starts_with("```") || rest.starts_with("~~~"))
}

/// The command line: the first argument is the skill folder.
pub fn run_validate_skill<P: ReadProof>(proof: &P, args: &[String]) -> Outcome {
    let result = validate_skill_directory(proof, args.first().map(String::as_str));
    let mut outcome = Outcome::default();
    for warning in &result.warnings {
        outcome.eprint(&format!("WARNING: {warning}"));
    }
    for error in &result.errors {
        outcome.eprint(&format!("ERROR: {error}"));
    }
    match result.skill.filter(|_| result.ok) {
        Some(skill) => outcome.print(&format!("Valid skill: {}", skill.name)),
        None => outcome.code = 1,
    }
    outcome
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;

    use super::*;

    fn skill(name: &str, files: &[(&str, &str)]) -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = root.path().join(name);
        for (rel, text) in files {
            let path = dir.join(rel);
            mixdog_testkit::create_dir_all(path.parent().expect("parent"));
            mixdog_testkit::write(&path, text);
        }
        let path = dir.display().to_string();
        (root, path)
    }

    fn document(front: &[&str], body: &[&str]) -> String {
        format!("---\n{}\n---\n{}", front.join("\n"), body.join("\n"))
    }

    const SAMPLE: &[&str] = &["name: sample", "description: Sample skill.", "when_to_use: Sample requests."];

    #[test]
    fn a_valid_skill_prints_its_name() {
        let (_root, dir) = skill("sample", &[("SKILL.md", &document(SAMPLE, &["# Instructions", "Do it."]))]);
        let outcome = run_validate_skill(&Unlaned, &[dir]);
        assert_eq!(outcome, Outcome { stdout: "Valid skill: sample\n".to_owned(), stderr: String::new(), code: 0 });
    }

    #[test]
    fn the_description_and_trigger_budgets_are_separate() {
        let validate = |trigger: &str| {
            let front = [format!("description: {}", "A".repeat(100)), format!("when_to_use: {trigger}")];
            let text = document(&["name: sample", &front[0], &front[1]], &["# Instructions", "Do it."]);
            let (_root, dir) = skill("sample", &[("SKILL.md", &text)]);
            validate_skill_directory(&Unlaned, Some(&dir))
        };
        let within = validate(&"B".repeat(100));
        assert!(within.ok && within.warnings.is_empty());
        let over = validate(&"B".repeat(101));
        assert!(over.ok);
        assert_eq!(over.warnings.len(), 1);
        let missing = validate("''");
        assert!(missing.ok);
        assert_eq!(missing.warnings.len(), 1);
    }

    #[test]
    fn a_fence_glued_to_a_line_is_unclosed() {
        let check = |body: &[&str]| {
            let (_root, dir) = skill("sample", &[("SKILL.md", &document(SAMPLE, body))]);
            validate_skill_directory(&Unlaned, Some(&dir))
        };
        assert!(check(&["Write the prompt:", "```", "Use: photo", "```"]).ok);
        let glued = check(&["Never wrap the prompt in JSON.```", "Use: photo", "```"]);
        assert!(!glued.ok);
        assert!(glued.errors.join("\n").contains("unclosed code fence"));
        assert!(check(&["   ~~~", "x", "~~~"]).ok);
        assert!(!check(&["    ```", "x"]).errors.iter().any(|error| error.contains("unclosed")));
    }

    #[test]
    fn referenced_files_are_checked_inside_the_folder() {
        let body = ["See `references/a.md`, [b](scripts/b.sh), `references/../../x`, `assets/none.png`, `scripts/b.sh`."];
        let (_root, dir) = skill("sample", &[("SKILL.md", &document(SAMPLE, &body)), ("references/other.md", ""), ("scripts/b.sh", "")]);
        let result = validate_skill_directory(&Unlaned, Some(&dir));
        assert_eq!(
            result.errors,
            [
                "Referenced resource does not exist: references/a.md.",
                "Referenced resource escapes the skill directory: references/../../x.",
            ]
        );
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].starts_with("assets/none.png is not bundled with the skill;"));
    }

    #[test]
    fn field_checks_keep_their_order_and_text() {
        let front = [
            "name: other",
            "description: <b>",
            "extra: 1",
            "compatibility: 5",
            "metadata: [1]",
            "dependencies: nope",
        ];
        let (_root, dir) = skill("sample", &[("SKILL.md", &document(&front, &[]))]);
        let result = validate_skill_directory(&Unlaned, Some(&dir));
        assert_eq!(
            result.errors,
            [
                "Unsupported frontmatter field: extra.",
                "dependencies must be a mapping.",
                "Folder name \"sample\" must match skill name \"other\".",
                "description and when_to_use cannot contain angle brackets.",
                "compatibility must be a string.",
                "metadata must be a mapping.",
                "SKILL.md must contain non-empty instructions after frontmatter.",
            ]
        );
    }

    #[test]
    fn failures_before_the_checks_are_single_errors() {
        let (root, dir) = skill("sample", &[("SKILL.md", "no front matter")]);
        assert_eq!(validate_skill_directory(&Unlaned, None).errors, ["A skill directory path is required."]);
        assert_eq!(validate_skill_directory(&Unlaned, Some("")).errors, ["A skill directory path is required."]);
        assert_eq!(validate_skill_directory(&Unlaned, Some(&dir)).errors, ["SKILL.md must start with YAML frontmatter."]);
        let missing = root.path().join("missing").display().to_string();
        assert!(validate_skill_directory(&Unlaned, Some(&missing)).errors[0].starts_with("Skill directory not found: "));
        let empty = root.path().join("empty");
        mixdog_testkit::create_dir_all(&empty);
        assert!(validate_skill_directory(&Unlaned, Some(&empty.display().to_string())).errors[0].starts_with("SKILL.md not found: "));
        let outcome = run_validate_skill(&Unlaned, &[]);
        assert_eq!((outcome.code, outcome.stdout.as_str()), (1, ""));
        assert_eq!(outcome.stderr, "ERROR: A skill directory path is required.\n");
    }
}
