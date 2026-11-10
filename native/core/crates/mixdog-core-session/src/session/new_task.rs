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
    /// The identity of the folder as it was secured (`securedFolders`); held while it is secured, so a second request joins.
    secured: tokio::sync::Mutex<Option<String>>,
    /// Every receipt written, as `phase` (`+refused` when marked) and whether it was flushed before being reported.
    #[cfg(test)]
    pub(super) writes: Mutex<Vec<(String, bool)>>,
}

/// One request's view of its receipt (`NewTaskRequest`).
pub struct Request {
    gate: Arc<NewTaskReceipts>,
    path: PathBuf,
    signature: String,
    receipt: Mutex<Receipt>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn reused() -> CoreError {
    failed("session", "Submission id was reused for different content.")
}

/// `freshSessionId`: `sess_desktop_` and 32 random bytes in hex.
fn fresh_session_id() -> String {
    format!("sess_desktop_{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
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
/// phases leaves. Compiled only into a build that asks for `crash-gates`.
#[cfg(feature = "crash-gates")]
#[allow(clippy::disallowed_methods, reason = "a test build's crash point reads its variable and ends the process")]
pub(super) fn crash_gate(point: &str) {
    if std::env::var("MIXDOG_NEW_TASK_CRASH_AT").is_ok_and(|at| at == point) {
        std::process::abort();
    }
}

#[cfg(not(feature = "crash-gates"))]
pub(super) fn crash_gate(_point: &str) {}

impl NewTaskReceipts {
    pub fn new(user_data: &Path, io: DurabilityIo) -> Arc<Self> {
        Arc::new(Self {
            folder: user_data.join("new-task-receipts"),
            io,
            active: Mutex::default(),
            secured: tokio::sync::Mutex::new(None),
            #[cfg(test)]
            writes: Mutex::default(),
        })
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
        let path = path.to_owned();
        let bytes = on_lane(self.io, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&path))
            .await?
            .map_err(|error| failed("session", error.to_string()))?;
        Ok(bytes.and_then(|bytes| Receipt::parse(&bytes)))
    }

    /// `writeReceipt`: an atomic rename; `durable` also flushes the file and its folder entry before it is reported.
    async fn write(&self, path: &Path, receipt: &Receipt, durable: bool) -> Result<(), CoreError> {
        self.secure().await?;
        #[cfg(test)]
        lock(&self.writes).push((format!("{}{}", receipt.phase().name(), if receipt.refused() { "+refused" } else { "" }), durable));
        let (path, bytes) = (path.to_owned(), receipt.to_bytes());
        let opts = mixdog_statefile::Opts { fsync: durable, fsync_dir: durable, ..mixdog_statefile::Opts::default() };
        on_lane(self.io, &CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, &bytes, &opts))
            .await?
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
        let mut done = {
            let mut active = lock(&self.active);
            if let Some(existing) = active.get(&key) {
                if existing.signature != signature {
                    return Err(reused());
                }
                existing.done.clone()
            } else {
                if active.len() >= MAX_ACTIVE {
                    return Err(failed("session", "Too many new task requests are in progress."));
                }
                let (settled, done) = watch::channel(None);
                active.insert(key.clone(), Active { signature: signature.clone(), done: done.clone() });
                let gate = self.clone();
                drop(mixdog_rt::spawn("new-task-request", TaskClass::Work, async move {
                    let outcome = gate.attempt(&key, signature, execute).await;
                    lock(&gate.active).remove(&key);
                    let _ = settled.send(Some(outcome));
                }));
                done
            }
        };
        let settled = done.wait_for(Option::is_some).await.map_err(|_| failed("session", "The new task request ended without an answer."))?;
        settled.clone().expect("waited for an answer")
    }

    async fn attempt<F, Fut>(self: &Arc<Self>, key: &str, signature: String, execute: F) -> Outcome
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
                self.write(&path, &receipt, refused).await?;
                crash_gate(Phase::Reserved.name());
                receipt
            }
        };
        execute(Arc::new(Request { gate: self.clone(), path, signature, receipt: Mutex::new(receipt) })).await
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
        self.gate.write(&self.path, &next, phase == Phase::Accepted).await?;
        *lock(&self.receipt) = next;
        crash_gate(phase.name());
        Ok(())
    }

    /// `reset`: back to `reserved` on a fresh address, marked refused, flushed: the attempt failed before anything that could
    /// have been accepted was sent, so the old reservation must not be resumed and the id may be resent with other content.
    pub async fn reset(&self) -> Result<(), CoreError> {
        let next = Receipt::reserved(&self.signature, &fresh_session_id(), true);
        self.gate.write(&self.path, &next, true).await?;
        *lock(&self.receipt) = next;
        Ok(())
    }
}

/// The id of a new-task request and the content it is signed over (`submitNewTask`): `id` is the client's submission id, else a
/// random one; the input is `{ prompt, options: { ...options, id, submittedAt: undefined }, draft }` with a worktree choice signed as
/// `{}` (acknowledging a large repository resends the same submission).
pub fn signed_request(params: &Value) -> (String, Value) {
    let input = params.get("initialInput");
    let mut options = input.and_then(|input| input.get("options")).and_then(Value::as_object).cloned().unwrap_or_default();
    let supplied = options.remove("clientSubmissionId");
    let id = supplied
        .as_ref()
        .and_then(Value::as_str)
        .map(|id| mixdog_js::js_trim(id).to_owned())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    options.insert("id".into(), Value::String(id.clone()));
    options.remove("submittedAt");
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
        let mut unsent = request.phase() == Phase::Reserved;
        let started = self.new_task_phases(request, req, params, submission, &id, &mut unsent).await;
        if let Err(error) = &started {
            // The daemon destroys an unclaimed reservation, so the receipt must stop pointing at it.
            if unsent {
                let _ = request.reset().await;
            }
            if !self.holds_user_conversation(&id).await.unwrap_or(true) {
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
    async fn new_task_phases(&self, request: &Request, req: &CoreRequest, mut params: ThreadStartParams, submission: &str, id: &ThreadId, unsent: &mut bool) -> Outcome {
        // The reservation is made again at its address when the session is not there (`client.create`); a session that is there
        // is opened and its draft applied again.
        let handle = if self.try_stored_header(id).await?.is_some() {
            let handle = self.open_handle(id, &req.ctx).await?;
            self.seat_session(id).await?;
            handle
        } else {
            self.begin_thread(req, &params, Some(id.clone())).await?
        };
        if request.phase() == Phase::Reserved {
            request.commit(Phase::Configured).await?;
        }
        self.enter_draft_worktree(&handle, req, &params).await?;
        *unsent = false;
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