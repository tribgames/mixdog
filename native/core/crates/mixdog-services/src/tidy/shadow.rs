//! Engine shadowing: a binary carrying an engine's name that tidy does not run.
//!
//! Nothing here changes resolution; this is the report that stops a caller mistaking a same-named
//! command for the engine that produced the findings. With no project-local Biome, `biome` on PATH
//! or `npx biome` runs whatever the environment provides, while tidy runs the managed Biome. Both
//! answer to the same name, so both paths and versions are reported. A shadow is never an error.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use super::catalog::engine_entry;
use super::process::{RunOptions, map_limit, run_process, which};
use super::resolve::{Resolved, first_existing, parse_version_text};

const NPX_CACHE_DIRS_MAX: usize = 40;
const SHADOW_CAP: usize = 8;

fn same_path(a: &str, b: &str) -> bool {
    let (a, b) = (a.replace('\\', "/"), b.replace('\\', "/"));
    !a.is_empty() && !b.is_empty() && if cfg!(windows) { a.to_lowercase() == b.to_lowercase() } else { a == b }
}

/// npm's `_npx` cache: where `npx <name>` finds a package it already fetched.
fn npx_cache_root(env: &HashMap<String, String>) -> Option<PathBuf> {
    let get = |k: &str| env.get(k).map(|v| mixdog_js::js_trim(v)).filter(|v| !v.is_empty());
    if let Some(configured) = get("npm_config_cache") {
        return Some(Path::new(configured).join("_npx"));
    }
    if cfg!(windows) {
        return get("LOCALAPPDATA").map(|l| Path::new(l).join("npm-cache").join("_npx"));
    }
    get("HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).map(|h| h.join(".npm").join("_npx"))
}

fn npx_cache_bin_dirs(env: &HashMap<String, String>) -> Vec<PathBuf> {
    let Some(root) = npx_cache_root(env).filter(|r| r.exists()) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(&root) else { return Vec::new() };
    rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).take(NPX_CACHE_DIRS_MAX).map(|e| e.path().join("node_modules").join(".bin")).collect()
}

fn uses_path(engine: &Resolved, candidate: &str) -> bool {
    same_path(&engine.path, candidate) || same_path(&engine.command, candidate)
}

struct Candidate {
    via: &'static str,
    path: String,
}

/// An engine's accepted host names are interchangeable (PSScriptAnalyzer runs under pwsh or
/// powershell), so when one of them is the binary tidy uses, none of them shadows it.
fn candidates_for(entry: &super::catalog::EngineEntry, engine: &Resolved, env: &HashMap<String, String>, npx_dirs: &[PathBuf]) -> Vec<Candidate> {
    let mut found = Vec::new();
    let host_hits: Vec<String> = std::iter::once(&entry.bin).chain(entry.alt_bins.iter()).filter_map(|n| which(n, Some(env), None)).map(|p| p.to_string_lossy().into_owned()).collect();
    let used_on_path = host_hits.iter().any(|h| uses_path(engine, h));
    if !used_on_path {
        if let Some(first) = host_hits.first() {
            found.push(Candidate { via: "path", path: first.clone() });
        }
    }
    for dir in npx_dirs {
        if let Some(hit) = first_existing(dir, &entry.bin).map(|p| p.to_string_lossy().into_owned()).filter(|h| !uses_path(engine, h)) {
            found.push(Candidate { via: "npx-cache", path: hit });
        }
    }
    found
}

async fn probe_binary_version(bin: &str) -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut options = RunOptions::new(&cwd);
    options.timeout = Duration::from_secs(5);
    let r = run_process(bin, &["--version".to_owned()], options).await;
    parse_version_text(&format!("{}\n{}", r.stdout, r.stderr))
}

/// Same-named binaries that are not the engine tidy uses. Missing engines still report shadows:
/// "nothing tidy runs" is exactly when a stray binary of that name gets mistaken for the engine.
/// `probe` replaces the `--version` spawn in tests.
pub async fn detect_engine_shadows(engines: &[Resolved], env: &HashMap<String, String>, probe: Option<&(dyn Fn(&str) -> String + Sync)>) -> Vec<Value> {
    let npx_dirs = npx_cache_bin_dirs(env);
    let mut found: Vec<(String, String, &'static str, String, &Resolved)> = Vec::new();
    for engine in engines {
        let Some(entry) = engine_entry(&engine.id).filter(|e| !e.bin.is_empty()) else { continue };
        for c in candidates_for(entry, engine, env, &npx_dirs) {
            if found.iter().any(|f| f.0 == engine.id && same_path(&f.3, &c.path)) {
                continue;
            }
            found.push((engine.id.clone(), entry.bin.clone(), c.via, c.path, engine));
        }
    }
    found.truncate(SHADOW_CAP);
    let versions = match probe {
        Some(p) => found.iter().map(|f| p(&f.3)).collect(),
        None => map_limit(found.iter().map(|f| f.3.clone()).collect(), SHADOW_CAP, |p| async move { probe_binary_version(&p).await }).await,
    };
    found
        .iter()
        .zip(versions)
        .map(|((id, bin, via, path, engine), version)| {
            let mut e = json!({"source": engine.source});
            if !engine.path.is_empty() {
                e["path"] = json!(engine.path);
            }
            if !engine.version.is_empty() {
                e["version"] = json!(engine.version);
            }
            json!({"id": id, "bin": bin, "via": via, "shadow": {"path": path, "version": version}, "engine": e})
        })
        .collect()
}

fn describe(path: &str, version: &str) -> String {
    if version.is_empty() { format!("{path} (version unknown)") } else { format!("{path} ({version})") }
}

/// One note per shadow, so the confusion is visible without reading `shadows`.
pub fn shadow_note(row: &Value) -> String {
    let route = if row["via"] == "path" { "PATH" } else { "npx cache" };
    let (id, bin) = (row["id"].as_str().unwrap_or(""), row["bin"].as_str().unwrap_or(""));
    let engine = match row.pointer("/engine/path").and_then(Value::as_str) {
        Some(p) => format!("tidy runs {} {}", row.pointer("/engine/source").and_then(Value::as_str).unwrap_or(""), describe(p, row.pointer("/engine/version").and_then(Value::as_str).unwrap_or(""))),
        None => format!("tidy has no {id} ({})", row.pointer("/engine/source").and_then(Value::as_str).unwrap_or("")),
    };
    format!(
        "{bin} on {route} is {}, not the {id} tidy uses: {engine}; output from that binary says nothing about this report",
        describe(row.pointer("/shadow/path").and_then(Value::as_str).unwrap_or(""), row.pointer("/shadow/version").and_then(Value::as_str).unwrap_or(""))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(id: &str, source: &str, path: &str) -> Resolved {
        Resolved { id: id.into(), source: source.into(), path: path.into(), command: path.into(), ..Default::default() }
    }

    fn bin(name: &str) -> String {
        if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() }
    }

    #[tokio::test]
    async fn a_same_named_binary_that_tidy_does_not_run_is_a_shadow() {
        let path_dir = tempfile::tempdir().unwrap();
        std::fs::write(path_dir.path().join(bin("biome")), "x").unwrap();
        let env = HashMap::from([("PATH".to_owned(), path_dir.path().to_string_lossy().into_owned())]);
        let managed = engine("biome", "managed", "/tools/biome/2.5.13/biome");
        let probe = |p: &str| if p.contains("biome") { "9.9.9".to_owned() } else { String::new() };
        let rows = detect_engine_shadows(&[managed], &env, Some(&probe)).await;
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0]["via"].clone(), rows[0]["shadow"]["version"].clone()), (json!("path"), json!("9.9.9")));
        let note = shadow_note(&rows[0]);
        assert!(note.contains("biome on PATH is") && note.contains("tidy runs managed /tools/biome/2.5.13/biome (version unknown)"), "{note}");
        // The engine itself is never its own shadow.
        let own = path_dir.path().join(bin("biome")).to_string_lossy().into_owned();
        assert!(detect_engine_shadows(&[engine("biome", "path", &own)], &env, Some(&probe)).await.is_empty());
        // A missing engine still reports the stray binary.
        let missing = detect_engine_shadows(&[Resolved { id: "biome".into(), source: "missing".into(), missing: true, ..Default::default() }], &env, Some(&probe)).await;
        assert!(shadow_note(&missing[0]).contains("tidy has no biome (missing)"));
    }

    #[tokio::test]
    async fn the_npx_cache_is_scanned_and_host_names_are_interchangeable() {
        let cache = tempfile::tempdir().unwrap();
        let bin_dir = cache.path().join("_npx").join("abc").join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(bin_dir.join(bin("biome")), "x").unwrap();
        let empty = tempfile::tempdir().unwrap();
        let env = HashMap::from([("PATH".to_owned(), empty.path().to_string_lossy().into_owned()), ("npm_config_cache".to_owned(), cache.path().to_string_lossy().into_owned())]);
        let rows = detect_engine_shadows(&[engine("biome", "managed", "/m/biome")], &env, Some(&|_: &str| String::new())).await;
        assert_eq!(rows[0]["via"], "npx-cache");
        assert!(shadow_note(&rows[0]).contains("npx cache"));
        // PSScriptAnalyzer runs under pwsh: powershell on PATH does not shadow it.
        let ps_dir = tempfile::tempdir().unwrap();
        std::fs::write(ps_dir.path().join(bin("pwsh")), "x").unwrap();
        std::fs::write(ps_dir.path().join(bin("powershell")), "x").unwrap();
        let env = HashMap::from([("PATH".to_owned(), ps_dir.path().to_string_lossy().into_owned())]);
        let pwsh = ps_dir.path().join(bin("pwsh")).to_string_lossy().into_owned();
        assert!(detect_engine_shadows(&[engine("psscriptanalyzer", "managed", &pwsh)], &env, Some(&|_: &str| String::new())).await.is_empty());
    }
}
