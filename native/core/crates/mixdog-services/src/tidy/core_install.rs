//! Code Tidy's one-click install and the real engine resolver behind the status card.
//!
//! The CORE set is what "Install" provisions: the managed engines that cover the languages tidy
//! is expected to clean up out of the box. Everything else stays demand-driven (the `tidy` tool
//! installs per project) or belongs to a language toolchain the user owns. Only
//! [`run_core_install`] touches the network, through `install`. Status is a pure resolution against
//! the manifest, PATH and the managed tools dir.

// The unchanged module-cache record, named without adding a wrapper or changing ownership.
type HostModules = HashMap<String, (String, Option<Instant>, bool)>;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::lane::on_lane;

use super::catalog::{engine_entry, engines};
use super::install::{OnProgress, install_engines, managed_engine_dir, managed_tools_dir, manifest_asset, read_engines_manifest};
use super::install_job::{InstallJob, TIDY_CORE_ENGINE_IDS};
use super::process::{Processes, which};
use super::resolve::{HostModuleProbe, ResolveOptions, Resolved, probe_host_managed_module, resolve_engines};
use super::status::{EngineResolver, ResolvedEngine, ResolvedSource};
use crate::local_provider::assets::Fetcher;

const HOST_MODULE_PROBE_TTL: Duration = Duration::from_secs(60);

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
fn dir_bytes(dir: &Path) -> i64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_bytes(&e.path()),
            Ok(m) => m.len() as i64,
            Err(_) => 0,
        })
        .sum()
}

/// On-disk size of one installed managed engine version, 0 when absent.
pub async fn managed_engine_bytes(lane: DurabilityIo, plugin_data: &Path, id: &str, version: &str) -> i64 {
    if plugin_data.as_os_str().is_empty() || version.is_empty() {
        return 0;
    }
    let dir = managed_engine_dir(plugin_data, id, version);
    on_lane(lane, move || existing_dir_bytes(&dir)).await.unwrap_or(0)
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn existing_dir_bytes(dir: &Path) -> i64 {
    if dir.exists() { dir_bytes(dir) } else { 0 }
}

/// PSScriptAnalyzer is a PowerShell module: without a host there is nothing to install it into.
async fn power_shell_host(lane: DurabilityIo, env: Option<&HashMap<String, String>>) -> bool {
    let env = env.cloned();
    on_lane(lane, move || {
        engine_entry("psscriptanalyzer").is_some_and(|e| std::iter::once(&e.bin).chain(e.alt_bins.iter()).any(|n| which(n, env.as_ref(), None).is_some()))
    })
    .await
    .unwrap_or(false)
}

async fn core_installable(lane: DurabilityIo, id: &str, manifest: &Value, env: Option<&HashMap<String, String>>) -> bool {
    TIDY_CORE_ENGINE_IDS.contains(&id) && manifest_asset(manifest, id).is_some() && (id != "psscriptanalyzer" || power_shell_host(lane, env).await)
}

/// The engine resolver behind the status card: project-free resolution against the manifest,
/// PATH and the managed tools dir. The PowerShell module probe needs a host (~700ms), so a poll
/// never waits for it: the cached value is served and refreshed in the background once stale.
pub struct SystemEngineResolver {
    processes: Processes,
    plugin_data: PathBuf,
    manifest: Value,
    env: Option<HashMap<String, String>>,
    host_modules: Arc<Mutex<HostModules>>,
}

#[async_trait]
impl EngineResolver for SystemEngineResolver {
    fn tools_dir(&self) -> String {
        if self.plugin_data.as_os_str().is_empty() { String::new() } else { managed_tools_dir(&self.plugin_data).to_string_lossy().into_owned() }
    }

    async fn resolve_all(&self) -> Vec<ResolvedEngine> {
        let resolution = resolve_engines(
            &self.processes,
            &self.scope(),
            ResolveOptions {
                engine_ids: engines().iter().map(|e| e.id.clone()).collect(),
                plugin_data: self.plugin_data.clone(),
                manifest: Some(self.manifest.clone()),
                env: self.env.clone(),
                probe_versions: false,
                host_module_probe: Some(self.cached_probe()),
                ..Default::default()
            },
        )
        .await;
        let mut out = Vec::with_capacity(resolution.engines.len());
        for e in &resolution.engines {
            let catalog = engine_entry(&e.id);
            let source = match e.source.as_str() {
                "managed" => ResolvedSource::Managed,
                // A lookup that never ran: pending (`probing`), neither installed nor missing.
                "missing" | "unavailable" => ResolvedSource::Missing,
                _ => ResolvedSource::Host,
            };
            // The host probe has not answered: pending, neither installed nor missing.
            let probing = e.unavailable.is_some()
                || (catalog.is_some_and(|c| c.managed_module)
                    && source == ResolvedSource::Missing
                    && !e.command.is_empty()
                    && !self.host_module_probed(&e.command));
            out.push(ResolvedEngine {
                id: e.id.clone(),
                source,
                version: e.version.clone(),
                install_hint: Some(e.install_hint.clone()).filter(|h| !h.is_empty()),
                probing,
                installable: source == ResolvedSource::Missing
                    && !probing
                    && core_installable(self.processes.durability(), &e.id, &self.manifest, self.env.as_ref()).await,
                bytes: if source == ResolvedSource::Managed {
                    managed_engine_bytes(self.processes.durability(), &self.plugin_data, &e.id, &e.version).await.max(0) as u64
                } else {
                    0
                },
            });
        }
        out
    }
}

fn engine_result(e: &super::install_job::EngineProgress) -> Value {
    let mut v = json!({"id": e.id, "version": e.version, "status": e.status, "bytes": e.bytes});
    if let Some(err) = &e.error {
        v["error"] = json!(err);
    }
    if let Some(h) = &e.install_hint {
        v["installHint"] = json!(h);
    }
    v
}

pub struct CoreInstall<'a> {
    pub processes: Processes,
    pub plugin_data: &'a Path,
    pub manifest: Option<Value>,
    pub env: Option<HashMap<String, String>>,
    pub fetcher: &'a dyn Fetcher,
    pub cancel: CancellationToken,
    /// A retry for named engines installs just those; the default is the set.
    pub only: Option<Vec<String>>,
}

struct FinishInstall<'a>(&'a InstallJob);

impl Drop for FinishInstall<'_> {
    fn drop(&mut self) {
        self.0.finish();
    }
}

fn wanted_engines(only: Option<&[String]>) -> Result<Vec<&'static str>, String> {
    let Some(only) = only else { return Ok(TIDY_CORE_ENGINE_IDS.to_vec()) };
    if let Some(id) = only.iter().find(|id| !TIDY_CORE_ENGINE_IDS.contains(&id.as_str())) {
        return Err(format!("Unknown Code Tidy core engine ID: {id:?}."));
    }
    Ok(TIDY_CORE_ENGINE_IDS.iter().copied().filter(|id| only.iter().any(|o| o == id)).collect())
}

/// Settles the engines that are already present or cannot be installed here; the rest are returned for installation.
async fn settle_without_install(job: &InstallJob, options: &CoreInstall<'_>, manifest: &Value, wanted: &[&str]) -> Vec<String> {
    let resolver = SystemEngineResolver::new(options.processes.clone(), options.plugin_data, Some(manifest.clone()), options.env.clone());
    let resolved = resolve_engines(
        &options.processes,
        &resolver.scope(),
        ResolveOptions {
            engine_ids: wanted.iter().map(|s| (*s).to_owned()).collect(),
            plugin_data: options.plugin_data.to_owned(),
            manifest: Some(manifest.clone()),
            env: options.env.clone(),
            probe_versions: false,
            cancel: Some(options.cancel.clone()),
            ..Default::default()
        },
    )
    .await;
    let mut pending: Vec<String> = Vec::new();
    for id in wanted {
        let catalog = engine_entry(id).expect("core ids are catalog ids");
        let engine = resolved.engines.iter().find(|e| e.id == *id);
        if *id == "psscriptanalyzer" && !power_shell_host(options.processes.durability(), options.env.as_ref()).await {
            let hint = if catalog.host_install_hint.is_empty() { catalog.install_hint.clone() } else { catalog.host_install_hint.clone() };
            job.settle(id, |e| {
                e.status = "skipped".into();
                e.install_hint = Some(hint);
            });
            continue;
        }
        if let Some(engine) = engine.filter(|e| !e.missing) {
            let bytes = if engine.source == "managed" {
                managed_engine_bytes(options.processes.durability(), options.plugin_data, id, &engine.version).await
            } else {
                0
            };
            let version = engine.version.clone();
            job.settle(id, |e| {
                e.status = "present".into();
                e.version = version;
                e.bytes = bytes as u64;
            });
            continue;
        }
        if manifest_asset(manifest, id).is_none() {
            let hint = catalog.install_hint.clone();
            job.settle(id, |e| {
                e.status = "skipped".into();
                e.install_hint = Some(hint);
            });
            continue;
        }
        pending.push((*id).to_owned());
    }
    pending
}

/// An explicit Install is the approval: policy gating exists for the model-driven tool path, not for a button the user just pressed.
async fn install_pending(job: &Arc<InstallJob>, options: &CoreInstall<'_>, manifest: &Value, wanted: &[&str], pending: &[String]) {
    let progress: OnProgress = {
        let shared = job.clone();
        Arc::new(move |id, received, total| shared.track_download(id, received.max(0) as u64, total.max(0) as u64))
    };
    let outcome =
        install_engines(&options.processes, pending, Some(manifest), options.plugin_data, "auto", true, options.fetcher, &options.cancel, Some(progress), None)
            .await;
    for item in outcome["installed"].as_array().into_iter().flatten() {
        let id = item["id"].as_str().unwrap_or("");
        let version = item["version"].as_str().unwrap_or("").to_owned();
        let present = item["status"] == "present";
        let bytes = managed_engine_bytes(options.processes.durability(), options.plugin_data, id, &version).await as u64;
        job.settle(id, |e| {
            e.status = if present { "present" } else { "installed" }.into();
            e.version = version;
            e.bytes = bytes;
        });
    }
    for failure in outcome["errors"].as_array().into_iter().flatten() {
        let error = failure["error"].as_str().unwrap_or("install failed").to_owned();
        let hint = failure["installHint"].as_str().map(str::to_owned);
        let failed_id = failure["id"].as_str().unwrap_or("");
        // The installer reports set-wide problems (no data dir) as id '*'.
        let targets: Vec<String> = if wanted.contains(&failed_id) { vec![failed_id.to_owned()] } else { job.pending_ids() };
        for id in targets {
            let (error, hint) = (error.clone(), hint.clone());
            job.settle(&id, |e| {
                e.status = "failed".into();
                e.error = Some(error);
                e.install_hint = hint;
            });
        }
    }
}

/// Installs the requested core engines and returns their settled results. An invalid request
/// starts no job; per-engine failures do not fail a valid request. Overlapping requests wait
/// their turn; `job` shows the active set.
pub async fn run_core_install(job: &Arc<InstallJob>, options: CoreInstall<'_>) -> Result<Value, String> {
    const CANCELLED: &str = "Code Tidy installation canceled.";
    let wanted = wanted_engines(options.only.as_deref())?;
    let _turn = tokio::select! {
        biased;
        () = options.cancel.cancelled() => return Err(CANCELLED.into()),
        turn = job.install_turn() => turn,
    };
    let manifest = options.manifest.clone().unwrap_or_else(read_engines_manifest);
    let tools_dir =
        if options.plugin_data.as_os_str().is_empty() { String::new() } else { managed_tools_dir(options.plugin_data).to_string_lossy().into_owned() };
    assert!(job.begin(&wanted), "the install turn owns the progress slot");
    // Settle the slot even if the caller drops the future; release the turn only after cleanup.
    let finish = FinishInstall(job);
    let pending = settle_without_install(job, &options, &manifest, &wanted).await;
    if !pending.is_empty() {
        install_pending(job, &options, &manifest, &wanted, &pending).await;
    }
    drop(finish);
    if options.cancel.is_cancelled() {
        return Err(CANCELLED.into());
    }
    Ok(json!({"toolsDir": tools_dir, "engines": job.snapshot_results().iter().map(engine_result).collect::<Vec<_>>()}))
}

impl SystemEngineResolver {
    pub fn new(processes: Processes, plugin_data: &Path, manifest: Option<Value>, env: Option<HashMap<String, String>>) -> Self {
        Self { processes, plugin_data: plugin_data.to_owned(), manifest: manifest.unwrap_or_else(read_engines_manifest), env, host_modules: Arc::default() }
    }

    /// Status/install resolution is project-free: the managed tools dir holds no config,
    /// node_modules or virtualenv, so resolution sees exactly manifest, PATH and managed installs.
    fn scope(&self) -> PathBuf {
        if self.plugin_data.as_os_str().is_empty() { std::env::temp_dir().join("mixdog-tidy-status") } else { managed_tools_dir(&self.plugin_data) }
    }

    fn cached_probe(&self) -> HostModuleProbe {
        let cache = self.host_modules.clone();
        let processes = self.processes.clone();
        Arc::new(move |engine: Resolved| {
            let cache = cache.clone();
            let processes = processes.clone();
            Box::pin(async move {
                let key = engine.command.clone();
                if key.is_empty() {
                    return String::new();
                }
                let (version, stale) = {
                    let mut c = cache.lock().unwrap();
                    let entry = c.entry(key.clone()).or_insert_with(|| (String::new(), None, false));
                    let stale = entry.1.is_none_or(|at| at.elapsed() >= HOST_MODULE_PROBE_TTL) && !entry.2;
                    if stale {
                        entry.2 = true;
                    }
                    (entry.0.clone(), stale)
                };
                if stale {
                    // The caller's request is long gone by then; publish for the next poll.
                    tokio::spawn(async move {
                        // The status card is project-free: the module answers the same anywhere.
                        let here = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
                        let version = probe_host_managed_module(&processes, &engine, &here, None).await;
                        cache.lock().unwrap().insert(key, (version, Some(Instant::now()), false));
                    });
                }
                version
            })
        })
    }

    fn host_module_probed(&self, command: &str) -> bool {
        self.host_modules.lock().unwrap().get(command).is_some_and(|e| e.1.is_some())
    }
}

#[cfg(test)]
mod tests {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    use async_trait::async_trait;
    use sha2::{Digest, Sha256};
    use tokio::sync::Semaphore;

    use super::*;
    use crate::local_provider::assets::{Body, Fetched};

    struct Chunks(Vec<Vec<u8>>);
    #[async_trait]
    impl Body for Chunks {
        async fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
            Ok(if self.0.is_empty() { None } else { Some(self.0.remove(0)) })
        }
    }

    struct ByUrl(HashMap<String, Vec<u8>>);
    #[async_trait]
    impl Fetcher for ByUrl {
        async fn get(&self, url: &str, _: i64) -> Result<Fetched, String> {
            let body = self.0.get(url).cloned().ok_or_else(|| "404".to_owned())?;
            Ok(Fetched {
                status: 200,
                content_length: Some(body.len() as i64),
                https: true,
                body: Box::new(Chunks(body.chunks(4).map(<[u8]>::to_vec).collect())),
            })
        }
    }

    fn hex(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    fn asset(url: &str, content: &[u8]) -> Value {
        json!({"url": url, "sha256": hex(content), "archive": "none", "binPath": "tool-bin"})
    }

    #[tokio::test]
    async fn the_core_install_settles_every_engine_and_never_stops_at_one_failure() {
        let data = tempfile::tempdir().unwrap();
        let empty_path = tempfile::tempdir().unwrap();
        let env = HashMap::from([("PATH".to_owned(), empty_path.path().to_string_lossy().into_owned())]);
        let manifest = json!({"engines": {
            "biome": {"version": "1.0.0", "assets": {"any": asset("https://x/biome", b"biome-bin")}},
            "ruff": {"version": "1.0.0", "assets": {"any": asset("https://x/ruff", b"expected")}},
        }});
        // ruff's bytes differ from its pinned digest; shfmt/shellcheck have no asset; PowerShell is absent.
        let fetcher = ByUrl(HashMap::from([("https://x/biome".to_owned(), b"biome-bin".to_vec()), ("https://x/ruff".to_owned(), b"tampered".to_vec())]));
        let job = Arc::new(InstallJob::default());
        let out = run_core_install(
            &job,
            CoreInstall {
                processes: Processes::for_tests(),
                plugin_data: data.path(),
                manifest: Some(manifest),
                env: Some(env),
                fetcher: &fetcher,
                cancel: CancellationToken::new(),
                only: None,
            },
        )
        .await
        .unwrap();
        let status_of = |id: &str| out["engines"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap()["status"].as_str().unwrap().to_owned();
        assert_eq!(status_of("biome"), "installed");
        assert_eq!(status_of("ruff"), "failed");
        assert_eq!(
            (status_of("shfmt"), status_of("shellcheck"), status_of("psscriptanalyzer")),
            ("skipped".to_owned(), "skipped".to_owned(), "skipped".to_owned())
        );
        let live = job.status();
        assert_eq!((live["active"].clone(), live["percent"].clone()), (json!(false), json!(100)));
        assert!(managed_engine_dir(data.path(), "biome", "1.0.0").join("tool-bin").exists());
    }

    #[tokio::test]
    async fn a_mixed_request_with_an_unknown_engine_is_rejected_before_progress_starts() {
        let job = Arc::new(InstallJob::default());
        let error = run_core_install(
            &job,
            CoreInstall {
                processes: Processes::for_tests(),
                plugin_data: Path::new(""),
                manifest: Some(json!({"engines": {}})),
                env: Some(HashMap::from([("PATH".to_owned(), String::new())])),
                fetcher: &ByUrl(HashMap::new()),
                cancel: CancellationToken::new(),
                only: Some(vec!["biome".into(), "not-an-engine".into()]),
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("not-an-engine"));
        assert!(job.status().is_null());
    }

    #[tokio::test]
    async fn overlapping_core_installs_wait_and_return_their_own_engine_set() {
        struct HeldFetch {
            entered: Semaphore,
            release: Semaphore,
            inner: ByUrl,
        }

        #[async_trait]
        impl Fetcher for HeldFetch {
            async fn get(&self, url: &str, timeout: i64) -> Result<Fetched, String> {
                if url == "https://x/biome" {
                    self.entered.add_permits(1);
                    self.release.acquire().await.unwrap().forget();
                }
                self.inner.get(url, timeout).await
            }
        }

        let data = tempfile::tempdir().unwrap();
        let env = HashMap::from([("PATH".to_owned(), data.path().to_string_lossy().into_owned())]);
        let manifest = json!({"engines": {
            "biome": {"version": "1.0.0", "assets": {"any": asset("https://x/biome", b"biome-bin")}},
            "ruff": {"version": "1.0.0", "assets": {"any": asset("https://x/ruff", b"ruff-bin")}},
        }});
        let fetcher = HeldFetch {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            inner: ByUrl(HashMap::from([("https://x/biome".to_owned(), b"biome-bin".to_vec()), ("https://x/ruff".to_owned(), b"ruff-bin".to_vec())])),
        };
        let job = Arc::new(InstallJob::default());
        let options = |id: &str| CoreInstall {
            processes: Processes::for_tests(),
            plugin_data: data.path(),
            manifest: Some(manifest.clone()),
            env: Some(env.clone()),
            fetcher: &fetcher,
            cancel: CancellationToken::new(),
            only: Some(vec![id.to_owned()]),
        };
        let first = run_core_install(&job, options("biome"));
        let second = async {
            fetcher.entered.acquire().await.unwrap().forget();
            let mut request = std::pin::pin!(run_core_install(&job, options("ruff")));
            poll_fn(|cx| {
                assert!(request.as_mut().poll(cx).is_pending(), "the queued request must not report completion");
                Poll::Ready(())
            })
            .await;
            let active = job.status();
            assert_eq!(active["active"], true);
            assert_eq!(active["engines"][0]["id"], "biome");
            fetcher.release.add_permits(1);
            request.await
        };

        let (first, second) = tokio::join!(first, second);
        for (outcome, id) in [(first, "biome"), (second, "ruff")] {
            let outcome = outcome.unwrap();
            let engines = outcome["engines"].as_array().unwrap();
            assert_eq!(engines.len(), 1);
            assert_eq!(engines[0]["id"], id);
            assert_eq!(engines[0]["status"], "installed");
        }
    }

    #[tokio::test]
    async fn the_status_resolver_reports_managed_installs_and_installable_gaps() {
        let data = tempfile::tempdir().unwrap();
        let empty_path = tempfile::tempdir().unwrap();
        let env = HashMap::from([("PATH".to_owned(), empty_path.path().to_string_lossy().into_owned())]);
        let manifest = json!({"engines": {"biome": {"version": "1.0.0", "assets": {"any": asset("https://x/b", b"bin")}}, "ruff": {"version": "2.0.0", "assets": {"any": asset("https://x/r", b"r")}}}});
        let dir = managed_engine_dir(data.path(), "biome", "1.0.0");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tool-bin"), b"bin").unwrap();
        let resolver = SystemEngineResolver::new(Processes::for_tests(), data.path(), Some(manifest), Some(env));
        let all = resolver.resolve_all().await;
        let by = |id: &str| all.iter().find(|e| e.id == id).unwrap();
        assert_eq!((by("biome").source, by("biome").version.as_str(), by("biome").bytes > 0), (ResolvedSource::Managed, "1.0.0", true));
        assert!(by("ruff").installable && by("ruff").source == ResolvedSource::Missing);
        assert!(!by("rustfmt").installable, "toolchain engines are never installable");
        assert_eq!(all.len(), engines().len());
        assert!(resolver.tools_dir().ends_with("tools"));
    }
}
