//! Explicit skill tool dependencies: the tools (`tool`) and MCP servers (`mcp`) a skill needs,
//! declared in `SKILL.md` frontmatter (`dependencies.tools`) or `agents/openai.yaml`, and the
//! user's local override that replaces the declaration. Imported manifests are read, never
//! rewritten; a dependency is a request to load tools, never a permission.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_DEPENDENCIES: usize = 128;
const ROOT_DIR: &str = "skill-tool-dependencies";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DependencySource {
    None,
    Declaration,
    Override,
}

impl DependencySource {
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Declaration => "declaration",
            Self::Override => "override",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SkillToolDependencies {
    /// What the skill loads: the override when there is one, else the declaration.
    pub tool_dependencies: Vec<Value>,
    pub declared: Vec<Value>,
    pub source: DependencySource,
    pub issues: Vec<String>,
}

impl SkillToolDependencies {
    pub fn none() -> Self {
        Self { tool_dependencies: Vec::new(), declared: Vec::new(), source: DependencySource::None, issues: Vec::new() }
    }

    /// The names the manifest lists after the skill: `tool` values and `mcp:<server>`.
    pub fn manifest_names(&self) -> Vec<String> {
        manifest_names(&self.tool_dependencies)
    }
}

pub fn manifest_names(dependencies: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in dependencies {
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or_default();
        let value = entry.get("value").and_then(Value::as_str).unwrap_or_default();
        let simple = !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'));
        if !matches!(kind, "tool" | "mcp") || !simple {
            continue;
        }
        let name = if kind == "mcp" { format!("mcp:{value}") } else { value.to_owned() };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// Validates and de-duplicates a `dependencies.tools` value. `strict` admits only `tool` and
/// `mcp` (what the local override stores).
pub fn normalize_dependencies(value: &Value, strict: bool) -> Result<Vec<Value>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let list = match value.as_array() {
        Some(list) if list.len() <= MAX_DEPENDENCIES => list,
        _ => return Err(format!("Skill dependencies.tools must be an array of at most {MAX_DEPENDENCIES} entries.")),
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in list {
        let Some(map) = entry.as_object() else {
            return Err("Each skill tool dependency needs type and value.".to_owned());
        };
        let text = |key: &str| map.get(key).and_then(Value::as_str).map(js_trim).unwrap_or_default().to_owned();
        let (kind, name) = (text("type").to_lowercase(), text("value"));
        let forbidden = |c: char| is_js_space(c) || matches!(c, '<' | '>' | '\0');
        if kind.is_empty()
            || name.is_empty()
            || utf16_len(&kind) > 64
            || utf16_len(&name) > 256
            || kind.chars().chain(name.chars()).any(forbidden)
        {
            return Err("Skill tool dependency type and value must be nonempty identifiers.".to_owned());
        }
        if strict && !matches!(kind.as_str(), "tool" | "mcp") {
            return Err(format!("Unsupported skill tool dependency type: {kind}"));
        }
        // Extra import metadata (URL, command, OAuth) is not executable authority.
        let mut kept: Map<String, Value> = map.clone();
        kept.insert("type".to_owned(), Value::String(kind.clone()));
        kept.insert("value".to_owned(), Value::String(name.clone()));
        if seen.insert(format!("{kind}:{name}")) {
            out.push(Value::Object(kept));
        }
    }
    Ok(out)
}

pub fn dependencies_root(data_dir: &Path) -> PathBuf {
    data_dir.join(ROOT_DIR)
}

/// `resolve()`: absolute, with `.` and `..` folded away.
fn resolve(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn override_path(data_dir: &Path, file_path: &Path) -> PathBuf {
    let mut key = resolve(file_path).to_string_lossy().into_owned();
    if cfg!(windows) {
        key = key.to_lowercase();
    }
    let digest = Sha256::digest(key.as_bytes());
    dependencies_root(data_dir).join(format!("{}.json", digest.iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn bounded_read(path: &Path) -> Result<String, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_METADATA_BYTES {
        return Err("Skill dependency metadata is too large.".to_owned());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// The dependencies of the skill at `file_path` (its `SKILL.md`) whose frontmatter is
/// `frontmatter`.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub fn read_skill_tool_dependencies(
    _lane: &InLane<MaintenanceIo>,
    data_dir: &Path,
    file_path: &Path,
    frontmatter: &Value,
) -> SkillToolDependencies {
    let mut issues = Vec::new();
    let mut declared: Vec<Value> = Vec::new();
    let mut add = |value: &Value, label: &str, issues: &mut Vec<String>| match normalize_dependencies(value, false) {
        Ok(list) => declared.extend(list),
        Err(error) => issues.push(format!("{label}: {error}")),
    };
    add(frontmatter.pointer("/dependencies/tools").unwrap_or(&Value::Null), "SKILL.md", &mut issues);
    let metadata = file_path.parent().unwrap_or(Path::new("")).join("agents").join("openai.yaml");
    if metadata.exists() {
        let parsed = bounded_read(&metadata).and_then(|text| {
            serde_yaml::from_str::<serde_yaml::Value>(&text)
                .map_err(|e| e.to_string())
                .and_then(|yaml| serde_json::to_value(yaml).map_err(|e| e.to_string()))
        });
        match parsed {
            Ok(doc) => add(doc.pointer("/dependencies/tools").unwrap_or(&Value::Null), "agents/openai.yaml", &mut issues),
            Err(error) => issues.push(format!("agents/openai.yaml: {error}")),
        }
    }
    let declared_list = match normalize_dependencies(&Value::Array(declared), false) {
        Ok(list) => list,
        Err(error) => {
            issues.push(error);
            Vec::new()
        }
    };
    let local = override_path(data_dir, file_path);
    if local.exists() {
        let loaded = bounded_read(&local).and_then(|text| {
            let doc: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            normalize_dependencies(doc.pointer("/dependencies/tools").unwrap_or(&Value::Null), false)
        });
        return match loaded {
            Ok(tools) => SkillToolDependencies {
                tool_dependencies: tools,
                declared: declared_list,
                source: DependencySource::Override,
                issues: Vec::new(),
            },
            // A broken override must not silently restore dependencies the user removed.
            Err(error) => SkillToolDependencies {
                tool_dependencies: Vec::new(),
                declared: declared_list,
                source: DependencySource::Override,
                issues: vec![format!("Local skill dependencies: {error}")],
            },
        };
    }
    let source = if !declared_list.is_empty() || !issues.is_empty() { DependencySource::Declaration } else { DependencySource::None };
    SkillToolDependencies { tool_dependencies: declared_list.clone(), declared: declared_list, source, issues }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job (InLane proof)")]
fn write_override(_lane: &InLane<DurabilityIo>, path: &Path, content: Option<String>) -> std::io::Result<()> {
    let Some(content) = content else {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".mixdog-tmp-{:08x}", rand::random::<u32>()));
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, content)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("{0}")]
    Invalid(String),
    #[error("could not save: {0}")]
    Io(String),
}

/// Saves the user's override for the skill at `file_path`. `None` restores the original
/// declaration; an empty list explicitly disconnects every tool.
pub async fn save_skill_tool_dependencies(
    io: DurabilityIo,
    data_dir: &Path,
    file_path: &Path,
    dependencies: Option<&Value>,
) -> Result<(), SaveError> {
    let path = override_path(data_dir, file_path);
    let content = match dependencies {
        None => None,
        Some(value) => {
            let tools = normalize_dependencies(value, true).map_err(SaveError::Invalid)?;
            let content = format!("{}\n", serde_json::to_string_pretty(&json!({"dependencies": {"tools": tools}})).unwrap_or_default());
            if content.len() as u64 > MAX_METADATA_BYTES {
                return Err(SaveError::Invalid("Skill dependency metadata is too large.".to_owned()));
            }
            Some(content)
        }
    };
    let job = io
        .submit(&CancellationToken::new(), move |lane| write_override(lane, &path, content))
        .map_err(|full| SaveError::Io(full.to_string()))?;
    job.await.map_err(|e| SaveError::Io(e.to_string()))?.map_err(|e| SaveError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_dedupes_and_rejects_bad_shapes() {
        let ok = normalize_dependencies(
            &json!([{"type": " MCP ", "value": "github", "url": "x"}, {"type": "mcp", "value": "github"}, {"type": "tool", "value": "read"}]),
            false,
        )
        .unwrap();
        assert_eq!(ok.len(), 2);
        assert_eq!(ok[0]["type"], "mcp");
        assert_eq!(ok[0]["url"], "x");
        assert!(normalize_dependencies(&json!("x"), false).is_err());
        assert!(normalize_dependencies(&json!([{"type": "tool", "value": "a b"}]), false).is_err());
        assert!(normalize_dependencies(&json!([{"type": "http", "value": "a"}]), true).unwrap_err().contains("Unsupported"));
        assert_eq!(manifest_names(&ok), ["mcp:github", "read"]);
    }
}
