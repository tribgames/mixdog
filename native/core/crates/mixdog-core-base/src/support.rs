//! Plumbing the domain services of this module share: params decoding, coded failures that
//! carry a sentence for the user, lane jobs, and the op gate of a mutation (P §9).

use std::collections::HashMap;
use std::future::Future;
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

pub fn decode<T: DeserializeOwned>(req: &CoreRequest) -> Result<T, CoreError> {
    serde_json::from_value(req.params.clone()).map_err(|error| CoreError::InvalidParams { path: "params".into(), expected: error.to_string().into() })
}

pub fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

/// The method does not belong to the service it reached.
pub fn wrong_method(namespace: &str, method: &str) -> CoreError {
    invalid("method", &format!("a method of {namespace}, not {method}"))
}

/// A failure the 1.4.5 daemon threw as a plain `Error`: its wire answer is `{ error: message }`
/// and no `code` (`call-route.mjs` adds one only when the error has it), so the sentence is the
/// whole answer.
pub fn failed(domain: &'static str, message: impl Into<String>) -> CoreError {
    CoreError::DomainError { domain: domain.into(), code: None, message: Some(Into::<String>::into(message).into()), detail: None }
}

/// A failure whose `Error` carried `code` (`INSTRUCTION_FILE_CONFLICT`, a Node errno).
pub fn coded(domain: &'static str, code: &str, message: impl Into<String>) -> CoreError {
    CoreError::DomainError { domain: domain.into(), code: Some(code.into()), message: Some(Into::<String>::into(message).into()), detail: None }
}

/// The `fs` call of Node's code path that failed (`atomic-file.mjs` `publishFileSync`,
/// `keepBackupSync`, and `rimraf`'s unlink for `rmSync`), which names the syscall and paths in
/// the error text.
#[derive(Debug)]
pub enum FsStep {
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
    /// `rmdirSync(path)`.
    Rmdir(PathBuf),
    /// `rmSync(path)` on a directory, which Node refuses before any syscall.
    RemoveDirectory(PathBuf),
    /// `statSync(path)`.
    Stat(PathBuf),
    /// `copyFileSync(from, to)` / `fs.promises.copyFile`: `copyfile '<from>' -> '<to>'`.
    CopyFile(PathBuf, PathBuf),
    /// `readdirSync(path)` / `fs.promises.readdir`: `scandir '<path>'`.
    Scandir(PathBuf),
}

/// A file operation that failed, with the step Node would have failed at.
#[derive(Debug)]
pub struct FsFailure {
    pub error: std::io::Error,
    pub step: FsStep,
}

/// libuv's name and description of every errno a file operation of the publication path (open,
/// write, fsync, rename, unlink) can fail with: `uv_err_name` and `uv_strerror`, which are what
/// Node's `<CODE>: <description>, <syscall>` text prints.
const ERRNOS: &[(&str, &str)] = &[
    ("EPERM", "operation not permitted"),
    ("ENOENT", "no such file or directory"),
    ("EIO", "i/o error"),
    ("EBADF", "bad file descriptor"),
    ("EACCES", "permission denied"),
    ("EBUSY", "resource busy or locked"),
    ("EEXIST", "file already exists"),
    ("EXDEV", "cross-device link not permitted"),
    ("ENOTDIR", "not a directory"),
    ("EISDIR", "illegal operation on a directory"),
    ("EINVAL", "invalid argument"),
    ("EMFILE", "too many open files"),
    ("ENFILE", "file table overflow"),
    ("ENOSPC", "no space left on device"),
    ("EROFS", "read-only file system"),
    ("EMLINK", "too many links"),
    ("ENAMETOOLONG", "name too long"),
    ("ENOTEMPTY", "directory not empty"),
    ("ELOOP", "too many symbolic links encountered"),
    ("ETXTBSY", "text file is busy"),
    ("EFBIG", "file too large"),
    ("ENOMEM", "not enough memory"),
    ("ENOTSUP", "operation not supported on socket"),
    ("EAGAIN", "resource temporarily unavailable"),
    ("EINTR", "interrupted system call"),
    ("EFAULT", "bad address in system call argument"),
    ("ENODEV", "no such device"),
    ("ESPIPE", "invalid seek"),
    ("EOVERFLOW", "value too large for defined data type"),
    ("ECANCELED", "operation canceled"),
    ("ETIMEDOUT", "connection timed out"),
    ("ENXIO", "no such device or address"),
    ("E2BIG", "argument list too long"),
    ("EADDRINUSE", "address already in use"),
    ("EADDRNOTAVAIL", "address not available"),
    ("EAFNOSUPPORT", "address family not supported"),
    ("EALREADY", "connection already in progress"),
    ("ECHARSET", "invalid Unicode character"),
    ("ECONNABORTED", "software caused connection abort"),
    ("ECONNREFUSED", "connection refused"),
    ("ECONNRESET", "connection reset by peer"),
    ("EFTYPE", "inappropriate file type or format"),
    ("EHOSTUNREACH", "host is unreachable"),
    ("EISCONN", "socket is already connected"),
    ("EMSGSIZE", "message too long"),
    ("ENETUNREACH", "network is unreachable"),
    ("ENOBUFS", "no buffer space available"),
    ("ENOTCONN", "socket is not connected"),
    ("ENOTSOCK", "socket operation on non-socket"),
    ("EOF", "end of file"),
    ("EPIPE", "broken pipe"),
    ("EPROTONOSUPPORT", "protocol not supported"),
    ("ESOCKTNOSUPPORT", "socket type not supported"),
    ("UNKNOWN", "unknown error"),
];

/// libuv's translation of a Win32 error, `uv_translate_sys_error` (src/win/error.c) entry for entry;
/// pinned to the source by `errno-win32-twin.json` (`record-errno-win32.mjs`).
#[cfg(windows)]
const OS_ERRORS: &[(i32, &str)] = &[
    (10013, "EACCES"),          // WSAEACCES
    (740, "EACCES"),            // ERROR_ELEVATION_REQUIRED
    (1920, "EACCES"),           // ERROR_CANT_ACCESS_FILE
    (1227, "EADDRINUSE"),       // ERROR_ADDRESS_ALREADY_ASSOCIATED
    (10048, "EADDRINUSE"),      // WSAEADDRINUSE
    (10049, "EADDRNOTAVAIL"),   // WSAEADDRNOTAVAIL
    (10047, "EAFNOSUPPORT"),    // WSAEAFNOSUPPORT
    (10035, "EAGAIN"),          // WSAEWOULDBLOCK
    (232, "EAGAIN"),            // ERROR_NO_DATA
    (10037, "EALREADY"),        // WSAEALREADY
    (1004, "EBADF"),            // ERROR_INVALID_FLAGS
    (6, "EBADF"),               // ERROR_INVALID_HANDLE
    (33, "EBUSY"),              // ERROR_LOCK_VIOLATION
    (231, "EBUSY"),             // ERROR_PIPE_BUSY
    (32, "EBUSY"),              // ERROR_SHARING_VIOLATION
    (995, "ECANCELED"),         // ERROR_OPERATION_ABORTED
    (10004, "ECANCELED"),       // WSAEINTR
    (1113, "ECHARSET"),         // ERROR_NO_UNICODE_TRANSLATION
    (1236, "ECONNABORTED"),     // ERROR_CONNECTION_ABORTED
    (10053, "ECONNABORTED"),    // WSAECONNABORTED
    (1225, "ECONNREFUSED"),     // ERROR_CONNECTION_REFUSED
    (10061, "ECONNREFUSED"),    // WSAECONNREFUSED
    (64, "ECONNRESET"),         // ERROR_NETNAME_DELETED
    (10054, "ECONNRESET"),      // WSAECONNRESET
    (183, "EEXIST"),            // ERROR_ALREADY_EXISTS
    (80, "EEXIST"),             // ERROR_FILE_EXISTS
    (998, "EFAULT"),            // ERROR_NOACCESS
    (10014, "EFAULT"),          // WSAEFAULT
    (1232, "EHOSTUNREACH"),     // ERROR_HOST_UNREACHABLE
    (10065, "EHOSTUNREACH"),    // WSAEHOSTUNREACH
    (122, "EINVAL"),            // ERROR_INSUFFICIENT_BUFFER
    (13, "EINVAL"),             // ERROR_INVALID_DATA
    (87, "EINVAL"),             // ERROR_INVALID_PARAMETER
    (1464, "EINVAL"),           // ERROR_SYMLINK_NOT_SUPPORTED
    (10022, "EINVAL"),          // WSAEINVAL
    (10046, "EINVAL"),          // WSAEPFNOSUPPORT
    (1102, "EIO"),              // ERROR_BEGINNING_OF_MEDIA
    (1111, "EIO"),              // ERROR_BUS_RESET
    (23, "EIO"),                // ERROR_CRC
    (1166, "EIO"),              // ERROR_DEVICE_DOOR_OPEN
    (1165, "EIO"),              // ERROR_DEVICE_REQUIRES_CLEANING
    (1393, "EIO"),              // ERROR_DISK_CORRUPT
    (1129, "EIO"),              // ERROR_EOM_OVERFLOW
    (1101, "EIO"),              // ERROR_FILEMARK_DETECTED
    (31, "EIO"),                // ERROR_GEN_FAILURE
    (1106, "EIO"),              // ERROR_INVALID_BLOCK_LENGTH
    (1117, "EIO"),              // ERROR_IO_DEVICE
    (1104, "EIO"),              // ERROR_NO_DATA_DETECTED
    (205, "EIO"),               // ERROR_NO_SIGNAL_SENT
    (110, "EIO"),               // ERROR_OPEN_FAILED
    (1103, "EIO"),              // ERROR_SETMARK_DETECTED
    (156, "EIO"),               // ERROR_SIGNAL_REFUSED
    (10056, "EISCONN"),         // WSAEISCONN
    (1921, "ELOOP"),            // ERROR_CANT_RESOLVE_FILENAME
    (4, "EMFILE"),              // ERROR_TOO_MANY_OPEN_FILES
    (10024, "EMFILE"),          // WSAEMFILE
    (10040, "EMSGSIZE"),        // WSAEMSGSIZE
    (111, "ENAMETOOLONG"),      // ERROR_BUFFER_OVERFLOW
    (206, "ENAMETOOLONG"),      // ERROR_FILENAME_EXCED_RANGE
    (1231, "ENETUNREACH"),      // ERROR_NETWORK_UNREACHABLE
    (10051, "ENETUNREACH"),     // WSAENETUNREACH
    (10055, "ENOBUFS"),         // WSAENOBUFS
    (161, "ENOENT"),            // ERROR_BAD_PATHNAME
    (267, "ENOENT"),            // ERROR_DIRECTORY
    (203, "ENOENT"),            // ERROR_ENVVAR_NOT_FOUND
    (2, "ENOENT"),              // ERROR_FILE_NOT_FOUND
    (123, "ENOENT"),            // ERROR_INVALID_NAME
    (15, "ENOENT"),             // ERROR_INVALID_DRIVE
    (4392, "ENOENT"),           // ERROR_INVALID_REPARSE_DATA
    (126, "ENOENT"),            // ERROR_MOD_NOT_FOUND
    (3, "ENOENT"),              // ERROR_PATH_NOT_FOUND
    (11001, "ENOENT"),          // WSAHOST_NOT_FOUND
    (11004, "ENOENT"),          // WSANO_DATA
    (8, "ENOMEM"),              // ERROR_NOT_ENOUGH_MEMORY
    (14, "ENOMEM"),             // ERROR_OUTOFMEMORY
    (82, "ENOSPC"),             // ERROR_CANNOT_MAKE
    (112, "ENOSPC"),            // ERROR_DISK_FULL
    (277, "ENOSPC"),            // ERROR_EA_TABLE_FULL
    (1100, "ENOSPC"),           // ERROR_END_OF_MEDIA
    (39, "ENOSPC"),             // ERROR_HANDLE_DISK_FULL
    (2250, "ENOTCONN"),         // ERROR_NOT_CONNECTED
    (10057, "ENOTCONN"),        // WSAENOTCONN
    (145, "ENOTEMPTY"),         // ERROR_DIR_NOT_EMPTY
    (10038, "ENOTSOCK"),        // WSAENOTSOCK
    (50, "ENOTSUP"),            // ERROR_NOT_SUPPORTED
    (109, "EOF"),               // ERROR_BROKEN_PIPE
    (5, "EPERM"),               // ERROR_ACCESS_DENIED
    (1314, "EPERM"),            // ERROR_PRIVILEGE_NOT_HELD
    (230, "EPIPE"),             // ERROR_BAD_PIPE
    (233, "EPIPE"),             // ERROR_PIPE_NOT_CONNECTED
    (10058, "EPIPE"),           // WSAESHUTDOWN
    (10043, "EPROTONOSUPPORT"), // WSAEPROTONOSUPPORT
    (19, "EROFS"),              // ERROR_WRITE_PROTECT
    (121, "ETIMEDOUT"),         // ERROR_SEM_TIMEOUT
    (10060, "ETIMEDOUT"),       // WSAETIMEDOUT
    (17, "EXDEV"),              // ERROR_NOT_SAME_DEVICE
    (1, "EISDIR"),              // ERROR_INVALID_FUNCTION
    (208, "E2BIG"),             // ERROR_META_EXPANSION_TOO_LONG
    (10044, "ESOCKTNOSUPPORT"), // WSAESOCKTNOSUPPORT
    (193, "EFTYPE"),            // ERROR_BAD_EXE_FORMAT
];

/// The errno of a Unix failure: what the system call returned.
#[cfg(not(windows))]
const OS_ERRORS: &[(i32, &str)] = &[
    (libc::EPERM, "EPERM"),
    (libc::ENOENT, "ENOENT"),
    (libc::EIO, "EIO"),
    (libc::EBADF, "EBADF"),
    (libc::EACCES, "EACCES"),
    (libc::EBUSY, "EBUSY"),
    (libc::EEXIST, "EEXIST"),
    (libc::EXDEV, "EXDEV"),
    (libc::ENOTDIR, "ENOTDIR"),
    (libc::EISDIR, "EISDIR"),
    (libc::EINVAL, "EINVAL"),
    (libc::EMFILE, "EMFILE"),
    (libc::ENFILE, "ENFILE"),
    (libc::ENOSPC, "ENOSPC"),
    (libc::EROFS, "EROFS"),
    (libc::EMLINK, "EMLINK"),
    (libc::ENAMETOOLONG, "ENAMETOOLONG"),
    (libc::ENOTEMPTY, "ENOTEMPTY"),
    (libc::ELOOP, "ELOOP"),
    (libc::ETXTBSY, "ETXTBSY"),
    (libc::EFBIG, "EFBIG"),
    (libc::ENOMEM, "ENOMEM"),
    (libc::ENOTSUP, "ENOTSUP"),
    (libc::EAGAIN, "EAGAIN"),
    (libc::EINTR, "EINTR"),
    (libc::EFAULT, "EFAULT"),
    (libc::ENODEV, "ENODEV"),
    (libc::ESPIPE, "ESPIPE"),
    (libc::EOVERFLOW, "EOVERFLOW"),
    (libc::ECANCELED, "ECANCELED"),
    (libc::ETIMEDOUT, "ETIMEDOUT"),
    (libc::ENXIO, "ENXIO"),
];

/// libuv's errno name and description for a failed call: by the system's own error number when
/// it has one, else by the kind Rust gave it. Windows reports a denied access as `EPERM` (libuv
/// translates `ERROR_ACCESS_DENIED` so), other systems as `EACCES`.
fn errno_of(error: &std::io::Error) -> Option<(&'static str, &'static str)> {
    use std::io::ErrorKind as Kind;
    let by_number = error.raw_os_error().and_then(|raw| OS_ERRORS.iter().find(|(number, _)| *number == raw)).map(|(_, name)| *name);
    // A Win32 error libuv has no translation for is `UNKNOWN` to Node, whatever Rust makes of it.
    let unknown = cfg!(windows).then(|| error.raw_os_error().map(|_| "UNKNOWN")).flatten();
    let name = by_number.or(unknown).or(match error.kind() {
        Kind::NotFound => Some("ENOENT"),
        Kind::PermissionDenied if cfg!(windows) => Some("EPERM"),
        Kind::PermissionDenied => Some("EACCES"),
        Kind::AlreadyExists => Some("EEXIST"),
        Kind::IsADirectory => Some("EISDIR"),
        Kind::NotADirectory => Some("ENOTDIR"),
        Kind::DirectoryNotEmpty => Some("ENOTEMPTY"),
        Kind::StorageFull => Some("ENOSPC"),
        Kind::ReadOnlyFilesystem => Some("EROFS"),
        Kind::ResourceBusy => Some("EBUSY"),
        _ => None,
    })?;
    ERRNOS.iter().find(|(code, _)| *code == name).copied()
}
/// A failed file operation as Node throws it: `code` is the errno name and the text
/// `<code>: <description>, <syscall> '<path>'` (`rename '<from>' -> '<to>'`). Kinds without a
/// known errno keep Rust's text and no code.
#[allow(clippy::disallowed_methods, reason = "a stat of the failed path, on the lane job's thread that reports the failure")]
pub fn io_failure(domain: &'static str, failure: &FsFailure) -> CoreError {
    if let FsStep::RemoveDirectory(path) = &failure.step {
        return coded(domain, "ERR_FS_EISDIR", format!("Path is a directory: rm returned EISDIR (is a directory) {}", path.display()));
    }
    // libuv's `scandir` looks at the path's attributes first: a path that is not a directory is
    // `ENOTDIR` whatever the system's own listing error says (Windows says `ENOENT`).
    let not_a_directory = matches!(&failure.step, FsStep::Scandir(path) if path.exists() && !path.is_dir());
    let errno = if not_a_directory { ERRNOS.iter().find(|(code, _)| *code == "ENOTDIR").copied() } else { errno_of(&failure.error) };
    let Some((code, description)) = errno else {
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
        FsStep::Rmdir(path) => format!("rmdir '{}'", path.display()),
        FsStep::Stat(path) => format!("stat '{}'", path.display()),
        FsStep::CopyFile(from, to) => format!("copyfile '{}' -> '{}'", from.display(), to.display()),
        FsStep::Scandir(path) => format!("scandir '{}'", path.display()),
        FsStep::RemoveDirectory(_) => unreachable!("answered above"),
    };
    coded(domain, code, format!("{code}: {description}, {call}"))
}

/// `rmSync(path, { force: true })`: an absent file is fine, a directory is refused.
#[allow(clippy::disallowed_methods, reason = "file-system body of the lane jobs that call it")]
pub fn remove_file_forced(path: &Path) -> Result<(), FsFailure> {
    if path.is_dir() {
        return Err(FsFailure { error: std::io::ErrorKind::IsADirectory.into(), step: FsStep::RemoveDirectory(path.to_owned()) });
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(FsFailure { error, step: FsStep::Unlink(path.to_owned()) }),
        _ => Ok(()),
    }
}

/// `rmSync(path, { recursive: true, force: true })`: an absent path is fine, any other failure is
/// the error.
#[allow(clippy::disallowed_methods, reason = "file-system body of the lane jobs that call it")]
pub fn remove_dir_all_forced(path: &Path) -> Result<(), FsFailure> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(FsFailure { error, step: FsStep::Rmdir(path.to_owned()) }),
        _ => Ok(()),
    }
}

/// Runs `job` on `lane`. A full queue answers `queueFull` at once; a cancelled caller drops
/// a job that has not started.
pub async fn on_lane<L, R, F>(lane: L, cancel: &CancellationToken, job: F) -> Result<R, CoreError>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    lane.submit(cancel, job)?.await.map_err(|_| CoreError::Cancelled { by: "caller".into() })
}

/// Why a job [`on_lane_wait`] or [`lane_job`] queued never ran, named after its lane.
fn unrun(lane: mixdog_rt::LaneKind, why: &str) -> CoreError {
    CoreError::Internal { incident_id: format!("{}-{why}", lane.name()).into() }
}

fn not_queued(error: mixdog_rt::SubmitWaitError) -> CoreError {
    match error {
        mixdog_rt::SubmitWaitError::Full(full) => full.into(),
        mixdog_rt::SubmitWaitError::Wedged(wedged) => unrun(wedged.lane, "lane-wedged"),
        mixdog_rt::SubmitWaitError::Cancelled => CoreError::Cancelled { by: "caller".into() },
        mixdog_rt::SubmitWaitError::ShutDown(lane) => unrun(lane, "lane-shut-down"),
    }
}

/// [`on_lane`] for work that carries data a caller must not lose (a row, a claim, a mark's rewrite): a full queue is
/// waited out, bounded by `cancel`, never refused. It fails only when the lane cannot run it (no healthy worker, or a
/// backend that cannot signal room), with an error that names the lane.
// The `Send` bound is stated, not inferred: the job's higher-ranked `&InLane` signature otherwise defeats the
// `Send` proof of a spawned future that awaits this one.
pub fn on_lane_wait<'a, L, R, F>(lane: L, cancel: &'a CancellationToken, job: F) -> impl Future<Output = Result<R, CoreError>> + Send + 'a
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    let queued = lane.submit_wait(cancel, job);
    async move { queued.await.map_err(not_queued)?.await.map_err(|_| unrun(L::KIND, "job-dropped")) }
}

/// Calls its `then` exactly once: with the job's result, or with the error that names why it never ran.
struct Answer<T, G: FnOnce(Result<T, CoreError>)> {
    then: Option<G>,
    lane: mixdog_rt::LaneKind,
    _out: std::marker::PhantomData<fn(T)>,
}

impl<T, G: FnOnce(Result<T, CoreError>)> Answer<T, G> {
    fn ran(mut self, out: T) {
        if let Some(then) = self.then.take() {
            then(Ok(out));
        }
    }

    fn failed(mut self, error: CoreError) {
        if let Some(then) = self.then.take() {
            then(Err(error));
        }
    }
}

impl<T, G: FnOnce(Result<T, CoreError>)> Drop for Answer<T, G> {
    // A job dropped unrun (its queue dropped it, or it panicked) still answers.
    fn drop(&mut self) {
        if let Some(then) = self.then.take() {
            then(Err(unrun(self.lane, "job-dropped")));
        }
    }
}

/// Runs `job` on `lane` and hands `then` its result, from the caller's side of no await: queued at once when the lane has
/// room, else queued by a task that waits for room. `then` is called exactly once — with the result, or with an error that
/// names the lane when the job will never run (no healthy worker, a backend that cannot signal room, or the job dropped
/// unrun) — so what the job carries (a row, a reply) is never lost to a busy lane. `then` runs on the lane's thread or the
/// caller's: it only hands the result on.
pub fn lane_job<L, T, F, G>(lane: L, what: &'static str, job: F, then: G)
where
    L: LaneToken,
    T: Send + 'static,
    F: FnOnce(&InLane<L>) -> T + Send + 'static,
    G: FnOnce(Result<T, CoreError>) + Send + 'static,
{
    let answer = Answer { then: Some(then), lane: L::KIND, _out: std::marker::PhantomData };
    let ready: Arc<Mutex<Option<Answer<T, G>>>> = Arc::new(Mutex::new(Some(answer)));
    let on_lane = ready.clone();
    let run = move |lane: &InLane<L>| {
        let answer = on_lane.lock().unwrap_or_else(PoisonError::into_inner).take();
        let out = job(lane);
        if let Some(answer) = answer {
            answer.ran(out);
        }
    };
    let mut queued = Box::pin(async move {
        let cancel = CancellationToken::new();
        lane.submit_wait(&cancel, run).await.map(drop)
    });
    let settle = move |queued: Result<(), mixdog_rt::SubmitWaitError>| {
        if let Err(error) = queued
            && let Some(answer) = ready.lock().unwrap_or_else(PoisonError::into_inner).take()
        {
            answer.failed(not_queued(error));
        }
    };
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match queued.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(result) => settle(result),
        std::task::Poll::Pending => drop(mixdog_rt::spawn(what, mixdog_rt::TaskClass::Work, async move { settle(queued.await) })),
    }
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
    pub async fn run<E, EF, R, RF>(&self, req: &CoreRequest, external: Option<(&'static str, String)>, execute: E, reproduce: R) -> Result<Reply, CoreError>
    where
        E: FnOnce() -> EF,
        EF: Future<Output = Result<Value, CoreError>>,
        R: FnOnce() -> RF,
        RF: Future<Output = Result<Value, CoreError>>,
    {
        let id = req.op.clone().ok_or(CoreError::OpIdRequired)?;
        let thread = req.params.get("threadId").and_then(Value::as_str).map(ThreadId::from);
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
            ticket.external_pending(effect.into(), target.into()).await?;
        }
        match execute().await {
            Ok(value) => {
                let stored = (value.to_string().len() <= STORED_RESULT_MAX).then(|| value.clone());
                ticket.finish(OpOutcome::Applied(AppliedOp { seq: None, result: stored })).await?;
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
pub use mixdog_js::is_js_space;
pub use mixdog_js::js_trim;

/// A file that holds nothing but NULs and blanks has no data to keep.
pub use mixdog_statefile::holds_no_data;

/// The lock of one file: a mutation reads the state it checks and writes under it, so two
/// writers (of any thread scope) never interleave their check and their write.
static PATH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

pub fn path_lock(path: &Path) -> Arc<Mutex<()>> {
    let mut locks = PATH_LOCKS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner);
    // A lock only the table holds is taken by no one: it goes, so the table holds the files in use, not every file ever
    // written. Swept only when a new path finds the table grown, so an ordinary call costs no sweep.
    if locks.len() >= 64 && !locks.contains_key(path) {
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    locks.entry(path.to_owned()).or_default().clone()
}

/// `writeFileAtomicSync(path, bytes, { backup })`: the bytes go to a uniquely named sibling
/// that is synced and renamed over `path`, so a reader sees the old file or the new one. With
/// `backup`, the replaced version stays as `<path>.bak` unless it held no data.
pub fn write_atomic<L: mixdog_statefile::WriteLane>(lane: &InLane<L>, path: &Path, bytes: &[u8], backup: bool) -> Result<(), FsFailure> {
    use mixdog_statefile::Step;
    let opts = mixdog_statefile::Opts { backup, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::write_file_stepped(lane, path, bytes, &opts).map(drop).map_err(|failure| FsFailure {
        error: failure.error,
        step: match failure.step {
            Step::Mkdir(dir) => FsStep::Mkdir(dir),
            Step::Open(file) => FsStep::Open(file),
            Step::Read => FsStep::Read,
            Step::Write | Step::Other => FsStep::Write,
            Step::Fsync => FsStep::Fsync,
            Step::Rename(from, to) => FsStep::Rename(from, to),
        },
    })
}

/// Fixtures the tests of every domain service share.
/// The errno wording against Node's own (`errno-texts-twin.json`, `record-errno-texts.mjs`).
#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "reads the recorded twins and makes real failing files on the test thread")]
mod errno_tests {

    use super::*;

    fn text(error: std::io::Error, step: FsStep) -> String {
        match io_failure("test", &FsFailure { error, step }) {
            CoreError::DomainError { message: Some(message), .. } => message.to_string(),
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn an_error_with_no_errno_keeps_rusts_text() {
        let error = std::io::Error::other("plain");
        assert_eq!(text(error, FsStep::Write), "plain");
    }

    #[test]
    fn a_failed_file_operation_reads_as_code_description_and_syscall() {
        let missing = || std::io::Error::from_raw_os_error(2);
        assert_eq!(text(missing(), FsStep::Write), "ENOENT: no such file or directory, write");
        assert_eq!(text(missing(), FsStep::Fsync), "ENOENT: no such file or directory, fsync");
    }

    #[test]
    fn open_rename_and_unlink_failures_name_their_paths() {
        let missing = || std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(text(missing(), FsStep::Open("/d/a.json".into())), "ENOENT: no such file or directory, open '/d/a.json'");
        assert_eq!(text(missing(), FsStep::Rename("/d/a".into(), "/d/b".into())), "ENOENT: no such file or directory, rename '/d/a' -> '/d/b'");
        assert_eq!(text(missing(), FsStep::Unlink("/d/a".into())), "ENOENT: no such file or directory, unlink '/d/a'");
    }
}
#[cfg(any(test, feature = "test-support"))]
pub mod testing {
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

    /// The op scopes of domain `name` over `state`.
    pub async fn scopes_over(state: CoreState, name: &str) -> OpScopes {
        let store = Arc::new(StateOpStore::new(state, name.into()));
        let gate = OpGate::domain(OpScope::Domain(name.into()), store).await.unwrap();
        OpScopes::new(gate.clone(), Arc::new(SharedGate(gate)))
    }

    pub fn op(n: u64) -> OpId {
        OpId::from(format!("018f0000-0000-7000-8000-{n:012x}"))
    }

    /// A request of `method` with `params`, as a connection would send it.
    pub fn request(method: &'static str, params: Value, op_n: Option<u64>) -> CoreRequest {
        CoreRequest { method: mixdog_core_api::ids::Method(method), params, op: op_n.map(op), ctx: CallContext::internal("test") }
    }

    /// `params` with the op id the mutation carries.
    pub fn with_op(mut params: Value, n: u64) -> Value {
        params["opId"] = json!(op(n).as_str());
        params
    }

    pub async fn value(service: &dyn DomainService, req: CoreRequest) -> Result<Value, CoreError> {
        match service.call(req).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => panic!("never subscribes"),
        }
    }

    /// The op scopes of domain `name` over a `state/core.sqlite` in `dir`.
    pub async fn scopes(dir: &std::path::Path, name: &str) -> OpScopes {
        scopes_over(op_state(dir), name).await
    }
    /// The `state/core.sqlite` in `dir` that [`scopes`] keeps the op records in, for a test that closes it before `dir` goes.
    pub fn op_state(dir: &std::path::Path) -> CoreState {
        let t = mixdog_rt::testing::tokens();
        CoreState::open(t.sqlite_writer_thread, t.interactive_io, &dir.join("core.sqlite")).unwrap().0
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod forced_removal_tests {
    use super::*;

    #[test]
    fn a_forced_removal_ignores_an_absent_path_and_reports_anything_else() {
        let dir = std::env::temp_dir().join(format!("mixdog-forced-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        remove_file_forced(&dir.join("absent")).unwrap();
        remove_dir_all_forced(&dir.join("absent")).unwrap();
        // `rmSync(dir, { force: true })` without `recursive` throws for a directory.
        assert!(matches!(remove_file_forced(&dir).unwrap_err().step, FsStep::RemoveDirectory(_)));
        remove_dir_all_forced(&dir).unwrap();
        assert!(!dir.exists());
    }
}

#[cfg(test)]
mod path_lock_tests {
    use super::*;

    /// A lock no caller holds leaves the table once it has grown; one a caller holds stays the same lock.
    #[test]
    fn the_path_lock_table_keeps_only_locks_in_use() {
        let dir = std::env::temp_dir().join(format!("path-lock-{}", std::process::id()));
        let held = path_lock(&dir.join("held"));
        for n in 0..500 {
            drop(path_lock(&dir.join(n.to_string())));
        }
        assert!(Arc::ptr_eq(&held, &path_lock(&dir.join("held"))), "a held lock is never replaced");
        let mine = PATH_LOCKS.get().unwrap().lock().unwrap().keys().filter(|p| p.starts_with(&dir)).count();
        assert!(mine < 100, "{mine} of the 501 locks are still in the table");
    }
}
