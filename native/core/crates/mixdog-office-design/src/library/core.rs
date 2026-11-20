//! `design/library/design-library-core.mjs`: the schema and limits of the design library, the folder layout under the
//! data directory, the reading of its configuration (a config file, an override object and the five environment
//! variables `MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG`, `MIXDOG_OFFICE_DESIGN_PACK_URL`, `MIXDOG_OFFICE_DESIGN_PACK_KEY_ID`,
//! `MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY`, `MIXDOG_OFFICE_TEMPLATE_DIRS`), semantic-version order and the atomic JSON
//! write every library file goes through.
//!
//! Every failure is the message Node's error carried, as a `String`; values are `serde_json` values built in the order
//! Node builds its objects.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_fsio::ReadProof;
use mixdog_fsio::WriteProof;
use mixdog_js::{js_to_lowercase, js_trim, json_parse, json_stringify, to_number_of, value_to_string};
use mixdog_office_base::data_dir::resolve_path;
use mixdog_office_base::values::{plain_object, sha256, stable_value, truthy};
use mixdog_statefile::Opts;
use serde_json::{Map, Value};

use crate::{prop, text};

pub const SCHEMA_VERSION: u64 = 1;
pub const TEMPLATE_INSPECTOR_VERSION: u64 = 4;
const DEFAULT_CHECK_INTERVAL_MS: f64 = 5.0 * 60.0 * 1000.0;
pub const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_TEMPLATE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TEMPLATE_COUNT: usize = 200;
pub const MAX_LOCAL_TEMPLATE_COUNT: usize = 5_000;
pub const MAX_SCAN_DEPTH: usize = 8;
pub const MAX_COMPOSITION_HISTORY: usize = 48;

pub const FORMATS: [&str; 6] = ["docx", "xlsx", "pptx", "pdf", "csv", "tsv"];

/// The template file extensions and the format each stands for (`TEMPLATE_FORMATS`).
pub const TEMPLATE_FORMATS: [(&str, &str); 12] = [
    (".docx", "docx"),
    (".dotx", "docx"),
    (".docm", "docx"),
    (".dotm", "docx"),
    (".xlsx", "xlsx"),
    (".xltx", "xlsx"),
    (".xlsm", "xlsx"),
    (".xltm", "xlsx"),
    (".pptx", "pptx"),
    (".potx", "pptx"),
    (".pptm", "pptx"),
    (".potm", "pptx"),
];

pub const ALLOWED_LAYOUT_DEFAULTS: [&str; 9] =
    ["background", "backgroundRole", "slideRole", "titleSize", "layout", "create", "visualPlacement", "density", "variant"];

pub const LAYOUT_SLOT_TYPES: [&str; 5] = ["text", "image", "chart", "table", "diagram"];

/// `FORMATS.has(format)`.
pub fn is_format(format: &str) -> bool {
    FORMATS.contains(&format)
}

/// `TEMPLATE_FORMATS[extension]`.
pub fn template_format(extension: &str) -> Option<&'static str> {
    TEMPLATE_FORMATS.iter().find(|(known, _)| *known == extension).map(|(_, format)| *format)
}

/// Everything of the process the library reads: the five environment variables (empty when unset, as `||` sees
/// them), the platform and the Windows locations of installed Office templates, the working directory, the folder the
/// packaged templates sit in and the clock. `Environment::process()` is the real one; a test builds its own.
#[derive(Clone)]
pub struct Environment {
    pub library_config: String,
    pub pack_url: String,
    pub pack_key_id: String,
    pub pack_public_key: String,
    pub template_dirs: String,
    pub windows: bool,
    pub program_files: String,
    pub program_files_x86: String,
    pub app_data: String,
    pub home: String,
    pub cwd: PathBuf,
    /// `BUNDLED_TEMPLATE_DIRECTORY` (already the unpacked sidecar of an archive).
    pub bundled_templates: PathBuf,
    /// `Date.now()`.
    pub now_ms: Arc<dyn Fn() -> f64 + Send + Sync>,
}

/// `safeId` of a text (`String(value || '')` already taken).
pub fn safe_id_text(value: &str, label: &str) -> Result<String, String> {
    let normalized = js_to_lowercase(js_trim(value));
    let mut chars = normalized.chars();
    let valid = normalized.chars().count() <= 64
        && chars.next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if valid { Ok(normalized) } else { Err(format!("Office design {label} must use 1-64 lowercase letters, digits, dots, underscores, or hyphens")) }
}

/// `safeId(value, label)`.
pub fn safe_id(value: Option<&Value>, label: &str) -> Result<String, String> {
    safe_id_text(&text(value), label)
}

/// `canonicalPath(path)`: resolved against the working directory; lower case on Windows.
pub fn canonical_path(env: &Environment, path: &str) -> String {
    let resolved = env.resolve(path).to_string_lossy().into_owned();
    if cfg!(windows) { js_to_lowercase(&resolved) } else { resolved }
}

/// `sha256File(path)`.
pub fn sha256_file<P: ReadProof>(proof: &P, path: &Path) -> std::io::Result<String> {
    Ok(sha256(mixdog_fsio::read(proof, path)?))
}

/// `canonicalOfficeDesignPack(pack)`: the JSON text of the pack with every object's keys sorted.
pub fn canonical_office_design_pack(pack: &Value) -> String {
    json_stringify(&stable_value(pack))
}

/// A parsed semantic version.
pub struct Version {
    pub parts: [f64; 3],
    pub prerelease: String,
}

/// `parseVersion(value)` of a text.
pub fn parse_version(value: &str) -> Option<Version> {
    let text = js_trim(value);
    let text = text.strip_prefix('v').unwrap_or(text);
    let (core, prerelease) = match text.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (text, None),
    };
    if let Some(prerelease) = prerelease {
        if prerelease.is_empty() || !prerelease.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-')) {
            return None;
        }
    }
    let pieces: Vec<&str> = core.split('.').collect();
    if pieces.len() != 3 || pieces.iter().any(|piece| piece.is_empty() || !piece.bytes().all(|byte| byte.is_ascii_digit())) {
        return None;
    }
    let mut parts = [0.0; 3];
    for (slot, piece) in parts.iter_mut().zip(&pieces) {
        *slot = piece.parse::<f64>().ok()?;
    }
    Some(Version { parts, prerelease: prerelease.unwrap_or_default().to_owned() })
}

/// `compareOfficeDesignVersions(left, right)`: 1, 0 or -1.
pub fn compare_office_design_versions(left: &str, right: &str) -> Result<i32, String> {
    let (Some(a), Some(b)) = (parse_version(left), parse_version(right)) else {
        return Err(format!("Office design pack versions must be semantic versions: {left}, {right}"));
    };
    for index in 0..3 {
        if a.parts[index] != b.parts[index] {
            return Ok(if a.parts[index] > b.parts[index] { 1 } else { -1 });
        }
    }
    if !a.prerelease.is_empty() && b.prerelease.is_empty() {
        return Ok(-1);
    }
    if a.prerelease.is_empty() && !b.prerelease.is_empty() {
        return Ok(1);
    }
    if a.prerelease == b.prerelease {
        return Ok(0);
    }
    // JavaScript compares strings by UTF-16 code unit.
    Ok(if a.prerelease.encode_utf16().cmp(b.prerelease.encode_utf16()).is_gt() { 1 } else { -1 })
}

/// `libraryPaths(dataDir)`.
#[derive(Clone, Debug)]
pub struct LibraryPaths {
    pub root: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub packs: PathBuf,
    pub templates: PathBuf,
    pub template_index: PathBuf,
    pub composition_history: PathBuf,
    pub bindings: PathBuf,
}

pub fn library_paths(env: &Environment, data_dir: &Path) -> LibraryPaths {
    let root = resolve_path(&env.cwd, data_dir).join("office").join("design-library");
    LibraryPaths {
        config: root.join("config.json"),
        state: root.join("state.json"),
        packs: root.join("packs"),
        templates: root.join("templates"),
        template_index: root.join("template-index.json"),
        composition_history: root.join("composition-history.json"),
        bindings: root.join("bindings"),
        root,
    }
}

/// `readJson(path, fallback)`: the file's JSON object, else `fallback` (missing, unreadable, not JSON or not an
/// object).
pub fn read_json<P: ReadProof>(proof: &P, path: &Path, fallback: Value) -> Value {
    match mixdog_fsio::read(proof, path) {
        Ok(bytes) => match json_parse(&String::from_utf8_lossy(&bytes)) {
            Ok(parsed) if plain_object(&parsed) => parsed,
            _ => fallback,
        },
        Err(_) => fallback,
    }
}

/// `writeJsonAtomic(path, value)`: durable atomic replace; the replaced version stays as `<file>.bak`.
pub fn write_json_atomic<P: WriteProof>(lane: &P, path: &Path, value: &Value) -> Result<(), String> {
    let opts = Opts { backup: true, ..Opts::default() };
    mixdog_statefile::write_json(lane, path, value, &opts).map(|_| ()).map_err(|error| error.to_string())
}

fn resolve_config_path(env: &Environment, path: &str, base: &Path) -> String {
    let value = js_trim(path);
    if value.is_empty() {
        return String::new();
    }
    let given = Path::new(value);
    let resolved = if given.is_absolute() || given.has_root() { resolve_path(&env.cwd, given) } else { resolve_path(base, given) };
    resolved.to_string_lossy().into_owned()
}

/// The configuration the library runs with (`loadConfig`).
#[derive(Clone, Debug)]
pub struct LibraryConfig {
    pub manifest_url: String,
    pub trusted_keys: Map<String, Value>,
    pub pack_id: String,
    pub channel: String,
    pub check_interval_ms: f64,
    pub template_directories: Vec<String>,
    pub discover_installed_templates: bool,
    pub default_templates: Map<String, Value>,
}

fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

/// `defaultOfficeTemplateDirectories`: the packaged templates, and on Windows the Office installation's templates, the
/// user's template folder and `Documents\Custom Office Templates`.
pub fn default_office_template_directories(env: &Environment) -> Vec<String> {
    let mut directories = vec![env.bundled_templates.to_string_lossy().into_owned()];
    if env.windows {
        for root in [js_trim(&env.program_files), js_trim(&env.program_files_x86)].into_iter().filter(|root| !root.is_empty()) {
            directories.push(win32_path(&[root, "Microsoft Office", "root", "Templates"]));
        }
        let app_data = js_trim(&env.app_data);
        if !app_data.is_empty() {
            directories.push(win32_path(&[app_data, "Microsoft", "Templates"]));
        }
        if !env.home.is_empty() {
            directories.push(win32_path(&[&env.home, "Documents", "Custom Office Templates"]));
        }
    }
    dedupe(directories)
}

/// `win32.resolve(win32.join(...parts))` of an absolute drive path: separators are backslashes, `.` and `..` fold.
fn win32_path(parts: &[&str]) -> String {
    let joined = parts.join("\\").replace('/', "\\");
    let (drive, rest) = match joined.as_bytes() {
        [letter, b':', ..] if letter.is_ascii_alphabetic() => joined.split_at(2),
        _ => ("", joined.as_str()),
    };
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split('\\').filter(|segment| !segment.is_empty() && *segment != ".") {
        if segment == ".." {
            segments.pop();
        } else {
            segments.push(segment);
        }
    }
    format!("{drive}\\{}", segments.join("\\"))
}

/// `loadConfig(dataDir, override)`: the override object when it is one, else the config file (the variable
/// `MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG`, else `<library>/config.json`; a relative path is taken against the working
/// directory), with the environment variables applied.
pub fn load_config<P: ReadProof>(proof: &P, env: &Environment, data_dir: &Path, override_source: Option<&Value>) -> Result<LibraryConfig, String> {
    let paths = library_paths(env, data_dir);
    let configured = if env.library_config.is_empty() { paths.config.to_string_lossy().into_owned() } else { env.library_config.clone() };
    let config_path = PathBuf::from(resolve_config_path(env, &configured, &env.cwd));
    let source = match override_source {
        Some(given) if plain_object(given) => given.clone(),
        _ => read_json(proof, &config_path, Value::Object(Map::new())),
    };
    let base = config_path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut trusted_keys = match prop(&source, "trustedKeys") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let environment_key = js_trim(&env.pack_public_key.replace("\\n", "\n")).to_owned();
    if !environment_key.is_empty() {
        let id = if env.pack_key_id.is_empty() { "environment".to_owned() } else { env.pack_key_id.clone() };
        trusted_keys.insert(id, Value::String(environment_key));
    }
    let environment_directories = js_trim(&env.template_dirs);
    let listed = prop(&source, "templateDirectories").and_then(Value::as_array);
    let has_explicit_directories = listed.is_some() || !environment_directories.is_empty();
    let configured_directories: Vec<String> = match listed {
        Some(items) => items.iter().map(|entry| resolve_config_path(env, &text(Some(entry)), &base)).collect(),
        None => {
            let delimiter = if cfg!(windows) { ';' } else { ':' };
            environment_directories.split(delimiter).map(|entry| resolve_config_path(env, entry, &base)).collect()
        }
    };
    let discover_installed_templates = match prop(&source, "discoverInstalledTemplates") {
        None | Some(Value::Null) => !has_explicit_directories,
        Some(flag) => *flag != Value::Bool(false),
    };
    let mut directories = vec![paths.templates.to_string_lossy().into_owned()];
    if discover_installed_templates {
        directories.extend(default_office_template_directories(env));
    }
    directories.extend(configured_directories.into_iter().filter(|entry| !entry.is_empty()));
    let mut default_templates = match prop(&source, "defaultTemplates") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    if discover_installed_templates && !default_templates.get("pptx").is_some_and(truthy) {
        default_templates.insert("pptx".to_owned(), Value::String("mixdog-executive".to_owned()));
    }
    let manifest_url = if env.pack_url.is_empty() { text(prop(&source, "manifestUrl")) } else { env.pack_url.clone() };
    let pack_id = match prop(&source, "packId") {
        Some(id) if truthy(id) => safe_id(Some(id), "config packId")?,
        _ => String::new(),
    };
    let channel_text = match prop(&source, "channel") {
        Some(channel) if truthy(channel) => value_to_string(channel),
        _ => "stable".to_owned(),
    };
    let interval = to_number_of(prop(&source, "checkIntervalMs"));
    let interval = if interval.is_nan() || interval == 0.0 { DEFAULT_CHECK_INTERVAL_MS } else { interval };
    Ok(LibraryConfig {
        manifest_url: js_trim(&manifest_url).to_owned(),
        trusted_keys,
        pack_id,
        channel: js_to_lowercase(js_trim(&channel_text)),
        check_interval_ms: 10_000.0_f64.max(interval.min(24.0 * 60.0 * 60.0 * 1000.0)),
        template_directories: dedupe(directories),
        discover_installed_templates,
        default_templates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_ids_are_trimmed_lower_case_and_bounded() {
        assert_eq!(safe_id_text("  Pack_1.x ", "id").unwrap(), "pack_1.x");
        assert!(safe_id_text("", "pack id").unwrap_err().contains("Office design pack id must use 1-64"));
        assert!(safe_id_text("-a", "id").is_err());
        assert!(safe_id_text(&"a".repeat(65), "id").is_err());
        assert!(safe_id_text(&"a".repeat(64), "id").is_ok());
    }

    #[test]
    fn versions_order_like_the_node_comparison() {
        assert_eq!(compare_office_design_versions("1.2.3", "1.2.4").unwrap(), -1);
        assert_eq!(compare_office_design_versions("v2.0.0", "1.9.9").unwrap(), 1);
        assert_eq!(compare_office_design_versions("1.0.0-beta", "1.0.0").unwrap(), -1);
        assert_eq!(compare_office_design_versions("1.0.0-b", "1.0.0-a").unwrap(), 1);
        assert_eq!(compare_office_design_versions("1.0.0", "1.0.0").unwrap(), 0);
        assert_eq!(compare_office_design_versions("1.0", "1.0.0").unwrap_err(), "Office design pack versions must be semantic versions: 1.0, 1.0.0");
    }

    #[test]
    fn windows_template_locations_fold_dots() {
        assert_eq!(win32_path(&["C:\\Program Files", "Microsoft Office", "root", "Templates"]), "C:\\Program Files\\Microsoft Office\\root\\Templates");
        assert_eq!(win32_path(&["C:/a/b", "..", "c"]), "C:\\a\\c");
    }

    #[test]
    fn the_packaged_templates_are_read_from_assets_templates_beside_the_executable() {
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        assert_eq!(Environment::process().bundled_templates, exe_dir.join("assets").join("templates"));
    }
}

fn env_text(names: &[&str]) -> String {
    names.iter().filter_map(|name| std::env::var(name).ok()).find(|value| !value.is_empty()).unwrap_or_default()
}
impl Environment {
    /// The environment of this process. The packaged templates are read from `assets/templates` beside the executable.
    pub fn process() -> Self {
        let bundled = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default().join("assets").join("templates");
        Self {
            library_config: env_text(&["MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG"]),
            pack_url: env_text(&["MIXDOG_OFFICE_DESIGN_PACK_URL"]),
            pack_key_id: env_text(&["MIXDOG_OFFICE_DESIGN_PACK_KEY_ID"]),
            pack_public_key: env_text(&["MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY"]),
            template_dirs: env_text(&["MIXDOG_OFFICE_TEMPLATE_DIRS"]),
            windows: cfg!(windows),
            program_files: env_text(&["ProgramFiles", "PROGRAMFILES"]),
            program_files_x86: env_text(&["ProgramFiles(x86)", "PROGRAMFILES_X86"]),
            app_data: env_text(&["APPDATA"]),
            home: std::env::home_dir().map(|home| home.to_string_lossy().into_owned()).unwrap_or_default(),
            cwd: std::env::current_dir().unwrap_or_default(),
            bundled_templates: bundled,
            now_ms: Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |since| since.as_millis() as f64)),
        }
    }

    /// `Date.now()`.
    pub fn now(&self) -> f64 {
        (self.now_ms)()
    }

    /// `path.resolve(path)` against the working directory.
    pub fn resolve(&self, path: &str) -> PathBuf {
        resolve_path(&self.cwd, Path::new(path))
    }
}
