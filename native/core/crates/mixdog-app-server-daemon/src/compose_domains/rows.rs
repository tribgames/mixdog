//! The domain rows of `mixdog-core-domains` this composition builds: `client`, `host`,
//! `instructions`, `feedback`, `blob`, `update`, and `system`.

use std::sync::Arc;

use mixdog_core_api::DomainService;
use mixdog_core_base::support::on_lane;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::Settings;
use mixdog_core_config::tool_modules::ToolModules;
use mixdog_core_domains::domains::blob::AttachmentSource;
use mixdog_core_domains::domains::blob::BlobService;
use mixdog_core_domains::domains::client::ClientService;
use mixdog_core_domains::domains::client::StderrPerf;
use mixdog_core_domains::domains::feedback::FeedbackService;
use mixdog_core_domains::domains::feedback::RelayUrl;
use mixdog_core_domains::domains::host::HostService;
use mixdog_core_domains::domains::instructions::InstructionPaths;
use mixdog_core_domains::domains::instructions::InstructionsService;
use mixdog_core_domains::domains::update::REGISTRY_URL;
use mixdog_core_domains::domains::update::UpdateConfig;
use mixdog_core_domains::domains::update::UpdateService;
use mixdog_store::blobs::BlobStore;
use mixdog_workspace::transfer::TransferSource;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::ComposeDomainsError;
use super::DomainInputs;
use super::adapters::ActivityInput;
use super::adapters::RemotePower;
use crate::update_installer::StagedConfig;
use crate::update_installer::StagedInstaller;

/// `resolveRelayUrl(process.env)` of the desktop over `MIXDOG_RELAY_URL`: the one rule of
/// [`crate::domain_seams::remote::resolve_relay_url`], which the remote runtime resolves with too.
fn relay_url(env: &super::EnvReader) -> RelayUrl {
    let env = env.clone();
    Arc::new(move || crate::domain_seams::remote::resolve_relay_url(env("MIXDOG_RELAY_URL").as_deref()))
}

/// The `version` of the installed `package.json` (`localPackageVersion`): an unreadable, malformed or version-less file
/// reads as `0.0.0`, so a damaged file never stops the service and the update check offers the registry's release.
#[allow(clippy::disallowed_methods, reason = "runs as an interactive-io lane job")]
pub(crate) async fn package_version(package_root: &std::path::Path, lane: mixdog_rt::InteractiveIo) -> String {
    let path = package_root.join("package.json");
    on_lane(lane, &CancellationToken::new(), move |_lane| installed_version(&path)).await.unwrap_or_else(|_| UNKNOWN_VERSION.to_owned())
}

const UNKNOWN_VERSION: &str = "0.0.0";

#[allow(clippy::disallowed_methods, reason = "runs as an interactive-io lane job")]
fn installed_version(path: &std::path::Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|package| package.get("version").and_then(Value::as_str).filter(|version| !version.is_empty()).map(str::to_owned))
        .unwrap_or_else(|| UNKNOWN_VERSION.to_owned())
}

pub(super) struct Rows {
    pub services: Vec<Arc<dyn DomainService>>,
    pub transfer_sources: Vec<Arc<dyn TransferSource>>,
    pub system: Arc<mixdog_spawn::service::SystemService>,
    pub host: Arc<HostService>,
    /// The one update service: `setup` `set_auto_update` answers its `getUpdateSettings()`.
    pub update: Arc<UpdateService>,
    pub package_version: String,
}

pub(super) async fn build(
    inputs: &DomainInputs,
    config: &Config,
    publisher: Arc<dyn mixdog_core_api::state::StatePublisher>,
    tool_modules: Arc<ToolModules>,
    session_attachments: Arc<dyn mixdog_core_ports::ports::domain_sessions::SessionAttachments>,
) -> Result<Rows, ComposeDomainsError> {
    let tokens = &inputs.tokens;
    let seams = &inputs.seams;
    let mut services: Vec<Arc<dyn DomainService>> = Vec::new();
    let mut transfer_sources: Vec<Arc<dyn TransferSource>> = Vec::new();

    let perf = StderrPerf::new(inputs.env.as_ref()("MIXDOG_DESKTOP_PERF").as_deref() == Some("1"));
    services.push(ClientService::new(Arc::new(ActivityInput::new(seams.user_activity.clone())), Arc::new(perf)));

    let power = Arc::new(RemotePower::new(seams.remote.clone(), seams.local_target.clone()));
    // network-watch.ts: the leg redials at once when the machine comes back online or its addresses change (the old main process reported
    // `power('resume')` for it; `RemotePower` closes the leg and redials from the first delay, as a system resume does).
    let on_network_change = power.clone();
    drop(mixdog_core_domains::domains::desktop_residual_b::NetworkWatcher::start(
        std::time::Duration::from_millis(mixdog_core_domains::domains::desktop_residual_b::NETWORK_POLL_MS),
        Arc::new(mixdog_core_domains::domains::desktop_residual_b::network_snapshot),
        Arc::new(move || mixdog_core_domains::domains::host::PowerSink::power(&*on_network_change, mixdog_app_protocol::v2::host::PowerEvent::Resume)),
    ));
    let host = HostService::new(
        publisher,
        power.clone(),
        Arc::new(crate::compose_connections::PowerSinks(vec![power, seams.connections_power.clone()])),
        seams.notification_clicks.clone(),
        seams.browser_surfaces.clone(),
        seams.screen_events.clone(),
        seams.visualize_panes.clone(),
    );
    services.push(host.clone());

    services.push(InstructionsService::new(
        InstructionPaths {
            shipped_orchestration: inputs.paths.package_root.join("src").join("orchestration"),
            shipped_output_styles: inputs.paths.package_root.join("src").join("output-styles"),
            data_dir: inputs.paths.data_dir.clone(),
        },
        tool_modules,
        seams.instructions_changed.clone(),
        inputs.scopes.scopes("instructions")?,
        tokens,
    ));
    services.push(FeedbackService::new(relay_url(&inputs.env), inputs.scopes.scopes("feedback")?));

    let blobs = BlobStore::new(&inputs.paths.data_dir);
    services.push(BlobService::new(blobs.clone(), tokens, &inputs.limits));
    // `$blobRef` params are expanded by the server from the same store, before precheck and the validators.
    crate::server::install_param_refs(blobs.clone(), tokens, &inputs.limits);
    transfer_sources.push(AttachmentSource::new(blobs, session_attachments, tokens));

    let current_version = package_version(&inputs.paths.package_root, inputs.tokens.interactive_io).await;
    let dev = on_lane(tokens.interactive_io, &CancellationToken::new(), {
        let root = inputs.paths.package_root.clone();
        move |lane| StagedInstaller::probe_dev_install(lane, &root)
    })
    .await
    .map_err(|error| ComposeDomainsError::Build(format!("probing the install: {error:?}")))?;
    let installer = StagedInstaller::new(
        StagedConfig { data_dir: inputs.paths.data_dir.clone(), package_root: inputs.paths.package_root.clone() },
        tokens.maintenance_io,
        seams.system_proxy.clone(),
        Arc::new(mixdog_scm::exec::Exec::new(inputs.processes.manager())),
        dev,
    )
    // The packaged desktop's updater is the only path there: this core neither stages nor announces an update.
    .for_packaged_desktop(inputs.paths.packaged_desktop);
    let auto = config.clone();
    let update = UpdateService::new(
        UpdateConfig {
            current_version: current_version.clone(),
            registry_url: REGISTRY_URL.to_owned(),
            registry: Arc::new(mixdog_core_domains::domains::update::ReqwestRegistry),
            // Node's `emitNotification('update ready', { kind: 'update-notice', version })` reaches the
            // user as a notice; here it is the `notice` section entry the desktop words as a toast.
            ready_notice: {
                let notices = mixdog_core_domains::notify::desktop_notice::DesktopNotices::new(inputs.state.publisher.clone());
                Arc::new(move |version: &str| {
                    notices.raise("update-ready", "update-ready", &[("version", version)]);
                })
            },
            data_dir: inputs.paths.data_dir.clone(),
            // `config.update.auto !== false` of the agent config, read on each use.
            auto_update: Arc::new(move || {
                auto.agent().get("update").and_then(Value::as_object).and_then(|update| update.get("auto")) != Some(&Value::Bool(false))
            }),
            auto_switch: Arc::new(Settings::new(config.clone(), seams.settings_effects.clone(), inputs.env.clone())),
        },
        Arc::new(installer),
        inputs.host.clone(),
        inputs.scopes.scopes("update")?,
        inputs.scopes.scopes("config")?,
        tokens,
    );
    services.push(update.clone());

    let system = mixdog_spawn::service::SystemService::new(inputs.scoped_feeds.clone());
    services.push(system.clone());
    Ok(Rows { services, transfer_sources, system, host, update, package_version: current_version })
}

#[cfg(test)]
mod version_tests {
    use super::installed_version;

    #[test]
    fn a_damaged_or_missing_version_file_reads_as_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package.json");
        assert_eq!(installed_version(&path), "0.0.0");
        for body in ["{ not json", "{}", r#"{"version":""}"#, r#"{"version":7}"#] {
            mixdog_fsio::write(&mixdog_fsio::Unlaned, &path, body).unwrap();
            assert_eq!(installed_version(&path), "0.0.0", "{body}");
        }
        mixdog_fsio::write(&mixdog_fsio::Unlaned, &path, r#"{"version":"1.5.0"}"#).unwrap();
        assert_eq!(installed_version(&path), "1.5.0");
    }
}
