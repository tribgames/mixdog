//! Engine resolution. Fixed order, first hit wins:
//!   1. project config  `.mixdog/tidy.json` `{engines:{<id>:{command,args,cwd?}}}`
//!   2. project-local   `node_modules/.bin`, `.venv/{bin,Scripts}`, `venv/{bin,Scripts}`
//!   3. PATH
//!   4. managed         `<data>/tools/<id>/<version>/<binPath>`
//!
//! Anything still unresolved is reported as `source: "missing"` with an install hint.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::lane::on_lane;

use super::catalog::{EngineEntry, engine_entry, engines_for_languages};
use super::install::{manifest_asset, managed_engine_binary, read_engines_manifest};
use super::process::{PathIndex, Processes, RunOptions, map_limit, which};

pub const DEFAULT_DOWNLOAD_POLICY: &str = "auto";
const DOWNLOAD_POLICIES: [&str; 3] = ["ask", "auto", "never"];
const TIDY_CONFIG_RELATIVE_PATH: &str = ".mixdog/tidy.json";
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
pub struct TidyConfig {
    pub engines: serde_json::Map<String, Value>,
    pub policy: serde_json::Map<String, Value>,
    pub present: bool,
    pub error: String,
}

/// Reads `.mixdog/tidy.json` on the lane; a malformed file is reported, never thrown.
async fn read_tidy_config(lane: DurabilityIo, cwd: &Path) -> TidyConfig {
    let owned = cwd.to_owned();
    on_lane(lane, move || read_tidy_config_blocking(&owned)).await.unwrap_or_else(|e| TidyConfig { error: format!("cannot read {TIDY_CONFIG_RELATIVE_PATH}: {e}"), ..Default::default() })
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_tidy_config_blocking(cwd: &Path) -> TidyConfig {
    let path = cwd.join(".mixdog").join("tidy.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return TidyConfig { present: path.exists(), error: if path.exists() { format!("cannot read {TIDY_CONFIG_RELATIVE_PATH}") } else { String::new() }, ..Default::default() };
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(parsed) => TidyConfig {
            engines: parsed.get("engines").and_then(Value::as_object).cloned().unwrap_or_default(),
            policy: parsed.get("policy").and_then(Value::as_object).cloned().unwrap_or_default(),
            present: true,
            error: String::new(),
        },
        Err(e) => TidyConfig { present: true, error: format!("cannot read {TIDY_CONFIG_RELATIVE_PATH}: {e}"), ..Default::default() },
    }
}

#[derive(Debug, PartialEq)]
pub struct DownloadPolicy {
    pub downloads: String,
    pub source: &'static str,
    pub warning: Option<String>,
}

/// Effective download policy. Project config wins over the environment override; an unknown
/// value falls back to the default and is reported.
fn resolve_download_policy(config: &TidyConfig, env_value: Option<&str>) -> DownloadPolicy {
    let from_config = config.policy.get("downloads").and_then(Value::as_str).unwrap_or("");
    let from_config = mixdog_js::js_trim(from_config).to_lowercase();
    let from_env = mixdog_js::js_trim(env_value.unwrap_or("")).to_lowercase();
    let chosen = if from_config.is_empty() { from_env } else { from_config.clone() };
    if chosen.is_empty() {
        return DownloadPolicy { downloads: DEFAULT_DOWNLOAD_POLICY.into(), source: "default", warning: None };
    }
    if !DOWNLOAD_POLICIES.contains(&chosen.as_str()) {
        return DownloadPolicy {
            downloads: DEFAULT_DOWNLOAD_POLICY.into(),
            source: "default",
            warning: Some(format!("tidy.downloads \"{chosen}\" is not one of {}; using {DEFAULT_DOWNLOAD_POLICY}", DOWNLOAD_POLICIES.join(", "))),
        };
    }
    DownloadPolicy { downloads: chosen, source: if from_config.is_empty() { "env" } else { "project-config" }, warning: None }
}

fn bin_names(name: &str) -> Vec<String> {
    if cfg!(windows) { [".exe", ".cmd", ".bat", ""].iter().map(|s| format!("{name}{s}")).collect() } else { vec![name.to_owned()] }
}

/// First on-disk file name `name` takes inside `dir`. Blocking: a lane job's body.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub fn first_existing(dir: &Path, name: &str) -> Option<PathBuf> {
    bin_names(name).into_iter().map(|c| dir.join(c)).find(|p| p.exists())
}

async fn project_local_binary(lane: DurabilityIo, cwd: &Path, entry: &'static EngineEntry) -> Option<PathBuf> {
    // The entry is looked up again inside the job: the job owns only an id.
    let (cwd, id) = (cwd.to_owned(), entry.id.clone());
    on_lane(lane, move || engine_entry(&id).and_then(|entry| project_local_binary_blocking(&cwd, entry))).await.ok().flatten()
}

fn project_local_binary_blocking(cwd: &Path, entry: &EngineEntry) -> Option<PathBuf> {
    let venv_bins: [&str; 2] = if cfg!(windows) { ["Scripts", "bin"] } else { ["bin", "Scripts"] };
    for root in &entry.project_local {
        if root == "node" {
            if let Some(f) = first_existing(&cwd.join("node_modules").join(".bin"), &entry.bin) {
                return Some(f);
            }
        }
        if root == "venv" {
            for venv in [".venv", "venv"] {
                for bin_dir in venv_bins {
                    if let Some(f) = first_existing(&cwd.join(venv).join(bin_dir), &entry.bin) {
                        return Some(f);
                    }
                }
            }
        }
    }
    None
}

/// Which of an engine's marker config files the project already has.
async fn project_config_file_for(lane: DurabilityIo, cwd: &Path, entry: &'static EngineEntry) -> Option<String> {
    let (cwd, id) = (cwd.to_owned(), entry.id.clone());
    on_lane(lane, move || engine_entry(&id).and_then(|entry| project_config_file_blocking(&cwd, entry))).await.ok().flatten()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn project_config_file_blocking(cwd: &Path, entry: &EngineEntry) -> Option<String> {
    if let Some(f) = entry.config_files.iter().find(|f| cwd.join(f).exists()) {
        return Some(f.clone());
    }
    let toml = entry.toml_config.as_ref()?;
    std::fs::read_to_string(cwd.join(&toml.file)).ok().filter(|t| t.contains(&toml.section)).map(|_| toml.file.clone())
}

/// The engine's binary on PATH; the lookups list directories, so they run as one lane job.
async fn path_binary(lane: DurabilityIo, entry: &'static EngineEntry, env: Option<&HashMap<String, String>>, index: &Arc<PathIndex>) -> Option<PathBuf> {
    let (env, index, id) = (env.cloned(), index.clone(), entry.id.clone());
    on_lane(lane, move || {
        let entry = engine_entry(&id)?;
        std::iter::once(&entry.bin).chain(entry.alt_bins.iter()).find_map(|name| which(name, env.as_ref(), Some(&index)))
    })
    .await
    .ok()
    .flatten()
}

#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub id: String,
    pub kind: Vec<String>,
    pub languages: Vec<String>,
    pub install_hint: String,
    /// `project-config | project-local | path | managed | missing`
    pub source: String,
    pub path: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub version: String,
    pub missing: bool,
    pub installable: bool,
    pub skipped: Option<String>,
    pub suppressed_by: Vec<String>,
    pub config_file: Option<String>,
    pub toolchain: bool,
    pub module_path: Option<String>,
}

impl Resolved {
    pub fn runnable(&self) -> bool {
        !self.missing && self.skipped.is_none()
    }

    pub fn to_json(&self) -> Value {
        let mut v = json!({"id": self.id, "kind": self.kind, "languages": self.languages, "installHint": self.install_hint, "source": self.source, "path": self.path});
        let put = |v: &mut Value, k: &str, x: Value| v[k] = x;
        if !self.command.is_empty() {
            put(&mut v, "command", json!(self.command));
            put(&mut v, "args", json!(self.args));
        }
        for (k, x) in [("cwd", &self.cwd), ("skipped", &self.skipped), ("configFile", &self.config_file), ("modulePath", &self.module_path)] {
            if let Some(x) = x {
                put(&mut v, k, json!(x));
            }
        }
        if !self.version.is_empty() {
            put(&mut v, "version", json!(self.version));
        }
        if self.missing {
            put(&mut v, "missing", json!(true));
        }
        if self.installable {
            put(&mut v, "installable", json!(true));
        }
        if !self.suppressed_by.is_empty() {
            put(&mut v, "suppressedBy", json!(self.suppressed_by));
        }
        if self.toolchain {
            put(&mut v, "toolchain", json!(true));
        }
        v
    }
}

fn command_for(entry: &EngineEntry, path: &Path) -> (String, Vec<String>) {
    // `zig fmt` / `dart format` / `mix format` / `dotnet format` are one engine reached through a
    // subcommand; the catalog carries the argv prefix.
    (path.to_string_lossy().into_owned(), entry.command.as_ref().map(|c| c[1..].to_vec()).unwrap_or_default())
}

/// Installable means "this platform has an asset", not merely "the manifest knows this engine".
fn installable(entry: &EngineEntry, manifest: &Value) -> bool {
    entry.managed && manifest_asset(manifest, &entry.id).is_some()
}

async fn resolve_one(processes: &Processes, cwd: &Path, entry: &'static EngineEntry, config: &TidyConfig, env: Option<&HashMap<String, String>>, manifest: &Value, plugin_data: &Path, index: &Arc<PathIndex>) -> Resolved {
    let lane = processes.durability();
    let base = Resolved { id: entry.id.clone(), kind: entry.kind.clone(), languages: entry.languages.clone(), install_hint: entry.install_hint.clone(), ..Default::default() };
    if let Some(configured) = config.engines.get(&entry.id).and_then(Value::as_object) {
        if let Some(command) = configured.get("command").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            return Resolved {
                source: "project-config".into(),
                path: command.into(),
                command: command.into(),
                args: configured.get("args").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect()).unwrap_or_default(),
                cwd: configured.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_owned),
                ..base
            };
        }
    }
    if let Some(local) = project_local_binary(processes.durability(), cwd, entry).await {
        let (command, args) = command_for(entry, &local);
        return Resolved { source: "project-local".into(), path: local.to_string_lossy().into_owned(), command, args, ..base };
    }
    if entry.project_local_only {
        return Resolved { source: "missing".into(), missing: true, ..base };
    }
    if entry.managed_module {
        let Some(host) = path_binary(lane, entry, env, index).await else {
            let hint = if entry.host_install_hint.is_empty() { entry.install_hint.clone() } else { entry.host_install_hint.clone() };
            return Resolved { source: "missing".into(), missing: true, install_hint: hint, ..base };
        };
        let host_path = host.to_string_lossy().into_owned();
        if entry.managed && !plugin_data.as_os_str().is_empty() {
            if let Some((module, version)) = managed_engine_binary(processes, &entry.id, manifest, plugin_data).await {
                let module = module.to_string_lossy().into_owned();
                return Resolved { source: "managed".into(), path: module.clone(), command: host_path, version, module_path: Some(module), ..base };
            }
        }
        return Resolved { source: "missing".into(), path: host_path.clone(), command: host_path, missing: true, installable: installable(entry, manifest), ..base };
    }
    if let Some(found) = path_binary(lane, entry, env, index).await {
        let (command, args) = command_for(entry, &found);
        return Resolved { source: "path".into(), path: found.to_string_lossy().into_owned(), command, args, ..base };
    }
    if entry.managed && !plugin_data.as_os_str().is_empty() {
        if let Some((path, version)) = managed_engine_binary(processes, &entry.id, manifest, plugin_data).await {
            let p = path.to_string_lossy().into_owned();
            return Resolved { source: "managed".into(), path: p.clone(), command: p, version, ..base };
        }
    }
    Resolved { source: "missing".into(), missing: true, installable: installable(entry, manifest), ..base }
}

/// First version-looking token in a `--version` output, or empty.
pub fn parse_version_text(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if bytes.get(j) == Some(&b'.') && bytes.get(j + 1).is_some_and(u8::is_ascii_digit) {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                // Optional third numeric component.
                if bytes.get(j) == Some(&b'.') && bytes.get(j + 1).is_some_and(u8::is_ascii_digit) {
                    j += 1;
                    while j < bytes.len() && bytes[j].is_ascii_digit() {
                        j += 1;
                    }
                }
                // Optional pre-release/build suffix.
                if matches!(bytes.get(j), Some(b'-' | b'+')) && bytes.get(j + 1).is_some_and(|b| b.is_ascii_alphanumeric()) {
                    j += 1;
                    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'.') {
                        j += 1;
                    }
                }
                return text[i..j].to_owned();
            }
            i = j;
        } else {
            i += 1;
        }
    }
    String::new()
}

/// Version of a host-provided managed module (PSScriptAnalyzer under pwsh/powershell). Spawns
/// a PowerShell host, so callers on a polled path must cache it.
pub async fn probe_host_managed_module(processes: &Processes, engine: &Resolved, cancel: Option<&CancellationToken>) -> String {
    let Some(args) = engine_entry(&engine.id).and_then(|e| e.version_args.clone()) else { return String::new() };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut options = RunOptions::new(&cwd);
    options.timeout = VERSION_PROBE_TIMEOUT;
    options.cancel = cancel;
    let result = processes.run(&engine.command, &args, options).await;
    let version = parse_dotted(&result.stdout);
    if result.code == 0 { version } else { String::new() }
}

/// `\d+\.\d+(\.\d+)?` only.
fn parse_dotted(text: &str) -> String {
    let v = parse_version_text(text);
    v.split(['-', '+']).next().unwrap_or("").to_owned()
}

async fn probe_version(processes: &Processes, engine: &Resolved, cancel: Option<&CancellationToken>) -> String {
    let defaults = vec!["--version".to_owned()];
    let version_args = engine_entry(&engine.id).and_then(|e| e.version_args.clone()).unwrap_or(defaults);
    let args: Vec<String> = engine.args.iter().cloned().chain(version_args).collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut options = RunOptions::new(&cwd);
    options.timeout = VERSION_PROBE_TIMEOUT;
    options.cancel = cancel;
    let result = processes.run(&engine.command, &args, options).await;
    parse_version_text(&format!("{}\n{}", result.stdout, result.stderr))
}

/// Answers the host-module version, cached by the caller on polled paths.
pub type HostModuleProbe = Arc<dyn Fn(Resolved) -> std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send>> + Send + Sync>;

#[derive(Default)]
pub struct ResolveOptions {
    pub languages: Vec<String>,
    pub engine_ids: Vec<String>,
    pub plugin_data: PathBuf,
    pub manifest: Option<Value>,
    pub env: Option<HashMap<String, String>>,
    pub probe_versions: bool,
    pub host_module_probe: Option<HostModuleProbe>,
    pub cancel: Option<CancellationToken>,
}

pub struct Resolution {
    pub engines: Vec<Resolved>,
    pub policy: DownloadPolicy,
    pub config: TidyConfig,
    pub unknown_engines: Vec<String>,
}

impl Resolution {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "engines": self.engines.iter().map(Resolved::to_json).collect::<Vec<_>>(),
            "policy": {"downloads": self.policy.downloads, "source": self.policy.source},
            "config": {"path": TIDY_CONFIG_RELATIVE_PATH, "present": self.config.present},
        });
        if let Some(w) = &self.policy.warning {
            v["policy"]["warning"] = json!(w);
        }
        if !self.config.error.is_empty() {
            v["config"]["error"] = json!(self.config.error);
        }
        if !self.unknown_engines.is_empty() {
            v["unknownEngines"] = json!(self.unknown_engines);
        }
        v
    }
}

/// Resolves every engine that can touch the requested languages. With neither `languages` nor
/// `engine_ids` there is nothing to resolve: a scope that holds no tracked file of a known
/// language must not probe the whole catalog.
pub async fn resolve_engines(processes: &Processes, cwd: &Path, options: ResolveOptions) -> Resolution {
    let config = read_tidy_config(processes.durability(), cwd).await;
    let env_downloads = options.env.as_ref().and_then(|e| e.get("MIXDOG_TIDY_DOWNLOADS").cloned()).or_else(|| std::env::var("MIXDOG_TIDY_DOWNLOADS").ok());
    let policy = resolve_download_policy(&config, env_downloads.as_deref());
    let manifest = options.manifest.clone().unwrap_or_else(read_engines_manifest);
    let requested: Vec<&'static EngineEntry> = if !options.engine_ids.is_empty() {
        options.engine_ids.iter().filter_map(|id| engine_entry(id)).collect()
    } else if !options.languages.is_empty() {
        engines_for_languages(&options.languages)
    } else {
        Vec::new()
    };
    let unknown: Vec<String> = options.engine_ids.iter().filter(|id| engine_entry(id).is_none()).cloned().collect();
    // One listing per PATH dir for the whole batch.
    let index = Arc::new(PathIndex::new(options.env.as_ref()));
    let mut resolved = Vec::new();
    for entry in requested {
        let mut r = resolve_one(processes, cwd, entry, &config, options.env.as_ref(), &manifest, &options.plugin_data, &index).await;
        r.config_file = project_config_file_for(processes.durability(), cwd, entry).await;
        if entry.requires_config && r.config_file.is_none() && r.source != "project-config" {
            r.skipped = Some("no project config for this engine".into());
        }
        r.toolchain = entry.toolchain;
        resolved.push(r);
    }
    // A project driving Prettier/ESLint from node_modules/.bin keeps them: Biome stands down.
    let sources: HashMap<String, String> = resolved.iter().map(|r| (r.id.clone(), r.source.clone())).collect();
    for engine in &mut resolved {
        let Some(entry) = engine_entry(&engine.id) else { continue };
        let suppressors: Vec<String> = entry.suppressed_by.iter().filter(|id| matches!(sources.get(*id).map(String::as_str), Some("project-local" | "project-config"))).cloned().collect();
        if !suppressors.is_empty() && !engine.missing {
            engine.skipped = Some(format!("project uses {}", suppressors.join(" + ")));
            engine.suppressed_by = suppressors;
        }
    }
    refine_managed_modules(processes, &mut resolved, options.host_module_probe.as_ref(), options.cancel.as_ref()).await;
    if options.probe_versions {
        let cancel = options.cancel.clone();
        let runnable: Vec<(usize, Resolved)> = resolved.iter().cloned().enumerate().filter(|(_, e)| !e.missing && !e.command.is_empty()).collect();
        let versions = map_limit(runnable.clone(), 4, |(_, e)| {
            let cancel = cancel.clone();
            async move { if e.version.is_empty() { probe_version(processes, &e, cancel.as_ref()).await } else { e.version.clone() } }
        })
        .await;
        for ((index, _), version) in runnable.iter().zip(versions) {
            if !version.is_empty() {
                resolved[*index].version = version;
            }
        }
    }
    Resolution { engines: resolved, policy, config, unknown_engines: unknown }
}

async fn refine_managed_modules(processes: &Processes, engines: &mut [Resolved], probe: Option<&HostModuleProbe>, cancel: Option<&CancellationToken>) {
    let candidates: Vec<(usize, Resolved)> = engines.iter().cloned().enumerate().filter(|(_, e)| engine_entry(&e.id).is_some_and(|c| c.managed_module) && !e.command.is_empty()).collect();
    if candidates.is_empty() {
        return;
    }
    let versions = map_limit(candidates.clone(), 4, |(_, e)| {
        let probe = probe.cloned();
        let cancel = cancel.cloned();
        async move {
            match probe {
                Some(p) => p(e).await,
                None => probe_host_managed_module(processes, &e, cancel.as_ref()).await,
            }
        }
    })
    .await;
    for ((index, _), version) in candidates.iter().zip(versions) {
        if version.is_empty() {
            continue;
        }
        let e = &mut engines[*index];
        e.source = "path".into();
        e.version = version;
        e.path = e.command.clone();
        e.module_path = None;
        e.missing = false;
        e.installable = false;
    }
}

/// Engines that can actually run: resolved, not suppressed, not config-gated.
fn runnable_engines(engines: &[Resolved]) -> Vec<&Resolved> {
    engines.iter().filter(|e| e.runnable()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn bin(name: &str) -> String {
        if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() }
    }

    fn opts(ids: &[&str], path_dir: &Path) -> ResolveOptions {
        ResolveOptions {
            engine_ids: ids.iter().map(|s| (*s).to_owned()).collect(),
            env: Some(HashMap::from([("PATH".to_owned(), path_dir.to_string_lossy().into_owned())])),
            manifest: Some(json!({"engines": {}})),
            ..Default::default()
        }
    }

    #[test]
    fn versions_are_the_first_dotted_token() {
        assert_eq!(parse_version_text("ruff 0.4.1 (abc)"), "0.4.1");
        assert_eq!(parse_version_text("v2.5-rc.1\n"), "2.5-rc.1");
        assert_eq!(parse_version_text("no digits"), "");
        assert_eq!(parse_version_text("1 2 3.4"), "3.4");
    }

    #[test]
    fn download_policy_prefers_project_config_and_reports_unknown_values() {
        let mut config = TidyConfig::default();
        assert_eq!(resolve_download_policy(&config, None).source, "default");
        assert_eq!(resolve_download_policy(&config, Some(" NEVER ")), DownloadPolicy { downloads: "never".into(), source: "env", warning: None });
        config.policy.insert("downloads".into(), json!("ask"));
        assert_eq!(resolve_download_policy(&config, Some("never")).downloads, "ask");
        config.policy.insert("downloads".into(), json!("sometimes"));
        let p = resolve_download_policy(&config, None);
        assert_eq!((p.downloads.as_str(), p.source), ("auto", "default"));
        assert!(p.warning.unwrap().contains("sometimes"));
    }

    #[tokio::test]
    async fn resolution_order_is_config_then_project_local_then_path_then_missing() {
        let project = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        write(path_dir.path(), &bin("shfmt"), "x");
        write(path_dir.path(), &bin("ruff"), "x");
        write(project.path(), &format!("node_modules/.bin/{}", bin("prettier")), "x");
        write(project.path(), ".mixdog/tidy.json", r#"{"engines":{"ruff":{"command":"/custom/ruff","args":["--x"]}}}"#);
        let r = resolve_engines(&Processes::for_tests(), project.path(), opts(&["ruff", "prettier", "shfmt", "stylua", "eslint", "nope"], path_dir.path())).await;
        let by = |id: &str| r.engines.iter().find(|e| e.id == id).unwrap();
        assert_eq!((by("ruff").source.as_str(), by("ruff").command.as_str(), by("ruff").args.clone()), ("project-config", "/custom/ruff", vec!["--x".to_owned()]));
        assert_eq!(by("prettier").source, "project-local");
        assert_eq!(by("shfmt").source, "path");
        assert!(by("stylua").missing && by("stylua").source == "missing");
        assert!(by("eslint").missing, "project-local-only engines never come from PATH");
        assert_eq!(r.unknown_engines, ["nope"]);
        assert!(r.config.present);
    }

    #[tokio::test]
    async fn biome_stands_down_for_a_project_prettier_and_gated_engines_are_skipped() {
        let project = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        write(path_dir.path(), &bin("biome"), "x");
        write(path_dir.path(), &bin("dprint"), "x");
        write(project.path(), &format!("node_modules/.bin/{}", bin("prettier")), "x");
        let r = resolve_engines(&Processes::for_tests(), project.path(), opts(&["biome", "prettier", "dprint"], path_dir.path())).await;
        let by = |id: &str| r.engines.iter().find(|e| e.id == id).unwrap();
        assert_eq!(by("biome").skipped.as_deref(), Some("project uses prettier"));
        assert_eq!(by("dprint").skipped.as_deref(), Some("no project config for this engine"));
        assert_eq!(runnable_engines(&r.engines).iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["prettier"]);
        write(project.path(), "dprint.json", "{}");
        let again = resolve_engines(&Processes::for_tests(), project.path(), opts(&["dprint"], path_dir.path())).await;
        assert!(again.engines[0].skipped.is_none() && again.engines[0].config_file.as_deref() == Some("dprint.json"));
    }

    #[tokio::test]
    async fn no_scope_resolves_nothing_and_subcommand_engines_carry_their_prefix() {
        let project = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        write(path_dir.path(), &bin("dotnet"), "x");
        assert!(resolve_engines(&Processes::for_tests(), project.path(), opts(&[], path_dir.path())).await.engines.is_empty());
        let r = resolve_engines(&Processes::for_tests(), project.path(), opts(&["dotnet-format"], path_dir.path())).await;
        assert_eq!(r.engines[0].args, ["format"]);
        let by_language = resolve_engines(&Processes::for_tests(), project.path(), ResolveOptions { languages: vec!["python".into()], ..opts(&[], path_dir.path()) }).await;
        assert_eq!(by_language.engines.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["ruff"]);
        assert_eq!(by_language.to_json()["engines"][0]["source"], "missing");
    }
}
