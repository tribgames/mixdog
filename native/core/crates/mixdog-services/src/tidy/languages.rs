//! Language registry for the tidy multiplexer. `CODE_LANGUAGE_EXTENSIONS` mirrors `lang_for` in
//! `native/mixdog-graph/src/lang.rs`, so a file the code graph calls `typescript` is the same
//! language here: the structural adapter passes rule packs to that binary and both sides must
//! agree on the id. The aux table adds the config/markup languages formatters know and the graph
//! never parses.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

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
    CODE_LANGUAGE_EXTENSIONS.iter().chain(AUX_LANGUAGE_EXTENSIONS).find(|(_, exts)| exts.contains(&ext.as_str())).map(|(l, _)| (*l).to_owned()).unwrap_or_default()
}

/// The graph binary's `--langs` capability table.
#[derive(Debug, Clone, Default)]
pub struct GraphLangs {
    pub extensions: HashMap<String, String>,
    pub ids: Vec<String>,
    pub scannable: Vec<String>,
}

fn language_with(file_path: &str, extensions: Option<&HashMap<String, String>>) -> String {
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

/// git-tracked (and untracked, non-ignored) files under `cwd`, filtered to the scope paths.
pub async fn list_scoped_files(processes: &Processes, cwd: &Path, paths: &[String], cancel: Option<&CancellationToken>) -> (Vec<String>, String) {
    let Some(git) = processes.which("git", None).await else { return (Vec::new(), "git is not installed".into()) };
    let mut args: Vec<String> = ["-c", "core.quotepath=false", "--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"].iter().map(|s| (*s).to_owned()).collect();
    args.extend(paths.iter().cloned());
    let mut options = RunOptions::new(cwd);
    options.cancel = cancel;
    options.timeout = std::time::Duration::from_secs(20);
    let result = processes.run(&git.to_string_lossy(), &args, options).await;
    if result.code != 0 {
        let err = mixdog_js::slice_utf16(mixdog_js::js_trim(&result.stderr), 200);
        return (Vec::new(), if err.is_empty() { if result.error.is_empty() { format!("git ls-files exited {}", result.code) } else { result.error } } else { err });
    }
    let files = result.stdout.split('\0').map(normalize_rel).filter(|f| !f.is_empty() && within_scope(f, paths)).collect();
    (files, String::new())
}

#[derive(Debug)]
pub struct Detected {
    /// `(language, files)` sorted by count then id.
    pub languages: Vec<(String, usize)>,
    pub files: Vec<String>,
    pub source: &'static str,
    pub extensions: Option<HashMap<String, String>>,
    pub note: Option<String>,
}

/// Detects the languages present in `cwd`. Files come from git (they scope every engine run) and
/// map to languages by extension: the graph binary's table wins when available, with the static
/// registry covering formatter-only extensions the binary does not parse.
pub async fn detect_languages(processes: &Processes, cwd: &Path, paths: &[String], language_filter: &[String], graph_langs: Option<&GraphLangs>, cancel: Option<&CancellationToken>) -> Detected {
    let (files, error) = list_scoped_files(processes, cwd, paths, cancel).await;
    let extensions = graph_langs.map(|g| &g.extensions);
    let language_of = |rel: &str| language_with(rel, extensions);
    let filtered: Vec<String> = if language_filter.is_empty() { files } else { files.into_iter().filter(|f| language_filter.contains(&language_of(f))).collect() };
    let mut counts: Vec<(String, usize)> = Vec::new();
    for rel in &filtered {
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
    Detected {
        languages: counts,
        files: filtered,
        source: if extensions.is_some() { "graph-binary" } else { "git" },
        extensions: extensions.cloned(),
        note: (!error.is_empty()).then(|| format!("language detection fell back to an empty file set: {error}")),
    }
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
        let json = r#"{"languages":[{"id":"typescript","extensions":["ts",".tsx"],"scan":true},{"id":"tsx","extensions":["tsx"],"scan":false},{"id":"nolist"}]}"#;
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
        let all = detect_languages(&Processes::for_tests(), dir.path(), &[], &[], None, None).await;
        assert_eq!(all.languages, [("rust".to_owned(), 2), ("python".to_owned(), 1)]);
        assert_eq!((all.source, all.files.len()), ("git", 4));
        let only = detect_languages(&Processes::for_tests(), dir.path(), &[], &["python".into()], None, None).await;
        assert_eq!(only.files, ["c.py"]);
        let scoped = detect_languages(&Processes::for_tests(), dir.path(), &["a.rs".into()], &[], None, None).await;
        assert_eq!(scoped.files, ["a.rs"]);
    }
}
