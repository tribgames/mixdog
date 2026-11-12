//! `serve`'s boot, LR §3 steps 1 to 5, before the core is composed:
//!
//! 1. the data-directory lock `L` (`startup::start`);
//! 2. the control listener and the `booting` discovery (`serving::begin`, run as `startup::start`'s `init`);
//! 3. the prior-owner verdict, a blocked one published on the lifecycle (discovery and the control listener answer it);
//! 4. barrier `B`;
//! 5. the migration's front (`mixdog_migrate::run::cli::front`, the roots of `mixdogd migrate`), the lifecycle `migrating` while it runs: the plan and everything but the
//!    sessions. The sessions convert behind the serving core ([`Behind`]), so a first start after the update does not wait for them.
//!
//! Step 6 (composition, then the RPC listener and `serving`) is `serve`'s.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;

use mixdog_exthost::ExtDocumentText;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::index::ServingIndex;
use mixdog_migrate::run::Back;
use mixdog_migrate::run::Front;
use mixdog_migrate::run::MigrateOptions;
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
    /// The sessions of the earlier version still to convert, once the core serves; `None` when the migration is complete.
    pub behind: Option<Behind>,
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

/// The index of the serving core as the migration reaches it: bound once the core is composed, which is before any session converts.
#[derive(Default)]
pub struct ServingProjector {
    index: OnceLock<Arc<mixdog_store::sqlite::SqliteStore>>,
}

impl IndexProjector for ServingProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }

    fn serving(&self) -> Option<&dyn ServingIndex> {
        Some(self)
    }
}

impl ServingIndex for ServingProjector {
    fn adopt(&self, data: &Path, session: &str) -> Result<(), String> {
        let index = self.index.get().ok_or("the core's index is not open")?;
        index.adopt(data, session).map_err(|error| error.to_string())
    }
}

/// What the migration left for after the core serves ([`mixdog_migrate::run::Back`]): the sessions of the earlier version, converted one by one behind the serving core, each
/// listed as soon as it is verified. Nobody waits for it: a person's first start after the update opens on the settings, the projects and the stores alone.
pub struct Behind {
    back: Back,
    /// The migration's own extension host (its office extractor reads through it), closed when the conversion ends.
    pool: Arc<ExtHostPool>,
    runtime: tokio::runtime::Handle,
    projector: Arc<ServingProjector>,
    /// Set when the core stops: the conversion ends at its next step, as a kill would end it, and the next start resumes it.
    stopped: Arc<AtomicBool>,
    /// What the earlier version listed of its sessions (`mixdog_migrate::session::listed`), read before the core composed.
    listed: Vec<(String, serde_json::Map<String, serde_json::Value>)>,
}

/// The pending row of a session the earlier version listed by `row`: its message fields are the row's own, the rest is the header the row is built from.
fn pending_row(session: String, mut row: serde_json::Map<String, serde_json::Value>) -> (mixdog_store::summary::CatalogHead, mixdog_store::summary::MessageStats) {
    use serde_json::Value;
    let mut text = |key: &str| match row.shift_remove(key) {
        Some(Value::String(text)) => text,
        _ => String::new(),
    };
    let (preview, last) = (text("preview"), text("lastMessagePreview"));
    let mut count = |key: &str| row.shift_remove(key).and_then(|count| count.as_u64()).unwrap_or(0);
    let stats = mixdog_store::summary::MessageStats {
        count: count("messageCount"),
        real: count("realTurnCount"),
        incoming: row.shift_remove("incomingTail").and_then(|tail| serde_json::from_value(tail).ok()),
        preview,
        last,
        last_routine: row.shift_remove("lastMessageRoutine").unwrap_or(Value::Null),
    };
    (mixdog_store::summary::CatalogHead { session, log_id: mixdog_store::sqlite::PENDING_LOG_ID.to_owned(), base_session: None, header: row }, stats)
}

/// The sessions still to convert, as the directory asks for one that is opened.
struct Converting(Arc<mixdog_migrate::run::Waiting>);

impl mixdog_core_session::session::ArrivingThreads for Converting {
    fn arriving(&self, thread: &mixdog_protocol::ThreadId) -> Option<futures::future::BoxFuture<'static, ()>> {
        let (settled, there) = tokio::sync::oneshot::channel();
        let asked = self.0.first(thread.as_str(), Box::new(move || drop(settled.send(()))));
        asked.then(|| -> futures::future::BoxFuture<'static, ()> {
            Box::pin(async move {
                let _ = there.await;
            })
        })
    }
}

impl Behind {
    /// Lists every session still to convert by the row the earlier version kept of it, so the list is whole before the first client reads it. A session that version listed
    /// no row of appears when it is converted.
    pub async fn list(&mut self, index: &mixdog_store::sqlite::SqliteStore) {
        let waiting: std::collections::BTreeSet<String> = self.back.waiting().pending().into_iter().collect();
        let rows = std::mem::take(&mut self.listed).into_iter().filter(|(session, _)| waiting.contains(session));
        let written = futures::future::join_all(rows.map(|(session, row)| {
            let (head, stats) = pending_row(session, row);
            index.list_pending(head, stats)
        }))
        .await;
        if let Some(error) = written.into_iter().find_map(Result::err) {
            tracing::warn!(%error, "a session of the earlier version could not be listed before it is converted");
        }
    }

    /// The directory's view of the sessions still to convert: one that is opened is converted next.
    pub fn arriving(&self) -> Arc<dyn mixdog_core_session::session::ArrivingThreads> {
        Arc::new(Converting(self.back.waiting()))
    }

    /// Converts the rest on a thread of its own, taking each session into `index`; returns at once. `stop` is the core's run token.
    #[allow(clippy::disallowed_methods, reason = "the migration's own thread (RL §13): it blocks on files and on the index writer for as long as the sessions take")]
    pub fn run(self, index: Arc<mixdog_store::sqlite::SqliteStore>, stop: mixdog_rt::CancellationToken, report: impl Fn(&str) + Send + 'static) -> std::io::Result<()> {
        let Behind { back, pool, runtime, projector, stopped, .. } = self;
        let _ = projector.index.set(index.clone());
        drop(mixdog_rt::spawn("migration-stop", mixdog_rt::TaskClass::Work, async move {
            stop.cancelled().await;
            stopped.store(true, Ordering::SeqCst);
        }));
        let sessions = back.sessions();
        std::thread::Builder::new().name("mixdog-migrate".to_owned()).spawn(move || {
            let _entered = runtime.enter();
            let began = std::time::Instant::now();
            report(&format!("migration: converting {sessions} sessions of the earlier version behind the serving core"));
            let outcome = back.run();
            runtime.block_on(pool.close());
            let seconds = began.elapsed().as_secs();
            match outcome {
                Ok(_) => {
                    // A session listed by its pending row that the migration set aside is no session: its row goes.
                    let unlisted = runtime.block_on(async {
                        let left = index.pending_sessions().await?;
                        for session in &left {
                            index.mark_deleted(session).await?;
                        }
                        Ok::<_, mixdog_store::sqlite::DbError>(left.len())
                    });
                    report(&format!("migration: complete, {sessions} sessions in {seconds}s (pending rows withdrawn: {unlisted:?})"));
                }
                Err(blocked) => report(&format!("migration: ended early after {seconds}s, the next start resumes it: {blocked}")),
            }
        })?;
        Ok(())
    }
}

/// The migration's front on its own thread: its office extractor drives the extension host with the runtime's handle (`block_on`), which a lane job running on a worker may not do.
/// The host it uses is its own, closed when the migration ends; the core's starts later. `None`: the migration is complete.
fn migrate_data(data_dir: &Path, host: ExtHostConfig, runtime: &tokio::runtime::Handle) -> Result<Option<Behind>, String> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let roots = migration_roots(data_dir, &|name| std::env::var_os(name), std::env::home_dir())?;
                let _entered = runtime.enter();
                let pool = Arc::new(ExtHostPool::new(host).map_err(|error| format!("starting the extension host: {error}"))?);
                let office = OfficeExtractor { docs: Arc::new(ExtDocumentText::new(pool.clone())), runtime: runtime.clone() };
                let projector = Arc::new(ServingProjector::default());
                let stopped = Arc::new(AtomicBool::new(false));
                let data = roots.data.clone();
                let options = MigrateOptions {
                    // Half the machine: the sessions are listed sooner than the one-shot run's four converters would list them, and the serving core keeps the other half.
                    workers: std::thread::available_parallelism().map_or(4, usize::from).div_ceil(2).clamp(4, 12),
                    fault: Some({
                        let stopped = stopped.clone();
                        Arc::new(move |_| if stopped.load(Ordering::SeqCst) { Err(mixdog_migrate::error::Blocked::journal("the core is stopping")) } else { Ok(()) })
                    }),
                    verified: Some({
                        let (projector, data) = (projector.clone(), roots.data.clone());
                        Arc::new(move |session| {
                            // The index item takes in whatever is missed here, before the migration completes.
                            if let Err(error) = projector.adopt(&data, session) {
                                tracing::warn!(%error, session, "a converted session could not be listed yet");
                            }
                        })
                    }),
                    ..MigrateOptions::default()
                };
                match mixdog_migrate::run::cli::front(roots, projector.clone(), office, options) {
                    Ok(Front::Pending(back)) => {
                        let listed = mixdog_migrate::session::listed::rows(&data);
                        Ok(Some(Behind { back, pool, runtime: runtime.clone(), projector, stopped, listed }))
                    }
                    Ok(Front::Complete(_)) => {
                        runtime.block_on(pool.close());
                        Ok(None)
                    }
                    Err(blocked) => {
                        runtime.block_on(pool.close());
                        Err(blocked.to_string())
                    }
                }
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
    let behind: Arc<Mutex<Option<Behind>>> = Arc::default();
    let migrate = {
        let (data_dir, runtime, behind) = (data_dir.to_path_buf(), tokio::runtime::Handle::current(), behind.clone());
        move || {
            let left = migrate_data(&data_dir, host, &runtime)?;
            *behind.lock().unwrap_or_else(PoisonError::into_inner) = left;
            Ok(())
        }
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
    let behind = behind.lock().unwrap_or_else(PoisonError::into_inner).take();
    Ok(Begun { started, booting, watch, behind })
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