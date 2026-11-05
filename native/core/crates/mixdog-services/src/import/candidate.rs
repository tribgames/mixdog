//! Enumeration of importable foreign conversations on disk (read-only, stat-only):
//!
//! - codex: `$CODEX_HOME/sessions/**/rollout-*.jsonl[.zst]` (default `~/.codex`)
//! - claude: `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl` (default `~/.claude`)
//! - cowork: `%APPDATA%\Claude\local-agent-mode-sessions` (Claude Desktop; Windows only)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use sha2::{Digest, Sha256};

use super::codex::{COMPRESSED_ROLLOUT_SUFFIX, is_rollout_name};
use super::convert::Source;
use super::fsutil::{ImportError, case_fold, is_inside, real_path};

const COWORK_MANIFEST_MAX_BYTES: u64 = 8 * 1024 * 1024;
const COWORK_TITLE_MAX_CHARS: usize = 200;

/// The environment a source root is resolved from.
#[derive(Clone, Debug, Default)]
pub struct Env {
    pub home: PathBuf,
    pub codex_home: Option<String>,
    pub claude_config_dir: Option<String>,
    pub appdata: Option<String>,
}

impl Env {
    pub fn from_process() -> Self {
        let var = |key: &str| std::env::var(key).ok();
        Self {
            home: std::env::home_dir().unwrap_or_default(),
            codex_home: var("CODEX_HOME"),
            claude_config_dir: var("CLAUDE_CONFIG_DIR"),
            appdata: var("APPDATA"),
        }
    }
}

/// A blank override is unset.
fn env_dir(value: &Option<String>) -> Option<PathBuf> {
    let trimmed = mixdog_js::js_trim(value.as_deref()?);
    (!trimmed.is_empty()).then(|| std::path::absolute(trimmed).unwrap_or_else(|_| PathBuf::from(trimmed)))
}

/// Root searched for a source. Only Windows sets `APPDATA`; elsewhere Claude Desktop has no
/// Cowork folder to search.
pub fn source_root(source: Source, env: &Env) -> Option<PathBuf> {
    match source {
        Source::Codex => Some(env_dir(&env.codex_home).unwrap_or_else(|| env.home.join(".codex")).join("sessions")),
        Source::Claude => Some(env_dir(&env.claude_config_dir).unwrap_or_else(|| env.home.join(".claude")).join("projects")),
        Source::Cowork => env_dir(&env.appdata).map(|a| a.join("Claude").join("local-agent-mode-sessions")),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub source: Source,
    /// The canonical source root of an enumerated candidate; `None` for a picked file.
    pub root: Option<PathBuf>,
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: f64,
    pub starred: bool,
    /// Cowork manifest title.
    pub title: Option<String>,
}

impl Candidate {
    pub fn for_file(source: Source, root: Option<PathBuf>, path: PathBuf, size: u64) -> Self {
        Self {
            id: candidate_id(source, &path),
            source,
            root,
            path,
            size,
            mtime_ms: 0.0,
            starred: false,
            title: None,
        }
    }

    pub fn stamp_key(&self) -> String {
        format!("{}:{}", self.size, self.mtime_ms)
    }
}

pub fn candidate_id(source: Source, canonical_path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}\0{}", source.as_str(), case_fold(&canonical_path.to_string_lossy())));
    let digest = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
    digest[..32].to_owned()
}

/// Dedupe identity: the foreign session id, else the canonical source path. Cowork transcripts
/// are Claude Code transcripts, so both share the `claude` namespace.
pub fn import_origin_key(source: Source, foreign_session_id: Option<&str>, canonical_path: &Path) -> String {
    let namespace = if source == Source::Cowork { "claude" } else { source.as_str() };
    match foreign_session_id.filter(|id| !id.is_empty()) {
        Some(id) => format!("{namespace}:{id}"),
        None => format!("{namespace}:path:{}", canonical_path.display()),
    }
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Canonical path of a directory entry, or `None` when it escapes the root.
pub(crate) fn contained_real_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let real = real_path(path).ok()?;
    is_inside(root, &real).then_some(real)
}

fn entries_of(dir: &Path) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(dir).map(|rd| rd.flatten().collect()).unwrap_or_default()
}

fn name_of(entry: &std::fs::DirEntry) -> String {
    entry.file_name().to_string_lossy().into_owned()
}

pub(crate) fn walk_codex(root: &Path, dir: &Path, files: &mut Vec<PathBuf>, seen_dirs: &mut HashSet<String>) {
    for entry in entries_of(dir) {
        let name = name_of(&entry);
        let path = dir.join(&name);
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() || kind.is_symlink() {
            let Some(real) = contained_real_path(root, &path) else { continue };
            if kind.is_dir() || std::fs::metadata(&real).is_ok_and(|m| m.is_dir()) {
                if !seen_dirs.insert(case_fold(&real.to_string_lossy())) {
                    continue;
                }
                walk_codex(root, &path, files, seen_dirs);
                continue;
            }
        }
        if !is_rollout_name(&name) {
            continue;
        }
        // A compressed rollout is skipped while its plain sibling exists.
        if name.ends_with(COMPRESSED_ROLLOUT_SUFFIX) {
            let plain = path.with_file_name(&name[..name.len() - ".zst".len()]);
            if std::fs::metadata(plain).is_ok() {
                continue;
            }
        }
        files.push(path);
    }
}

fn walk_claude(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in entries_of(root) {
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() && !kind.is_symlink() {
            continue;
        }
        let dir = root.join(name_of(&entry));
        if contained_real_path(root, &dir).is_none() {
            continue;
        }
        for file in entries_of(&dir) {
            let name = name_of(&file);
            let Ok(kind) = file.file_type() else { continue };
            if (kind.is_file() || kind.is_symlink()) && name.to_lowercase().ends_with(".jsonl") {
                files.push(dir.join(name));
            }
        }
    }
}

/// Cowork keeps one `local_<id>.json` manifest per conversation (the account/org folders hold
/// them directly, the agent variant under `agent/`), next to a `local_<id>/` folder whose
/// `.claude/projects/<project>/<cliSessionId>.jsonl` is the Claude Code transcript. The manifest
/// also holds the system prompt and account details, so only title / isStarred / cliSessionId
/// are read.
fn cowork_manifest_paths(root: &Path) -> Vec<PathBuf> {
    let mut manifests = Vec::new();
    for account in entries_of(root) {
        if !account.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let account_dir = root.join(name_of(&account));
        for org in entries_of(&account_dir) {
            if !org.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let org_dir = account_dir.join(name_of(&org));
            for dir in [org_dir.clone(), org_dir.join("agent")] {
                for file in entries_of(&dir) {
                    let name = name_of(&file);
                    if file.file_type().is_ok_and(|t| t.is_file())
                        && name.starts_with("local_")
                        && name.ends_with(".json")
                        && name.len() > "local_.json".len()
                    {
                        manifests.push(dir.join(name));
                    }
                }
            }
        }
    }
    manifests
}

struct CoworkEntry {
    path: PathBuf,
    title: Option<String>,
    starred: bool,
}

/// The transcript a manifest names, with the manifest's title and star; `None` when it has none.
fn cowork_transcript(root: &Path, manifest_path: &Path) -> Option<CoworkEntry> {
    let real = contained_real_path(root, manifest_path)?;
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() || meta.len() > COWORK_MANIFEST_MAX_BYTES {
        return None;
    }
    let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&real).ok()?).ok()?;
    let cli = manifest.get("cliSessionId")?.as_str()?;
    if cli.is_empty() || !cli.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let stem = real.to_string_lossy();
    let projects = Path::new(&stem[..stem.len() - ".json".len()]).join(".claude").join("projects");
    for project in entries_of(&projects) {
        if !project.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let path = projects.join(name_of(&project)).join(format!("{cli}.jsonl"));
        if contained_real_path(root, &path).is_some() {
            let title = manifest
                .get("title")
                .and_then(|t| t.as_str())
                .map(|t| mixdog_js::slice_utf16(mixdog_js::js_trim(t), COWORK_TITLE_MAX_CHARS))
                .filter(|t| !t.is_empty());
            return Some(CoworkEntry { path, title, starred: manifest.get("isStarred") == Some(&serde_json::Value::Bool(true)) });
        }
    }
    None
}

/// Starred conversations (Cowork) come first, then newest first.
pub fn by_modified_then_id(left: &Candidate, right: &Candidate) -> std::cmp::Ordering {
    right
        .starred
        .cmp(&left.starred)
        .then_with(|| right.mtime_ms.partial_cmp(&left.mtime_ms).unwrap_or(std::cmp::Ordering::Equal))
        .then_with(|| super::fsutil::compare_code_units(&left.id, &right.id))
}

pub struct Enumeration {
    /// The configured root as a string (empty when the source has none), even when absent.
    pub root: String,
    pub candidates: Vec<Candidate>,
}

/// Regular files under the source root, canonical and contained, as candidates.
pub fn enumerate_candidates(source: Source, env: &Env) -> Enumeration {
    let Some(root) = source_root(source, env) else {
        return Enumeration { root: String::new(), candidates: Vec::new() };
    };
    let root_text = root.to_string_lossy().into_owned();
    let Ok(root_real) = real_path(&root) else {
        return Enumeration { root: root_text, candidates: Vec::new() };
    };
    let mut paths = Vec::new();
    let mut extras: HashMap<PathBuf, (Option<String>, bool)> = HashMap::new();
    match source {
        Source::Codex => {
            walk_codex(&root_real, &root_real, &mut paths, &mut HashSet::from([case_fold(&root_real.to_string_lossy())]))
        }
        Source::Cowork => {
            for entry in cowork_manifest_paths(&root_real).iter().filter_map(|m| cowork_transcript(&root_real, m)) {
                extras.insert(entry.path.clone(), (entry.title, entry.starred));
                paths.push(entry.path);
            }
        }
        Source::Claude => walk_claude(&root_real, &mut paths),
    }
    let mut unique: HashMap<String, Candidate> = HashMap::new();
    for path in paths {
        let Some(real) = contained_real_path(&root_real, &path) else { continue };
        let Ok(meta) = std::fs::metadata(&real) else { continue };
        if !meta.is_file() {
            continue;
        }
        let (title, starred) = extras.get(&path).cloned().unwrap_or((None, false));
        let id = candidate_id(source, &real);
        unique.insert(
            id.clone(),
            Candidate {
                id,
                source,
                root: Some(root_real.clone()),
                path: real,
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
                starred,
                title,
            },
        );
    }
    let mut candidates: Vec<Candidate> = unique.into_values().collect();
    candidates.sort_by(by_modified_then_id);
    Enumeration { root: root_text, candidates }
}

pub fn require_source(value: &str) -> Result<Source, ImportError> {
    Source::parse(value).ok_or_else(|| ImportError::new("unsupported"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn env_for(dir: &Path) -> Env {
        Env {
            home: dir.join("home"),
            codex_home: Some(dir.join("codex").to_string_lossy().into_owned()),
            claude_config_dir: Some(dir.join("claude").to_string_lossy().into_owned()),
            appdata: Some(dir.join("appdata").to_string_lossy().into_owned()),
        }
    }

    #[test]
    fn roots_follow_the_overrides_and_blank_means_unset() {
        let env = Env { home: PathBuf::from("/h"), codex_home: Some("  ".into()), ..Env::default() };
        assert_eq!(source_root(Source::Codex, &env), Some(PathBuf::from("/h/.codex/sessions")));
        assert_eq!(source_root(Source::Claude, &env), Some(PathBuf::from("/h/.claude/projects")));
        assert_eq!(source_root(Source::Cowork, &env), None);
    }

    #[test]
    fn origin_key_and_candidate_id_are_stable() {
        assert_eq!(import_origin_key(Source::Cowork, Some("s"), Path::new("/p")), "claude:s");
        assert_eq!(import_origin_key(Source::Codex, None, Path::new("/p")), "codex:path:/p");
        let id = candidate_id(Source::Codex, Path::new("/some/path"));
        assert_eq!(id.len(), 32);
        assert_eq!(id, candidate_id(Source::Codex, Path::new("/some/path")));
        assert_ne!(id, candidate_id(Source::Claude, Path::new("/some/path")));
    }

    #[test]
    fn codex_walk_lists_rollouts_and_skips_a_compressed_twin() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_for(dir.path());
        let s = dir.path().join("codex/sessions/2025/01");
        put(&s.join("rollout-a-1.jsonl"), "{}");
        put(&s.join("rollout-a-1.jsonl.zst"), "x");
        put(&s.join("rollout-b-2.jsonl.zst"), "x");
        put(&s.join("notes.jsonl"), "{}");
        let found = enumerate_candidates(Source::Codex, &env);
        let mut names: Vec<_> = found.candidates.iter().map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["rollout-a-1.jsonl", "rollout-b-2.jsonl.zst"]);
    }

    #[test]
    fn claude_walk_is_one_level_deep_and_sorted_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_for(dir.path());
        let p = dir.path().join("claude/projects");
        put(&p.join("proj-a/old.jsonl"), "{}");
        std::thread::sleep(std::time::Duration::from_millis(30));
        put(&p.join("proj-b/new.JSONL"), "{}");
        put(&p.join("proj-b/deeper/skip.jsonl"), "{}");
        put(&p.join("loose.jsonl"), "{}");
        let names: Vec<_> = enumerate_candidates(Source::Claude, &env)
            .candidates
            .iter()
            .map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["new.JSONL", "old.jsonl"]);
    }

    #[test]
    fn cowork_manifest_names_the_transcript_title_and_star() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_for(dir.path());
        let org = dir.path().join("appdata/Claude/local-agent-mode-sessions/acct/org");
        put(&org.join("local_abc.json"), r#"{"cliSessionId":"cli-1","title":"  My chat ","isStarred":true}"#);
        put(&org.join("local_abc/.claude/projects/p1/cli-1.jsonl"), "{}");
        put(&org.join("local_nope.json"), r#"{"cliSessionId":"../x"}"#);
        let found = enumerate_candidates(Source::Cowork, &env).candidates;
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].title.as_deref(), found[0].starred), (Some("My chat"), true));
    }

    #[test]
    fn a_missing_root_is_an_empty_listing() {
        let dir = tempfile::tempdir().unwrap();
        let found = enumerate_candidates(Source::Codex, &env_for(dir.path()));
        assert!(found.candidates.is_empty() && found.root.ends_with("sessions"));
    }
}
