//! The composition of Computer Use: the sessions' pool (the helper, or the desktop's computer host when `desktop.computerBackend`
//! says so), the core blob store the desktop host's replies are read from, the host facts the `computer` feature gate asks, the
//! GNOME extension that follows `desktop.computerControl`, and the services over the pool (`computer/userControl`,
//! `computer/pointerReleased`, and `dev/computer/run` for a `test-hooks` build started with MIXDOGD_TEST_HOOKS=1).
//!
//! `compose_flip.rs` calls [`compose_computer`] once, where the pool is built, and [`Composed::register`] once, where the domain
//! services are registered.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core::run_host::native_tools::ComputerSettings;
use mixdog_core::run_host::native_tools::NativeTool;
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
    helper_resolvable: AtomicBool,
}

impl ComputerHostPresence {
    pub fn new(host: Arc<dyn HostChannel>) -> Self {
        Self { host, helper_resolvable: AtomicBool::new(false) }
    }
}

impl HostPresence for ComputerHostPresence {
    fn computer_claimed(&self) -> bool {
        self.host.serves(HostCapability::Computer)
    }

    fn tui_helper_resolvable(&self) -> bool {
        self.helper_resolvable.load(Ordering::SeqCst)
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
    /// Ends the GNOME extension's follower with the daemon.
    pub cancel: CancellationToken,
}

/// What the composition keeps of Computer Use.
pub struct Composed {
    /// The sessions' pool; `None` where no place has the helper and the desktop host is not chosen (the tool is then not registered).
    pub pool: Option<Arc<ComputerSessionPool>>,
    #[cfg(feature = "test-hooks")]
    dev: Option<Arc<crate::dev_computer::DevComputerRun>>,
}

/// Builds the pool over the resolved helper (or the desktop host), binds the desktop channel to it, tells `presence` whether the helper resolved, and starts the follower of
/// `desktop.computerControl` that installs and enables Mixy's GNOME shell extension.
pub async fn compose_computer(inputs: ComputerInputs<'_>) -> Composed {
    let ComputerInputs { env, paths, manager, wrap, publisher, data_dir, config, presence, blobs, tokens, cancel } = inputs;
    presence.helper_resolvable.store(paths.resolve(NativeTool::Computer).await.is_some(), Ordering::SeqCst);
    let host_blobs: Arc<dyn ComputerBlobs> = Arc::new(CoreComputerBlobs::new(blobs.clone(), tokens.interactive_io));
    let settings = ComputerSettings::from_config(data_dir, config.clone(), Some(host_blobs));
    let pool = paths.computer_sessions(manager.clone(), wrap, publisher, settings).await;
    if let Some(pool) = &pool {
        // The desktop's computer host takes the screen captures and reports the displays (`host/computer/*`).
        pool.attach_desktop(presence.host.clone());
    }
    follow_gnome_extension(config, manager, cancel);
    #[cfg(feature = "test-hooks")]
    let dev = pool.as_ref().and_then(|pool| crate::dev_computer::DevComputerRun::if_enabled(&*env, pool.clone(), pool.clone(), blobs, tokens));
    #[cfg(not(feature = "test-hooks"))]
    let _ = (env, blobs);
    Composed {
        pool,
        #[cfg(feature = "test-hooks")]
        dev,
    }
}

impl Composed {
    /// Registers `computer/userControl` (the pill's Resume, Stop, Pause, takeover and idle-resume), `computer/pointerReleased`, and
    /// `dev/computer/run` where the test hooks are on. `dev/computer/run` stays in `SERVICE_PENDING`: an ordinary start registers
    /// nothing for it.
    pub fn register(&self, builder: &mut DomainsBuilder) -> Result<(), DomainsError> {
        builder.register(Arc::new(ComputerUserControlService::new(self.pool.as_ref().map(|pool| pool.user_control()))))?;
        builder.register(Arc::new(ComputerPointerService::new(self.pool.as_ref().map(|pool| pool.pointer_hold()))))?;
        #[cfg(feature = "test-hooks")]
        if let Some(dev) = &self.dev {
            builder.register(dev.clone())?;
        }
        Ok(())
    }
}

/// GNOME window control comes from Mixdog's own shell extension: it is kept installed and enabled exactly while Computer Use is on
/// (port of the desktop's applyGnomeExtensionSetting; a no-op off GNOME).
fn follow_gnome_extension(config: Config, manager: Arc<dyn ProcessManager>, cancel: CancellationToken) {
    tokio::spawn(async move {
        use mixdog_tools::desktop::computer_gnome_extension::apply_gnome_extension;
        use mixdog_tools::desktop::computer_gnome_extension::bundled_dir;

        let mut changes = config.changes();
        let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)).unwrap_or_default();
        loop {
            let enabled = config.desktop_settings().computer_control;
            let env: mixdog_tools::desktop::computer_linux::Env = std::env::vars().collect();
            apply_gnome_extension(manager.clone(), enabled, &env, bundled_dir(&env, &exe_dir).as_deref(), &cancel).await;
            if !matches!(cancel.run_until_cancelled(changes.changed()).await, Some(Ok(()))) {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let digest = on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| put_store.put(lane, &put_bytes).map(|pin| pin.digest().as_str().to_owned()))
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

    /// The gate's host facts: the claim comes from the channel, the helper from the resolution.
    #[test]
    fn the_host_facts_follow_the_claim_and_the_helper() {
        let presence = ComputerHostPresence::new(Arc::new(Claimed(true)));
        assert!(presence.computer_claimed() && !presence.tui_helper_resolvable());
        let presence = ComputerHostPresence::new(Arc::new(Claimed(false)));
        presence.helper_resolvable.store(true, Ordering::SeqCst);
        assert!(!presence.computer_claimed() && presence.tui_helper_resolvable());
    }
}
