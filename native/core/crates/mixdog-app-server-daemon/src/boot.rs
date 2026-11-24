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

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;

use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_exthost::ExtDocumentText;
use mixdog_exthost::ExtHostPool;

use mixdog_exthost::ExtHostConfig;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::index::ServingIndex;
use mixdog_migrate::run::Back;
use mixdog_migrate::run::Front;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Settled;
use mixdog_migrate::run::Waiting;
use mixdog_migrate::run::cli::MigrateArgs;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::SectionName;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use serde_json::json;

use crate::ServeError;
use crate::barrier::BarrierRecord;
use crate::lifecycle::DiscoveryPublication;
use crate::lifecycle::Lifecycle;
use crate::lifecycle::Migration;
use crate::lifecycle::Publication;
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
        BlockedKind::WaitExit | BlockedKind::WaitClaim if !blocked.releasable => crate::lifecycle::Blocked::WaitExit { pid: identity.pid },
        BlockedKind::WaitExit | BlockedKind::WaitClaim | BlockedKind::Undecidable => crate::lifecycle::Blocked::Undecidable {
            pid: identity.pid,
            image: blocked.process.image.as_ref().map(|image| image.to_string_lossy().into_owned()).unwrap_or_default(),
            command_line: blocked.process.command_line.clone().unwrap_or_default(),
            start_time: identity.start_ms.to_string(),
        },
    }
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

/// The product's retention as the migration asks it about a session before converting it: the sub-agent rule's own verdict
/// ([`mixdog_core_session::session::sub_agent_retention::deleted_before_conversion`]), and the product's purge for a session it
/// removes. Bound to the core's index and directory once the core is composed, which is before any session is judged.
pub struct ProductRetention {
    core: OnceLock<(Arc<mixdog_store::sqlite::SqliteStore>, Arc<mixdog_core_session::session::SessionDirectory>)>,
    runtime: tokio::runtime::Handle,
    data: std::path::PathBuf,
}

impl mixdog_migrate::framework::Retention for ProductRetention {
    fn now_ms(&self) -> u64 {
        mixdog_core_session::session::sub_agent_retention::now_ms() as u64
    }

    fn fields(&self) -> Vec<String> {
        mixdog_core_session::session::sub_agent_retention::judged_fields().into_iter().map(str::to_owned).collect()
    }

    fn candidate(&self, session: &str, header: &serde_json::Map<String, serde_json::Value>) -> bool {
        mixdog_core_session::session::sub_agent_retention::member(session, header).is_some()
    }

    fn expired(
        &self,
        sessions: &std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>>,
        held: &std::collections::BTreeSet<String>,
        now_ms: u64,
    ) -> std::collections::BTreeSet<String> {
        // Before the core's sessions are bound nothing is known of the archive authority: nothing is trusted, nothing expires.
        let directory = self.core.get().map(|(_, directory)| directory);
        let archive = |id: &str, header: &serde_json::Map<String, serde_json::Value>| match directory {
            Some(directory) => (directory.archive_resolved(id, header), directory.archive_state(id, header).trusted()),
            None => (header.clone(), false),
        };
        mixdog_core_session::session::sub_agent_retention::deleted_before_conversion(sessions, held, &archive, now_ms as f64)
    }

    fn unlisted(&self, sessions: &[String]) {
        let Some((index, _)) = self.core.get() else { return };
        let listed = match self.runtime.block_on(index.pending_sessions(&self.data)) {
            Ok(listed) => listed,
            Err(error) => {
                tracing::warn!(%error, "the rows of sessions removed unconverted could not be read; they are withdrawn when the migration completes");
                return;
            }
        };
        for session in listed.iter().filter(|session| sessions.contains(session)) {
            if let Err(error) = self.runtime.block_on(index.mark_deleted(session)) {
                tracing::warn!(%error, session, "the row of a session removed unconverted could not be withdrawn yet");
            }
        }
    }

    fn purge(&self, session: &str, header: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
        let (_, directory) = self.core.get().ok_or("the core's sessions are not bound")?;
        self.runtime.block_on(directory.purge_unconverted(session, header));
        Ok(())
    }
}

/// Runs what the front left, and tells `completed` when, and only when, it ran to the completion marker: what must not act on
/// sessions half converted (retention) starts there, and a run that ends early leaves it to the start that resumes it.
fn finish(back: Back, completed: impl FnOnce()) -> Result<mixdog_store::schema::migration::Complete, mixdog_migrate::error::Blocked> {
    let outcome = back.run();
    if outcome.is_ok() {
        completed();
    }
    outcome
}

/// What the migration left for after the core serves ([`mixdog_migrate::run::Back`]): the sessions of the earlier version, converted one by one behind the serving core, each
/// listed as soon as it is verified. Nobody waits for it: a person's first start after the update opens on the settings, the projects and the stores alone.
pub struct Behind {
    back: Back,
    pub(crate) legacy_homes: Arc<crate::compose::LegacyHomes>,
    /// The migration's own extension host (its office extractor reads through it), closed when the conversion ends.
    pool: Arc<ExtHostPool>,
    runtime: tokio::runtime::Handle,
    projector: Arc<ServingProjector>,
    retention: Arc<ProductRetention>,
    /// Set when the core stops: the conversion ends at its next step, as a kill would end it, and the next start resumes it.
    stopped: Arc<AtomicBool>,
    /// What the earlier version listed of its sessions (`mixdog_migrate::session::listed`), read before the core composed.
    listed: Vec<(String, serde_json::Map<String, serde_json::Value>)>,
    data: std::path::PathBuf,
}

/// The pending row of a session the earlier version listed by `row`: its message fields are the row's own, the rest is the header the row is built from.
fn pending_row(
    session: String,
    mut row: serde_json::Map<String, serde_json::Value>,
) -> (mixdog_store::summary::CatalogHead, mixdog_store::summary::MessageStats) {
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

/// Withdraws the rows of sessions listed as still to convert that the migration, now complete, did not convert (it set them aside): such a row lists a session there is
/// none of. Run when the conversion completes and at every start that finds the migration complete, so a process that ended between the two leaves none behind.
pub async fn withdraw_pending(index: &mixdog_store::sqlite::SqliteStore, data: &Path) -> Result<usize, mixdog_store::sqlite::DbError> {
    let left = index.pending_sessions(data).await?;
    for session in &left {
        index.mark_deleted(session).await?;
    }
    Ok(left.len())
}

/// What the migration set aside (quarantined, expected or not) by `<data>/migration/complete.json`: how many items, where they are
/// (`<data>/quarantine`), and the completed migration's identity (its manifest digest), which a client keys "told once" by. `None`
/// while the migration has not completed, when it set nothing aside, or when the record cannot be read.
pub fn set_aside_of(data: &Path) -> Option<serde_json::Value> {
    use mixdog_store::schema::migration::COMPLETE_PATH;
    use mixdog_store::schema::migration::Complete;
    use mixdog_store::schema::migration::QUARANTINE_DIR;
    let bytes = mixdog_statefile::read_content(&data.join(COMPLETE_PATH)).ok().flatten()?;
    let complete: Complete = serde_json::from_slice(&bytes).ok()?;
    let (kept, profile) = (complete.kinds.data, complete.kinds.desktop_profile);
    let count = kept.quarantined_expected + kept.quarantined_unexpected + profile.quarantined_expected + profile.quarantined_unexpected;
    (count > 0).then(|| {
        json!({
            "id": complete.manifest_sha256,
            "count": count,
            "unexpected": kept.quarantined_unexpected + profile.quarantined_unexpected,
            "dir": data.join(QUARANTINE_DIR).display().to_string(),
        })
    })
}

/// The `migration` app section once nothing converts: what the completed migration set aside, for a client to tell the person once.
/// Published at every start that finds the migration complete and at the end of the conversion behind the serving core.
pub fn publish_migration_settled(publisher: &dyn StatePublisher, data: &Path) {
    let value = json!({ "converting": false, "done": 0, "total": 0, "setAside": set_aside_of(data) });
    publisher.publish(SectionName::Migration, None, change_of(&value));
}

/// The conversion of the earlier version's sessions behind the serving core, as the `migration` app section tells a client
/// (`{converting: true, done, total}`: its conversation list is still filling), and the rows of the sessions it sets aside, withdrawn
/// as each is set aside rather than when the whole conversion completes: such a row names a conversation there is none of, and
/// opening it fails. The migration tells it of each session as it settles ([`Waiting::watch`]), on the converter's thread and before
/// an open of that session goes on; a run that ends early tells it nothing of what it leaves to the next start.
struct Settling {
    publisher: Arc<dyn StatePublisher>,
    /// Withdraws the pending row of a session set aside.
    withdraw: Box<dyn Fn(&str) + Send + Sync>,
    /// The sessions still to settle as the watch began.
    initial: OnceLock<BTreeSet<String>>,
    /// How many of them have settled: published under this lock, so a client is told it only growing.
    done: Mutex<usize>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Settling {
    /// Watches the conversion that begins now and tells the clients how much it has to settle.
    fn watch(waiting: &Waiting, publisher: Arc<dyn StatePublisher>, withdraw: Box<dyn Fn(&str) + Send + Sync>) {
        let settling = Arc::new(Settling { publisher, withdraw, initial: OnceLock::new(), done: Mutex::new(0) });
        let told = settling.clone();
        // Held until the sessions to settle are known: one that settles meanwhile is counted against them.
        let done = locked(&settling.done);
        let initial = waiting.watch(Arc::new(move |sessions: &[String], how| told.settled(sessions, how)));
        let _ = settling.initial.set(initial.into_iter().collect());
        settling.publish(*done);
        drop(done);
    }

    fn settled(&self, sessions: &[String], how: Settled) {
        if how == Settled::Quarantined {
            sessions.iter().for_each(|session| (self.withdraw)(session));
        }
        let mut done = locked(&self.done);
        let Some(initial) = self.initial.get() else { return };
        let counted = sessions.iter().filter(|session| initial.contains(*session)).count();
        if counted == 0 {
            return;
        }
        *done = (*done + counted).min(initial.len());
        self.publish(*done);
    }

    fn publish(&self, done: usize) {
        let total = self.initial.get().map_or(0, BTreeSet::len);
        let value = json!({ "converting": true, "done": done, "total": total, "setAside": null });
        self.publisher.publish(SectionName::Migration, None, change_of(&value));
    }
}

/// Node's first read of a config that does not parse keeps it aside and restores the newest backup (`readAll`): the migration then reads a
/// config that parses, or none, and a damaged file never stops the start. `mixdogd migrate` runs it too, before its own run. Not from an async context.
pub fn recover_malformed_config(data_dir: &Path, tokens: &LaneTokens, runtime: &tokio::runtime::Handle) -> Result<(), String> {
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    runtime
        .block_on(Config::recover_malformed(crate::compose_flip::config_file(data_dir), lanes))
        .map_err(|error| format!("recovering {}: {error}", mixdog_core_config::user_data::CONFIG_FILE))
}

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
/// The roots the serving core migrates. It names no desktop profile of its own: the launcher's `MIXDOG_DESKTOP_USER_DATA` in `env` is the only way one is migrated (D-profile-1).
fn migration_roots(data_dir: &Path, env: &dyn Fn(&str) -> Option<std::ffi::OsString>, home: Option<std::path::PathBuf>) -> Result<MigrationRoots, String> {
    let args = MigrateArgs { data_dir: Some(data_dir.to_path_buf()), home: None, desktop_profile: None };
    mixdog_migrate::run::cli::resolve_roots(&args, env, home).ok_or_else(|| "no home directory for the migration roots (set MIXDOG_HOME or HOME)".to_owned())
}
/// The sessions still to convert, as the directory asks for one that is opened.
struct Converting(Arc<mixdog_migrate::run::Waiting>);
impl mixdog_core_session::session::ArrivingThreads for Converting {
    fn arriving(&self, thread: &mixdog_protocol::ThreadId) -> Option<futures::future::BoxFuture<'static, ()>> {
        let (settled, there) = tokio::sync::oneshot::channel();
        let asked = self.0.first(
            thread.as_str(),
            Box::new(move || {
                let _ = settled.send(());
            }),
        );
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
        let rows: Vec<_> = std::mem::take(&mut self.listed).into_iter().filter(|(session, _)| waiting.contains(session)).collect();
        let ids: Vec<String> = rows.iter().map(|(session, _)| session.clone()).collect();
        // What the desktop kept of a session (the name a person gave it, its archive mark) is what its converted header will carry.
        let kept = self.back.listed_meta(&ids);
        let sessions = rows
            .into_iter()
            .zip(kept)
            .map(|((session, mut row), kept)| {
                // The row's own title outranks the desktop's legacy one, as it does when the session is converted.
                if let Some(kept) = mixdog_migrate::session::without_outranked_title(&row, kept) {
                    row.extend(kept);
                }
                pending_row(session, row)
            })
            .collect();
        if let Err(error) = index.list_pending(sessions).await {
            tracing::warn!(%error, "the sessions of the earlier version could not be listed before they are converted");
        }
    }

    /// The directory's view of the sessions still to convert: one that is opened is converted next.
    pub fn arriving(&self) -> Arc<dyn mixdog_core_session::session::ArrivingThreads> {
        Arc::new(Converting(self.back.waiting()))
    }

    /// Converts the rest on a thread of its own, taking each session into `index`; returns at once. `stop` is the core's run token.
    /// `completed` runs on that thread once the conversion has run to its completion marker, never when it ends early. The clients
    /// are told through `publisher` how far it has come (`migration` section), and once it completes what it set aside.
    #[allow(
        clippy::disallowed_methods,
        reason = "the migration's own thread (RL §13): it blocks on files and on the index writer for as long as the sessions take"
    )]
    pub fn run(
        self,
        index: Arc<mixdog_store::sqlite::SqliteStore>,
        directory: Arc<mixdog_core_session::session::SessionDirectory>,
        publisher: Arc<dyn StatePublisher>,
        stop: mixdog_rt::CancellationToken,
        report: impl Fn(&str) + Send + 'static,
        completed: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<()> {
        let Behind { back, pool, runtime, projector, retention, stopped, data, .. } = self;
        let _ = projector.index.set(index.clone());
        let _ = retention.core.set((index.clone(), directory));
        let withdraw = {
            let (index, runtime) = (index.clone(), runtime.clone());
            // On the converter's thread, as the retention's withdrawals run.
            Box::new(move |session: &str| {
                if let Err(error) = runtime.block_on(index.mark_deleted(session)) {
                    tracing::warn!(%error, session, "the row of a session the migration set aside could not be withdrawn yet");
                }
            })
        };
        Settling::watch(&back.waiting(), publisher.clone(), withdraw);
        drop(mixdog_rt::spawn("migration-stop", mixdog_rt::TaskClass::Work, async move {
            stop.cancelled().await;
            stopped.store(true, Ordering::SeqCst);
        }));
        let sessions = back.sessions();
        std::thread::Builder::new().name("mixdog-migrate".to_owned()).spawn(move || {
            let _entered = runtime.enter();
            let began = std::time::Instant::now();
            report(&format!("migration: converting {sessions} sessions of the earlier version behind the serving core"));
            let outcome = finish(back, completed);
            runtime.block_on(pool.close());
            let seconds = began.elapsed().as_secs();
            match outcome {
                Ok(_) => {
                    let unlisted = runtime.block_on(withdraw_pending(&index, &data));
                    // The steps that run after the migration (what the running database carries over), with what each recorded.
                    let after = match mixdog_migrate::post_upgrade::read_report(&data) {
                        Ok(read) => read.steps_line(),
                        Err(error) => format!("unreadable ({error})"),
                    };
                    report(&format!(
                        "migration: complete, {sessions} sessions in {seconds}s (pending rows withdrawn: {unlisted:?}; post-upgrade steps: {after})"
                    ));
                    publish_migration_settled(publisher.as_ref(), &data);
                }
                Err(blocked) => {
                    report(&format!("migration: ended early after {seconds}s, the next start resumes it: {blocked}"));
                    // Nothing converts until the next start: the clients are not told it still does.
                    publish_migration_settled(publisher.as_ref(), &data);
                }
            }
        })?;
        Ok(())
    }
}
/// The migration's front on its own thread: its office extractor drives the extension host with the runtime's handle (`block_on`), which a lane job running on a worker may not do.
/// The host it uses is its own, closed when the migration ends; the core's starts later. `None`: the migration is complete.
fn migrate_data(data_dir: &Path, host: ExtHostConfig, tokens: LaneTokens, runtime: &tokio::runtime::Handle) -> Result<Option<Behind>, String> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let roots = migration_roots(data_dir, &|name| std::env::var_os(name), std::env::home_dir())?;
                let _entered = runtime.enter();
                recover_malformed_config(&roots.data, &tokens, runtime)?;
                let pool = Arc::new(ExtHostPool::new(host).map_err(|error| format!("starting the extension host: {error}"))?);
                let office = OfficeExtractor { docs: Arc::new(ExtDocumentText::new(pool.clone())), runtime: runtime.clone() };
                let projector = Arc::new(ServingProjector::default());
                let stopped = Arc::new(AtomicBool::new(false));
                let data = roots.data.clone();
                let retention = Arc::new(ProductRetention { core: OnceLock::new(), runtime: runtime.clone(), data: data.clone() });
                let options = MigrateOptions {
                    retention: Some(retention.clone()),
                    // Half the machine: the sessions are listed sooner than the one-shot run's four converters would list them, and the serving core keeps the other half.
                    workers: std::thread::available_parallelism().map_or(4, usize::from).div_ceil(2).clamp(4, 12),
                    fault: Some({
                        let stopped = stopped.clone();
                        Arc::new(
                            move |_| if stopped.load(Ordering::SeqCst) { Err(mixdog_migrate::error::Blocked::journal("the core is stopping")) } else { Ok(()) },
                        )
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
                };
                match mixdog_migrate::run::cli::front(roots, projector.clone(), office, options) {
                    Ok(Front::Pending(back)) => {
                        let homes = back.home_evidence(mixdog_core_session::session::agent_evidence::HomeEvidence::from_history);
                        let legacy_homes = match homes {
                            Ok(homes) => Arc::new(homes),
                            Err(error) => {
                                runtime.block_on(pool.close());
                                return Err(error.to_string());
                            }
                        };
                        let listed = mixdog_migrate::session::listed::rows(&data);
                        Ok(Some(Behind { back, legacy_homes, pool, runtime: runtime.clone(), projector, retention, stopped, listed, data }))
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
        let tokens = *tokens;
        move || {
            let left = migrate_data(&data_dir, host, tokens, &runtime)?;
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
    let booting = booted.lock().unwrap_or_else(PoisonError::into_inner).take();
    let behind = behind.lock().unwrap_or_else(PoisonError::into_inner).take();
    let outcome = match watch.requested() {
        Some(signal) => Err(ServeError::StoppedDuringStartup(signal.name())),
        None => started.map_err(ServeError::from),
    };
    let started = match outcome {
        Ok(started) => started,
        Err(error) => {
            abandon(tokens, booting.map(|booting| booting.discovery), behind).await;
            return Err(error);
        }
    };
    crate::stale_temps::sweep_summary_temps_of_start(tokens, data_dir).await;
    let booting = booting.expect("startup ran init before it returned");
    Ok(Begun { started, booting, watch, behind })
}

/// A start abandoned before the core serves (a stop request, a failed step, composition or attach) gives back what the boot published
/// and started, since no release runs to do it: the discovery document naming this core is withdrawn (dropped, the publication leaves
/// it), and the migration's extension host is closed and awaited (dropped, it is only asked to leave, on a runtime about to end).
pub async fn abandon(tokens: &LaneTokens, discovery: Option<Arc<DiscoveryPublication>>, behind: Option<Behind>) {
    if let Some(behind) = behind {
        behind.pool.close().await;
    }
    let Some(discovery) = discovery else { return };
    // The withdrawal waits for the discovery writer's thread: a lane job, off the runtime's workers.
    let withdrawn = match tokens.durability_io.submit(&mixdog_rt::CancellationToken::new(), move |_lane| discovery.withdraw()) {
        Ok(job) => job.await.map_err(|error| error.to_string()),
        Err(_) => Err("the durability lane is full".to_owned()),
    };
    if let Err(error) = withdrawn {
        tracing::error!(%error, "the discovery of the abandoned start was not withdrawn");
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test writes the migration record of its own temporary directory")]
mod set_aside_tests {
    use super::*;

    fn complete(data: &Path, data_counts: (u64, u64), profile_counts: (u64, u64)) {
        let counts = |(expected, unexpected): (u64, u64)| {
            json!({ "verified": 5, "quarantined_expected": expected, "quarantined_unexpected": unexpected, "retired": 0, "retained": 0, "dangling": 0 })
        };
        let record = json!({
            "format": 1,
            "manifest_sha256": "abc",
            "journal_end_ordinal": 9,
            "kinds": { "data": counts(data_counts), "desktopProfile": counts(profile_counts) },
        });
        std::fs::create_dir_all(data.join("migration")).unwrap();
        std::fs::write(data.join(mixdog_store::schema::migration::COMPLETE_PATH), record.to_string()).unwrap();
    }

    /// What the completed migration set aside is told by its record: every quarantined item, expected or not, where they are, and the
    /// migration's identity; nothing while it has not completed or when it set nothing aside.
    #[test]
    fn the_set_aside_items_are_counted_from_the_completed_migration() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(set_aside_of(root.path()), None, "no record: the migration has not completed");
        complete(root.path(), (0, 0), (0, 0));
        assert_eq!(set_aside_of(root.path()), None, "nothing set aside: nothing to tell");
        complete(root.path(), (1, 2), (0, 3));
        let told = set_aside_of(root.path()).expect("items were set aside");
        assert_eq!(told["count"], 6);
        assert_eq!(told["unexpected"], 5);
        assert_eq!(told["id"], "abc");
        assert_eq!(told["dir"], root.path().join("quarantine").display().to_string());
    }

    struct Told(Mutex<Vec<serde_json::Value>>);

    impl StatePublisher for Told {
        fn publish(&self, _section: SectionName, _key: Option<String>, change: mixdog_core_api::state::SectionChange) {
            let mixdog_core_api::state::SectionChange::Set(bytes) = change else { panic!("the migration section is inline") };
            self.0.lock().unwrap().push(serde_json::from_slice(&bytes).unwrap());
        }
    }

    /// Only a session the migration says it quarantined has its row withdrawn, as it settles (one converted or removed by the
    /// retention keeps its own); what has settled is counted as each is told, and told to the clients only growing.
    #[test]
    fn a_quarantined_session_has_its_row_withdrawn_as_it_settles_and_the_count_only_grows() {
        let told = Arc::new(Told(Mutex::default()));
        let withdrawn = Arc::new(Mutex::new(Vec::<String>::new()));
        let settling = Settling {
            publisher: told.clone(),
            withdraw: {
                let withdrawn = withdrawn.clone();
                Box::new(move |session: &str| withdrawn.lock().unwrap().push(session.to_owned()))
            },
            initial: OnceLock::from(["a", "b", "c", "d"].map(str::to_owned).into_iter().collect::<BTreeSet<String>>()),
            done: Mutex::new(0),
        };
        settling.settled(&["a".to_owned()], Settled::Verified);
        settling.settled(&["b".to_owned()], Settled::Quarantined);
        settling.settled(&["c".to_owned()], Settled::Removed);
        settling.settled(&["x".to_owned()], Settled::Verified);
        assert_eq!(*withdrawn.lock().unwrap(), ["b"]);
        let published = told.0.lock().unwrap();
        let done: Vec<u64> = published.iter().map(|value| value["done"].as_u64().unwrap()).collect();
        assert_eq!(done, [1, 2, 3], "one more as each is told; none for a session it was not waiting on");
        assert!(published.iter().all(|value| value["converting"] == true && value["total"] == 4));
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test reads the discovery file of its own temporary directory")]
mod abandon_tests {
    use super::*;
    use crate::discovery;
    use crate::lifecycle::DiscoveryPhase;
    use crate::lifecycle::DiscoveryState;

    /// A start abandoned before the core serves leaves no discovery document naming it: the `booting` one its boot published is withdrawn.
    #[tokio::test]
    async fn an_abandoned_start_withdraws_the_discovery_it_published() {
        let root = tempfile::tempdir().unwrap();
        let base = discovery::Discovery {
            pid: 1,
            endpoints: discovery::Endpoints { session: discovery::SessionEndpoint { port: 4001, token: "tok".into() }, model_proxy: None },
            core: discovery::CoreSection {
                version: "1.5.0".into(),
                build: "b".into(),
                instance_id: "inst".into(),
                process_start_time: "1".into(),
                state: discovery::CoreState::Booting,
                blocked: None,
                drain: None,
                rpc: None,
                ssh_rpc: None,
                rebuild: None,
                control: discovery::Port { port: 4001 },
            },
        };
        let publication = Arc::new(DiscoveryPublication::new(root.path().to_path_buf(), base, Box::new(|_| {})));
        publication.publish(&DiscoveryState { phase: DiscoveryPhase::Booting, blocked: None, drain_id: None });
        publication.flush();
        assert!(discovery::path(root.path()).exists(), "the booting core is published");
        abandon(&mixdog_rt::testing::tokens(), Some(publication), None).await;
        assert!(!discovery::path(root.path()).exists(), "the abandoned start's discovery is withdrawn");
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests over files of their own temporary directory")]
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

        /// The roots of this run, over an environment of this run alone plus `extra`.
        fn roots(&self, extra: &[(&str, std::path::PathBuf)]) -> MigrationRoots {
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
            migration_roots(&self.data(), &env, Some(home)).unwrap()
        }

        /// Boots the migration the way `migrate_data` does.
        fn migrate(&self, extra: &[(&str, std::path::PathBuf)]) {
            let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
            let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: runtime.handle().clone() };
            mixdog_migrate::run::cli::migrate(self.roots(extra), Arc::new(StoreProjector), office).unwrap();
        }

        /// The front of a serving core's migration: what is left is the sessions.
        fn front(&self, fault: Option<mixdog_migrate::framework::FaultHook>) -> (tokio::runtime::Runtime, Back) {
            let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
            let back = self.front_on(&runtime, fault, None);
            (runtime, back)
        }

        /// [`Self::front`] on `runtime`, with the retention the core gives the migration.
        fn front_on(
            &self,
            runtime: &tokio::runtime::Runtime,
            fault: Option<mixdog_migrate::framework::FaultHook>,
            retention: Option<Arc<dyn mixdog_migrate::framework::Retention>>,
        ) -> Back {
            let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: runtime.handle().clone() };
            let options = MigrateOptions { workers: 1, fault, verified: Some(Arc::new(|_| {})), retention };
            match mixdog_migrate::run::cli::front(self.roots(&[]), Arc::new(StoreProjector), office, options).unwrap() {
                Front::Pending(back) => back,
                Front::Complete(_) => panic!("the sessions are left"),
            }
        }
    }

    /// The product's verdict and its purge of a session removed unconverted, the purge over the real file hooks
    /// (`purge::FileHooks`, with the read state's file store): what `ProductRetention` does through the composed core, without
    /// the owners that keep a session's state in memory.
    struct FilePurge {
        hooks: mixdog_core_session::session::delete::PurgeHooks,
        runtime: tokio::runtime::Handle,
    }

    impl FilePurge {
        fn new(runtime: &tokio::runtime::Runtime, data: &Path, mixdog_home: &Path) -> Arc<Self> {
            use mixdog_core_session::session::delete::PurgeHook;
            let _entered = runtime.enter();
            let tokens = mixdog_rt::testing::tokens();
            let snapshots = Arc::new(mixdog_core::run_host::read_snapshots::FileSnapshotPersist::new(data));
            let read_state = Arc::new(mixdog_tools::fs::ReadState::new(Some(mixdog_tools::fs::Persistence::new(snapshots, tokens.durability_io))));
            let files = mixdog_core_session::session::purge::FileHooks::new(mixdog_core_session::session::purge::FileOwners {
                data_dir: data.to_path_buf(),
                mixdog_home: mixdog_home.to_path_buf(),
                maintenance: tokens.maintenance_io,
                read_state,
                ingest_offsets: None,
                transcripts: None,
            });
            let none =
                || -> Arc<dyn PurgeHook> { Arc::new(|_: &str, _: &[String]| -> futures::future::BoxFuture<'static, ()> { Box::pin(std::future::ready(())) }) };
            let hooks = mixdog_core_session::session::delete::PurgeHooks::with_files(files, none(), none(), none(), none(), none());
            Arc::new(Self { hooks, runtime: runtime.handle().clone() })
        }
    }

    impl mixdog_migrate::framework::Retention for FilePurge {
        fn now_ms(&self) -> u64 {
            mixdog_core_session::session::sub_agent_retention::now_ms() as u64
        }
        fn fields(&self) -> Vec<String> {
            mixdog_core_session::session::sub_agent_retention::judged_fields().into_iter().map(str::to_owned).collect()
        }
        fn candidate(&self, session: &str, header: &serde_json::Map<String, serde_json::Value>) -> bool {
            mixdog_core_session::session::sub_agent_retention::member(session, header).is_some()
        }
        fn expired(
            &self,
            sessions: &std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>>,
            held: &std::collections::BTreeSet<String>,
            now_ms: u64,
        ) -> std::collections::BTreeSet<String> {
            let trusted = |_: &str, header: &serde_json::Map<String, serde_json::Value>| (header.clone(), true);
            mixdog_core_session::session::sub_agent_retention::deleted_before_conversion(sessions, held, &trusted, now_ms as f64)
        }
        fn unlisted(&self, _: &[String]) {}
        fn purge(&self, session: &str, header: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
            let cwds: Vec<String> = header.get("cwd").and_then(serde_json::Value::as_str).map(str::to_owned).into_iter().collect();
            self.runtime.block_on(async {
                for hook in self.hooks.unconverted_hooks() {
                    hook.purge(session, &cwds).await;
                }
            });
            Ok(())
        }
    }

    /// A worker the retention deletes is removed unconverted. The serving core's run that finishes the migration removes
    /// its project transcript, its scratch folder and its read snapshot with its sources; a run without the core
    /// (`mixdogd migrate`) finishes nothing of it and leaves all of them where they are.
    #[test]
    fn a_skipped_workers_transcript_scratch_and_read_snapshot_go_with_the_core_and_stay_without_it() {
        for with_core in [true, false] {
            let run = Isolated::new();
            let now = mixdog_core_session::session::sub_agent_retention::now_ms() as u64;
            let day = 24 * 60 * 60 * 1000;
            let cwd = run.root.path().join("proj").to_string_lossy().into_owned();
            let worker = serde_json::json!({
                "id": "sess_worker", "agent": "worker", "visibility": "agent-only", "ownerSessionId": "sess_lead", "parentSessionId": "sess_lead",
                "cwd": cwd, "lastUsedAt": now - 8 * day, "messages": [{ "role": "user", "content": "hi" }]
            });
            let kept = serde_json::json!({ "id": "sess_kept", "lastUsedAt": now - day, "messages": [{ "role": "user", "content": "hi" }] });
            let source = run.data().join("sessions").join("sess_worker.json");
            let mixdog_home = run.root.path().join("home").join(".mixdog");
            let transcript = mixdog_home.join("projects").join(mixdog_core_session::session::purge::project_slug(&cwd)).join("sess_worker.jsonl");
            let scratch = mixdog_tools::exec::session_scratch_dir(&run.data(), "sess_worker").unwrap().join("note.txt");
            let snapshot = run.data().join("read-snapshots").join("sess_worker.json");
            durable::publish_file(&source, worker.to_string().as_bytes()).unwrap();
            durable::publish_file(&run.data().join("sessions").join("sess_kept.json"), kept.to_string().as_bytes()).unwrap();
            for of_worker in [&transcript, &scratch, &snapshot] {
                durable::publish_file(of_worker, b"{}").unwrap();
            }
            let left = || [&source, &transcript, &scratch, &snapshot].map(|path| path.exists());
            let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
            let retention = FilePurge::new(&runtime, &run.data(), &mixdog_home);
            // The core is stopped once every session is settled, before anything is disposed of.
            let cut = "counts:before";
            let stop: mixdog_migrate::framework::FaultHook =
                Arc::new(move |point| if point == cut { Err(mixdog_migrate::error::Blocked::Interrupted { point: cut.into() }) } else { Ok(()) });
            let back = run.front_on(&runtime, Some(stop), Some(retention.clone()));
            assert!(finish(back, || {}).is_err(), "the run ends before disposal");
            assert!(!run.data().join("sessions").join("sess_worker").exists(), "the worker is not converted");
            assert_eq!(left(), [true; 4], "nothing of the worker is removed before disposal");

            if with_core {
                let back = run.front_on(&runtime, None, Some(retention));
                finish(back, || {}).unwrap();
                assert_eq!(left(), [false; 4], "the core finishes the skip: sources, transcript, scratch and read snapshot");
            } else {
                let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: runtime.handle().clone() };
                let refused = mixdog_migrate::run::cli::migrate(run.roots(&[]), Arc::new(StoreProjector), office).unwrap_err();
                assert!(refused.to_string().contains("start the core"), "{refused}");
                assert_eq!(left(), [true; 4], "a run without the core removes nothing of the worker");
            }
        }
    }

    /// Retention starts when the conversion has run to its completion marker. A conversion that ends with an old parent
    /// converted and its recently used child still to convert does not start it: it would judge the parent's tree by the
    /// parent alone. The start that resumes the conversion and completes it starts retention, once.
    #[test]
    fn retention_starts_when_the_conversion_completes_and_not_while_a_child_is_still_to_convert() {
        let run = Isolated::new();
        let now = mixdog_core_session::session::sub_agent_retention::now_ms() as u64;
        let day = 24 * 60 * 60 * 1000;
        let session = |id: &str, last_used: u64, parent: &str| {
            let body = format!(
                r#"{{"id":"{id}","agent":"worker","ownerSessionId":"{parent}","parentSessionId":"{parent}","lastUsedAt":{last_used},"messages":[{{"role":"user","content":"hi"}}]}}"#
            );
            let path = run.data().join("sessions").join(format!("{id}.json"));
            durable::publish_file(&path, body.as_bytes()).unwrap();
            path
        };
        session("sess_parent", now - 30 * day, "sess_lead");
        let child = session("sess_child", now - day, "sess_parent");
        // The sessions convert newest file first: the child's file is the older one, so the parent converts before it.
        std::fs::File::options().write(true).open(&child).unwrap().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
        let started = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let start = || {
            let started = started.clone();
            move || {
                started.fetch_add(1, Ordering::SeqCst);
            }
        };
        let cut = "journal:sources:session/sess_child:before";
        let stop: mixdog_migrate::framework::FaultHook =
            Arc::new(move |point| if point == cut { Err(mixdog_migrate::error::Blocked::Interrupted { point: cut.into() }) } else { Ok(()) });

        let (_runtime, back) = run.front(Some(stop));
        assert!(finish(back, start()).is_err(), "the conversion ends at the child");
        assert!(run.data().join("sessions/sess_parent").is_dir(), "the old parent is converted");
        assert!(!run.data().join("sessions/sess_child").exists(), "its child is still to convert");
        assert_eq!(started.load(Ordering::SeqCst), 0, "retention must not see the parent without its child");

        let (_runtime, back) = run.front(None);
        finish(back, start()).unwrap();
        assert!(run.data().join("sessions/sess_child").is_dir());
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }
}
