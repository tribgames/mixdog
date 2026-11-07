//! The services of `mixdog-services` this composition builds: `localProvider`, `tidy`, `media`,
//! `import`, `voice`, and the tool-module host that reads the first two and the models.

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::DomainService;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLocalProviderSettings;
use mixdog_core_config::config::ConfigVoiceEnabled;
use mixdog_core_config::config::ConfigVoiceSettings;
use mixdog_core_config::tool_modules::HostParts;
use mixdog_core_config::tool_modules::ServicesToolModulesHost;
use mixdog_core_agents::setup::SetupVoice;
use crate::domain_seams::media_status::MediaStatus;
use mixdog_exthost::ExtImageCodec;
use mixdog_rt::TaskClass;
use mixdog_services::effort_judge::install::Manifest;
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
use mixdog_services::media::MediaUsageLedger;
use mixdog_services::media::MediaService;
use mixdog_services::media::MediaStore;
use mixdog_services::media::StillRenditions;
use mixdog_services::tidy::InstallJob;
use mixdog_services::tidy::TidyService;
use mixdog_services::tidy::core_install::SystemEngineResolver;
use mixdog_services::voice::ProcessAudioTools;
use mixdog_services::voice::ProgressHints;
use mixdog_services::voice::RuntimeManifest;
use mixdog_services::voice::VoiceInstaller;
use mixdog_services::voice::VoicePipeline;
use mixdog_services::voice::VoiceService;
use mixdog_services::voice::VoiceSetup;
use mixdog_services::voice::WhisperServer;
use mixdog_services::voice::setup_action::voice_toggle_answer;
use mixdog_tools::orch::util::PortError;
use mixdog_workspace::transfer::TransferSource;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::ComposeDomainsError;
use super::DomainInputs;
use super::EnvReader;
use super::adapters::CatalogRefresh;

/// Owed by other work packages: each is a service that has no real implementation yet.
pub struct LocalSeams {
    /// Media generation by lane: xai, codex, image-api, antigravity, gemini (WP-SVC-MISC).
    pub media_generator: Arc<dyn MediaGenerator>,
    /// Where each generation is billed: one usage row per generation (WP-SVC-MISC QueuedLedger over the usage queue and the pricing catalog).
    pub media_ledger: Arc<dyn MediaUsageLedger>,
    /// Each thread's hint line, for the voice install's progress (`ThreadProgressHints`).
    pub voice_progress: Arc<dyn ProgressHints>,
    /// The voice runtime download: whisper, model, ffmpeg (WP-SVC-MISC).
    pub voice_installer: Arc<dyn VoiceInstaller>,
}

/// `rt.setVoiceEnabled` for the setup tool's `set_builtin_enabled` / `install_builtin` of `voice`: the
/// toggle the Built-in card uses, answered as `{ status, error }` (the dispatcher judges the state).
pub struct VoiceToggle(pub Arc<VoiceSetup>);

#[async_trait::async_trait]
impl SetupVoice for VoiceToggle {
    async fn set_enabled(&self, enabled: bool) -> Result<Value, PortError> {
        Ok(voice_toggle_answer(&self.0, enabled).await)
    }
}

pub(super) struct Local {
    /// The media domain of the setup tool's status: compose_domains registers it with the status readers.
    pub media_status: Arc<MediaStatus>,
    /// The voice toggle the setup tool drives: the root passes `VoiceToggle(local.voice_setup)` as its `SetupVoice`.
    pub voice_setup: Arc<VoiceSetup>,
    /// The one media job table and store the media domain service holds: the `media` tool's `StudioGraph` takes the same two.
    pub media_jobs: Arc<MediaJobs>,
    pub media_store: Arc<MediaStore>,
    pub services: Vec<Arc<dyn DomainService>>,
    pub transfer_sources: Vec<Arc<dyn TransferSource>>,
    pub tool_modules_host: Arc<ServicesToolModulesHost>,
    pub service: Arc<LocalProviderService>,
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
fn voice_manifest(inputs: &DomainInputs) -> Result<RuntimeManifest, ComposeDomainsError> {
    let manifest: &Value = &inputs.voice_manifest;
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    RuntimeManifest::from_json(manifest, &format!("{os}-{arch}"), "standard")
        .ok_or_else(|| ComposeDomainsError::Build("voice-runtime-manifest.json names no voice runtime".to_owned()))
}

/// The process's one managed local provider. It needs only the data folder, the process manager, the
/// config and the stop token, so the composition builds it before `ProcessServices` (which the provider
/// registry, the effects and then `compose_domains` follow) and hands it to `compose_domains` as
/// `DomainInputs.local_provider`.
pub fn build_local_provider(
    data_dir: &Path,
    processes: &mixdog_services::tidy::process::Processes,
    config: &Config,
    cancel: &CancellationToken,
) -> Result<Arc<LocalProvider>, ComposeDomainsError> {
    let provider = LocalProvider::new(Parts {
        data_dir: data_dir.to_owned(),
        fetcher: Arc::new(ReqwestFetcher::default()),
        processes: processes.clone(),
        hf_http: Box::new(ReqwestHf::default()),
        launcher: Arc::new(SystemLauncher::new(processes)),
        health: Arc::new(LoopbackHealth::default()),
        timing: Timing::default(),
        idle_ttl_seconds: idle_ttl(config)?,
        platform_key: None,
    });
    // `setConfig` re-applies the idle TTL on every adopted config.
    let (watched, synced, stop) = (config.clone(), provider.clone(), cancel.clone());
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
    Ok(provider)
}

pub(super) async fn build(inputs: &DomainInputs, config: &Config) -> Result<Local, ComposeDomainsError> {
    let tokens = &inputs.tokens;
    let data_dir: &Path = &inputs.paths.data_dir;
    let processes = inputs.processes.clone();
    let seams = &inputs.seams.local;
    let mut services: Vec<Arc<dyn DomainService>> = Vec::new();
    let mut transfer_sources: Vec<Arc<dyn TransferSource>> = Vec::new();

    let provider = inputs.local_provider.clone();
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
    let jobs = MediaJobs::with_ledger(store.clone(), seams.media_generator.clone(), media_max_active(&inputs.env), Some(renditions.clone()), seams.media_ledger.clone());
    services.push(Arc::new(MediaService::new(store.clone(), jobs.clone(), processes.clone(), renditions)));
    let media_status = Arc::new(MediaStatus::new(store.clone()));
    transfer_sources.push(Arc::new(MediaAssetSource::new(store.clone())));


    let manifest = voice_manifest(inputs)?;
    let pipeline = Arc::new(VoicePipeline::new(
        data_dir.to_owned(),
        manifest,
        Arc::new(ConfigVoiceSettings::new(config.clone())),
        Arc::new(WhisperServer::with_defaults(&processes)),
        Arc::new(ProcessAudioTools(processes)),
        tokens.durability_io,
    ));
    let setup = Arc::new(VoiceSetup::new(pipeline.clone(), Arc::new(ConfigVoiceEnabled::new(config.clone())), seams.voice_installer.clone()));
    services.push(Arc::new(VoiceService::new(pipeline, setup.clone(), seams.voice_progress.clone())));

    Ok(Local { media_status, voice_setup: setup, media_jobs: jobs, media_store: store, services, transfer_sources, tool_modules_host, service: local_service })
}
