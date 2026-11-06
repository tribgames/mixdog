//! The core's startup, LR §3 steps 1 to 5 as one sequence (step 6, the serving discovery, is the
//! caller's):
//!
//! 1. the data-directory handle and the OS lock `L` ([`ownership::acquire`], on the maintenance
//!    lane); then the caller's `init` (step 2: the control listener and `booting`);
//! 2. the prior-owner verdict, judged without `B`, and on `clear` the take of `B` and the
//!    installation of the permanent claim barrier ([`Gate::step`], repeated while it blocks);
//! 3. the migration, which runs only now: no 1.4.5 process can own the directory again.
//!
//! Only then does [`start`] return a [`Started`], the proof that composition, the idle sweep
//! and the event pipeline require. A blocked verdict is handed to [`Publish`] (discovery and the
//! control listener answer it) and waited on outside every lane; the wait ends on the OS facts,
//! on a user `release{pid}` ([`Startup::releases`]) or on the interrupt, which refuses the start.

use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;

use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;

use crate::barrier::BarrierRecord;
use crate::ownership;
use crate::ownership::AcquireError;
use crate::ownership::CoreOwnership;
use crate::verdict::Blocked;
use crate::verdict::Gate;
use crate::verdict::GateError;
use crate::verdict::GateStep;
use crate::verdict::Interrupt;
use crate::verdict::ReleaseError;
use crate::verdict::Wake;

/// What startup needs to know.
pub struct Startup {
    pub data_dir: PathBuf,
    /// The legacy discovery the verdict reads (`<runtime root>/daemon.json`).
    pub discovery_path: PathBuf,
    pub record: BarrierRecord,
    /// Wakes a blocked wait: after a `release{pid}`, or to give up.
    pub interrupt: Arc<Interrupt>,
    /// The `release{pid}` decisions the control listener took, each followed by an interrupt.
    pub releases: mpsc::Receiver<u32>,
}

/// The lanes startup runs on: the gate's durable renames, and the blocking waits and migration.
#[derive(Clone, Copy)]
pub struct Lanes {
    pub durability: DurabilityIo,
    pub maintenance: MaintenanceIo,
}

/// Where startup shows its progress (LR §3 steps 3 and 5).
pub trait Publish {
    /// The verdict blocks: publish it on discovery and answer it on the control listener.
    fn blocked(&mut self, blocked: &Blocked);
    /// The barrier stands; the migration starts (`state:"migrating"`).
    fn migrating(&mut self);
}

/// Startup finished: the lock is held, the barrier is installed and pinned, the migration is
/// complete. Only [`start`] makes one.
#[derive(Clone)]
pub struct Started {
    ownership: Arc<CoreOwnership>,
}

impl Started {
    pub fn ownership(&self) -> &Arc<CoreOwnership> {
        &self.ownership
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    /// LR §3 step 1.
    #[error("{0}")]
    Ownership(#[from] AcquireError),
    #[error("{0}")]
    Gate(#[from] GateError),
    #[error("waiting on the prior owner: {0}")]
    Wait(#[source] io::Error),
    #[error("{0}")]
    Release(#[from] ReleaseError),
    /// The wait was interrupted with no decision to apply: the start is abandoned, `B` untouched.
    #[error("startup interrupted while the prior owner is still blocking")]
    Interrupted,
    /// LR §3 step 2: the control listener or the `booting` publication failed.
    #[error("control listener: {0}")]
    Init(String),
    #[error("migration blocked: {0}")]
    Migration(String),
    #[error("the startup lane refused the job")]
    Lane,
}

/// Runs the startup sequence. `init` is LR §3 step 2, awaited right after `L` and before the
/// verdict: the call site starts the control listener and publishes `booting` in it, so a blocked
/// verdict can be answered. `migrate` is the migration (`mixdog_migrate::run::cli::migrate` over
/// the call site's roots); it runs once, after the barrier.
pub async fn start(
    startup: Startup,
    lanes: Lanes,
    publish: &mut dyn Publish,
    init: impl Future<Output = Result<(), String>>,
    migrate: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<Started, StartupError> {
    let cancel = CancellationToken::new();
    // Creating the directory, opening the handle and taking the OS lock block: a maintenance job.
    let ownership = {
        let data_dir = startup.data_dir.clone();
        Arc::new(
            lanes
                .maintenance
                .submit(&cancel, move |_| ownership::acquire(&data_dir))
                .map_err(|_| StartupError::Lane)?
                .await
                .map_err(|_| StartupError::Lane)??,
        )
    };
    init.await.map_err(StartupError::Init)?;
    let Startup { discovery_path, record, interrupt, releases, .. } = startup;
    let mut gate = {
        let ownership = ownership.clone();
        lanes
            .durability
            .submit(&cancel, move |_| Gate::new(ownership, discovery_path, record))
            .map_err(|_| StartupError::Lane)?
            .await
            .map_err(|_| StartupError::Lane)?
            .map_err(GateError::Io)?
    };
    let mut decided = Vec::new();
    loop {
        let (returned, step) = lanes
            .durability
            .submit(&cancel, move |lane| {
                let step = decided.into_iter().try_for_each(|pid| gate.release(pid).map(drop)).map_err(StartupError::Release).and_then(|()| {
                    gate.step(lane).map_err(StartupError::Gate)
                });
                (gate, step)
            })
            .map_err(|_| StartupError::Lane)?
            .await
            .map_err(|_| StartupError::Lane)?;
        gate = returned;
        decided = Vec::new();
        let blocked = match step? {
            GateStep::Clear => break,
            GateStep::Blocked(blocked) => blocked,
        };
        publish.blocked(&blocked);
        let waiting = interrupt.clone();
        let wake = lanes
            .maintenance
            .submit(&cancel, move |_| blocked.wait(&waiting))
            .map_err(|_| StartupError::Lane)?
            .await
            .map_err(|_| StartupError::Lane)?
            .map_err(StartupError::Wait)?;
        if wake == Wake::Interrupted {
            decided.extend(releases.try_iter());
            if decided.is_empty() {
                return Err(StartupError::Interrupted);
            }
        }
    }
    publish.migrating();
    lanes
        .maintenance
        .submit(&cancel, move |_| migrate())
        .map_err(|_| StartupError::Lane)?
        .await
        .map_err(|_| StartupError::Lane)?
        .map_err(StartupError::Migration)?;
    Ok(Started { ownership })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering::SeqCst;

    use super::*;
    use crate::barrier::BARRIER_TOKEN_PREFIX;
    use crate::barrier::CLAIM_LOCK_FILE;
    use crate::verdict::BlockedKind;
    use crate::verdict::tests::TempData;
    use crate::verdict::tests::record;

    #[derive(Default)]
    struct Log {
        events: Vec<String>,
    }

    impl Publish for Log {
        fn blocked(&mut self, blocked: &Blocked) {
            let kind = match blocked.kind {
                BlockedKind::WaitExit => "waitExit",
                BlockedKind::WaitClaim => "waitClaim",
                BlockedKind::Undecidable => "undecidable",
            };
            self.events.push(format!("blocked:{kind}"));
        }

        fn migrating(&mut self) {
            self.events.push("migrating".into());
        }
    }

    fn startup(temp: &TempData) -> (Startup, mpsc::Sender<u32>) {
        let (release, releases) = mpsc::channel();
        let startup = Startup {
            data_dir: temp.data(),
            discovery_path: crate::discovery::path(&temp.runtime()),
            record: record(),
            interrupt: Arc::new(Interrupt::new().expect("interrupt")),
            releases,
        };
        (startup, release)
    }

    fn lanes() -> Lanes {
        let tokens = mixdog_rt::testing::tokens();
        Lanes { durability: tokens.durability_io, maintenance: tokens.maintenance_io }
    }

    async fn ok_init() -> Result<(), String> {
        Ok(())
    }

    /// LR §3 step 2 runs after `L` and before everything else; a failed init is a failed start.
    #[tokio::test]
    async fn init_runs_after_l_and_before_the_migration() {
        let temp = TempData::new();
        let data = temp.data();
        let (config, _release) = startup(&temp);
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let (seen, migrating) = (order.clone(), order.clone());
        let mut log = Log::default();
        let init = async move {
            assert!(matches!(ownership::acquire(&data), Err(AcquireError::AlreadyOwned)), "init ran before L");
            seen.lock().unwrap().push("init");
            Ok(())
        };
        start(config, lanes(), &mut log, init, move || {
            migrating.lock().unwrap().push("migrate");
            Ok(())
        })
        .await
        .expect("start");
        assert_eq!(*order.lock().unwrap(), ["init", "migrate"]);

        let temp = TempData::new();
        let (config, _release) = startup(&temp);
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        let outcome = start(config, lanes(), &mut Log::default(), async { Err("listener".into()) }, move || {
            flag.store(true, SeqCst);
            Ok(())
        })
        .await;
        assert!(matches!(outcome, Err(StartupError::Init(ref why)) if why == "listener"));
        assert!(!ran.load(SeqCst));
        assert!(temp.file(CLAIM_LOCK_FILE).is_none(), "B was installed after a failed init");
    }

    /// A failed migration is a failed start; the next start (B stands from the first) succeeds
    /// and runs the migration again, so a partial migration resumes.
    #[tokio::test]
    async fn a_start_that_fails_mid_migration_is_followed_by_one_that_succeeds() {
        let temp = TempData::new();
        let (config, _release) = startup(&temp);
        let outcome = start(config, lanes(), &mut Log::default(), ok_init(), || Err("journal".into())).await;
        assert!(matches!(outcome, Err(StartupError::Migration(ref why)) if why == "journal"));
        let barrier = temp.file(CLAIM_LOCK_FILE).expect("B stands after the failed start");
        assert!(String::from_utf8_lossy(&barrier).contains(BARRIER_TOKEN_PREFIX));

        let (config, _release) = startup(&temp);
        let migrated = Arc::new(AtomicBool::new(false));
        let flag = migrated.clone();
        let mut log = Log::default();
        let started = start(config, lanes(), &mut log, ok_init(), move || {
            flag.store(true, SeqCst);
            Ok(())
        })
        .await
        .expect("the second start");
        assert_eq!(log.events, ["migrating"]);
        assert!(migrated.load(SeqCst));
        assert!(matches!(ownership::acquire(&temp.data()), Err(AcquireError::AlreadyOwned)), "L is held for the core's life");
        drop(started);
    }
}
