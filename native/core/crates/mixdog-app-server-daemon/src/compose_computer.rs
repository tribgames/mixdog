//! The composition of Computer Use: the sessions' pool (the helper, or the desktop's computer host when `desktop.computerBackend`
//! says so), the core blob store the desktop host's replies are read from, the host facts the `computer` feature gate asks, the
//! GNOME extension that follows `desktop.computerControl`, and the services over the pool (`computer/userControl`,
//! `computer/pointerReleased`, and `dev/computer/run` for a `test-hooks` build started with MIXDOGD_TEST_HOOKS=1).
//!
//! `compose_flip.rs` calls [`compose_computer`] once, where the pool is built, and [`Composed::register`] once, where the domain
//! services are registered.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core::run_host::native_tools::ComputerSettings;
use mixdog_core::run_host::native_tools::NativeToolPaths;
use mixdog_core::run_host::native_tools::WrapBackend;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::support::on_lane;
use mixdog_core_config::config::Config;
use mixdog_core_domains::domains::DomainsBuilder;
use mixdog_core_domains::domains::DomainsError;
use mixdog_protocol::BlobDigest;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use mixdog_store::blobs::BlobError;
use mixdog_store::blobs::BlobStore;
use mixdog_tools::desktop::computer_pixels::ComputerBlobs;
use tokio_util::sync::CancellationToken;

use crate::compose_domains::EnvReader;
use crate::computer_control::ComputerUserControlService;
use crate::computer_gate::HostPresence;
use crate::computer_pointer_service::ComputerPointerService;
use crate::computer_scope_report_service::ComputerScopeReportService;

/// The core's blob store as the computer reads it: the image bytes the desktop uploaded with `blob/put` and named by digest in a
/// reply (`imageBlob`) or a pixel capture.
pub struct CoreComputerBlobs {
    store: BlobStore,
    lane: InteractiveIo,
}

impl CoreComputerBlobs {
    pub fn new(store: BlobStore, lane: InteractiveIo) -> Self {
        Self { store, lane }
    }
}

/// One reading serves the desktop host's replies and the display captures alike.
#[async_trait]
impl ComputerBlobs for CoreComputerBlobs {
    async fn read(&self, digest: &str) -> Result<Vec<u8>, ComputerError> {
        let missing = |message: String| ComputerError::Failed { code: "blob_missing".into(), message };
        let parsed = BlobDigest::try_from(digest.to_owned()).map_err(|error| missing(format!("{digest}: {error}")))?;
        let store = self.store.clone();
        let named = parsed.clone();
        let read = on_lane(self.lane, &CancellationToken::new(), move |lane| store.read(lane, &named))
            .await
            .map_err(|error| ComputerError::Failed { code: "blob_unreadable".into(), message: format!("{parsed}: {error:?}") })?;
        read.map_err(|error| match error {
            BlobError::Missing { .. } => missing(format!("no blob {digest}")),
            other => ComputerError::Failed { code: "blob_unreadable".into(), message: format!("{digest}: {other}") },
        })
    }
}

/// What the machine offers the `computer` feature gate: a connection that claimed the host with `capabilities.host.computer`, and a
/// helper binary that resolves where no desktop claims anything (a TUI-hosted core). Built before the pool, because the bridge fact
/// the skill gate, the setup status and the feature probes read is built before it; [`compose_computer`] then tells it whether the
/// helper resolved.
pub struct ComputerHostPresence {
    host: Arc<dyn HostChannel>,
    /// The pool, bound once it is built: whether a helper is there is the pool's own last look at the file system, not a fact kept here.
    pool: std::sync::OnceLock<Arc<ComputerSessionPool>>,
}

impl ComputerHostPresence {
    pub fn new(host: Arc<dyn HostChannel>) -> Self {
        Self { host, pool: std::sync::OnceLock::new() }
    }
}

impl HostPresence for ComputerHostPresence {
    fn computer_claimed(&self) -> bool {
        self.host.serves(HostCapability::Computer)
    }

    fn tui_helper_resolvable(&self) -> bool {
        self.pool.get().is_some_and(|pool| pool.helper_resolvable())
    }
}

/// What [`compose_computer`] needs of the composition.
pub struct ComputerInputs<'a> {
    pub env: EnvReader,
    /// Where the helper binary is found (`MIXDOG_COMPUTER_BIN`, else bundled `native-tools/`, else the local build); the same
    /// value the tidy host resolves its native tools with.
    pub paths: Arc<NativeToolPaths>,
    pub manager: Arc<dyn ProcessManager>,
    /// Decorates each session's backend as it is made (the secret redaction, the human-only lock, the saved-login fill).
    pub wrap: WrapBackend,
    pub publisher: Arc<dyn StatePublisher>,
    pub data_dir: PathBuf,
    pub config: Config,
    /// The host facts over the desktop's channel: its computer host takes the screen captures and, with
    /// `desktop.computerBackend = desktopHost`, every command.
    pub presence: Arc<ComputerHostPresence>,
    pub blobs: BlobStore,
    pub tokens: &'a LaneTokens,
    /// Which connection holds the Computer host claim: the only one whose scope reports are taken.
    pub claimants: Arc<dyn crate::browser_engine_service::ClaimantProbe>,
    /// Ends the GNOME extension's follower with the daemon.
    pub cancel: CancellationToken,
}

/// What the composition keeps of Computer Use.
pub struct Composed {
    /// The sessions' pool: always built, so the tool is always registered; whether it can run is read live from the pool
    /// (`ComputerSessionPool::can_serve`, `Tool::runnable`) and the gate.
    pub pool: Option<Arc<ComputerSessionPool>>,
    /// `host/computer/scopeReport`, and the owner told when the desktop that reported scopes disconnects.
    pub scope_reports: Arc<ComputerScopeReportService>,
    #[cfg(feature = "test-hooks")]
    dev: Option<Arc<crate::dev_computer::DevComputerRun>>,
}

impl Composed {
    /// Registers `computer/userControl` (the pill's Resume, Stop, Pause, takeover and idle-resume), `computer/pointerReleased`, and
    /// `dev/computer/run` where the test hooks are on. `dev/computer/run` stays in `SERVICE_PENDING`: an ordinary start registers
    /// nothing for it.
    pub fn register(&self, builder: &mut DomainsBuilder) -> Result<(), DomainsError> {
        builder.register(Arc::new(ComputerUserControlService::new(self.pool.as_ref().map(|pool| pool.user_control()))))?;
        builder.register(Arc::new(ComputerPointerService::new(self.pool.as_ref().map(|pool| pool.pointer_hold()))))?;
        builder.register(self.scope_reports.clone())?;
        #[cfg(feature = "test-hooks")]
        if let Some(dev) = &self.dev {
            builder.register(dev.clone())?;
        }
        Ok(())
    }
}

fn follow_computer_control(config: Config, pool: Arc<ComputerSessionPool>, cancel: CancellationToken) {
    let runtime = tokio::runtime::Handle::current();
    let adopted = config.clone();
    let apply = move || {
        if adopted.desktop_settings().computer_control {
            pool.reopen();
            return;
        }
        let revoked = pool.revoke_all();
        let stopping = pool.clone();
        runtime.spawn(async move {
            // What off answered: the section already shows its cleanup (stopping, pending, unconfirmed or ready); the facts of
            // each executor go to the log, an unconfirmed closure as a warning.
            let report = stopping.stop_revoked(revoked).await;
            for executor in &report.reports {
                tracing::info!(
                    scope = executor.scope,
                    executor = %executor.executor,
                    admission_closed = executor.report.admission_closed,
                    unfinished_at_closure = ?executor.report.unfinished_at_closure,
                    cleanup = ?executor.report.cleanup,
                    unknown_executors = ?executor.report.unknown_executors,
                    "computer use off: executor report"
                );
            }
            if !report.confirmed {
                tracing::warn!(unknown_executors = ?report.unknown_executors(), cleanup = ?report.cleanup(), "computer use off: closure not confirmed at every executor");
            }
        });
    };
    // The state at start, before any change: a core started with Computer Use off makes no scope.
    apply();
    let guard = config.on_adoption(apply);
    tokio::spawn(async move {
        cancel.cancelled().await;
        drop(guard);
    });
}

/// Builds the pool over the resolved helper (or the desktop host), binds the desktop channel to it, tells `presence` whether the helper resolved, and starts the follower of
/// `desktop.computerControl` that installs and enables Mixy's GNOME shell extension.
pub async fn compose_computer(inputs: ComputerInputs<'_>) -> Composed {
    let ComputerInputs { env, paths, manager, wrap, publisher, data_dir, config, presence, blobs, tokens, claimants, cancel } = inputs;
    let host_blobs: Arc<dyn ComputerBlobs> = Arc::new(CoreComputerBlobs::new(blobs.clone(), tokens.interactive_io));
    let settings = ComputerSettings::from_config(data_dir, config.clone(), Some(host_blobs), tokens.interactive_io);
    let pool = paths.computer_sessions(manager.clone(), wrap, publisher, settings).await;
    // The desktop's computer host takes the screen captures and reports the displays (`host/computer/*`).
    pool.attach_desktop(presence.host.clone());
    let _ = presence.pool.set(pool.clone());
    follow_computer_control(config.clone(), pool.clone(), cancel.clone());
    follow_gnome_extension(config, manager, tokens.interactive_io, cancel);
    #[cfg(feature = "test-hooks")]
    let dev = crate::dev_computer::DevComputerRun::if_enabled(&*env, pool.clone(), pool.clone(), blobs, tokens);
    #[cfg(not(feature = "test-hooks"))]
    let _ = (env, blobs);
    Composed {
        scope_reports: Arc::new(ComputerScopeReportService::new(Some(pool.clone()), claimants)),
        pool: Some(pool),
        #[cfg(feature = "test-hooks")]
        dev,
    }
}

/// GNOME window control comes from Mixdog's own shell extension: it is kept installed and enabled exactly while Computer Use is on
/// (port of the desktop's applyGnomeExtensionSetting; a no-op off GNOME).
fn follow_gnome_extension(config: Config, manager: Arc<dyn ProcessManager>, io: InteractiveIo, cancel: CancellationToken) {
    tokio::spawn(async move {
        use mixdog_tools::desktop::computer_gnome_extension::apply_gnome_extension;
        use mixdog_tools::desktop::computer_gnome_extension::bundled_dir;

        let mut changes = config.changes();
        let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)).unwrap_or_default();
        loop {
            let enabled = config.desktop_settings().computer_control;
            let env: mixdog_tools::desktop::computer_linux::Env = std::env::vars().collect();
            let bundled = bundled_dir(io, &env, &exe_dir).await;
            apply_gnome_extension(manager.clone(), io, enabled, &env, bundled.as_deref(), &cancel).await;
            if !matches!(cancel.run_until_cancelled(changes.changed()).await, Some(Ok(()))) {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::compose_mcp::BridgeFeatures;

    struct Claimed(bool);

    #[async_trait]
    impl HostChannel for Claimed {
        async fn request(
            &self,
            _: HostCapability,
            _: mixdog_core_api::ids::Method,
            _: serde_json::Value,
        ) -> Result<serde_json::Value, mixdog_core_api::HostError> {
            Err(mixdog_core_api::HostError::Core(mixdog_core_api::CoreError::Cancelled { by: "test".into() }))
        }

        fn serves(&self, capability: HostCapability) -> bool {
            self.0 && matches!(capability, HostCapability::Computer)
        }

        fn notify(&self, _: HostCapability, _: mixdog_core_api::ids::Method, _: serde_json::Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    /// The gate's host facts: the claim comes from the channel; with no pool bound there is no helper to speak of.
    #[test]
    fn the_host_facts_follow_the_claim() {
        let presence = ComputerHostPresence::new(Arc::new(Claimed(true)));
        assert!(presence.computer_claimed() && !presence.tui_helper_resolvable());
        let presence = ComputerHostPresence::new(Arc::new(Claimed(false)));
        assert!(!presence.computer_claimed() && !presence.tui_helper_resolvable());
    }

    /// A desktop that is there or not, as the claim registry says it at each ask.
    struct Desk(std::sync::atomic::AtomicBool);

    #[async_trait]
    impl HostChannel for Desk {
        async fn request(
            &self,
            _: HostCapability,
            _: mixdog_core_api::ids::Method,
            _: serde_json::Value,
        ) -> Result<serde_json::Value, mixdog_core_api::HostError> {
            Err(mixdog_core_api::HostError::Core(mixdog_core_api::CoreError::Cancelled { by: "test".into() }))
        }

        fn serves(&self, capability: HostCapability) -> bool {
            self.0.load(Ordering::SeqCst) && matches!(capability, HostCapability::Computer)
        }

        fn notify(&self, _: HostCapability, _: mixdog_core_api::ids::Method, _: serde_json::Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    struct NoBlobs;

    #[async_trait]
    impl ComputerBlobs for NoBlobs {
        async fn read(&self, _: &str) -> Result<Vec<u8>, ComputerError> {
            Err(ComputerError::Failed { code: "blob_missing".into(), message: "no blob".into() })
        }
    }

    struct Files(Arc<AtomicBool>);

    #[async_trait]
    impl mixdog_core::run_host::native_tools::PathExists for Files {
        async fn exists(&self, _: &std::path::Path) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct Quiet;

    impl StatePublisher for Quiet {
        fn publish(&self, _: mixdog_protocol::SectionName, _: Option<String>, _: mixdog_core_api::state::SectionChange) {}
    }

    /// What the skill gate, the setup status and the feature probes read: the fact and the registration, each at the moment of the ask.
    fn offered(bridges: &crate::mcp_surface::ToolBridges) -> bool {
        bridges.present("computer") && bridges.registered("computer")
    }

    fn store_in(dir: &std::path::Path) -> (BlobStore, LaneTokens) {
        (BlobStore::new(dir), mixdog_rt::testing::tokens())
    }

    /// The desktop host's reply names a stored image by digest: the bytes come back as stored.
    #[tokio::test]
    async fn a_stored_image_is_read_by_its_digest() {
        let dir = tempfile::tempdir().unwrap();
        let (store, tokens) = store_in(dir.path());
        let bytes = b"\x89PNG not really".to_vec();
        let (put_store, put_bytes) = (store.clone(), bytes.clone());
        let digest =
            on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| put_store.put(lane, &put_bytes).map(|digest| digest.as_str().to_owned()))
                .await
                .unwrap()
                .unwrap();
        let blobs = CoreComputerBlobs::new(store, tokens.interactive_io);
        assert_eq!(blobs.read(&digest).await.unwrap(), bytes);
    }

    /// A digest the store does not hold, and text that is no digest, are the helper's `blob_missing`.
    #[tokio::test]
    async fn a_digest_that_is_not_stored_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (store, tokens) = store_in(dir.path());
        let blobs = CoreComputerBlobs::new(store, tokens.interactive_io);
        let absent = format!("sha256:{}", "0".repeat(64));
        for digest in [absent.as_str(), "sha256:aaaa", ""] {
            let refused = blobs.read(digest).await;
            assert!(matches!(&refused, Err(ComputerError::Failed { code, .. }) if code == "blob_missing"), "{digest}: {refused:?}");
        }
    }

    /// The rig of a core as it stood at start: a pool made with whatever the machine had, the gate over the live claim registry.
    async fn core(
        helper_file: &Arc<AtomicBool>,
        desk: &Arc<Desk>,
        control: &Arc<AtomicBool>,
        host_backend: bool,
    ) -> (Arc<ComputerSessionPool>, Arc<ComputerHostPresence>, crate::mcp_surface::ToolBridges) {
        let tokens = mixdog_rt::testing::tokens();
        let manager: Arc<dyn ProcessManager> = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        let paths = Arc::new(
            NativeToolPaths::new(Arc::new(|_: &str| None::<String>), PathBuf::from("/pkg"), Arc::new(Files(helper_file.clone())), None).with_exe_dir(None),
        );
        let mut settings = ComputerSettings::new(std::env::temp_dir().join("mixdog-compose-computer-test"), Arc::new(|| false), tokens.interactive_io);
        if host_backend {
            settings.backend = Arc::new(|| mixdog_core_config::config::ComputerBackendChoice::DesktopHost);
            settings.host_blobs = Some(Arc::new(NoBlobs));
        }
        let pool = paths
            .computer_sessions(
                manager,
                Arc::new(|_: &str, inner: Arc<dyn mixdog_core_api::domain::computer::ComputerBackend>| inner),
                Arc::new(Quiet),
                settings,
            )
            .await;
        let presence = Arc::new(ComputerHostPresence::new(desk.clone()));
        assert!(presence.pool.set(pool.clone()).is_ok(), "the pool is bound once");
        let late = Arc::new(crate::late_session::LateComputerHosts::default());
        late.bind(Some(pool.clone())).unwrap();
        let flag = control.clone();
        let bridges = crate::mcp_surface::ToolBridges {
            host: desk.clone(),
            desktop: Arc::new(move || {
                let doc = serde_json::json!({ "desktop": { "computerControl": flag.load(Ordering::SeqCst) } });
                mixdog_core_config::config::desktop_settings(doc.as_object().unwrap())
            }),
            computer: late,
        };
        (pool, presence, bridges)
    }

    /// The core started from a terminal: no desktop, and (on Windows) the desktop host the chosen backend. A desktop that attaches later
    /// with the setting on makes `computer` available, and one that leaves takes it away, with no restart of the core.
    #[tokio::test]
    async fn a_desktop_attaching_after_start_offers_computer_and_leaving_takes_it_away() {
        let helper_file = Arc::new(AtomicBool::new(false));
        let desk = Arc::new(Desk(AtomicBool::new(false)));
        let control = Arc::new(AtomicBool::new(true));
        let (pool, _presence, bridges) = core(&helper_file, &desk, &control, true).await;
        assert!(pool.can_serve() && !pool.helper_resolvable());
        assert!(!offered(&bridges), "no desktop, no helper: nothing serves");
        desk.0.store(true, Ordering::SeqCst);
        assert!(offered(&bridges), "the desktop attached");
        control.store(false, Ordering::SeqCst);
        assert!(!offered(&bridges), "the setting off");
        control.store(true, Ordering::SeqCst);
        assert!(offered(&bridges));
        desk.0.store(false, Ordering::SeqCst);
        assert!(!offered(&bridges), "the desktop left");
    }

    /// A helper that is not there at start but is found when the settings next change is served from then on, and the gate's own fact
    /// of it follows; the helper going away is read the same way.
    #[tokio::test]
    async fn a_helper_found_after_start_is_served_without_a_restart() {
        let helper_file = Arc::new(AtomicBool::new(false));
        let desk = Arc::new(Desk(AtomicBool::new(false)));
        let control = Arc::new(AtomicBool::new(true));
        let (pool, presence, bridges) = core(&helper_file, &desk, &control, false).await;
        assert!(!offered(&bridges) && !pool.can_serve());
        // Placed on disk, no setting changed: the next listing (the feature probes' read) finds it.
        helper_file.store(true, Ordering::SeqCst);
        bridges.refresh().await;
        assert!(pool.can_serve() && presence.tui_helper_resolvable());
        assert!(offered(&bridges), "a core with a helper offers it with no desktop");
        // Removed the same way: the next listing no longer offers it.
        helper_file.store(false, Ordering::SeqCst);
        bridges.refresh().await;
        assert!(!offered(&bridges) && !presence.tui_helper_resolvable());
        // A call decides for itself: a helper placed since the last listing is what its decision finds.
        helper_file.store(true, Ordering::SeqCst);
        assert!(pool.availability_now().await.route.is_some());
    }
}
