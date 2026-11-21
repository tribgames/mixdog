//! Language registry for the tidy multiplexer. `CODE_LANGUAGE_EXTENSIONS` mirrors `lang_for` in
//! `native/mixdog-graph/src/lang.rs`, so a file the code graph calls `typescript` is the same
//! language here: the structural adapter passes rule packs to that binary and both sides must
//! agree on the id. The aux table adds the config/markup languages formatters know and the graph
//! never parses.

use std::collections::HashMap;
use std::path::{Component, Path};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::lane::on_lane;

#[cfg(test)]
use super::process::which;
use super::process::{Processes, RunOptions};

pub const CODE_LANGUAGE_EXTENSIONS: &[(&str, &[&str])] = &[
    ("javascript", &["js", "mjs", "cjs", "jsx"]),
    ("typescript", &["ts", "tsx", "mts", "cts"]),
    ("python", &["py", "pyi"]),
    ("go", &["go"]),
    ("rust", &["rs"]),
    ("java", &["java"]),
    ("kotlin", &["kt", "kts"]),
    ("csharp", &["cs"]),
    ("ruby", &["rb"]),
    ("php", &["php"]),
    ("swift", &["swift"]),
    ("c", &["c", "h"]),
    ("cpp", &["cpp", "cc", "cxx", "hpp", "hxx", "hh"]),
    ("scala", &["scala", "sc"]),
    ("bash", &["sh", "bash", "zsh"]),
    ("lua", &["lua"]),
    ("dart", &["dart"]),
    ("objc", &["m", "mm"]),
    ("elixir", &["ex", "exs"]),
    ("zig", &["zig"]),
    ("r", &["r"]),
    // Extraction languages the graph parses; no formatter/linter ships for them.
    ("solidity", &["sol"]),
    ("haskell", &["hs"]),
    ("hcl", &["tf", "hcl"]),
];

pub const AUX_LANGUAGE_EXTENSIONS: &[(&str, &[&str])] = &[
    ("powershell", &["ps1", "psm1", "psd1"]),
    ("json", &["json", "jsonc"]),
    ("yaml", &["yml", "yaml"]),
    ("markdown", &["md", "markdown"]),
    ("toml", &["toml"]),
    ("css", &["css", "scss", "less"]),
    ("html", &["html", "htm"]),
];

/// Lower-case extension of a path without its dot; empty when it has none.
fn extension_of(file_path: &str) -> String {
    Path::new(file_path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Language id for a path, or empty when the extension is not in the registry.
pub fn language_for_path(file_path: &str) -> String {
    let ext = extension_of(file_path);
    if ext.is_empty() {
        return String::new();
    }
    // First declaration wins: `tsx` is typescript, as lang.rs has it.
    CODE_LANGUAGE_EXTENSIONS
        .iter()
        .chain(AUX_LANGUAGE_EXTENSIONS)
        .find(|(_, exts)| exts.contains(&ext.as_str()))
        .map(|(l, _)| (*l).to_owned())
        .unwrap_or_default()
}

/// Whether `id` names a language tidy knows: the static registry, or one the graph binary reports.
pub fn is_known_language(id: &str, graph: Option<&GraphLangs>) -> bool {
    CODE_LANGUAGE_EXTENSIONS.iter().chain(AUX_LANGUAGE_EXTENSIONS).any(|(l, _)| *l == id) || graph.is_some_and(|g| g.ids.iter().any(|l| l == id))
}

/// The graph binary's `--langs` capability table.
#[derive(Debug, Clone, Default)]
pub struct GraphLangs {
    pub extensions: HashMap<String, String>,
    pub ids: Vec<String>,
    pub scannable: Vec<String>,
}

pub fn language_with(file_path: &str, extensions: Option<&HashMap<String, String>>) -> String {
    let ext = extension_of(file_path);
    if let Some(from_graph) = extensions.and_then(|m| m.get(&ext)).filter(|_| !ext.is_empty()) {
        return from_graph.clone();
    }
    language_for_path(file_path)
}

/// Forward-slash path without a leading `./`.
pub fn normalize_rel(value: &str) -> String {
    let v = value.replace('\\', "/");
    v.strip_prefix("./").unwrap_or(&v).to_owned()
}

/// A path is in scope when it equals, or sits under, one of the requested paths. An empty scope
/// list means everything.
pub fn within_scope(rel: &str, scopes: &[String]) -> bool {
    if scopes.is_empty() {
        return true;
    }
    let path = normalize_rel(rel);
    scopes.iter().any(|scope| {
        let base = normalize_rel(scope);
        let base = base.trim_end_matches('/');
        base.is_empty() || base == "." || path == base || path.starts_with(&format!("{base}/"))
    })
}

/// Parses `mixdog-graph <cwd> --langs`: `{"languages":[{"id","extensions":[…],"scan","extract"}]}`
/// (or the rows as JSON lines). `None` when nothing parses, so the caller falls back to the static
/// registry.
pub fn parse_graph_langs(stdout: &str) -> Option<GraphLangs> {
    let text = mixdog_js::js_trim(stdout);
    if text.is_empty() {
        return None;
    }
    let rows: Vec<Value> = match serde_json::from_str::<Value>(text) {
        Ok(whole) => [Some(&whole), whole.get("languages"), whole.get("langs")].into_iter().flatten().find_map(|v| v.as_array().cloned())?,
        Err(_) => text.lines().map(mixdog_js::js_trim).filter(|l| !l.is_empty()).map(|l| serde_json::from_str::<Value>(l).ok()).collect::<Option<Vec<_>>>()?,
    };
    if rows.is_empty() {
        return None;
    }
    let mut langs = GraphLangs::default();
    for row in rows {
        let obj = row.as_object()?;
        let id = ["id", "lang", "language"].iter().find_map(|k| obj.get(*k).and_then(Value::as_str)).map(mixdog_js::js_trim).unwrap_or("").to_owned();
        let Some(exts) = obj.get("extensions").and_then(Value::as_array) else { continue };
        if id.is_empty() {
            continue;
        }
        langs.ids.push(id.clone());
        if obj.get("scan") != Some(&Value::Bool(false)) {
            langs.scannable.push(id.clone());
        }
        for raw in exts {
            let ext = raw.as_str().unwrap_or("").trim_start_matches('.').to_lowercase();
            // First declaration wins: the binary lists `tsx` twice and typescript is the id lang.rs uses.
            if !ext.is_empty() {
                langs.extensions.entry(ext).or_insert_with(|| id.clone());
            }
        }
    }
    (!langs.extensions.is_empty()).then_some(langs)
}

#[derive(Debug)]
pub struct Detected {
    /// `(language, files)` sorted by count then id.
    pub languages: Vec<(String, usize)>,
    pub files: Vec<String>,
    /// Listed files that are symbolic links.
    pub links: Vec<String>,
    /// `(path, reason)` for each requested path that yields no file of a known language.
    pub empty_paths: Vec<(String, String)>,
    pub source: &'static str,
    pub extensions: Option<HashMap<String, String>>,
}

/// Files of the requested languages, in scope order, classified with the same table detection used.
pub fn files_for_languages(files: &[String], languages: &[String], extensions: Option<&HashMap<String, String>>) -> Vec<String> {
    if languages.is_empty() {
        return Vec::new();
    }
    files.iter().filter(|f| languages.contains(&language_with(f, extensions))).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_map_to_languages_with_typescript_owning_tsx() {
        assert_eq!(language_for_path("a/B.TSX"), "typescript");
        assert_eq!(language_for_path("run.ps1"), "powershell");
        assert_eq!(language_for_path("Makefile"), "");
        assert_eq!(language_for_path("x.unknown"), "");
        assert_eq!(language_for_path("m.m"), "objc");
    }

    #[test]
    fn scope_matches_equal_or_nested_paths_only() {
        let scope = vec!["src/".to_owned()];
        assert!(within_scope("src/a.ts", &scope) && within_scope("./src", &scope));
        assert!(!within_scope("srcs/a.ts", &scope));
        assert!(within_scope("anything", &[]) && within_scope("x", &[".".to_owned()]));
        assert_eq!(normalize_rel(".\\a\\b"), "a/b");
    }

    #[test]
    fn the_graph_table_wins_and_first_declaration_keeps_an_extension() {
        let json =
            r#"{"languages":[{"id":"typescript","extensions":["ts",".tsx"],"scan":true},{"id":"tsx","extensions":["tsx"],"scan":false},{"id":"nolist"}]}"#;
        let g = parse_graph_langs(json).unwrap();
        assert_eq!(g.extensions["tsx"], "typescript");
        assert_eq!((g.ids, g.scannable), (vec!["typescript".to_owned(), "tsx".to_owned()], vec!["typescript".to_owned()]));
        assert!(parse_graph_langs("").is_none() && parse_graph_langs("garbage").is_none() && parse_graph_langs("[]").is_none());
        let lines = parse_graph_langs("{\"id\":\"go\",\"extensions\":[\"go\"]}\n{\"id\":\"c\",\"extensions\":[\"h\"]}").unwrap();
        assert_eq!(lines.extensions.len(), 2);
        let table = HashMap::from([("foo".to_owned(), "custom".to_owned())]);
        assert_eq!(language_with("a.foo", Some(&table)), "custom");
        assert_eq!(language_with("a.rs", Some(&table)), "rust");
        assert_eq!(files_for_languages(&["a.foo".into(), "b.rs".into()], &["custom".into()], Some(&table)), ["a.foo"]);
        assert!(files_for_languages(&["a.rs".into()], &[], None).is_empty());
    }

    #[tokio::test]
    async fn detection_counts_git_files_by_language() {
        let dir = tempfile::tempdir().unwrap();
        if which("git", None, None).is_none() {
            return;
        }
        let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(dir.path()).output().unwrap();
        git(&["init", "-q"]);
        for f in ["a.rs", "b.rs", "c.py", "notes.txt"] {
            std::fs::write(dir.path().join(f), "x").unwrap();
        }
        let all = detect_languages(&Processes::for_tests(), dir.path(), &[], &[], None, None).await.unwrap();
        assert_eq!(all.languages, [("rust".to_owned(), 2), ("python".to_owned(), 1)]);
        assert_eq!((all.source, all.files.len()), ("git", 4));
        let only = detect_languages(&Processes::for_tests(), dir.path(), &[], &["python".into()], None, None).await.unwrap();
        assert_eq!(only.files, ["c.py"]);
        let scoped = detect_languages(&Processes::for_tests(), dir.path(), &["a.rs".into()], &[], None, None).await.unwrap();
        assert_eq!(scoped.files, ["a.rs"]);
    }

    /// The listing is the only source of files: a directory git cannot list fails, by name.
    #[tokio::test]
    async fn a_directory_that_is_not_a_repository_fails_the_listing() {
        if which("git", None, None).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "x").unwrap();
        // GIT_CEILING_DIRECTORIES is not set here, so the temp dir must not sit inside a repository.
        let probe = std::process::Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(dir.path()).output().unwrap();
        if probe.status.success() {
            return eprintln!("skipped: the temp directory is inside a git repository");
        }
        let why = list_scoped_files(&Processes::for_tests(), dir.path(), &[".".into()], None).await.unwrap_err();
        assert!(why.contains("is not a git repository"), "{why}");
        assert!(detect_languages(&Processes::for_tests(), dir.path(), &[".".into()], &[], None, None).await.is_err());
    }

    /// An index entry whose file was deleted is not a file, and a nested repository is one
    /// directory entry; a requested path that yields nothing says which of these it is.
    #[tokio::test]
    async fn deleted_entries_and_nested_repositories_are_not_files() {
        if which("git", None, None).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str], at: &Path| std::process::Command::new("git").args(args).current_dir(at).output().unwrap();
        git(&["init", "-q"], dir.path());
        for f in ["a.rs", "gone.rs", "docs/notes.txt", "nested/b.rs"] {
            std::fs::create_dir_all(dir.path().join(f).parent().unwrap()).unwrap();
            std::fs::write(dir.path().join(f), "x").unwrap();
        }
        git(&["init", "-q"], &dir.path().join("nested"));
        git(&["add", "a.rs", "gone.rs"], dir.path());
        std::fs::remove_file(dir.path().join("gone.rs")).unwrap();
        let listing = list_scoped_files(&Processes::for_tests(), dir.path(), &[], None).await.unwrap();
        assert_eq!(
            (listing.files.clone(), listing.directories.clone()),
            (vec!["a.rs".to_owned(), "docs/notes.txt".to_owned()], vec!["nested".to_owned()]),
            "{listing:?}"
        );
        let paths: Vec<String> = ["a.rs", "docs", "nested", "nested/b.rs"].iter().map(|s| (*s).to_owned()).collect();
        let d = detect_languages(&Processes::for_tests(), dir.path(), &paths, &[], None, None).await.unwrap();
        assert_eq!(d.files, ["a.rs", "docs/notes.txt"]);
        let reason = |p: &str| d.empty_paths.iter().find(|(path, _)| path == p).map(|(_, why)| why.clone()).unwrap_or_default();
        assert_eq!(d.empty_paths.len(), 3, "{:?}", d.empty_paths);
        assert!(reason("docs").contains("none of its 1 listed file(s) is of a language tidy handles"));
        assert!(reason("nested").contains("nested is a nested repository or submodule"));
        assert!(reason("nested/b.rs").contains("nested is a nested repository or submodule"));
    }

    /// Only absence drops a listed entry; a file that cannot be looked at fails the listing by name.
    #[test]
    fn a_listed_entry_that_cannot_be_checked_fails_the_listing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "x").unwrap();
        std::fs::write(dir.path().join("plain"), "x").unwrap();
        let listing = classify_entries(dir.path(), vec!["a.rs".into(), "gone.rs".into(), "plain/under.rs".into()]).unwrap();
        assert_eq!(listing.files, ["a.rs"], "a deleted file and one under what is now a file are absent");
        let why = classify_entries(dir.path(), vec!["a.rs".into(), "bad\u{0}name.rs".into()]).unwrap_err();
        assert!(why.contains("bad\u{0}name.rs could not be checked on disk"), "{why}");
    }

    /// On Windows a requested path in another letter case lists its files under the disk's case.
    #[tokio::test]
    async fn a_requested_path_in_another_case_yields_its_files() {
        if !cfg!(windows) || which("git", None, None).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).output().unwrap();
        std::fs::create_dir_all(dir.path().join("Src")).unwrap();
        std::fs::write(dir.path().join("Src/a.py"), "x = 1\n").unwrap();
        let paths = requested_paths_on_disk(&Processes::for_tests(), dir.path(), &["src".into(), "SRC/A.PY".into(), ".".into()]).await.unwrap();
        assert_eq!(paths, ["Src", "Src/a.py", "."]);
        let d = detect_languages(&Processes::for_tests(), dir.path(), &paths[..1], &[], None, None).await.unwrap();
        assert_eq!((d.files.clone(), d.empty_paths.len()), (vec!["Src/a.py".to_owned()], 0));
    }

    #[test]
    fn project_paths_compare_by_component_and_by_case_on_windows() {
        let root = Path::new(if cfg!(windows) { "C:\\Proj" } else { "/proj" });
        let inside = if cfg!(windows) { "c:\\proj\\src\\a.ts" } else { "/proj/src/a.ts" };
        assert_eq!(project_relative(root, Path::new(inside)).as_deref(), Some("src/a.ts"));
        let dots = if cfg!(windows) { "C:\\Proj\\..cache\\x" } else { "/proj/..cache/x" };
        assert_eq!(project_relative(root, Path::new(dots)).as_deref(), Some("..cache/x"));
        let up = if cfg!(windows) { "C:\\Proj\\..\\x" } else { "/proj/../x" };
        assert!(project_relative(root, Path::new(up)).is_none());
        let other = if cfg!(windows) { "C:\\Projects\\x" } else { "/projects/x" };
        assert!(project_relative(root, Path::new(other)).is_none());
        assert_eq!(project_relative(root, root).as_deref(), Some(""));
    }
}

/// What `git ls-files` listed under the requested paths, checked against the working tree.
#[derive(Debug, Default, PartialEq)]
pub struct Listing {
    /// Entries that are files on disk (a symbolic link to a file included).
    pub files: Vec<String>,
    /// The entries of `files` that are symbolic links.
    pub links: Vec<String>,
    /// Entries that are directories: git lists a nested repository or a submodule as one entry.
    pub directories: Vec<String>,
}

fn listing_failure(cwd: &Path, result: &super::process::ProcessResult) -> String {
    let stderr = mixdog_js::js_trim(&result.stderr);
    if stderr.contains("not a git repository") {
        return format!("{} is not a git repository: tidy takes its files from git ls-files", cwd.display());
    }
    let why = if !result.error.is_empty() {
        result.error.clone()
    } else if !stderr.is_empty() {
        mixdog_js::slice_utf16(stderr, 400)
    } else {
        format!("it exited {}", result.code)
    };
    format!("git ls-files failed, so there is no file list: {why}")
}

/// Whether a metadata error means nothing is there.
fn absent(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory)
}

/// Sorts listed entries by what the working tree holds. An index entry whose file was deleted (or
/// a link to nothing) is not a file and is dropped; any other failure to look fails the listing.
/// Blocking: a lane job's body.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn classify_entries(cwd: &Path, entries: Vec<String>) -> Result<Listing, String> {
    let mut listing = Listing::default();
    let failed = |entry: &str, e: std::io::Error| format!("the listed file {entry} could not be checked on disk: {e}");
    for entry in entries {
        // `--others` names an untracked nested repository with a trailing slash.
        if let Some(dir) = entry.strip_suffix('/') {
            listing.directories.push(dir.to_owned());
            continue;
        }
        let full = cwd.join(&entry);
        let meta = match std::fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(e) if absent(&e) => continue,
            Err(e) => return Err(failed(&entry, e)),
        };
        if meta.is_dir() {
            listing.directories.push(entry);
        } else if meta.file_type().is_symlink() {
            match std::fs::metadata(&full) {
                Ok(target) if target.is_file() => {
                    listing.links.push(entry.clone());
                    listing.files.push(entry);
                }
                Ok(_) => {}
                Err(e) if absent(&e) => {}
                Err(e) => return Err(failed(&entry, e)),
            }
        } else {
            listing.files.push(entry);
        }
    }
    Ok(listing)
}

/// The requested paths in the letter case the disk uses (Windows matches names in any case,
/// git does not), so a path typed in another case lists its files. Each name is taken from the
/// listing of the directory it is in, so a link is spelled as the link is, not as what it points
/// to; a name no listing has stays as given. Blocking: a lane job's body.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn disk_case(cwd: &Path, paths: Vec<String>) -> Vec<String> {
    let spelled = |dir: &Path, name: &str| {
        let names: Vec<String> =
            std::fs::read_dir(dir).map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        if names.iter().any(|n| n == name) {
            return name.to_owned();
        }
        names.into_iter().find(|n| n.to_lowercase() == name.to_lowercase()).unwrap_or_else(|| name.to_owned())
    };
    let on_disk = |path: String| {
        let mut parts: Vec<String> = Vec::new();
        for name in normalize_rel(&path).split('/').filter(|name| !name.is_empty()) {
            let dir = parts.iter().fold(cwd.to_owned(), |dir, part| dir.join(part));
            parts.push(if name == "." || name == ".." { name.to_owned() } else { spelled(&dir, name) });
        }
        if parts.is_empty() { path } else { parts.join("/") }
    };
    paths.into_iter().map(on_disk).collect()
}

/// [`disk_case`] on Windows; elsewhere paths are already exact.
pub async fn requested_paths_on_disk(processes: &Processes, cwd: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if !cfg!(windows) {
        return Ok(paths.to_vec());
    }
    let (root, owned) = (cwd.to_owned(), paths.to_vec());
    on_lane(processes.durability(), move || disk_case(&root, owned))
        .await
        .map_err(|_| "the requested paths could not be checked on disk: their lane did not run the check".to_owned())
}

/// git-tracked (and untracked, non-ignored) files under `cwd`, filtered to the scope paths. The
/// listing is the only source of files, so a git that cannot answer is an error, never an empty set.
pub async fn list_scoped_files(processes: &Processes, cwd: &Path, paths: &[String], cancel: Option<&CancellationToken>) -> Result<Listing, String> {
    let Some(git) = processes.which("git", None).await else { return Err("git is not installed: tidy takes its files from git ls-files".into()) };
    let mut args: Vec<String> = ["-c", "core.quotepath=false", "--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    args.extend(paths.iter().cloned());
    let mut options = RunOptions::new(cwd);
    options.cancel = cancel;
    options.timeout = std::time::Duration::from_secs(20);
    // A large repository lists more than the engine capture limit; the listing is never cut.
    options.max_capture = usize::MAX;
    let result = processes.run(&git.to_string_lossy(), &args, options).await;
    if result.code != 0 || !result.error.is_empty() {
        return Err(listing_failure(cwd, &result));
    }
    let mut entries: Vec<String> = result.stdout.split('\0').map(normalize_rel).filter(|f| !f.is_empty() && within_scope(f, paths)).collect();
    // Untracked entries come first and a conflicted file once per stage.
    entries.sort();
    entries.dedup();
    let root = cwd.to_owned();
    on_lane(processes.durability(), move || classify_entries(&root, entries))
        .await
        .map_err(|_| "the listed files could not be checked on disk: their lane did not run the check".to_owned())?
}

/// `path` relative to `root` with forward slashes; components compare case-insensitively on
/// Windows, where `c:\proj\src` sits under `C:\Proj`. `None` when `path` is not under `root`.
pub fn project_relative(root: &Path, path: &Path) -> Option<String> {
    let key = |c: &Component| {
        let s = c.as_os_str().to_string_lossy();
        if cfg!(windows) { s.to_lowercase() } else { s.into_owned() }
    };
    let mut rest = path.components().filter(|c| *c != Component::CurDir);
    for r in root.components().filter(|c| *c != Component::CurDir) {
        if key(&rest.next()?) != key(&r) {
            return None;
        }
    }
    let parts: Vec<Component> = rest.collect();
    if parts.contains(&Component::ParentDir) {
        return None;
    }
    Some(parts.iter().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
}

/// Why a requested path yields no file, as far as the tree can tell. Blocking: a lane job's body.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn empty_path_reason(cwd: &Path, path: &str, listing: &Listing, listed: usize, filtered: bool) -> String {
    let scope = [path.to_owned()];
    if let Some(dir) = listing.directories.iter().find(|d| within_scope(d, &scope)) {
        return format!("{dir} is a nested repository or submodule: git lists it as one entry, not the files inside it");
    }
    let rel = normalize_rel(path);
    let parts: Vec<&str> = rel.trim_end_matches('/').split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if let Some(n) = (1..=parts.len()).find(|n| cwd.join(parts[..*n].join("/")).join(".git").exists()) {
        return format!("{} is a nested repository or submodule: git lists none of the files inside it", parts[..n].join("/"));
    }
    match (listed, filtered) {
        (0, _) => "nothing is listed there: git has no tracked or non-ignored untracked file under it".to_owned(),
        (n, true) => format!("none of its {n} listed file(s) is of the requested languages"),
        (n, false) => format!("none of its {n} listed file(s) is of a language tidy handles"),
    }
}

/// `(language, files)` of the files with a known language, most files first, ties by id.
fn language_counts(files: &[String], language_of: &impl Fn(&str) -> String) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for rel in files {
        let language = language_of(rel);
        if language.is_empty() {
            continue;
        }
        match counts.iter_mut().find(|(l, _)| *l == language) {
            Some((_, n)) => *n += 1,
            None => counts.push((language, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| mixdog_js::locale_compare(&a.0, &b.0)));
    counts
}

/// `(path, reason)` for each requested path holding no file of a known (and requested) language.
async fn empty_path_reasons(
    processes: &Processes,
    cwd: &Path,
    paths: &[String],
    filtered: &[String],
    language_filter: &[String],
    listing: Listing,
    language_of: &impl Fn(&str) -> String,
) -> Result<Vec<(String, String)>, String> {
    let empty: Vec<(String, usize)> = paths
        .iter()
        .filter(|p| !filtered.iter().any(|f| !language_of(f).is_empty() && within_scope(f, std::slice::from_ref(*p))))
        .map(|p| (p.clone(), listing.files.iter().filter(|f| within_scope(f, std::slice::from_ref(p))).count()))
        .collect();
    if empty.is_empty() {
        return Ok(Vec::new());
    }
    let (root, filter) = (cwd.to_owned(), !language_filter.is_empty());
    on_lane(processes.durability(), move || {
        empty
            .into_iter()
            .map(|(p, n)| {
                let why = empty_path_reason(&root, &p, &listing, n, filter);
                (p, why)
            })
            .collect()
    })
    .await
    .map_err(|_| "the requested paths that yield no file could not be examined: their lane did not run the check".to_owned())
}
/// Detects the languages present in `cwd`. Files come from git (they scope every engine run) and
/// map to languages by extension: the graph binary's table wins when available, with the static
/// registry covering formatter-only extensions the binary does not parse.
pub async fn detect_languages(
    processes: &Processes,
    cwd: &Path,
    paths: &[String],
    language_filter: &[String],
    graph_langs: Option<&GraphLangs>,
    cancel: Option<&CancellationToken>,
) -> Result<Detected, String> {
    let listing = list_scoped_files(processes, cwd, paths, cancel).await?;
    let extensions = graph_langs.map(|g| &g.extensions);
    let language_of = |rel: &str| language_with(rel, extensions);
    let files = listing.files.clone();
    let filtered: Vec<String> =
        if language_filter.is_empty() { files } else { files.into_iter().filter(|f| language_filter.contains(&language_of(f))).collect() };
    let counts = language_counts(&filtered, &language_of);
    let links = listing.links.clone();
    let empty_paths = empty_path_reasons(processes, cwd, paths, &filtered, language_filter, listing, &language_of).await?;
    Ok(Detected {
        languages: counts,
        files: filtered,
        links,
        empty_paths,
        source: if extensions.is_some() { "graph-binary" } else { "git" },
        extensions: extensions.cloned(),
    })
}
