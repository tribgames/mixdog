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
use super::languages::project_relative;
use super::process::{PathIndex, Processes, RunOptions, map_limit, which};

pub const DEFAULT_DOWNLOAD_POLICY: &str = "auto";
const DOWNLOAD_POLICIES: [&str; 3] = ["ask", "auto", "never"];
const TIDY_CONFIG_RELATIVE_PATH: &str = ".mixdog/tidy.json";
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// One `engines.<id>` entry of `.mixdog/tidy.json`, as the engine will be run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfiguredEngine {
    /// A relative command with a directory part is resolved against the project root. `None`:
    /// the engine is resolved the normal way and `args`/`cwd` apply to it.
    pub command: Option<String>,
    pub args: Vec<String>,
    /// Absolute directory inside the project the engine runs in.
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, Default)]
pub struct TidyConfig {
    pub engines: HashMap<String, ConfiguredEngine>,
    /// `policy.downloads`, validated; empty when the file does not set it.
    pub downloads: String,
    pub present: bool,
    /// Why the file cannot be honoured. Non-empty fails the call: nothing falls back.
    pub error: String,
}

/// Reads `.mixdog/tidy.json` on the lane; a file that cannot be honoured comes back with `error`.
async fn read_tidy_config(lane: DurabilityIo, cwd: &Path) -> TidyConfig {
    let owned = cwd.to_owned();
    on_lane(lane, move || read_tidy_config_blocking(&owned)).await.unwrap_or_else(|e| TidyConfig { error: format!("cannot read {TIDY_CONFIG_RELATIVE_PATH}: {e}"), ..Default::default() })
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_tidy_config_blocking(cwd: &Path) -> TidyConfig {
    let path = cwd.join(".mixdog").join("tidy.json");
    // Absent means no entry at that path; a link to nothing is an entry that cannot be read.
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TidyConfig::default(),
        Err(e) => return TidyConfig { present: true, error: format!("cannot read {TIDY_CONFIG_RELATIVE_PATH}: {e}"), ..Default::default() },
        Ok(_) => {}
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) => return TidyConfig { present: true, error: format!("cannot read {TIDY_CONFIG_RELATIVE_PATH}: {e}"), ..Default::default() },
    };
    match parse_tidy_config(&text, cwd) {
        Ok(config) => TidyConfig { present: true, ..config },
        Err(e) => TidyConfig { present: true, error: format!("{TIDY_CONFIG_RELATIVE_PATH}: {e}"), ..Default::default() },
    }
}

/// Parses the project config, refusing anything it could only honour by guessing. Blocking: an
/// engine `cwd` is checked on disk.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn parse_tidy_config(text: &str, root: &Path) -> Result<TidyConfig, String> {
    let parsed: Value = serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
    let obj = parsed.as_object().ok_or("the top level must be a JSON object")?;
    let mut config = TidyConfig::default();
    match obj.get("engines") {
        None | Some(Value::Null) => {}
        Some(Value::Object(engines)) => {
            for (id, entry) in engines {
                config.engines.insert(id.clone(), configured_engine(id, entry, root)?);
            }
        }
        Some(_) => return Err("engines must be an object of engine id to {command, args?, cwd?}".into()),
    }
    match obj.get("policy") {
        None | Some(Value::Null) => {}
        Some(Value::Object(policy)) => match policy.get("downloads") {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if DOWNLOAD_POLICIES.contains(&mixdog_js::js_trim(s).to_lowercase().as_str()) => config.downloads = mixdog_js::js_trim(s).to_lowercase(),
            Some(other) => return Err(format!("policy.downloads is {other}, not one of {}", DOWNLOAD_POLICIES.join(", "))),
        },
        Some(_) => return Err("policy must be an object".into()),
    }
    Ok(config)
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn configured_engine(id: &str, entry: &Value, root: &Path) -> Result<ConfiguredEngine, String> {
    if engine_entry(id).is_none() {
        return Err(format!("engines.{id} is not an engine tidy knows"));
    }
    let e = entry.as_object().ok_or_else(|| format!("engines.{id} must be an object of command?, args?, cwd?"))?;
    let command = match e.get("command") {
        None => None,
        Some(Value::String(c)) if !mixdog_js::js_trim(c).is_empty() => Some(c.clone()),
        _ => return Err(format!("engines.{id}.command must be a non-empty string")),
    };
    let args = match e.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>().ok_or_else(|| format!("engines.{id}.args must be an array of strings"))?,
        Some(_) => return Err(format!("engines.{id}.args must be an array of strings")),
    };
    let cwd = match e.get("cwd") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) if !d.is_empty() => {
            // Containment and the engine's file arguments come from where the directory really
            // is: a link or junction inside the project can lead anywhere, at any depth.
            let full = if Path::new(d).is_absolute() { PathBuf::from(d) } else { root.join(d) };
            let real_root = std::fs::canonicalize(root).map_err(|e| format!("the project root cannot be resolved: {e}"))?;
            let real = std::fs::canonicalize(&full).map_err(|e| format!("engines.{id}.cwd {d} cannot be resolved: {e}"))?;
            if !real.is_dir() {
                return Err(format!("engines.{id}.cwd {d} is not a directory"));
            }
            let rel = project_relative(&real_root, &real).ok_or_else(|| format!("engines.{id}.cwd {d} is not inside the project: it resolves to {}", real.display()))?;
            Some(if rel.is_empty() { root.to_owned() } else { root.join(rel) })
        }
        Some(_) => return Err(format!("engines.{id}.cwd must be a non-empty string")),
    };
    // `tools/fmt` names a file in the project; a bare name is looked up on PATH.
    let command = command.map(|command| {
        let path = Path::new(&command);
        if !path.has_root() && path.components().count() > 1 { root.join(path).to_string_lossy().into_owned() } else { command }
    });
    Ok(ConfiguredEngine { command, args, cwd })
}

#[derive(Debug, PartialEq)]
pub struct DownloadPolicy {
    pub downloads: String,
    pub source: &'static str,
    pub warning: Option<String>,
}

/// Effective download policy. Project config (validated when read) wins over the environment
/// override; an unknown environment value falls back to the default and is reported.
fn resolve_download_policy(config: &TidyConfig, env_value: Option<&str>) -> DownloadPolicy {
    let from_config = config.downloads.clone();
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

/// Why a lookup has no answer: its lane job never ran. That says nothing about the project, so the
/// engine is reported `unavailable` and neither "missing" nor replaced by another binary.
fn unrun(what: &str) -> String {
    format!("{what} could not be looked up: its lane did not run the check")
}

fn unavailable(base: Resolved, why: String) -> Resolved {
    Resolved { source: "unavailable".into(), unavailable: Some(why), ..base }
}

async fn project_local_binary(lane: DurabilityIo, cwd: &Path, entry: &'static EngineEntry) -> Result<Option<PathBuf>, String> {
    // The entry is looked up again inside the job: the job owns only an id.
    let (cwd, id) = (cwd.to_owned(), entry.id.clone());
    on_lane(lane, move || engine_entry(&id).and_then(|entry| project_local_binary_blocking(&cwd, entry))).await.map_err(|_| unrun("The project-local binary"))
}

fn project_local_binary_blocking(cwd: &Path, entry: &EngineEntry) -> Option<PathBuf> {
    let venv_bins: [&str; 2] = if cfg!(windows) { ["Scripts", "bin"] } else { ["bin", "Scripts"] };
    for root in &entry.project_local {
        if root == "node"
            && let Some(f) = first_existing(&cwd.join("node_modules").join(".bin"), &entry.bin)
        {
            return Some(f);
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

/// Which of an engine's marker config files the project already has, named from the project:
/// the nearest one from the directory the engine runs in up to the project, as an engine that
/// looks upward from where it runs would find it.
async fn project_config_file_for(lane: DurabilityIo, cwd: &Path, engine_dir: &Path, entry: &'static EngineEntry) -> Result<Option<String>, String> {
    let (cwd, dir, id) = (cwd.to_owned(), engine_dir.to_owned(), entry.id.clone());
    on_lane(lane, move || {
        let entry = engine_entry(&id)?;
        dir.ancestors().take_while(|at| at.starts_with(&cwd)).find_map(|at| {
            let file = project_config_file_blocking(at, entry)?;
            let below = at.strip_prefix(&cwd).ok()?.to_string_lossy().replace('\\', "/");
            Some(if below.is_empty() { file } else { format!("{below}/{file}") })
        })
    })
    .await
    .map_err(|_| unrun("The project's config for this engine"))
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
async fn path_binary(lane: DurabilityIo, entry: &'static EngineEntry, env: Option<&HashMap<String, String>>, index: &Arc<PathIndex>) -> Result<Option<PathBuf>, String> {
    let (env, index, id) = (env.cloned(), index.clone(), entry.id.clone());
    on_lane(lane, move || {
        let entry = engine_entry(&id)?;
        std::iter::once(&entry.bin).chain(entry.alt_bins.iter()).find_map(|name| which(name, env.as_ref(), Some(&index)))
    })
    .await
    .map_err(|_| unrun("The PATH lookup"))
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
    /// A lookup that decides what this engine is never ran (`source` is `unavailable`): the engine
    /// is not run and is not reported missing, and no other binary stands in for it.
    pub unavailable: Option<String>,
}

impl Resolved {
    pub fn runnable(&self) -> bool {
        !self.missing && self.skipped.is_none() && self.unavailable.is_none()
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
        if let Some(why) = &self.unavailable {
            put(&mut v, "unavailable", json!(why));
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
    // `zig fmt` / `dart format` / `dotnet format` are one engine reached through a
    // subcommand; the catalog carries the argv prefix.
    (path.to_string_lossy().into_owned(), entry.command.as_ref().map(|c| c[1..].to_vec()).unwrap_or_default())
}

/// Installable means "this platform has an asset", not merely "the manifest knows this engine".
fn installable(entry: &EngineEntry, manifest: &Value) -> bool {
    entry.managed && manifest_asset(manifest, &entry.id).is_some()
}

/// An engine as the project config sets it: its own `command`, or the engine found the normal way
/// with the entry's `args` after any catalog prefix and its `cwd`.
async fn resolve_one(processes: &Processes, cwd: &Path, entry: &'static EngineEntry, config: &TidyConfig, env: Option<&HashMap<String, String>>, managed: (&Value, &Path), index: &Arc<PathIndex>) -> Resolved {
    let configured = config.engines.get(&entry.id);
    let dir = configured.and_then(|c| c.cwd.as_ref()).map(|d| d.to_string_lossy().into_owned());
    if let Some(command) = configured.and_then(|c| c.command.as_ref()) {
        let base = Resolved { id: entry.id.clone(), kind: entry.kind.clone(), languages: entry.languages.clone(), install_hint: entry.install_hint.clone(), ..Default::default() };
        return Resolved { source: "project-config".into(), path: command.clone(), command: command.clone(), args: configured.map(|c| c.args.clone()).unwrap_or_default(), cwd: dir, ..base };
    }
    let mut found = locate(processes, cwd, entry, env, managed, index).await;
    if let Some(c) = configured {
        found.args.extend(c.args.iter().cloned());
        found.cwd = dir;
    }
    found
}

/// The engine found project-local, on PATH or managed, in that order.
async fn locate(processes: &Processes, cwd: &Path, entry: &'static EngineEntry, env: Option<&HashMap<String, String>>, managed: (&Value, &Path), index: &Arc<PathIndex>) -> Resolved {
    let (manifest, plugin_data) = managed;
    let lane = processes.durability();
    let base = Resolved { id: entry.id.clone(), kind: entry.kind.clone(), languages: entry.languages.clone(), install_hint: entry.install_hint.clone(), ..Default::default() };
    match project_local_binary(processes.durability(), cwd, entry).await {
        Ok(Some(local)) => {
            let (command, args) = command_for(entry, &local);
            return Resolved { source: "project-local".into(), path: local.to_string_lossy().into_owned(), command, args, ..base };
        }
        Ok(None) => {}
        Err(why) => return unavailable(base, why),
    }
    if entry.project_local_only {
        return Resolved { source: "missing".into(), missing: true, ..base };
    }
    if entry.managed_module {
        let host = match path_binary(lane, entry, env, index).await {
            Ok(Some(host)) => host,
            Ok(None) => {
                let hint = if entry.host_install_hint.is_empty() { entry.install_hint.clone() } else { entry.host_install_hint.clone() };
                return Resolved { source: "missing".into(), missing: true, install_hint: hint, ..base };
            }
            Err(why) => return unavailable(base, why),
        };
        let host_path = host.to_string_lossy().into_owned();
        if entry.managed && !plugin_data.as_os_str().is_empty()
            && let Some((module, version)) = managed_engine_binary(processes, &entry.id, manifest, plugin_data).await
        {
            let module = module.to_string_lossy().into_owned();
            return Resolved { source: "managed".into(), path: module.clone(), command: host_path, version, module_path: Some(module), ..base };
        }
        return Resolved { source: "missing".into(), path: host_path.clone(), command: host_path, missing: true, installable: installable(entry, manifest), ..base };
    }
    match path_binary(lane, entry, env, index).await {
        Ok(Some(found)) => {
            let (command, args) = command_for(entry, &found);
            return Resolved { source: "path".into(), path: found.to_string_lossy().into_owned(), command, args, ..base };
        }
        Ok(None) => {}
        Err(why) => return unavailable(base, why),
    }
    if entry.managed && !plugin_data.as_os_str().is_empty()
        && let Some((path, version)) = managed_engine_binary(processes, &entry.id, manifest, plugin_data).await
    {
        let p = path.to_string_lossy().into_owned();
        return Resolved { source: "managed".into(), path: p.clone(), command: p, version, ..base };
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

/// `\d+\.\d+(\.\d+)?` only.
fn parse_dotted(text: &str) -> String {
    let v = parse_version_text(text);
    v.split(['-', '+']).next().unwrap_or("").to_owned()
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

/// Engines that can actually run: resolved, not suppressed, not config-gated.
#[cfg(test)]
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
        config.downloads = "ask".into();
        assert_eq!(resolve_download_policy(&config, Some("never")).downloads, "ask");
        let p = resolve_download_policy(&TidyConfig::default(), Some("sometimes"));
        assert_eq!((p.downloads.as_str(), p.source), ("auto", "default"));
        assert!(p.warning.unwrap().contains("sometimes"));
    }

    /// A project config the tool cannot honour is an error, never a fallback to another binary.
    #[test]
    fn a_config_that_cannot_be_honoured_is_an_error() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        std::fs::create_dir_all(root.join("web")).unwrap();
        let error = |text: &str| parse_tidy_config(text, root).err().unwrap_or_default();
        assert!(error("{\"engines\":").contains("not valid JSON"));
        assert!(error("[]").contains("top level must be a JSON object"));
        assert!(error(r#"{"engines":{"ruff":{"command":""}}}"#).contains("engines.ruff.command must be a non-empty string"));
        assert!(error(r#"{"engines":{"ruff":{"command":7}}}"#).contains("engines.ruff.command must be a non-empty string"));
        assert!(error(r#"{"engines":{"ruff":{"command":"ruff","args":[1]}}}"#).contains("args must be an array of strings"));
        assert!(error(r#"{"engines":{"rufff":{"command":"ruff"}}}"#).contains("not an engine tidy knows"));
        assert!(error(r#"{"engines":{"ruff":{"command":"ruff","cwd":".."}}}"#).contains("not inside the project"));
        assert!(error(r#"{"engines":{"ruff":{"command":"ruff","cwd":"nope"}}}"#).contains("cannot be resolved"));
        write(root, "file.txt", "");
        assert!(error(r#"{"engines":{"ruff":{"command":"ruff","cwd":"file.txt"}}}"#).contains("not a directory"));
        assert!(error(r#"{"policy":{"downloads":"sometimes"}}"#).contains("policy.downloads"));
        let config = parse_tidy_config(r#"{"engines":{"ruff":{"command":"tools/ruff","args":["--x"],"cwd":"web"}},"policy":{"downloads":"Never"}}"#, root).unwrap();
        assert_eq!(config.engines["ruff"], ConfiguredEngine { command: Some(root.join("tools/ruff").to_string_lossy().into_owned()), args: vec!["--x".into()], cwd: Some(root.join("web")) });
        assert_eq!(config.downloads, "never");
        assert_eq!(parse_tidy_config(r#"{"engines":{"ruff":{"command":"ruff"}}}"#, root).unwrap().engines["ruff"].command.as_deref(), Some("ruff"), "a bare name is looked up on PATH");
        assert_eq!(parse_tidy_config(r#"{"engines":{"ruff":{"args":["--x"]}}}"#, root).unwrap().engines["ruff"].command, None, "an entry may leave the binary to resolution");
        write(root, ".mixdog/tidy.json", "{oops");
        let read = read_tidy_config_blocking(root);
        assert!(read.present && read.error.starts_with(".mixdog/tidy.json: not valid JSON"), "{}", read.error);
    }

    fn python() -> Option<String> {
        ["python3", "python"].into_iter().find(|p| std::process::Command::new(p).args(["-c", "pass"]).status().is_ok_and(|s| s.success())).map(str::to_owned)
    }

    /// The rustup proxy answers by directory, so a version is asked where the engine runs; a probe
    /// that exits non-zero has no version even when its text holds a number.
    #[tokio::test]
    async fn versions_are_probed_where_the_engine_runs_and_a_failed_probe_has_none() {
        let Some(python) = python() else { return eprintln!("skipped: python is missing") };
        let project = tempfile::tempdir().unwrap();
        let script = "import os, sys\nif os.path.exists('toolchain-marker'):\n    print('fake 1.10.0')\nelif os.path.exists('broken-marker'):\n    print('usage: fake 3.4 --help'); sys.exit(2)\nelse:\n    print('fake 1.9.0')\n";
        write(project.path(), "fake.py", script);
        write(project.path(), "toolchain-marker", "");
        let config = json!({"engines": {"ruff": {"command": python, "args": [project.path().join("fake.py").to_string_lossy()]}}});
        write(project.path(), ".mixdog/tidy.json", &config.to_string());
        let probe = |dir: &Path| {
            let dir = dir.to_owned();
            async move { resolve_engines(&Processes::for_tests(), &dir, ResolveOptions { engine_ids: vec!["ruff".into()], probe_versions: true, manifest: Some(json!({"engines": {}})), ..Default::default() }).await }
        };
        assert_eq!(probe(project.path()).await.engines[0].version, "1.10.0");
        std::fs::remove_file(project.path().join("toolchain-marker")).unwrap();
        write(project.path(), "broken-marker", "");
        assert_eq!(probe(project.path()).await.engines[0].version, "", "a failed probe has no version");
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
    /// A lookup whose lane job never ran is neither a missing engine nor an excuse to run another
    /// binary: the engine is `unavailable` and does not run.
    #[tokio::test]
    async fn a_lookup_that_never_ran_is_unavailable_not_missing_and_not_the_path_binary() {
        let project = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        write(path_dir.path(), &bin("ruff"), "x");
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        let r = resolve_engines(&Processes::for_tests(), project.path(), opts(&["ruff"], path_dir.path())).await;
        let ruff = &r.engines[0];
        assert!(ruff.unavailable.as_deref().is_some_and(|why| why.contains("could not be looked up")), "{ruff:?}");
        assert_eq!(ruff.source, "unavailable");
        assert!(!ruff.missing && !ruff.runnable() && ruff.command.is_empty());
        assert!(ruff.to_json()["unavailable"].is_string());
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
        let taplo = |r: &Resolution| r.engines.iter().find(|e| e.id == "taplo").unwrap().skipped.clone();
        let unconfigured = resolve_engines(&Processes::for_tests(), project.path(), opts(&["dprint", "taplo"], path_dir.path())).await;
        assert_eq!(taplo(&unconfigured), None, "a dprint with no configuration formats nothing: TOML stays taplo's");
        write(project.path(), "dprint.json", "{}");
        let again = resolve_engines(&Processes::for_tests(), project.path(), opts(&["dprint", "taplo"], path_dir.path())).await;
        assert!(again.engines[0].skipped.is_none() && again.engines[0].config_file.as_deref() == Some("dprint.json"));
        assert_eq!(taplo(&again).as_deref(), Some("project uses dprint"));
        // The same configuration with no dprint installed: nothing would format TOML if taplo stood down.
        let nowhere = tempfile::tempdir().unwrap();
        let absent = resolve_engines(&Processes::for_tests(), project.path(), opts(&["dprint", "taplo"], nowhere.path())).await;
        assert!(absent.engines[0].missing);
        assert_eq!(taplo(&absent), None);
        // A dprint this run can download takes over from a taplo that is missing too, so taplo is
        // not downloaded beside it; one that downloads are refused for takes over from nothing.
        let downloadable = |path: &Path, downloads: &str| {
            let mut options = opts(&["dprint", "taplo"], path);
            options.manifest = Some(json!({"engines": {"dprint": {"version": "1", "assets": {"any": {"url": "https://example.invalid/dprint.zip"}}}}}));
            options.env.as_mut().unwrap().insert("MIXDOG_TIDY_DOWNLOADS".to_owned(), downloads.to_owned());
            options
        };
        assert_eq!(taplo(&resolve_engines(&Processes::for_tests(), project.path(), downloadable(nowhere.path(), "auto")).await).as_deref(), Some("project uses dprint"));
        assert_eq!(taplo(&resolve_engines(&Processes::for_tests(), project.path(), downloadable(nowhere.path(), "never")).await), None);
        // An installed taplo keeps TOML until that dprint is really there: a download still to be
        // approved formats nothing.
        let only_taplo = tempfile::tempdir().unwrap();
        write(only_taplo.path(), &bin("taplo"), "x");
        assert_eq!(taplo(&resolve_engines(&Processes::for_tests(), project.path(), downloadable(only_taplo.path(), "ask")).await), None);
        // A dprint configured to run in a directory of its own is configured by the nearest
        // configuration from there up to the project.
        let nested = tempfile::tempdir().unwrap();
        write(nested.path(), ".mixdog/tidy.json", r#"{"engines":{"dprint":{"cwd":"packages/web/src"}}}"#);
        write(nested.path(), "packages/web/dprint.json", "{}");
        write(nested.path(), "packages/web/src/a.ts", "");
        let in_web = resolve_engines(&Processes::for_tests(), nested.path(), opts(&["dprint", "taplo"], path_dir.path())).await;
        assert_eq!((in_web.engines[0].skipped.clone(), in_web.engines[0].config_file.as_deref()), (None, Some("packages/web/dprint.json")));
        assert_eq!(taplo(&in_web).as_deref(), Some("project uses dprint"));
    }

    /// The stand-down is per language, and only an engine that will run takes anything over.
    #[tokio::test]
    async fn an_engine_stands_down_only_for_the_languages_a_running_project_engine_handles() {
        let project = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        write(path_dir.path(), &bin("biome"), "x");
        write(path_dir.path(), &bin("taplo"), "x");
        write(project.path(), &format!("node_modules/.bin/{}", bin("eslint")), "x");
        write(project.path(), &format!("node_modules/.bin/{}", bin("dprint")), "x");
        let r = resolve_engines(&Processes::for_tests(), project.path(), opts(&["biome", "eslint", "dprint", "taplo"], path_dir.path())).await;
        let by = |id: &str| r.engines.iter().find(|e| e.id == id).unwrap().clone();
        let biome = by("biome");
        assert_eq!((biome.skipped.clone(), biome.languages.clone(), biome.suppressed_by.clone()), (None, vec!["json".to_owned(), "css".to_owned(), "yaml".to_owned()], vec!["eslint".to_owned()]));
        assert_eq!(by("dprint").skipped.as_deref(), Some("no project config for this engine"));
        assert_eq!((by("taplo").skipped, by("taplo").suppressed_by), (None, Vec::<String>::new()), "a project-local dprint with no configuration leaves TOML to taplo");
    }

    /// An entry without `command` keeps the engine resolution finds, with its args after the
    /// catalog prefix and its cwd.
    #[tokio::test]
    async fn an_entry_without_a_command_configures_the_engine_resolution_finds() {
        let project = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        write(path_dir.path(), &bin("dotnet"), "x");
        write(path_dir.path(), &bin("shfmt"), "x");
        std::fs::create_dir_all(project.path().join("web")).unwrap();
        write(project.path(), ".mixdog/tidy.json", r#"{"engines":{"dotnet-format":{"args":["--verbosity","q"],"cwd":"web"},"shfmt":{"args":["-i","2"]}}}"#);
        let r = resolve_engines(&Processes::for_tests(), project.path(), opts(&["dotnet-format", "shfmt"], path_dir.path())).await;
        assert!(r.config.error.is_empty(), "{}", r.config.error);
        let (dotnet, shfmt) = (&r.engines[0], &r.engines[1]);
        assert_eq!((dotnet.source.as_str(), dotnet.args.clone(), dotnet.cwd.clone()), ("path", vec!["format".to_owned(), "--verbosity".to_owned(), "q".to_owned()], Some(project.path().join("web").to_string_lossy().into_owned())));
        assert_eq!((shfmt.source.as_str(), shfmt.args.clone()), ("path", vec!["-i".to_owned(), "2".to_owned()]));
        assert!(shfmt.command.ends_with(&bin("shfmt")));
    }

    /// The engine directory is where the configured path really leads: a link out of the project is
    /// refused, and a link inside it gives the directory's real place.
    #[test]
    fn an_engine_directory_is_placed_where_it_really_is() {
        let (project, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let root = project.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        let link = |target: &Path, name: &str| -> bool {
            #[cfg(windows)]
            return std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(root.join(name)).arg(target).output().is_ok_and(|o| o.status.success());
            #[cfg(unix)]
            return std::os::unix::fs::symlink(target, root.join(name)).is_ok();
        };
        if !link(outside.path(), "out") || !link(&root.join("a").join("b"), "inner") {
            return eprintln!("skipped: cannot create a link here");
        }
        let error = parse_tidy_config(r#"{"engines":{"ruff":{"command":"ruff","cwd":"out"}}}"#, root).err().unwrap_or_default();
        assert!(error.contains("not inside the project"), "{error}");
        let inner = parse_tidy_config(r#"{"engines":{"ruff":{"command":"ruff","cwd":"inner"}}}"#, root).unwrap();
        assert_eq!(inner.engines["ruff"].cwd, Some(root.join("a/b")));
    }

    /// Only no entry at all is an absent config; a link to nothing is one that cannot be read.
    #[test]
    fn a_config_link_to_nothing_is_an_error_not_an_absent_config() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        std::fs::create_dir_all(root.join(".mixdog")).unwrap();
        assert!(read_tidy_config_blocking(root).error.is_empty() && !read_tidy_config_blocking(root).present);
        let gone = root.join("gone");
        #[cfg(windows)]
        let linked = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(root.join(".mixdog/tidy.json")).arg(&gone).output().is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&gone, root.join(".mixdog/tidy.json")).is_ok();
        if !linked {
            return eprintln!("skipped: cannot create a link here");
        }
        let read = read_tidy_config_blocking(root);
        assert!(read.present && read.error.starts_with("cannot read .mixdog/tidy.json"), "{read:?}");
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


/// The directory an engine runs in: its configured `cwd`, else the project. Toolchain proxies
/// (rustup) pick the version by directory, so a probe anywhere else can name another binary.
pub fn engine_dir<'a>(engine: &'a Resolved, project: &'a Path) -> &'a Path {
    engine.cwd.as_deref().map_or(project, Path::new)
}

/// Version of a host-provided managed module (PSScriptAnalyzer under pwsh/powershell), asked in
/// `cwd`. Spawns a PowerShell host, so callers on a polled path must cache it.
pub async fn probe_host_managed_module(processes: &Processes, engine: &Resolved, cwd: &Path, cancel: Option<&CancellationToken>) -> String {
    let Some(version_args) = engine_entry(&engine.id).and_then(|e| e.version_args.clone()) else { return String::new() };
    // The host is asked the way the engine will be run: after the arguments the project configured for it.
    let args: Vec<String> = engine.args.iter().cloned().chain(version_args).collect();
    let mut options = RunOptions::new(cwd);
    options.timeout = VERSION_PROBE_TIMEOUT;
    options.cancel = cancel;
    let result = processes.run(&engine.command, &args, options).await;
    if result.code == 0 && result.error.is_empty() { parse_dotted(&result.stdout) } else { String::new() }
}

/// The engine's own `--version` answer where it will run. A probe that fails has no version: the
/// first number of a usage or error text is not one.
async fn probe_version(processes: &Processes, engine: &Resolved, cwd: &Path, cancel: Option<&CancellationToken>) -> String {
    let defaults = vec!["--version".to_owned()];
    let version_args = engine_entry(&engine.id).and_then(|e| e.version_args.clone()).unwrap_or(defaults);
    let args: Vec<String> = engine.args.iter().cloned().chain(version_args).collect();
    let mut options = RunOptions::new(engine_dir(engine, cwd));
    options.timeout = VERSION_PROBE_TIMEOUT;
    options.cancel = cancel;
    let result = processes.run(&engine.command, &args, options).await;
    if result.code != 0 || !result.error.is_empty() {
        return String::new();
    }
    parse_version_text(&format!("{}\n{}", result.stdout, result.stderr))
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
        let mut r = resolve_one(processes, cwd, entry, &config, options.env.as_ref(), (&manifest, &options.plugin_data), &index).await;
        let runs_in = engine_dir(&r, cwd).to_owned();
        match project_config_file_for(processes.durability(), cwd, &runs_in, entry).await {
            Ok(file) => r.config_file = file,
            Err(why) => {
                r.unavailable.get_or_insert(why);
            }
        }
        if entry.requires_config && r.config_file.is_none() && r.source != "project-config" && r.unavailable.is_none() {
            r.skipped = Some("no project config for this engine".into());
        }
        r.toolchain = entry.toolchain;
        resolved.push(r);
    }
    // A project keeps the engine it chose, and the one that would format the same files stands
    // down: Biome for a Prettier or ESLint in node_modules/.bin, taplo for a configured dprint.
    // Chosen means brought by the project, or run only under the project's own configuration. A
    // chosen engine that runs takes over from every engine it suppresses; a skipped or unavailable
    // one formats nothing, so it takes nothing over. One that is missing but that this run can
    // download takes over only from engines that are missing too: the engine it would replace
    // is not downloaded beside it, and an installed one keeps working until the chosen engine is
    // really there. The stand-down is per language: an engine keeps what no suppressor handles.
    let downloadable = |r: &Resolved| r.missing && r.installable && policy.downloads != "never" && r.skipped.is_none() && r.unavailable.is_none();
    let chosen: Vec<(String, Vec<String>, bool)> = resolved
        .iter()
        .filter(|r| r.runnable() || downloadable(r))
        .filter(|r| matches!(r.source.as_str(), "project-local" | "project-config") || (r.config_file.is_some() && engine_entry(&r.id).is_some_and(|e| e.requires_config)))
        .map(|r| (r.id.clone(), r.languages.clone(), r.runnable()))
        .collect();
    for engine in &mut resolved {
        let Some(entry) = engine_entry(&engine.id) else { continue };
        let suppressors: Vec<&(String, Vec<String>, bool)> = chosen.iter().filter(|(id, _, runs)| entry.suppressed_by.contains(id) && (*runs || engine.missing)).collect();
        // A missing engine is suppressed too: installing it would only have it skipped.
        if suppressors.is_empty() || engine.unavailable.is_some() {
            continue;
        }
        let names: Vec<String> = suppressors.iter().map(|(id, _, _)| id.clone()).collect();
        let kept: Vec<String> = engine.languages.iter().filter(|l| !suppressors.iter().any(|(_, langs, _)| langs.contains(l))).cloned().collect();
        if kept.is_empty() {
            engine.skipped = Some(format!("project uses {}", names.join(" + ")));
        } else {
            engine.languages = kept;
        }
        engine.suppressed_by = names;
    }
    refine_managed_modules(processes, cwd, &mut resolved, options.host_module_probe.as_ref(), options.cancel.as_ref()).await;
    if options.probe_versions {
        let cancel = options.cancel.clone();
        let runnable: Vec<(usize, Resolved)> = resolved.iter().cloned().enumerate().filter(|(_, e)| !e.missing && !e.command.is_empty()).collect();
        let versions = map_limit(runnable.clone(), 4, |(_, e)| {
            let cancel = cancel.clone();
            async move { if e.version.is_empty() { probe_version(processes, &e, cwd, cancel.as_ref()).await } else { e.version.clone() } }
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
async fn refine_managed_modules(processes: &Processes, cwd: &Path, engines: &mut [Resolved], probe: Option<&HostModuleProbe>, cancel: Option<&CancellationToken>) {
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
                None => probe_host_managed_module(processes, &e, engine_dir(&e, cwd), cancel.as_ref()).await,
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
