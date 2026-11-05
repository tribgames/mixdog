//! Plumbing the domain services of this module share: params decoding, coded failures that
//! carry a sentence for the user, lane jobs, and the op gate of a mutation (P §9).

use std::collections::HashMap;
use std::future::Future;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;

use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::ops::AppliedOp;
use crate::ops::Begin;
use crate::ops::OpGate;
use crate::ops::OpOutcome;
use crate::ops::OpRequest;
use crate::ops::ThreadOpGates;

/// An applied result larger than this is not stored with the op (P §9.3): a duplicate
/// reproduces it instead.
const STORED_RESULT_MAX: usize = 16 * 1024;

pub(crate) fn decode<T: DeserializeOwned>(req: &CoreRequest) -> Result<T, CoreError> {
    serde_json::from_value(req.params.clone()).map_err(|error| CoreError::InvalidParams {
        path: "params".into(),
        expected: error.to_string().into(),
    })
}

pub(crate) fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams {
        path: path.into(),
        expected: expected.into(),
    }
}

/// The method does not belong to the service it reached.
pub(crate) fn wrong_method(namespace: &str, method: &str) -> CoreError {
    invalid("method", &format!("a method of {namespace}, not {method}"))
}

/// A failure the 1.4.5 daemon threw as a plain `Error`: its wire answer is `{ error: message }`
/// and no `code` (`call-route.mjs` adds one only when the error has it), so the sentence is the
/// whole answer.
pub(crate) fn failed(domain: &'static str, message: impl Into<String>) -> CoreError {
    CoreError::DomainError {
        domain: domain.into(),
        code: None,
        message: Some(Into::<String>::into(message).into()),
        detail: None,
    }
}

/// A failure whose `Error` carried `code` (`INSTRUCTION_FILE_CONFLICT`, a Node errno).
pub(crate) fn coded(domain: &'static str, code: &str, message: impl Into<String>) -> CoreError {
    CoreError::DomainError {
        domain: domain.into(),
        code: Some(code.into()),
        message: Some(Into::<String>::into(message).into()),
        detail: None,
    }
}

/// The `fs` call of Node's code path that failed (`atomic-file.mjs` `publishFileSync`,
/// `keepBackupSync`, and `rimraf`'s unlink for `rmSync`), which names the syscall and paths in
/// the error text.
#[derive(Debug)]
pub(crate) enum FsStep {
    /// `mkdirSync(dir, { recursive: true })`.
    Mkdir(PathBuf),
    /// `openSync(path, 'wx')` of the temp file, or `readFileSync` of the file being replaced.
    Open(PathBuf),
    /// `readFileSync` of a directory: the failing call is the `read` after the open.
    Read,
    /// `writeFileSync(fd, …)`.
    Write,
    /// `fsyncSync(fd)`.
    Fsync,
    /// `renameSync(from, to)`.
    Rename(PathBuf, PathBuf),
    /// `unlinkSync(path)`, as `rmSync(path, { force: true })` ends in for a file.
    Unlink(PathBuf),
    /// `rmSync(path)` on a directory, which Node refuses before any syscall.
    RemoveDirectory(PathBuf),
}

/// A file operation that failed, with the step Node would have failed at.
#[derive(Debug)]
pub(crate) struct FsFailure {
    pub error: std::io::Error,
    pub step: FsStep,
}

impl FsFailure {
    fn at(step: FsStep) -> impl FnOnce(std::io::Error) -> FsFailure {
        move |error| FsFailure { error, step }
    }
}

/// libuv's errno name and description for a failed call. Windows reports a denied access as
/// `EPERM` (libuv translates `ERROR_ACCESS_DENIED` so), other systems as `EACCES`.
fn errno_of(error: &std::io::Error) -> Option<(&'static str, &'static str)> {
    use std::io::ErrorKind as Kind;
    Some(match error.kind() {
        Kind::NotFound => ("ENOENT", "no such file or directory"),
        Kind::PermissionDenied if cfg!(windows) => ("EPERM", "operation not permitted"),
        Kind::PermissionDenied => ("EACCES", "permission denied"),
        Kind::AlreadyExists => ("EEXIST", "file already exists"),
        Kind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        Kind::NotADirectory => ("ENOTDIR", "not a directory"),
        Kind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        Kind::StorageFull => ("ENOSPC", "no space left on device"),
        Kind::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        Kind::ResourceBusy => ("EBUSY", "resource busy or locked"),
        _ => return None,
    })
}

/// A failed file operation as Node throws it: `code` is the errno name and the text
/// `<code>: <description>, <syscall> '<path>'` (`rename '<from>' -> '<to>'`). Kinds without a
/// known errno keep Rust's text and no code.
pub(crate) fn io_failure(domain: &'static str, failure: &FsFailure) -> CoreError {
    if let FsStep::RemoveDirectory(path) = &failure.step {
        return coded(
            domain,
            "ERR_FS_EISDIR",
            format!(
                "Path is a directory: rm returned EISDIR (is a directory) {}",
                path.display()
            ),
        );
    }
    let Some((code, description)) = errno_of(&failure.error) else {
        return failed(domain, failure.error.to_string());
    };
    let call = match &failure.step {
        FsStep::Mkdir(path) => format!("mkdir '{}'", path.display()),
        FsStep::Open(path) => format!("open '{}'", path.display()),
        FsStep::Read => "read".to_owned(),
        FsStep::Write => "write".to_owned(),
        FsStep::Fsync => "fsync".to_owned(),
        FsStep::Rename(from, to) => format!("rename '{}' -> '{}'", from.display(), to.display()),
        FsStep::Unlink(path) => format!("unlink '{}'", path.display()),
        FsStep::RemoveDirectory(_) => unreachable!("answered above"),
    };
    coded(domain, code, format!("{code}: {description}, {call}"))
}

/// `rmSync(path, { force: true })`: an absent file is fine, a directory is refused.
pub(crate) fn remove_file_forced(path: &Path) -> Result<(), FsFailure> {
    if path.is_dir() {
        return Err(FsFailure {
            error: std::io::ErrorKind::IsADirectory.into(),
            step: FsStep::RemoveDirectory(path.to_owned()),
        });
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(FsFailure {
            error,
            step: FsStep::Unlink(path.to_owned()),
        }),
        _ => Ok(()),
    }
}

/// Runs `job` on `lane`. A full queue answers `queueFull` at once; a cancelled caller drops
/// a job that has not started.
pub(crate) async fn on_lane<L, R, F>(
    lane: L,
    cancel: &CancellationToken,
    job: F,
) -> Result<R, CoreError>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    lane.submit(cancel, job)?
        .await
        .map_err(|_| CoreError::Cancelled {
            by: "caller".into(),
        })
}

/// The op gates of the mutating methods of one domain: its own scope's gate, and the
/// thread directory's for a request that names a thread (`thread_or_none(thread_id)`).
#[derive(Clone)]
pub struct OpScopes {
    domain: OpGate,
    threads: Arc<dyn ThreadOpGates>,
}

impl OpScopes {
    pub fn new(domain: OpGate, threads: Arc<dyn ThreadOpGates>) -> Self {
        Self { domain, threads }
    }

    /// Runs one mutation once per `(scope, opId)`: a duplicate answers the recorded outcome
    /// without executing. `external` brackets an action that leaves the process
    /// (`effect`, `target`), so a crash in between reads as `externalOutcomeUnknown`.
    /// `reproduce` rebuilds the result of a duplicate whose result was too large to store.
    pub async fn run<E, EF, R, RF>(
        &self,
        req: &CoreRequest,
        external: Option<(&'static str, String)>,
        execute: E,
        reproduce: R,
    ) -> Result<Reply, CoreError>
    where
        E: FnOnce() -> EF,
        EF: Future<Output = Result<Value, CoreError>>,
        R: FnOnce() -> RF,
        RF: Future<Output = Result<Value, CoreError>>,
    {
        let id = req.op.clone().ok_or(CoreError::OpIdRequired)?;
        let thread = req
            .params
            .get("threadId")
            .and_then(Value::as_str)
            .map(ThreadId::from);
        let gate = match thread {
            Some(thread) => self.threads.gate(&thread, &req.ctx).await?,
            None => self.domain.clone(),
        };
        let op = OpRequest::new(id.clone(), req.method.as_str(), &req.params);
        let ticket = match gate.begin(&op, &req.ctx).await? {
            Begin::Done(outcome) => {
                let AppliedOp { result, .. } = outcome.into_result(&id)?;
                return match result {
                    Some(value) => Ok(Reply::Value(value)),
                    None => reproduce().await.map(Reply::Value),
                };
            }
            Begin::Execute(ticket) => ticket,
        };
        if let Some((effect, target)) = external {
            ticket
                .external_pending(effect.into(), target.into())
                .await?;
        }
        match execute().await {
            Ok(value) => {
                let stored = (value.to_string().len() <= STORED_RESULT_MAX).then(|| value.clone());
                ticket
                    .finish(OpOutcome::Applied(AppliedOp {
                        seq: None,
                        result: stored,
                    }))
                    .await?;
                Ok(Reply::Value(value))
            }
            Err(error) => {
                ticket.finish(OpOutcome::Rejected(error.clone())).await?;
                Err(error)
            }
        }
    }
}

/// JavaScript's `\s` and `trim()` set, which is not `char::is_whitespace` (that one counts
/// U+0085 and lacks U+FEFF).
pub(crate) use mixdog_js::is_js_space;
pub(crate) use mixdog_js::js_trim;

/// A file that holds nothing but NULs and blanks has no data to keep.
pub(crate) fn holds_no_data(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .all(|b| matches!(b, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

/// The lock of one file: a mutation reads the state it checks and writes under it, so two
/// writers (of any thread scope) never interleave their check and their write.
pub(crate) fn path_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    locks.entry(path.to_owned()).or_default().clone()
}

/// `writeFileAtomicSync(path, bytes, { backup })`: the bytes go to a uniquely named sibling
/// that is synced and renamed over `path`, so a reader sees the old file or the new one. With
/// `backup`, the replaced version stays as `<path>.bak` unless it held no data.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8], backup: bool) -> Result<(), FsFailure> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(FsFailure::at(FsStep::Mkdir(dir.to_owned())))?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // No leading dot: cloud-sync drives refuse to create such a file. 8 random bytes in hex.
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let staging = path.with_file_name(format!("{name}.mixdog-tmp-{}", &suffix[..16]));
    let published = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(FsFailure::at(FsStep::Open(staging.clone())))?;
        file.write_all(bytes)
            .map_err(FsFailure::at(FsStep::Write))?;
        file.sync_all().map_err(FsFailure::at(FsStep::Fsync))?;
        drop(file);
        if backup {
            keep_backup(path)?;
        }
        std::fs::rename(&staging, path).map_err(FsFailure::at(FsStep::Rename(
            staging.clone(),
            path.to_owned(),
        )))
    })();
    if published.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    published
}

/// `keepBackupSync`: the file being replaced becomes `<path>.bak` unless it is absent or held
/// no data. Any other read failure fails the write, as in Node.
fn keep_backup(path: &Path) -> Result<(), FsFailure> {
    let previous = match std::fs::read(path) {
        Ok(previous) => previous,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) if path.is_dir() => {
            return Err(FsFailure {
                error: std::io::ErrorKind::IsADirectory.into(),
                step: FsStep::Read,
            });
        }
        Err(error) => {
            return Err(FsFailure {
                error,
                step: FsStep::Open(path.to_owned()),
            });
        }
    };
    if holds_no_data(&previous) {
        return Ok(());
    }
    let mut kept = path.as_os_str().to_owned();
    kept.push(".bak");
    write_atomic(Path::new(&kept), &previous, false)
}

/// Fixtures the tests of every domain service share.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Arc;

    use async_trait::async_trait;
    use mixdog_core_api::CoreError;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::ids::OpId;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_api::ops::OpScope;
    use mixdog_core_api::service::DomainService;
    use mixdog_store::state::CoreState;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::ops::StateOpStore;

    /// Every thread shares the domain's gate: the tests need an op record, not a thread actor.
    struct SharedGate(OpGate);

    #[async_trait]
    impl ThreadOpGates for SharedGate {
        async fn gate(&self, _thread: &ThreadId, _ctx: &CallContext) -> Result<OpGate, CoreError> {
            Ok(self.0.clone())
        }
    }

    /// The op scopes of domain `name` over a `state/core.sqlite` in `dir`.
    pub(crate) async fn scopes(dir: &std::path::Path, name: &str) -> OpScopes {
        let t = mixdog_rt::testing::tokens();
        let state = CoreState::open(
            t.sqlite_writer_thread,
            t.interactive_io,
            &dir.join("core.sqlite"),
        )
        .unwrap()
        .0;
        let store = Arc::new(StateOpStore::new(state, name.into()));
        let gate = OpGate::domain(OpScope::Domain(name.into()), store)
            .await
            .unwrap();
        OpScopes::new(gate.clone(), Arc::new(SharedGate(gate)))
    }

    pub(crate) fn op(n: u64) -> OpId {
        OpId::from(format!("018f0000-0000-7000-8000-{n:012x}"))
    }

    /// A request of `method` with `params`, as a connection would send it.
    pub(crate) fn request(method: &'static str, params: Value, op_n: Option<u64>) -> CoreRequest {
        CoreRequest {
            method: mixdog_core_api::ids::Method(method),
            params,
            op: op_n.map(op),
            ctx: CallContext::internal("test"),
        }
    }

    /// `params` with the op id the mutation carries.
    pub(crate) fn with_op(mut params: Value, n: u64) -> Value {
        params["opId"] = json!(op(n).as_str());
        params
    }

    pub(crate) async fn value(
        service: &dyn DomainService,
        req: CoreRequest,
    ) -> Result<Value, CoreError> {
        match service.call(req).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => panic!("never subscribes"),
        }
    }
}
