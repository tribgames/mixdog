//! The services of `mixdog-services` this composition builds: `localProvider`, `tidy`, `media`,
//! `import`, `voice`, and the tool-module host that reads the first two and the models.

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::DomainService;
use mixdog_core_base::support::on_lane;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLocalProviderSettings;
use mixdog_core_config::config::ConfigVoiceEnabled;
use mixdog_core_config::config::ConfigVoiceSettings;
use mixdog_core_config::tool_modules::HostParts;
use mixdog_core_config::tool_modules::ServicesToolModulesHost;
use mixdog_exthost::ExtImageCodec;
use mixdog_rt::TaskClass;
use mixdog_services::effort_judge::install::Manifest;
use mixdog_services::import::Discovery;
use mixdog_services::import::Env;
use mixdog_services::import::ImportJobs;
use mixdog_services::import::ImportService;
use mixdog_services::import::ImportSessions;
use mixdog_services::import::Limits;
use mixdog_services::local_provider::LocalProvider;
use mixdog_services::local_provider::LocalProviderService;
use mixdog_services::local_provider::Parts;
use mixdog_services::local_provider::assets::ReqwestFetcher;
use mixdog_services::local_provider::hugging_face::ReqwestHf;
use mixdog_services::local_provider::request_queue::local_idle_ttl_seconds;
use mixdog_services::local_provider::server_process::LoopbackHealth;
use mixdog_services::local_provider::server_process::SystemLauncher;
use mixdog_services::local_provider::server_process::Timing;
use mixdog_services::media::MediaAssetSource;
use mixdog_services::media::MediaGenerator;
use mixdog_services::media::MediaJobs;
use mixdog_services::media::MediaService;
use mixdog_services::media::MediaStore;
use mixdog_services::media::StillRenditions;
use mixdog_services::tidy::InstallJob;
use mixdog_services::tidy::TidyService;
use mixdog_services::tidy::core_install::SystemEngineResolver;
use mixdog_services::voice::ProcessAudioTools;
use mixdog_services::voice::RuntimeManifest;
use mixdog_services::voice::VoiceInstaller;
use mixdog_services::voice::VoicePipeline;
use mixdog_services::voice::VoiceService;
use mixdog_services::voice::VoiceSetup;
use mixdog_services::voice::WhisperServer;
use mixdog_workspace::transfer::TransferSource;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::ComposeDomainsError;
use super::DomainInputs;
use super::EnvReader;
use super::adapters::CatalogRefresh;

/// Owed by other work packages: each is a service that has no real implementation yet.
pub struct LocalSeams {
    /// The session layer's import of a converted conversation (WP-SESSION).
    pub import_sessions: Arc<dyn ImportSessions>,
    /// Media generation by lane: xai, codex, image-api, antigravity, gemini (WP-SVC-MISC).
    pub media_generator: Arc<dyn MediaGenerator>,
    /// The voice runtime download: whisper, model, ffmpeg (WP-SVC-MISC).
    pub voice_installer: Arc<dyn VoiceInstaller>,
}

pub(super) struct Local {
    pub services: Vec<Arc<dyn DomainService>>,
    pub transfer_sources: Vec<Arc<dyn TransferSource>>,
    pub tool_modules_host: Arc<ServicesToolModulesHost>,
    pub provider: Arc<LocalProvider>,
}

/// `Math.max(1, Number(process.env.MIXDOG_MEDIA_MAX_ACTIVE_JOBS) || 4)`: a count of `a` running
/// jobs is refused when `a >= limit`, so a fractional limit rounds up. `None` is the default 4.
fn media_max_active(env: &EnvReader) -> Option<usize> {
    let number = mixdog_js::string_to_number(&env("MIXDOG_MEDIA_MAX_ACTIVE_JOBS")?);
    if number.is_nan() || number == 0.0 {
        return None;
    }
    Some(number.max(1.0).ceil() as usize)
}

/// `agent.providers['mixdog-local'].idleTtlSeconds` as Node's `configureLocalProviderIdleTtl` reads
/// it: absent is the default; anything but an integer from 0 to 86400 is a `TypeError`.
fn idle_ttl(config: &Config) -> Result<Option<u64>, ComposeDomainsError> {
    let agent = config.agent();
    let Some(value) = agent.get("providers").and_then(|p| p.get("mixdog-local")).and_then(|l| l.get("idleTtlSeconds")) else {
        return Ok(None);
    };
    let integer = value.as_i64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64));
    integer
        .and_then(|seconds| local_idle_ttl_seconds(seconds).ok())
        .map(Some)
        .ok_or_else(|| ComposeDomainsError::Build("idleTtlSeconds must be an integer from 0 (disabled) to 86400.".into()))
}

/// The bundled voice manifest for this host (`voice-runtime-manifest.json`, platform key
/// `<os>-<arch>`, model `standard`).
#[allow(clippy::disallowed_methods, reason = "runs as an interactive-io lane job")]
async fn voice_manifest(inputs: &DomainInputs) -> Result<RuntimeManifest, ComposeDomainsError> {
    let path = inputs.paths.package_root.join("src").join("runtime").join("channels").join("data").join("voice-runtime-manifest.json");
    let shown = path.display().to_string();
    let text = on_lane(inputs.tokens.interactive_io, &CancellationToken::new(), move |_lane| std::fs::read_to_string(path))
        .await
        .map_err(|error| ComposeDomainsError::Build(format!("reading {shown}: {error:?}")))?
        .map_err(|error| ComposeDomainsError::Build(format!("reading {shown}: {error}")))?;
    let manifest: Value =
        serde_json::from_str(&text).map_err(|error| ComposeDomainsError::Build(format!("{shown} is not valid: {error}")))?;
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    RuntimeManifest::from_json(&manifest, &format!("{os}-{arch}"), "standard")
        .ok_or_else(|| ComposeDomainsError::Build(format!("{shown} names no voice runtime")))
}

pub(super) async fn build(inputs: &DomainInputs, config: &Config) -> Result<Local, ComposeDomainsError> {
    let tokens = &inputs.tokens;
    let data_dir: &Path = &inputs.paths.data_dir;
    let processes = inputs.processes.clone();
    let seams = &inputs.seams.local;
    let mut services: Vec<Arc<dyn DomainService>> = Vec::new();
    let mut transfer_sources: Vec<Arc<dyn TransferSource>> = Vec::new();

    let provider = LocalProvider::new(Parts {
        data_dir: data_dir.to_owned(),
        fetcher: Arc::new(ReqwestFetcher::default()),
        processes: processes.clone(),
        hf_http: Box::new(ReqwestHf::default()),
        launcher: Arc::new(SystemLauncher::new(&processes)),
        health: Arc::new(LoopbackHealth::default()),
        timing: Timing::default(),
        idle_ttl_seconds: idle_ttl(config)?,
        platform_key: None,
    });
    // `setConfig` re-applies the idle TTL on every adopted config.
    let (watched, synced, stop) = (config.clone(), provider.clone(), inputs.cancel.clone());
    let mut changes = watched.changes();
    mixdog_rt::spawn("local-provider-idle-ttl", TaskClass::Work, async move {
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                changed = changes.changed() => if changed.is_err() { return },
            }
            if let Ok(Some(seconds)) = idle_ttl(&watched) {
                synced.queue.configure(seconds);
            }
        }
    });
    let settings = Arc::new(ConfigLocalProviderSettings::new(config.clone(), Arc::new(CatalogRefresh::new(inputs.catalog.clone()))));
    let local_service = Arc::new(LocalProviderService::new(provider.clone(), settings));
    services.push(local_service.clone());

    let tidy_job = Arc::new(InstallJob::default());
    let resolver = Arc::new(SystemEngineResolver::new(processes.clone(), data_dir, None, None));
    services.push(Arc::new(TidyService::new(resolver, tidy_job.clone())));

    let judge_manifest = Manifest::bundled().map_err(|error| ComposeDomainsError::Build(error.to_string()))?;
    let command_error = local_service.clone();
    let tool_modules_host = ServicesToolModulesHost::new(
        HostParts {
            local_provider: provider.clone(),
            installation_command_error: Arc::new(move || command_error.installation_command_error()),
            embedder: inputs.models.embeddings.clone(),
            judge: inputs.models.effort_judge.clone(),
            judge_manifest,
            tick: inputs.models.tick.clone(),
            plugin_data: data_dir.to_owned(),
            tidy_job,
            processes: processes.clone(),
            fetcher: Arc::new(ReqwestFetcher::default()),
            effects: inputs.seams.feature_effects.clone(),
            read_lane: tokens.interactive_io,
        },
        inputs.cancel.clone(),
    );

    let store = Arc::new(MediaStore::new(data_dir, tokens.durability_io));
    let renditions = StillRenditions::new(Arc::new(ExtImageCodec::new(inputs.ext_host.clone())), tokens.durability_io, store.renditions_dir());
    let jobs = MediaJobs::with_renditions(store.clone(), seams.media_generator.clone(), media_max_active(&inputs.env), renditions.clone());
    services.push(Arc::new(MediaService::new(store.clone(), jobs, processes.clone(), renditions)));
    transfer_sources.push(Arc::new(MediaAssetSource::new(store)));

    let discovery = Discovery::new(Env::from_process(), tokens.maintenance_io);
    let jobs = ImportJobs::new(discovery.clone(), seams.import_sessions.clone(), Limits::default());
    services.push(Arc::new(ImportService::new(discovery, jobs, Limits::default())));

    let manifest = voice_manifest(inputs).await?;
    let pipeline = Arc::new(VoicePipeline::new(
        data_dir.to_owned(),
        manifest,
        Arc::new(ConfigVoiceSettings::new(config.clone())),
        Arc::new(WhisperServer::with_defaults(&processes)),
        Arc::new(ProcessAudioTools(processes)),
        tokens.durability_io,
    ));
    let setup = Arc::new(VoiceSetup::new(pipeline.clone(), Arc::new(ConfigVoiceEnabled::new(config.clone())), seams.voice_installer.clone()));
    services.push(Arc::new(VoiceService::new(pipeline, setup)));

    Ok(Local { services, transfer_sources, tool_modules_host, provider })
}
