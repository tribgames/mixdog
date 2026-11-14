//! The MCP scopes of the sessions: Node's runtime-owned `rt.mcpScopeId` (`boot/begin.mjs:24`) and
//! the connection lifecycle it carries, over the one [`McpHub`] (a scope is a key into it).
//!
//! Node's runtime serializes its connection operations (`state.mcpConnectInFlight`,
//! `mcp-glue/connect.mjs:55-107`), numbers its full connects (`state.mcpConnectGeneration`, `:101`;
//! a scoped toggle queued behind a newer full connect bails, `:86`) and aborts connects that a
//! close overtakes (`connectServer`'s `genAtStart`, `mcp/client.mjs:138-150,199,405,447`;
//! `disconnectAll({ scopeId })`, `:1183-1197`). Here:
//!
//! * **Serialization.** Every scope has one chain ([`SerialChain`]); an operation resolves its
//!   configuration *inside* its turn, so it is never older than the operation before it.
//! * **Generations.** The hub keeps each scope's generation and release mark
//!   ([`McpHub::apply_at`]): an operation applies only if the scope is unreleased and no newer full
//!   connect was requested since it was, checked and applied under one lock. A release makes every
//!   operation in flight or queued void at once and for ever (the mark is never cleared). The first
//!   connect's generation is reserved when the scope is registered, before any request can see it.
//! * **Readiness.** The first connect of a scope runs in a task of its own; everyone else, openers
//!   and later operations alike, waits for it to settle, so no one sees a half-opened scope and the
//!   first connect is the first operation of the scope.
//! * **Ownership.** A scope belongs to the owner that opened it, and [`ScopeRuntime::release`]
//!   releases what an owner holds exactly once (the cell leaves the table in the same step that
//!   retires the scope). An owner that was released cannot open a scope any more. The runtime
//!   scope ([`ScopeRuntime::open_runtime`]) belongs to the daemon: its id is the hub's, it is
//!   opened once at boot, and nothing releases or hands it on.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::SerialChain;
use mixdog_rt::TaskClass;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::config::McpServerConfig;
use crate::hub::McpHub;
use crate::hub::ScopeReleased;
use crate::hub::close_retired;
use crate::hub::normalize_scope;
use crate::server::McpServer;
use crate::server::ServerState;

/// One connection operation (`connectConfiguredMcp`'s `reset`, `only`/`enabled`, `reconcile`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Reset,
    Only(String, bool),
    Reconcile,
}

/// What a scope is configured to run.
pub struct Resolved {
    /// The connections the catalog asks for.
    pub configs: Vec<McpServerConfig>,
    /// The hub server names an `Op::Only` stands for (an account name, or all accounts of a connector).
    pub targets: Vec<String>,
    /// The data folder (`_mixdogPlugin.data`) of each enabled plugin server the catalog names, by that name: what an
    /// operation makes before it connects the server ([`ScopeConfigs::make_data_folders`]).
    pub data_folders: Vec<(String, PathBuf)>,
}

/// The configuration side: `resolveEffectiveMcpServers` for a scope working in a folder.
#[async_trait]
pub trait ScopeConfigs: Send + Sync {
    /// Resolved when asked, never earlier: the answer is as current as the turn it is asked in. A read: it writes
    /// nothing (the readiness wait resolves too).
    async fn resolve(&self, scope: &str, cwd: &str, only: Option<&str>) -> Resolved;

    /// `ensurePluginServerData` (`plugin-servers.mjs`): makes `folders`, the data folders of the plugin servers an
    /// operation is about to connect, in that operation's turn and before its connect.
    async fn make_data_folders(&self, _folders: Vec<PathBuf>) {}
}

/// The plugin data folders `op` makes before it connects (`connect.mjs:119`, `server-connection.mjs:41`): every enabled
/// server's for a full connect or a reconcile (a reconcile connects the new, changed and failed ones only; making a
/// folder that exists changes nothing), the toggled server's for a toggle on, and none for a toggle off, which connects
/// nothing (`applyMcpServerConnection` returns before it).
fn data_folders(op: &Op, folders: &[(String, PathBuf)]) -> Vec<PathBuf> {
    folders
        .iter()
        .filter(|(name, _)| match op {
            Op::Reset | Op::Reconcile => true,
            Op::Only(only, enabled) => *enabled && name == only,
        })
        .map(|(_, folder)| folder.clone())
        .collect()
}

/// An open scope.
struct Cell {
    scope: String,
    /// Who releases it: the session that opened it; the daemon for the runtime scope.
    owner: Mutex<String>,
    /// The folder the scope's session works in now ([`ScopeRuntime::cwd_changed`] moves it).
    cwd: Mutex<String>,
    /// The scope's operations, one at a time in arrival order.
    turns: Arc<SerialChain>,
    /// True once the first connect settled, or the scope was released.
    ready: watch::Sender<bool>,
    /// How many callers wait at the readiness barrier now (for whoever must know they arrived).
    waiting: watch::Sender<usize>,
    /// The same count over every scope ([`ScopeRuntime::waiting_all`]).
    waiting_all: Arc<watch::Sender<usize>>,
    /// Why the scope's connection is not what its configuration asks for: the first connect did not
    /// return. Node records a failed connect and keeps the runtime (connect.mjs:121-124); the status
    /// shows it, and the next operation that applies (a reset, reconnect or reconcile) clears it.
    failure: Mutex<Option<String>>,
}

impl Cell {
    fn cwd(&self) -> String {
        lock(&self.cwd).clone()
    }
}

/// The first connect of a scope in progress. Dropped without having returned (a panic, or the task
/// cancelled), it records the failure on the scope, which stays open; dropped either way it settles
/// the readiness barrier, so no opener or queued operation waits for ever.
struct FirstConnect<'a> {
    cell: &'a Arc<Cell>,
    returned: bool,
}

impl Drop for FirstConnect<'_> {
    fn drop(&mut self) {
        if !self.returned {
            let why = if std::thread::panicking() { "the initial MCP connect panicked" } else { "the initial MCP connect was cancelled" };
            *lock(&self.cell.failure) = Some(why.to_owned());
        }
        self.cell.ready.send_replace(true);
    }
}

tokio::task_local! {
    /// The scope the management request being served addresses, resolved from its `threadId` when the
    /// request began (absent: none).
    static REQUEST_SCOPE: Option<String>;
}

/// Runs `work` as a request addressing `scope`: the management reads and operations inside it read
/// and change that scope (Node's calls go through the calling session's runtime, whose
/// `getMcpScopeId()` they read, `mcp-glue/server-catalog.mjs:150`). The scope is the one the
/// thread's session holds, or inherited from the session that spawned it (`spawn-plan.mjs:108`), so
/// the caller resolves it before the request runs.
pub async fn with_request_scope<F: std::future::Future>(scope: Option<String>, work: F) -> F::Output {
    REQUEST_SCOPE.scope(scope, work).await
}

/// Whether a request is being served (its scope may still be none).
pub fn in_request() -> bool {
    REQUEST_SCOPE.try_with(|_| ()).is_ok()
}

/// The scope the request being served addresses; `None` outside a request, or when its session holds
/// no scope.
pub fn request_scope() -> Option<String> {
    REQUEST_SCOPE.try_with(Clone::clone).ok().flatten()
}
/// A caller at the readiness barrier, counted while it waits.
struct AtWaiting<'a>(&'a Cell);

impl<'a> AtWaiting<'a> {
    fn enter(cell: &'a Cell) -> Self {
        cell.waiting.send_modify(|count| *count += 1);
        cell.waiting_all.send_modify(|count| *count += 1);
        Self(cell)
    }
}

impl Drop for AtWaiting<'_> {
    fn drop(&mut self) {
        self.0.waiting.send_modify(|count| *count -= 1);
        self.0.waiting_all.send_modify(|count| *count -= 1);
    }
}

#[derive(Default)]
struct Table {
    cells: HashMap<String, Arc<Cell>>,
    /// Owners that released: they open nothing afterwards (a late open of a closed session).
    closed_owners: HashSet<String>,
}

/// The owner of the runtime scope: the daemon itself, which never releases it.
const RUNTIME_OWNER: &str = "runtime";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Test seam (feature `test-support`): each scope's operations as a replay of Node's scripted connector
/// (`connectConfiguredMcp`, `cancelMcpLogin`) sees them.
#[cfg(feature = "test-support")]
#[async_trait]
pub trait OpWatch: Send + Sync {
    /// `op` is about to resolve its configuration on `scope` in its turn; it waits for this.
    async fn connecting(&self, scope: &str, op: &Op);
    /// `op` was applied on `scope` (or voided).
    fn connected(&self, scope: &str, op: &Op);
    /// A disable asks the server's sign-in in flight to end (`cancelMcpLogin`).
    fn cancelling_login(&self, server: &str);
}

pub struct ScopeRuntime {
    hub: Arc<McpHub>,
    configs: Arc<dyn ScopeConfigs>,
    table: Mutex<Table>,
    waiting_all: Arc<watch::Sender<usize>>,
    #[cfg(feature = "test-support")]
    watch: std::sync::OnceLock<Arc<dyn OpWatch>>,
}

impl ScopeRuntime {
    pub fn new(hub: Arc<McpHub>, configs: Arc<dyn ScopeConfigs>) -> Arc<Self> {
        Arc::new(Self {
            hub,
            configs,
            table: Mutex::default(),
            waiting_all: Arc::new(watch::channel(0).0),
            #[cfg(feature = "test-support")]
            watch: std::sync::OnceLock::new(),
        })
    }

    /// Connects the test's watch of the operations; once.
    #[cfg(feature = "test-support")]
    pub fn watch(&self, watch: Arc<dyn OpWatch>) {
        let _ = self.watch.set(watch);
    }

    #[cfg(feature = "test-support")]
    pub(crate) fn cancelling_login(&self, server: &str) {
        if let Some(watch) = self.watch.get() {
            watch.cancelling_login(server);
        }
    }

    /// Opens `scope` for `owner`, working in `cwd`, and returns once its first connect settled. A
    /// scope already open (or opening) is not opened again: the caller waits for the opener's
    /// connect. `Err`: the scope, or the owner, was released.
    pub async fn open(self: &Arc<Self>, scope: &str, owner: &str, cwd: &str) -> Result<(), ScopeReleased> {
        let cell = self.begin(scope, owner, cwd)?;
        Self::ready(&cell).await;
        if self.hub.is_released(&cell.scope) { Err(ScopeReleased) } else { Ok(()) }
    }

    /// [`open`](Self::open) that does not wait for the first connect: Node's runtime boot starts it unawaited
    /// (`boot/tools.mjs:56`) and a turn's grace for it is zero, so a server still connecting when the first turn
    /// runs is not in that turn's tool surface.
    pub fn start(self: &Arc<Self>, scope: &str, owner: &str, cwd: &str) -> Result<(), ScopeReleased> {
        self.begin(scope, owner, cwd).map(drop)
    }

    /// Returns once the first connect of every open scope settled (connected or failed): the point at which Node's
    /// `mcp:ready` / `mcp:failed` boot lines of those scopes have been written.
    pub async fn all_settled(&self) {
        let cells: Vec<Arc<Cell>> = lock(&self.table).cells.values().cloned().collect();
        for cell in cells {
            Self::ready(&cell).await;
        }
    }

    /// `awaitInitialConnect` (`initial-connect-gate.mjs`) for `scope`: waits for its first connect, bounded by the
    /// slowest enabled server's startup budget (the default budget when none is enabled); never fails. A budget of
    /// 0 disables the wait, as the connect may then never settle. Returns at once when the scope is not open or its
    /// first connect settled.
    pub async fn await_initial(&self, scope: &str) {
        let Some(cell) = self.cell(scope) else { return };
        if *cell.ready.borrow() {
            return;
        }
        // `syncScopeRoot` before the connect (mcp-glue/connect.mjs:111).
        self.hub.set_scope_root(&cell.scope, &cell.cwd());
        let resolved = self.configs.resolve(&cell.scope, &cell.cwd(), None).await;
        let budgets: Vec<Option<Duration>> = resolved.configs.iter().filter(|c| c.enabled).map(|c| c.startup_timeout).collect();
        if budgets.contains(&None) {
            return;
        }
        let budget = budgets.into_iter().flatten().max().unwrap_or(crate::config::DEFAULT_STARTUP_TIMEOUT);
        let _ = mixdog_rt::time::timeout(budget, Self::ready(&cell)).await;
    }

    /// [`open`](Self::open) without the wait: the scope is registered and its first connect started
    /// (by the first caller only), and the cell is handed back while that connect may still be pending.
    fn begin(self: &Arc<Self>, scope: &str, owner: &str, cwd: &str) -> Result<Arc<Cell>, ScopeReleased> {
        let key = normalize_scope(Some(scope));
        let (cell, first) = {
            let mut table = lock(&self.table);
            if self.hub.is_released(&key) {
                return Err(ScopeReleased);
            }
            match table.cells.get(&key) {
                Some(cell) => (cell.clone(), None),
                None => {
                    if table.closed_owners.contains(owner) {
                        return Err(ScopeReleased);
                    }
                    // The first connect's generation is taken here, in the step that makes the cell
                    // visible, and not when its task first runs: Node's `connectAll` bumps
                    // `mcpConnectGeneration` synchronously before it yields (`connect.mjs:98-103`). A
                    // request that finds the cell captures a generation that already counts the first
                    // connect, so the task starting late can neither void it nor be voided by it unless
                    // the request is itself a newer full connect.
                    let generation = self.hub.next_generation(&key)?;
                    let (ready, _) = watch::channel(false);
                    let (waiting, _) = watch::channel(0);
                    let cell = Arc::new(Cell {
                        scope: key.clone(),
                        // The runtime scope is the daemon's whoever asks for it (a control thread resuming in it).
                        owner: Mutex::new(if key == self.hub.runtime_scope() { RUNTIME_OWNER.to_owned() } else { owner.to_owned() }),
                        cwd: Mutex::new(cwd.to_owned()),
                        turns: SerialChain::new(),
                        ready,
                        waiting,
                        waiting_all: self.waiting_all.clone(),
                        failure: Mutex::new(None),
                    });
                    table.cells.insert(key.clone(), cell.clone());
                    (cell, Some(generation))
                }
            }
        };
        if let Some(generation) = first {
            let runtime = Arc::clone(self);
            let opening = cell.clone();
            drop(mixdog_rt::spawn("mcp.scope.open", TaskClass::Work, async move { runtime.first_connect(&opening, generation).await }));
        }
        Ok(cell)
    }

    /// The scope's first connect: a full connect (`connectAll`, `connect.mjs:98`). The readiness
    /// barrier is settled on every way out (Node clears `mcpConnectInFlight` in a `finally`,
    /// `connect.mjs:61`): the connect returning, panicking or being cancelled with its task. One that
    /// does not return leaves the failure recorded on the scope, which stays open and in the fan-out
    /// ([`FirstConnect`]), as Node keeps the runtime and records the failed connect.
    async fn first_connect(&self, cell: &Arc<Cell>, generation: u64) {
        let mut settling = FirstConnect { cell, returned: false };
        self.run_cell(cell, &Op::Reset, generation).await;
        settling.returned = true;
    }

    /// Why `scope`'s connection is not what its configuration asks for, if its first connect did not
    /// return and no operation has applied since.
    pub fn failure_of(&self, scope: &str) -> Option<String> {
        lock(&self.cell(scope)?.failure).clone()
    }

    /// The runtime scope once its first connect has settled (waiting for it if it is still
    /// connecting), without starting it: an observation. `None`: it was never started
    /// ([`open_runtime`](Self::open_runtime)) or was released.
    pub async fn runtime_ready(&self) -> Option<String> {
        let cell = self.cell(self.hub.runtime_scope())?;
        Self::ready(&cell).await;
        (!self.hub.is_released(&cell.scope)).then(|| cell.scope.clone())
    }
    async fn ready(cell: &Cell) {
        let _waiting = AtWaiting::enter(cell);
        let mut ready = cell.ready.subscribe();
        let _ = ready.wait_for(|ready| *ready).await;
    }

    /// How many callers wait for `scope`'s first connect now; the receiver follows the count. `None`:
    /// the scope is not open.
    pub fn waiting(&self, scope: &str) -> Option<watch::Receiver<usize>> {
        self.cell(scope).map(|cell| cell.waiting.subscribe())
    }

    /// How many callers wait for a first connect, over every scope; the receiver follows the count.
    pub fn waiting_all(&self) -> watch::Receiver<usize> {
        self.waiting_all.subscribe()
    }

    /// Opens the runtime scope, working in `cwd`, and returns its id once its first connect settled
    /// (a second caller waits for the first's). Node connects its runtime's scope while it boots
    /// (`boot/tools.mjs:57`), so the daemon starts this at boot; the scope belongs to the daemon,
    /// is never claimed by a session and is never minted again.
    pub async fn open_runtime(self: &Arc<Self>, cwd: &str) -> Result<String, ScopeReleased> {
        let scope = self.hub.runtime_scope().to_owned();
        self.open(&scope, RUNTIME_OWNER, cwd).await?;
        Ok(scope)
    }

    /// Starts the runtime scope if nothing has, and returns its id at once, whether or not its first
    /// connect has settled: what a request with no session addresses. Node's `mcpStatus()` answers the
    /// status of the moment while the boot connects in the background (`server-catalog.mjs:239`,
    /// `boot/tools.mjs:56`); an operation that waits in Node queues behind the connect on the scope's
    /// own barrier ([`run`](Self::run), [`fan_out`](Self::fan_out)), not here.
    pub fn start_runtime(self: &Arc<Self>, cwd: &str) -> Result<String, ScopeReleased> {
        let scope = self.hub.runtime_scope().to_owned();
        self.begin(&scope, RUNTIME_OWNER, cwd)?;
        Ok(scope)
    }
    fn cell(&self, scope: &str) -> Option<Arc<Cell>> {
        lock(&self.table).cells.get(&normalize_scope(Some(scope))).cloned()
    }

    /// Whether `scope` is open.
    pub fn is_open(&self, scope: &str) -> bool {
        self.cell(scope).is_some()
    }

    /// The generation `op` runs at when requested now: a full connect supersedes everything
    /// requested before it; any other operation runs at the scope's current generation.
    fn requested(&self, cell: &Cell, op: &Op) -> Option<u64> {
        match op {
            Op::Reset => self.hub.next_generation(&cell.scope).ok(),
            _ => Some(self.hub.generation(&cell.scope)),
        }
    }

    /// Runs `op` on `scope` after the scope's first connect and everything queued before it.
    pub async fn run(self: &Arc<Self>, scope: &str, op: Op) {
        let Some(cell) = self.cell(scope) else { return };
        Self::ready(&cell).await;
        let Some(generation) = self.requested(&cell, &op) else { return };
        self.run_cell(&cell, &op, generation).await;
    }

    /// `onCwdChanged` (`boot/infrastructure.mjs:299`): the session of `scope` now works in `cwd`.
    /// Plugin servers without a declared cwd follow the session's folder, so the scope reconciles
    /// in place (`connectConfiguredMcp({ reconcile: true })`): its configuration is resolved for
    /// the new folder and only the servers it changes reconnect. A scope that is not open does
    /// nothing; the next open reads the folder it is given.
    pub async fn cwd_changed(self: &Arc<Self>, scope: &str, cwd: &str) {
        let Some(cell) = self.cell(scope) else { return };
        cwd.clone_into(&mut lock(&cell.cwd));
        self.run(scope, Op::Reconcile).await;
    }

    /// Requests `op` on every open scope now, and runs each in its own task behind its own queue
    /// (the caller's runtime and Node's fan-out to the process's other runtimes alike). The tasks,
    /// for whoever waits. No scope open: nothing connects.
    pub fn fan_out(self: &Arc<Self>, op: &Op) -> Vec<JoinHandle<()>> {
        let cells: Vec<Arc<Cell>> = lock(&self.table).cells.values().cloned().collect();
        cells
            .into_iter()
            .filter_map(|cell| {
                let generation = self.requested(&cell, op)?;
                let (runtime, op) = (Arc::clone(self), op.clone());
                Some(mixdog_rt::spawn("mcp.scope.fan-out", TaskClass::Work, async move {
                    Self::ready(&cell).await;
                    runtime.run_cell(&cell, &op, generation).await;
                }))
            })
            .collect()
    }

    /// Whether an operation requested at `generation` still stands.
    fn stands(&self, scope: &str, generation: u64) -> bool {
        !self.hub.is_released(scope) && self.hub.generation(scope) == generation
    }

    async fn run_cell(&self, cell: &Cell, op: &Op, generation: u64) {
        let _turn = cell.turns.acquire().await;
        if !self.stands(&cell.scope, generation) {
            return;
        }
        let only = match op {
            Op::Only(name, _) => Some(name.as_str()),
            _ => None,
        };
        #[cfg(feature = "test-support")]
        let watch = self.watch.get().cloned();
        #[cfg(feature = "test-support")]
        if let Some(watch) = &watch {
            watch.connecting(&cell.scope, op).await;
        }
        // `syncScopeRoot` (mcp-glue/server-connection.mjs:70): the roots the scope-following servers advertise track
        // the session's folder, and the connected ones are told when it moved.
        self.hub.set_scope_root(&cell.scope, &cell.cwd());
        let resolved = self.configs.resolve(&cell.scope, &cell.cwd(), only).await;
        let folders = data_folders(op, &resolved.data_folders);
        if !folders.is_empty() {
            self.configs.make_data_folders(folders).await;
        }
        self.connect(&cell.scope, generation, op, resolved).await;
        #[cfg(feature = "test-support")]
        if let Some(watch) = &watch {
            watch.connected(&cell.scope, op);
        }
        // An operation that was applied (not voided) puts the scope as its configuration asks.
        if self.stands(&cell.scope, generation) {
            *lock(&cell.failure) = None;
        }
    }

    /// `op` on the servers of `scope`; every change goes through [`McpHub::apply_at`], so a release
    /// or a newer full connect during the awaits above and below voids the rest.
    async fn connect(&self, scope: &str, generation: u64, op: &Op, resolved: Resolved) {
        let Resolved { mut configs, targets, .. } = resolved;
        match op {
            Op::Reset => {
                if !self.hub.apply_at(scope, generation, Vec::new(), &|_| true) {
                    return;
                }
                let names: Vec<String> = configs.iter().filter(|c| c.enabled).map(|c| c.name.clone()).collect();
                if self.hub.apply_at(scope, generation, configs, &|_| true) {
                    Self::settled(self.awaited(scope, &names)).await;
                }
            }
            Op::Reconcile => {
                // The apply connects new and changed servers and those whose last connect failed
                // (a sign-in or a stored credential may have changed), once each.
                let before: HashSet<String> = self
                    .hub
                    .servers_in(scope)
                    .iter()
                    .filter(|s| !matches!(&*s.state(), ServerState::Failed { .. }))
                    .map(|s| s.name().to_owned())
                    .collect();
                let names: Vec<String> = configs.iter().filter(|c| c.enabled).map(|c| c.name.clone()).collect();
                if !self.hub.apply_at(scope, generation, configs, &|_| true) {
                    return;
                }
                Self::settled(self.awaited(scope, &names.iter().filter(|n| !before.contains(*n)).cloned().collect::<Vec<_>>())).await;
            }
            Op::Only(_, enabled) => {
                if !*enabled {
                    configs.retain(|c| !targets.contains(&c.name));
                    self.hub.apply_at(scope, generation, configs, &|_| false);
                    return;
                }
                // A failed one is not among them: the apply connects it (replaced, or a shared one again in place).
                let kept: Vec<_> = targets
                    .iter()
                    .filter_map(|t| self.hub.server_in(scope, t))
                    .filter(|s| configs.iter().any(|c| c.name == s.name() && c == s.config()) && !matches!(&*s.state(), ServerState::Failed { .. }))
                    .collect();
                // The toggle connects its own servers only (`reconnectSingleMcpServer`).
                if !self.hub.apply_at(scope, generation, configs, &|name| targets.iter().any(|t| t == name)) {
                    return;
                }
                let waits = self.awaited(scope, &targets);
                // A connection another scope shares is not restarted: `reconnectSingleMcpServer` gives up only this
                // scope's use of it and adopts it again (`_closeServer`, `connectServer`, mcp/client.mjs:1367-1374, 1425-1426).
                for server in kept {
                    if self.hub.server_in(scope, server.name()).is_some_and(|now| Arc::ptr_eq(&now, &server)) && !self.hub.held_elsewhere(scope, &server) {
                        let _ = server.reconnect().await;
                    }
                }
                Self::settled(waits).await;
            }
        }
    }

    /// The servers of `names` of `scope` an operation waits for ([`Self::settled`]), read as its apply left them: each
    /// with whether its connection had ended by itself, which only a shared one the apply connects again in place has.
    fn awaited(&self, scope: &str, names: &[String]) -> Vec<(Arc<McpServer>, bool)> {
        names
            .iter()
            .filter_map(|name| self.hub.server_in(scope, name))
            .map(|server| {
                let in_place = server.is_dead();
                (server, in_place)
            })
            .collect()
    }

    /// Waits until every one of `servers` ([`Self::awaited`]) stopped starting; one the apply connects again in place,
    /// until that connect settled. One that went ready and died after it was read is connected again by nothing, and
    /// ends its wait once failed.
    async fn settled(servers: Vec<(Arc<McpServer>, bool)>) {
        for (server, in_place) in servers {
            let mut rx = server.subscribe();
            // A server whose startup budget is disabled may never stop starting: it is not waited for.
            let Some(budget) = server.config().startup_timeout else { continue };
            let done = rx.wait_for(|s| match &**s {
                ServerState::Starting => false,
                ServerState::Failed { .. } => !(in_place && server.is_dead()),
                _ => true,
            });
            let _ = mixdog_rt::time::timeout(budget + Duration::from_secs(5), done).await;
        }
    }

    /// Releases every scope `owner` holds (the runtime's teardown, `disconnectAll({ scopeId })`,
    /// `runtime-stops.mjs:24`), exactly once: a scope leaves the table in the step that retires it
    /// on the hub, and the owner can open nothing afterwards. The servers close in the background.
    /// The runtime scope is the exception ([`McpHub::retire_scope`]): its servers close, but it stays in the
    /// table and its owner is not closed, so it reads on and a reset connects it again.
    pub fn release(&self, owner: &str) {
        let retired: Vec<(Arc<Cell>, Vec<Arc<McpServer>>)> = {
            let mut table = lock(&self.table);
            if owner != RUNTIME_OWNER {
                table.closed_owners.insert(owner.to_owned());
            }
            let held: Vec<String> = table.cells.iter().filter(|(_, cell)| *lock(&cell.owner) == owner).map(|(scope, _)| scope.clone()).collect();
            held.into_iter()
                .filter_map(|scope| if scope == self.hub.runtime_scope() { table.cells.get(&scope).cloned() } else { table.cells.remove(&scope) })
                .map(|cell| {
                    let servers = self.hub.retire_scope(&cell.scope);
                    (cell, servers)
                })
                .collect()
        };
        for (cell, servers) in retired {
            cell.ready.send_replace(true);
            drop(mixdog_rt::spawn("mcp.scope.release", TaskClass::Work, close_retired(servers)));
        }
    }
}
