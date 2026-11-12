//! `serve`'s boot, LR §3 steps 1 to 5, before the core is composed:
//!
//! 1. the data-directory lock `L` (`startup::start`);
//! 2. the control listener and the `booting` discovery (`serving::begin`, run as `startup::start`'s `init`);
//! 3. the prior-owner verdict, a blocked one published on the lifecycle (discovery and the control listener answer it);
//! 4. barrier `B`;
//! 5. the migration (`mixdog_migrate::run::cli::migrate`, the roots of `mixdogd migrate`), the lifecycle `migrating` while it runs.
//!
//! Step 6 (composition, then the RPC listener and `serving`) is `serve`'s.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::mpsc;

use mixdog_exthost::ExtDocumentText;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::cli::MigrateArgs;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_rt::LaneTokens;

use crate::ServeError;
use crate::barrier::BarrierRecord;
use crate::lifecycle::Lifecycle;
use crate::lifecycle::Migration;
use crate::serving::Booting;
use crate::serving::StartIn;
use crate::startup::Lanes;
use crate::startup::Publish;
use crate::startup::Started;
use crate::startup::Startup;
use crate::stop_watch::StopWatch;
use crate::verdict::Blocked;
use crate::verdict::BlockedKind;
use crate::verdict::Interrupt;

/// What `boot` hands to composition and serving.
pub struct Begun {
    /// The proof of steps 1 to 5; its lock is the core's ownership.
    pub started: Started,
    pub booting: Booting,
    /// The one stop watcher, live from the start of boot to the end of `serve`.
    pub watch: StopWatch,
}

/// The index projector of the migration: the store's `project_index`, which builds each catalog row with the store's one row builder (the same one as its live upsert).
/// `mixdogd migrate` runs the same one.
pub struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

/// Publishes the verdict and the migration on the lifecycle, which `init` builds before either runs.
struct LifecyclePublish(Arc<OnceLock<Arc<Lifecycle>>>);

impl LifecyclePublish {
    fn lifecycle(&self) -> &Arc<Lifecycle> {
        self.0.get().expect("startup runs init (which builds the lifecycle) before the verdict")
    }
}

impl Publish for LifecyclePublish {
    fn blocked(&mut self, blocked: &Blocked) {
        if let Err(error) = self.lifecycle().set_blocked(lifecycle_blocked(blocked)) {
            tracing::error!(%error, "the blocked verdict could not be published");
        }
    }

    fn migrating(&mut self) {
        // The migration reports no progress while it runs (`Migrator::run` returns `Complete`), so the counts are not known.
        if let Err(error) = self.lifecycle().set_migrating(Migration { kind: "migration".to_owned(), done: 0, total: 0 }) {
            tracing::error!(%error, "the migration could not be published");
        }
    }
}

/// The lifecycle's form of a blocked verdict: a wait for a claim on `B` is a wait for its holder to leave, as a wait for an exit is.
fn lifecycle_blocked(blocked: &Blocked) -> crate::lifecycle::Blocked {
    let identity = &blocked.process.identity;
    match blocked.kind {
        BlockedKind::WaitExit | BlockedKind::WaitClaim => crate::lifecycle::Blocked::WaitExit { pid: identity.pid },
        BlockedKind::Undecidable => crate::lifecycle::Blocked::Undecidable {
            pid: identity.pid,
            image: blocked.process.image.as_ref().map(|image| image.to_string_lossy().into_owned()).unwrap_or_default(),
            command_line: blocked.process.command_line.clone().unwrap_or_default(),
            start_time: identity.start_ms.to_string(),
        },
    }
}

/// The roots the serving core migrates. It names no desktop profile of its own: the launcher's `MIXDOG_DESKTOP_USER_DATA` in `env` is the only way one is migrated (D-profile-1).
fn migration_roots(data_dir: &Path, env: &dyn Fn(&str) -> Option<std::ffi::OsString>, home: Option<std::path::PathBuf>) -> Result<MigrationRoots, String> {
    let args = MigrateArgs { data_dir: Some(data_dir.to_path_buf()), home: None, desktop_profile: None };
    mixdog_migrate::run::cli::resolve_roots(&args, env, home)
        .ok_or_else(|| "no home directory for the migration roots (set MIXDOG_HOME or HOME)".to_owned())
}

/// The migration on its own thread: its office extractor drives the extension host with the runtime's handle (`block_on`), which a lane job running on a worker may not do.
/// The host it uses is its own, closed when the migration returns; the core's starts later.
fn migrate_data(data_dir: &Path, host: ExtHostConfig, runtime: &tokio::runtime::Handle) -> Result<(), String> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let roots = migration_roots(data_dir, &|name| std::env::var_os(name), std::env::home_dir())?;
                let _entered = runtime.enter();
                let pool = Arc::new(ExtHostPool::new(host).map_err(|error| format!("starting the extension host: {error}"))?);
                let office = OfficeExtractor { docs: Arc::new(ExtDocumentText::new(pool.clone())), runtime: runtime.clone() };
                let outcome = mixdog_migrate::run::cli::migrate(roots, Arc::new(StoreProjector), office);
                runtime.block_on(pool.close());
                outcome.map(drop).map_err(|blocked| blocked.to_string())
            })
            .join()
            .unwrap_or_else(|_| Err("the migration panicked".to_owned()))
    })
}

/// Runs LR §3 steps 1 to 5 over `data_dir`. A `release{pid}` decision reaches the verdict gate through `Booting::release`; a start the interrupt abandons returns
/// `StartupError::Interrupted` with `B` untouched.
pub async fn boot(tokens: &LaneTokens, data_dir: &Path, host: ExtHostConfig, given: StartIn) -> Result<Begun, ServeError> {
    let (decide, releases) = mpsc::channel::<u32>();
    let interrupt = Arc::new(Interrupt::new().map_err(ServeError::Interrupt)?);
    let discovery_path = crate::discovery::path(&given.runtime_root);
    let record = BarrierRecord { version: env!("CARGO_PKG_VERSION").to_owned(), update_text: given.update_text.clone() };
    let lifecycle: Arc<OnceLock<Arc<Lifecycle>>> = Arc::default();
    let booted: Mutex<Option<Booting>> = Mutex::new(None);
    let init = {
        let (lifecycle, interrupt, booted) = (&lifecycle, &interrupt, &booted);
        async move {
            let booting = crate::serving::begin(tokens, given).await.map_err(|error| error.to_string())?;
            let wake = interrupt.clone();
            booting.release.bind(Arc::new(move |pid| {
                let _ = decide.send(pid);
                let _ = wake.signal();
            }));
            let _ = lifecycle.set(booting.lifecycle.clone());
            *booted.lock().unwrap_or_else(PoisonError::into_inner) = Some(booting);
            Ok(())
        }
    };
    let migrate = {
        let (data_dir, runtime) = (data_dir.to_path_buf(), tokio::runtime::Handle::current());
        move || migrate_data(&data_dir, host, &runtime)
    };
    // A stop request during startup (Node's signal handlers are installed before its start, `daemon.mjs:1297`) wakes a blocked verdict wait through the interrupt, which refuses
    // the start with `B` untouched. The migration cannot be interrupted: a stop waits until it has finished (`CommandError`'s text), and is honoured right after.
    // The watcher is not ended with startup: it stays live in `Begun` so that a stop during composition, or between composition and serving, is kept too.
    let watch = StopWatch::install({
        let interrupt = interrupt.clone();
        move || {
            if let Err(error) = interrupt.signal() {
                tracing::error!(%error, "the startup interrupt could not be signalled");
            }
        }
    });
    let started = crate::startup::start(
        Startup { data_dir: data_dir.to_path_buf(), discovery_path, record, interrupt: interrupt.clone(), releases },
        Lanes { durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        &mut LifecyclePublish(lifecycle.clone()),
        init,
        migrate,
    )
    .await;
    if let Some(signal) = watch.requested() {
        return Err(ServeError::StoppedDuringStartup(signal.name()));
    }
    let started = started?;
    crate::stale_temps::sweep_summary_temps_of_start(tokens, data_dir).await;
    let booting = booted.lock().unwrap_or_else(PoisonError::into_inner).take().expect("startup ran init before it returned");
    Ok(Begun { started, booting, watch })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use mixdog_core_api::domain::ext::DocumentText;
    use mixdog_core_api::domain::ext::ExtError;
    use mixdog_core_api::domain::ext::PdfIntake;
    use mixdog_migrate::durable;
    use mixdog_protocol::ThreadId;
    use tempfile::TempDir;

    use super::*;

    const DEVICE: &[u8] = br#"{"deviceId":"d","deviceSecret":"s"}"#;

    /// The migration reads no document here: the data dir holds no session.
    struct NoDocuments;

    #[async_trait::async_trait]
    impl DocumentText for NoDocuments {
        async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
            unreachable!("no session signs an office document ({filename})")
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
            unreachable!("the migration extracts no PDF text")
        }
        async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
            unreachable!("the migration counts no PDF")
        }
    }

    /// One isolated run: its own `APPDATA`/home/data dir, and a desktop profile holding a relay pairing under `APPDATA`.
    struct Isolated {
        root: TempDir,
    }

    impl Isolated {
        fn new() -> Self {
            let run = Self { root: TempDir::new().unwrap() };
            durable::publish_file(&run.app_data_profile().join("relay-device.json"), DEVICE).unwrap();
            run
        }

        fn app_data(&self) -> std::path::PathBuf {
            self.root.path().join("appdata")
        }

        fn app_data_profile(&self) -> std::path::PathBuf {
            self.app_data().join("mixdog-desktop")
        }

        fn data(&self) -> std::path::PathBuf {
            self.root.path().join("data")
        }

        /// Boots the migration the way `migrate_data` does, over an environment of this run alone plus `extra`.
        fn migrate(&self, extra: &[(&str, std::path::PathBuf)]) {
            let home = self.root.path().join("home");
            let mut vars: Vec<(String, OsString)> = [
                ("APPDATA", self.app_data()),
                ("LOCALAPPDATA", self.root.path().join("local")),
                ("HOME", home.clone()),
                ("USERPROFILE", home.clone()),
                ("XDG_CONFIG_HOME", self.app_data()),
                ("MIXDOG_HOME", home.join(".mixdog")),
                ("MIXDOG_CONFIG_DIR", self.root.path().join("config")),
                ("MIXDOG_RUNTIME_ROOT", self.root.path().join("runtime")),
            ]
            .into_iter()
            .map(|(name, path)| (name.to_owned(), path.into_os_string()))
            .collect();
            vars.extend(extra.iter().map(|(name, path)| ((*name).to_owned(), path.clone().into_os_string())));
            let env = move |name: &str| vars.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
            let roots = migration_roots(&self.data(), &env, Some(home)).unwrap();
            let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
            let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: runtime.handle().clone() };
            mixdog_migrate::run::cli::migrate(roots, Arc::new(StoreProjector), office).unwrap();
        }
    }

    #[test]
    fn the_serving_core_leaves_the_app_data_profile_untouched() {
        let run = Isolated::new();
        let before = durable::walk_files(&run.app_data_profile()).unwrap();
        run.migrate(&[]);
        assert_eq!(durable::walk_files(&run.app_data_profile()).unwrap(), before);
        assert_eq!(durable::read_optional(&run.app_data_profile().join("relay-device.json")).unwrap().as_deref(), Some(DEVICE));
        assert_eq!(durable::read_optional(&run.data().join("remote").join("device.json")).unwrap(), None, "nothing was migrated from the profile");
    }

    #[test]
    fn the_profile_the_launcher_names_migrates() {
        let run = Isolated::new();
        run.migrate(&[("MIXDOG_DESKTOP_USER_DATA", run.app_data_profile())]);
        assert_eq!(durable::read_optional(&run.data().join("remote").join("device.json")).unwrap().as_deref(), Some(DEVICE));
        assert_eq!(durable::read_optional(&run.app_data_profile().join("relay-device.json")).unwrap(), None, "the source is moved");
    }
}