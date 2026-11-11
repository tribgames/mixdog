//! The receipt gate of a new task (`apps/desktop/src/main/new-task-requests.ts`): one receipt per client submission id in
//! `<data>/userdata/new-task-receipts/<sha256(id)>.json`, the same bytes Node keeps, so a request that arrives twice (a retry after
//! a lost reply, a crash between phases, changed content, a refusal) starts one task. The phases are Node's: `reserved` (the id is
//! bound to its content and to the session address), `configured` (the draft was applied), `accepted` (the first prompt was).
//!
//! The gate runs each request on its own task, as Node's promise runs without the caller: an identical request that arrives
//! while it runs joins it and gets its answer, another content under the id is refused, and at most [`MAX_ACTIVE`] run at once.
//! A receipt has at most one writer (the one request that holds its id), which is what Node's per-path serial queue guarantees.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CoreRequest;
use mixdog_app_protocol::v2::thread::ThreadStartParams;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::on_lane;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::TaskClass;
use mixdog_statefile::new_task_receipt::Phase;
use mixdog_statefile::new_task_receipt::Receipt;
use serde_json::Value;
use super::directory::SessionDirectory;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::watch;

/// The most requests in flight (`this.active.size >= 128`).
pub const MAX_ACTIVE: usize = 128;

/// What a request started: the session, and the first turn's answer when this attempt submitted it.
#[derive(Clone, Debug, PartialEq)]
pub struct Started {
    pub thread: ThreadId,
    /// The thread's summary when its first prompt was about to be sent (the `thread` of the `thread/start` answer).
    pub summary: Value,
    pub turn: Option<Value>,
}

type Outcome = Result<Started, CoreError>;

struct Active {
    signature: String,
    done: watch::Receiver<Option<Outcome>>,
}

/// The receipts folder and the requests in flight.
pub struct NewTaskReceipts {
    folder: PathBuf,
    io: DurabilityIo,
    active: Mutex<HashMap<String, Active>>,
    /// Cancelled at shutdown: each attempt ends as Node's does at quit ([`SessionDirectory::start_new_task`]), and no new one starts.
    closing: CancellationToken,
    /// A read hold per running attempt, shared by each receipt write it began; `shutdown` takes the write hold, so it returns
    /// once every attempt has ended and every write that began has ended whole.
    #[allow(clippy::disallowed_types, reason = "a read hold is kept across an attempt's awaits and shutdown waits for the write hold")]
    alive: Arc<tokio::sync::RwLock<()>>,
    /// Told each time a request joins an attempt in flight.
    #[cfg(test)]
    pub(super) joined: tokio::sync::Notify,
    /// How many attempts started.
    #[cfg(test)]
    pub(super) attempts: watch::Sender<usize>,
    /// When set, each receipt write stops once it has begun (holding its place at shutdown) until the stall releases it.
    #[cfg(test)]
    pub(super) stall: Mutex<Option<Arc<WriteStall>>>,
    /// The identity of the folder as it was secured (`securedFolders`); held while it is secured, so a second request joins.
    #[allow(clippy::disallowed_types, reason = "held across the awaited securing of the folder, so a second request waits for the first")]
    secured: tokio::sync::Mutex<Option<String>>,
    /// Every receipt written, as `phase` (`+refused` when marked) and whether it was flushed before being reported.
    #[cfg(test)]
    pub(super) writes: Mutex<Vec<(String, bool)>>,
}

/// One request's view of its receipt (`NewTaskRequest`).
pub struct Request {
    gate: Arc<NewTaskReceipts>,
    /// The attempt's hold on `alive`, which each of its writes keeps until it has ended whole.
    hold: Hold,
    path: PathBuf,
    signature: String,
    receipt: Mutex<Receipt>,
}

type Hold = Arc<tokio::sync::OwnedRwLockReadGuard<()>>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn reused() -> CoreError {
    failed("session", "Submission id was reused for different content.")
}

/// A test's hold on the receipt writes: `entered` is told when a write has begun, which then waits for a permit of `release`.
#[cfg(test)]
pub(super) struct WriteStall {
    pub(super) entered: tokio::sync::Notify,
    pub(super) release: tokio::sync::Semaphore,
}

#[cfg(test)]
impl Default for WriteStall {
    fn default() -> Self {
        Self { entered: tokio::sync::Notify::new(), release: tokio::sync::Semaphore::new(0) }
    }
}

/// What a caller gets once the receipts are shut down: no answer. Node's quit does not answer or refuse a new-task request (its
/// attempt ends with the process); the core's callers are disconnected before the directory shuts down (the release's
/// `closeConnections` comes before `closeDataHandles`), so the request ends with its connection, as in Node.
async fn unanswered() -> Outcome {
    std::future::pending().await
}

/// An attempt's place in `active`, given up however the attempt ends (an answer, a panic, the cut at shutdown): a later request
/// for the id then starts a new attempt instead of joining one that will never answer.
struct Leave {
    gate: Arc<NewTaskReceipts>,
    key: String,
}

impl Drop for Leave {
    fn drop(&mut self) {
        lock(&self.gate.active).remove(&self.key);
    }
}

/// `freshSessionId`: `sess_desktop_` and 32 random bytes in hex (`randomBytes(32).toString('hex')`).
pub(super) fn fresh_session_id() -> String {
    let bytes: [u8; 32] = rand::random();
    format!("sess_desktop_{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// Where an attempt of `createNewTask` stands, which decides what Node's quit leaves when it cuts the attempt there. The steps are
/// Node's await boundaries, not the core's calls: the core adopts the draft's route inside its creation call ([`SessionDirectory::begin_thread`]),
/// where Node has already returned from `client.create`.
#[derive(Clone, Copy)]
pub(super) enum Step {
    /// `client.create` (session-host-lifecycle.ts:824): the session is being created or opened at the reserved address.
    Creating,
    /// The draft's route (`configureDraft` → `setRoute`, :779), inside the `try` (:835) after `client.create` returned: the core's
    /// adoption of the draft route and the rest of its creation call after it.
    Configuring,
    /// `request.commit('configured')`: the host's own file write.
    Committing,
    /// The draft's worktree (`selectBranch` / `requestWorktree`), inside the `try`.
    Entering,
    /// The first prompt and `accepted`, after `unsent = false`.
    Sending,
}

/// The input with every object's keys inserted in UTF-16 order, arrays and the objects in them included: the replacer of
/// `signature` rebuilds each object with `Object.fromEntries(sorted keys)`.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Value::Object(keys.into_iter().map(|key| (key.clone(), sorted(&map[key]))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// `folderIdentity`: the folder as the operating system knows it, so a replaced folder is secured again.
fn identity_of(meta: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}:{:?}", meta.dev(), meta.ino(), meta.created().ok())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}", meta.created().ok())
    }
}

/// A test-only end of the process at a named point of a request (`MIXDOG_NEW_TASK_CRASH_AT`): what a power cut between two
/// phases leaves (a new task's phases, a restart notice's store, `agent_registry/restart.rs`). Compiled only into a build that
/// asks for `crash-gates`.
#[cfg(feature = "crash-gates")]
#[allow(clippy::disallowed_methods, reason = "a test build's crash point reads its variable and ends the process")]
pub(super) fn crash_gate(point: &str) {
    if std::env::var("MIXDOG_NEW_TASK_CRASH_AT").is_ok_and(|at| at == point) {
        std::process::abort();
    }
}

#[cfg(not(feature = "crash-gates"))]
pub(super) fn crash_gate(_point: &str) {}

/// A test-only hold at a named call of a new task's draft step (`MIXDOG_NEW_TASK_QUIT_AT`: `setWorkflow`, `setOrchestrationMode`,
/// `setRoute`, `requestWorktree`): the attempt says on stderr that it is held there and goes on once the stop request cut the attempts
/// (`closing`), as Node's recording lets the held call go once the daemon answered the stop request (record-new-task-quit.mjs).
/// Compiled only into a build that asks for `crash-gates`.
#[cfg(feature = "crash-gates")]
#[allow(clippy::disallowed_methods, reason = "a test build's hold point reads its variable")]
pub(super) async fn quit_gate(point: &str, closing: &CancellationToken) {
    use std::io::Write;
    if std::env::var("MIXDOG_NEW_TASK_QUIT_AT").is_ok_and(|at| at == point) {
        let _ = writeln!(std::io::stderr(), "new-task held at {point}");
        closing.cancelled().await;
    }
}

#[cfg(not(feature = "crash-gates"))]
pub(super) async fn quit_gate(_point: &str, _closing: &CancellationToken) {}

/// `/workflow ".*" not found/` on the failure's text (session-host-lifecycle.ts:770).
pub(super) fn workflow_not_found(error: &CoreError) -> bool {
    let CoreError::DomainError { message: Some(message), .. } = error else {
        return false;
    };
    message.find("workflow \"").is_some_and(|at| message[at + "workflow \"".len()..].contains("\" not found"))
}

/// The attempt stopped before its next call once the stop request cut it ([`SessionDirectory::new_task_phases`]).
const CUT: &str = "new task cut by the stop request";

fn cut() -> CoreError {
    CoreError::Cancelled { by: CUT.into() }
}

/// `None` for an attempt the stop request cut.
fn uncut(outcome: Outcome) -> Option<Outcome> {
    match &outcome {
        Err(CoreError::Cancelled { by }) if &**by == CUT => None,
        _ => Some(outcome),
    }
}

/// Whether Node's daemon stored the session of an attempt that ended at `step`. A reservation lives in the daemon's memory only
/// (session-views.mjs:31-45, `reservedOnly`) and is destroyed by the host's unsubscribe or ends with the daemon (daemon.mjs:412):
/// Node stores none for an attempt that failed or was cut in its creation or its draft's workflow, mode or route (recorded:
/// new-task-quit `quit-in-set-route`). Its `requestWorktree` stores the session it binds (recorded: `quit-in-request-worktree`,
/// the cut attempt's and the refused retry's), and so does an accepted prompt. Where Node stores none, the record the core made
/// earlier than Node would is not left behind.
fn stored_by_node(step: Step, enters: bool) -> bool {
    match step {
        Step::Sending => true,
        Step::Entering => enters,
        Step::Creating | Step::Configuring | Step::Committing => false,
    }
}

/// The attempt's [`Step`], shared with the call it is in: read when the attempt is cut while that call runs on.
pub(super) struct StepCell(std::sync::Mutex<Step>);

impl StepCell {
    fn new(step: Step) -> Self {
        Self(std::sync::Mutex::new(step))
    }

    pub(super) fn set(&self, step: Step) {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = step;
    }

    fn get(&self) -> Step {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl NewTaskReceipts {
    pub fn new(user_data: &Path, io: DurabilityIo) -> Arc<Self> {
        Arc::new(Self {
            folder: user_data.join("new-task-receipts"),
            io,
            active: Mutex::default(),
            closing: CancellationToken::new(),
            alive: Arc::default(),
            #[cfg(test)]
            joined: tokio::sync::Notify::new(),
            #[cfg(test)]
            attempts: watch::Sender::new(0),
            #[cfg(test)]
            stall: Mutex::default(),
            #[allow(clippy::disallowed_types, reason = "see the field")]
            secured: tokio::sync::Mutex::new(None),
            #[cfg(test)]
            writes: Mutex::default(),
        })
    }

    /// At shutdown, what Node's quit leaves: every attempt in flight ends as Node's does when its daemon client is disposed
    /// ([`SessionDirectory::start_new_task`]: cut where it stands, or refused while it applies its draft to a created session),
    /// before the directory closes (a write that began ends whole first, within `bound`); none runs on with a closed directory.
    /// The next start resumes each receipt as it resumes it after a crash or a refusal (an atomic rename leaves the receipt
    /// before or after a write that outlives `bound`). The callers in flight and later requests get no answer ([`unanswered`]).
    /// `Err` when a write outlived `bound`.
    pub async fn shutdown(&self, bound: std::time::Duration) -> Result<(), String> {
        self.cut();
        match tokio::time::timeout(bound, self.alive.write()).await {
            Ok(_) => Ok(()),
            Err(_) => Err(format!("a new-task receipt write did not end within {bound:?} of shutdown; its receipt holds the phase before or after it")),
        }
    }

    /// The stop request (Node's host dispose): every attempt in flight ends now, as [`Self::shutdown`] ends it, and no new one starts;
    /// the writes they begin are waited for by [`Self::shutdown`].
    pub fn cut(&self) {
        self.closing.cancel();
    }

    /// Cancelled when the receipts shut down.
    pub(super) fn closing(&self) -> CancellationToken {
        self.closing.clone()
    }

    /// How many requests are in flight.
    #[cfg(test)]
    pub(super) fn in_flight(&self) -> usize {
        lock(&self.active).len()
    }

    /// `secureReceiptFolder`: made owner-only once, before any receipt in it is read, and again when it is gone or replaced.
    async fn secure(&self) -> Result<(), CoreError> {
        let mut state = self.secured.lock().await;
        let (folder, known) = (self.folder.clone(), state.clone());
        let identity = on_lane(self.io, &CancellationToken::new(), move |lane| -> io::Result<String> {
            match mixdog_statefile::metadata(lane, &folder) {
                Ok(meta) if known.as_deref() == Some(identity_of(&meta).as_str()) => return Ok(identity_of(&meta)),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            mixdog_statefile::create_private_dir_all(lane, &folder)?;
            mixdog_statefile::secure_private_dir(lane, &folder)?;
            Ok(identity_of(&mixdog_statefile::metadata(lane, &folder)?))
        })
        .await?
        .map_err(|error| failed("session", error.to_string()))?;
        *state = Some(identity);
        Ok(())
    }

    /// `readReceipt`: what is no receipt binds nothing; only an I/O error fails.
    async fn read(&self, path: &Path) -> Result<Option<Receipt>, CoreError> {
        use mixdog_core_base::support::FsFailure;
        use mixdog_core_base::support::FsStep;
        let path = path.to_owned();
        let bytes = on_lane(self.io, &CancellationToken::new(), move |lane| {
            mixdog_statefile::read_content(&path).map_err(|error| {
                // Node's `open` takes a folder and its read fails (`EISDIR: illegal operation on a directory, read`, libuv on
                // every system); Windows refuses the open itself. Any other failure is the open's, as Node words it.
                if mixdog_statefile::metadata(lane, &path).is_ok_and(|meta| meta.is_dir()) {
                    FsFailure { error: io::ErrorKind::IsADirectory.into(), step: FsStep::Read }
                } else {
                    FsFailure { error, step: FsStep::Open(path.clone()) }
                }
            })
        })
        .await?
        .map_err(|failure| mixdog_core_base::support::io_failure("session", &failure))?;
        Ok(bytes.and_then(|bytes| Receipt::parse(&bytes)))
    }

    /// `writeReceipt`: an atomic rename; `durable` also flushes the file and its folder entry before it is reported.
    async fn write(&self, hold: &Hold, path: &Path, receipt: &Receipt, durable: bool) -> Result<(), CoreError> {
        self.secure().await?;
        #[cfg(test)]
        lock(&self.writes).push((format!("{}{}", receipt.phase().name(), if receipt.refused() { "+refused" } else { "" }), durable));
        let (path, bytes) = (path.to_owned(), receipt.to_bytes());
        let opts = mixdog_statefile::Opts { fsync: durable, fsync_dir: durable, ..mixdog_statefile::Opts::default() };
        let alive = hold.clone();
        let (io, written) = (self.io, tokio::sync::oneshot::channel());
        #[cfg(test)]
        let stall = lock(&self.stall).clone();
        // A write that began ends whole even when its attempt is cut at shutdown, which waits for it.
        drop(mixdog_rt::spawn("new-task-receipt-write", TaskClass::Work, async move {
            #[cfg(test)]
            if let Some(stall) = stall {
                stall.entered.notify_one();
                stall.release.acquire().await.expect("open").forget();
            }
            let result = on_lane(io, &CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, &bytes, &opts)).await;
            let _ = written.0.send(result);
            drop(alive);
        }));
        written
            .1
            .await
            .map_err(|_| failed("session", "The receipt write ended without an answer."))??
            .map(drop)
            .map_err(|error| failed("session", error.to_string()))
    }

    /// `run`: `execute` runs once for the id, whoever asks; the same content joins it, other content is refused.
    pub async fn run<F, Fut>(self: &Arc<Self>, id: &str, input: &Value, execute: F) -> Outcome
    where
        F: FnOnce(Arc<Request>) -> Fut + Send + 'static,
        Fut: Future<Output = Outcome> + Send + 'static,
    {
        let key = sha256_hex(id.as_bytes());
        let signature = sha256_hex(mixdog_js::json_stringify(&sorted(input)).as_bytes());
        // `None`: the receipts are shut down, and the request gets no answer.
        let done = {
            let mut active = lock(&self.active);
            if let Some(existing) = active.get(&key) {
                if existing.signature != signature {
                    return Err(reused());
                }
                #[cfg(test)]
                self.joined.notify_one();
                Some(existing.done.clone())
            } else {
                if active.len() >= MAX_ACTIVE {
                    return Err(failed("session", "Too many new task requests are in progress."));
                }
                match self.alive.clone().try_read_owned() {
                    Ok(alive) if !self.closing.is_cancelled() => Some(self.begin(&mut active, key, signature, alive, execute)),
                    _ => None,
                }
            }
        };
        let Some(mut done) = done else { return unanswered().await };
        let outcome = done.wait_for(Option::is_some).await.map(|settled| settled.clone().expect("waited for an answer"));
        match outcome {
            Ok(outcome) => outcome,
            // Cut at shutdown: no answer, as the process ends.
            Err(_) if self.closing.is_cancelled() => unanswered().await,
            // The attempt panicked.
            Err(_) => Err(failed("session", "The new task request ended without an answer.")),
        }
    }

    /// Starts the attempt for `key` on its own task, holding its place in `active` and its read hold on `alive`.
    fn begin<F, Fut>(
        self: &Arc<Self>,
        active: &mut HashMap<String, Active>,
        key: String,
        signature: String,
        alive: tokio::sync::OwnedRwLockReadGuard<()>,
        execute: F,
    ) -> watch::Receiver<Option<Outcome>>
    where
        F: FnOnce(Arc<Request>) -> Fut + Send + 'static,
        Fut: Future<Output = Outcome> + Send + 'static,
    {
        #[cfg(test)]
        self.attempts.send_modify(|n| *n += 1);
        let (settled, done) = watch::channel(None);
        active.insert(key.clone(), Active { signature: signature.clone(), done: done.clone() });
        let gate = self.clone();
        drop(mixdog_rt::spawn("new-task-request", TaskClass::Work, async move {
            let leave = Leave { gate: gate.clone(), key: key.clone() };
            let outcome = gate.attempt(&key, signature, Arc::new(alive), execute).await;
            drop(leave);
            // At shutdown nobody is answered, as Node's quit answers nobody.
            if !gate.closing.is_cancelled() {
                let _ = settled.send(Some(outcome));
            }
        }));
        done
    }

    async fn attempt<F, Fut>(self: &Arc<Self>, key: &str, signature: String, hold: Hold, execute: F) -> Outcome
    where
        F: FnOnce(Arc<Request>) -> Fut + Send + 'static,
        Fut: Future<Output = Outcome> + Send + 'static,
    {
        self.secure().await?;
        let path = self.folder.join(format!("{key}.json"));
        let stored = self.read(&path).await?;
        // Only a recorded refusal frees the id for other content; any other receipt, a `reserved` one left by an interrupted
        // attempt included, keeps it.
        let refused = stored.as_ref().is_some_and(Receipt::refused);
        if stored.as_ref().is_some_and(|stored| stored.signature() != signature) && !refused {
            return Err(reused());
        }
        // The next attempt runs unmarked again. The same content resumes the refusal's address; other content starts on a
        // fresh one, so nothing the refused address may hold carries over.
        let receipt = match stored {
            Some(stored) if !refused => stored,
            other => {
                let session = match &other {
                    None => format!("sess_desktop_{key}"),
                    Some(stored) if stored.signature() == signature => stored.session_id().to_owned(),
                    Some(_) => fresh_session_id(),
                };
                let receipt = Receipt::reserved(&signature, &session, false);
                self.write(&hold, &path, &receipt, refused).await?;
                crash_gate(Phase::Reserved.name());
                receipt
            }
        };
        execute(Arc::new(Request { gate: self.clone(), hold, path, signature, receipt: Mutex::new(receipt) })).await
    }
}

impl Request {
    pub fn session_id(&self) -> ThreadId {
        ThreadId::from(lock(&self.receipt).session_id().to_owned())
    }

    pub fn phase(&self) -> Phase {
        lock(&self.receipt).phase()
    }

    /// `commit`: only `accepted` is flushed before it is reported.
    pub async fn commit(&self, phase: Phase) -> Result<(), CoreError> {
        let next = lock(&self.receipt).with_phase(phase);
        self.gate.write(&self.hold, &self.path, &next, phase == Phase::Accepted).await?;
        *lock(&self.receipt) = next;
        crash_gate(phase.name());
        Ok(())
    }

    /// `reset`: back to `reserved` on a fresh address, marked refused, flushed: the attempt failed before anything that could
    /// have been accepted was sent, so the old reservation must not be resumed and the id may be resent with other content.
    pub async fn reset(&self) -> Result<(), CoreError> {
        let next = Receipt::reserved(&self.signature, &fresh_session_id(), true);
        self.gate.write(&self.hold, &self.path, &next, true).await?;
        *lock(&self.receipt) = next;
        Ok(())
    }
}

/// Whether `thread/start` params are a new task (`submitNewTask`): a task with its first prompt.
pub fn starts_new_task(params: &Value) -> bool {
    params.get("kind").and_then(Value::as_str) == Some("task") && params.get("initialInput").is_some_and(|input| !input.is_null())
}

/// The id of a new-task request and the content it is signed over (`submitNewTask`): `id` is the client's submission id, else a
/// random one; the input is `{ prompt, options: { ...options, id, submittedAt: undefined }, draft }` with a worktree choice signed as
/// `{}` (acknowledging a large repository resends the same submission).
pub fn signed_request(params: &Value) -> (String, Value) {
    let input = params.get("initialInput");
    let mut options = input.and_then(|input| input.get("options")).and_then(Value::as_object).cloned().unwrap_or_default();
    let supplied = options.shift_remove("clientSubmissionId");
    let id = supplied
        .as_ref()
        .and_then(Value::as_str)
        .map(|id| mixdog_js::js_trim(id).to_owned())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    options.insert("id".into(), Value::String(id.clone()));
    options.shift_remove("submittedAt");
    let mut draft = params.get("draft").cloned().unwrap_or_else(|| Value::Object(Default::default()));
    if let Some(draft) = draft.as_object_mut()
        && draft.get("worktree").is_some_and(truthy)
    {
        draft.insert("worktree".into(), Value::Object(Default::default()));
    }
    let prompt = input.and_then(|input| input.get("prompt")).cloned().unwrap_or(Value::Null);
    (id, serde_json::json!({ "prompt": prompt, "options": options, "draft": draft }))
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

impl SessionDirectory {
    /// `submitNewTask` at `thread/start`: the request runs once for its submission id (see [`NewTaskReceipts::run`]).
    pub(super) async fn start_new_task(&self, req: CoreRequest, params: ThreadStartParams) -> Result<Reply, CoreError> {
        let (submission, input) = signed_request(&req.params);
        let ctx = req.ctx.clone();
        // The attempt runs without its caller (Node's promise does): a connection that ends while it runs, which loses the reply,
        // must not cancel it, or a retry that joins it would get the cancellation instead of the task.
        let mut req = req;
        req.ctx.cancel = CancellationToken::new();
        let (directory, receipts) = (self.share(), self.deps().new_tasks.clone());
        let started = receipts
            .run(&submission.clone(), &input, move |request| async move { directory.new_task(&request, &req, params, &submission).await })
            .await?;
        // Every caller of the request, the first or one that joined, takes its own subscription on the thread.
        let handle = self.open_handle(&started.thread, &ctx).await?;
        let mut result = serde_json::json!({ "thread": started.summary });
        if let Some(turn) = started.turn {
            result["turn"] = turn;
        }
        Ok(Reply::Subscribe(self.subscribed(&handle, result)))
    }

    /// `createNewTask`: the phases of one attempt. `unsent` holds until the first prompt may have been sent: an attempt that fails
    /// before it is refused (its receipt marked, its reservation destroyed), one that fails after it keeps its receipt.
    async fn new_task(&self, request: &Request, req: &CoreRequest, params: ThreadStartParams, submission: &str) -> Outcome {
        let id = request.session_id();
        if request.phase() == Phase::Accepted {
            let handle = self.open_handle(&id, &req.ctx).await?;
            return Ok(Started { thread: id, summary: serde_json::to_value(handle.cell.view.load_full().summary.clone()).unwrap_or(Value::Null), turn: None });
        }
        // A replay (receipt past `reserved`) may follow an ambiguous send: only a first attempt that fails before the prompt is
        // refused.
        let first = request.phase() == Phase::Reserved;
        let enters = params.draft.as_ref().is_some_and(|draft| draft.worktree.is_some());
        let closing = self.deps().new_tasks.closing();
        let step = StepCell::new(Step::Creating);
        let started = {
            let phases = self.new_task_phases(request, req, params, submission, &id, &step);
            tokio::pin!(phases);
            tokio::select! {
                biased;
                // The call the attempt awaits in its draft step settles while Node's daemon shuts down (the session service closes
                // first, session-service.mjs:257, and its shutdown awaits the session's work, :271-275): it runs to its end here
                // too, and the attempt stops before its next call ([`Self::new_task_phases`] answers `None` there).
                () = closing.cancelled() => match step.get() {
                    Step::Configuring | Step::Entering => uncut(phases.await),
                    _ => None,
                },
                started = &mut phases => uncut(started),
            }
        };
        let step = step.get();
        let Some(started) = started else {
            // A stop request, as Node's quit (the app's `/stop {force:true}`, session-client.mjs:667-707, runs the daemon's
            // `shutdown`, daemon.mjs:272): the session service is closed first (session-service.mjs:257) and the host is disposed
            // (session-host.ts:1210), so the call the attempt awaits settles while the daemon shuts down and the next one fails
            // (`assertAvailable`, session-action.mjs:111, entries/lifecycle.mjs:36-39; session-host-transport.ts:87), and
            // `createNewTask` goes on from the call that failed. The creation (`client.create`, session-host-lifecycle.ts:824) fails
            // before the `try` that refuses (:835): the receipt stays as it is. The draft's workflow, mode and route (:766-779) are
            // awaited inside the `try` while unsent: refused, wherever in the core's creation call they are applied. The commit of
            // `configured` is the host's own file write, which completes: the next call fails, the worktree's inside the `try` while
            // unsent (:955 `if (unsent) await request.reset()`), else the submit after `unsent = false`. Nobody is answered (the gate
            // sends no outcome once it is closing).
            let refused = first
                && match step {
                    Step::Creating | Step::Sending => false,
                    Step::Committing => enters,
                    Step::Configuring | Step::Entering => true,
                };
            if refused {
                let _ = request.reset().await;
            }
            if !stored_by_node(step, enters) && !self.holds_user_conversation(&id).await.unwrap_or(true) {
                self.discard(&id).await;
            }
            return Err(failed("session", "The new task request ended with the shutdown."));
        };
        if let Err(error) = &started {
            // The daemon destroys an unclaimed reservation, so the receipt must stop pointing at it.
            if first && !matches!(step, Step::Sending) {
                let _ = request.reset().await;
            }
            if !stored_by_node(step, enters) && !self.holds_user_conversation(&id).await.unwrap_or(true) {
                self.discard(&id).await;
            }
            return Err(error.clone());
        }
        started
    }

    /// Whether the thread's stored history holds a user prompt sent under `submission` (`transcript.clientSubmissionId`), whatever
    /// became of its turn.
    async fn holds_submission(&self, id: &ThreadId, submission: &str) -> Result<bool, CoreError> {
        let (store, thread) = (self.deps().store.clone(), id.clone());
        let (_, rows) = on_lane(self.deps().lanes.io, &CancellationToken::new(), move |lane| store.history_rows(lane, &thread)).await??;
        Ok(rows.iter().any(|row| {
            row.role.as_ref().is_some_and(|role| role.as_str() == "user")
                && matches!(&row.body, mixdog_store::schema::blob::Slot::Inline(body)
                    if body.pointer("/meta/transcript/clientSubmissionId").and_then(Value::as_str) == Some(submission))
        }))
    }
    /// `step` outlives the future: it is read when the attempt fails or is cut ([`Self::new_task`]). Once the stop request cut the
    /// attempt (`closing`), the call in flight ends and the attempt stops before its next call ([`cut`]), as Node's next call fails.
    async fn new_task_phases(&self, request: &Request, req: &CoreRequest, mut params: ThreadStartParams, submission: &str, id: &ThreadId, step: &StepCell) -> Outcome {
        let closing = &self.deps().new_tasks.closing();
        let go_on = || if closing.is_cancelled() { Err(cut()) } else { Ok(()) };
        // `client.create`: the reservation is made again at its address when the session is not there; a session that is there
        // is opened (Node's daemon opens the session at the address it is given, `getOrCreateSessionEntry`). The core's creation
        // applies the draft's workflow, mode and route with it (`begin_thread`: before the record, the route seated after it); the
        // attempt is in the draft step from the first of them on (`begin_thread` moves `step`).
        let handle = if self.try_stored_header(id).await?.is_some() {
            let handle = self.open_handle(id, &req.ctx).await?;
            self.seat_session(id).await?;
            handle
        } else {
            self.begin_thread(req, &params, Some(id.clone()), Some((step, request.phase() == Phase::Reserved))).await?
        };
        go_on()?;
        step.set(Step::Committing);
        if request.phase() == Phase::Reserved {
            request.commit(Phase::Configured).await?;
        }
        go_on()?;
        step.set(Step::Entering);
        if params.draft.as_ref().is_some_and(|draft| draft.worktree.is_some()) {
            quit_gate("requestWorktree", closing).await;
        }
        self.enter_draft_worktree(&handle, req, &params).await?;
        go_on()?;
        step.set(Step::Sending);
        let summary = serde_json::to_value(handle.cell.view.load_full().summary.clone()).unwrap_or(Value::Null);
        let mut input = params.initial_input.take().expect("a new task carries its first prompt");
        input.options.get_or_insert_with(Default::default).client_submission_id = Some(submission.to_owned());
        // A prompt already in the thread was accepted by an earlier attempt that ended before it was recorded: what Node's
        // resend gets from the daemon's memory of the submission, the stored thread gives here. The submission is looked for in the
        // stored rows themselves: a turn the crash interrupted is no longer part of the model context, but its prompt is still there.
        let turn = if self.holds_user_conversation(id).await? || self.holds_submission(id, submission).await? { None } else { self.first_turn(&handle, req, input).await? };
        crash_gate("submitted");
        request.commit(Phase::Accepted).await?;
        Ok(Started { thread: id.clone(), summary, turn })
    }
}