//! The messages between the core and its code graph helper. Both ends are the same executable; [`Ready`] carries
//! [`PROTOCOL_VERSION`] so a helper of another build is refused rather than misread.
//!
//! No graph, syntax tree, file inventory or session object crosses: a query carries its guarded arguments and the roots
//! the core looked up, and its answer is rendered text with warnings, pagination and the output budget already applied.
//! An absent list and an empty one are distinct values here, as are a partial answer and a complete one. Paths cross
//! losslessly: as text when they are Unicode, else as their native code units.

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// The version a helper announces in [`Ready`]; the core refuses any other.
pub const PROTOCOL_VERSION: u32 = 1;

/// A request's id, unique within one helper generation.
pub type RequestId = u64;

/// The helper's first message, written once it holds to its owner (`mixdog_spawn::owned::hold_to_parent`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ready {
    pub version: u32,
    pub pid: u32,
}

/// Core to helper.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToWorker {
    /// One top-level `code_graph` call, run on the helper's build thread.
    Query { id: RequestId, query: Query },
    /// Build the graph of the project a directory belongs to, on the build thread.
    Prewarm { id: RequestId, prewarm: Prewarm },
    /// Write notices, applied by the helper's control reader in arrival order, before any request read after them.
    Changed { changed: Changed },
    /// Drop one root from the cache, serialized with its refresh and pending commits.
    ForgetRoot { id: RequestId, forget: ForgetRoot },
    /// Finish the work already sent, flush staged writes, acknowledge, exit.
    DrainAndExit { id: RequestId },
}

/// Helper to core.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(clippy::large_enum_variant, reason = "one frame decoded and matched at once; the helper's start is sent once per process")]
pub enum FromWorker {
    Ready { ready: Ready },
    Reply { id: RequestId, reply: Reply },
}

/// The one reply to a request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Reply {
    /// A query's answer.
    Answer { answer: Answer },
    /// The dispatcher refused the query (Node throws an `Error` with this message).
    Refused { refusal: Refusal },
    /// The request failed in the helper.
    Failed { failure: WorkerFailure },
    /// A prewarm's or a root removal's result.
    Maintenance { result: MaintenanceResult },
    /// [`ToWorker::DrainAndExit`] is done; the helper exits next.
    DrainAck { ack: DrainAck },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// The session's working directory (always a selected directory).
    #[serde(with = "path")]
    pub session_cwd: PathBuf,
    /// The call's arguments after the core's guard.
    pub args: serde_json::Value,
    /// The registered project roots (`TrustedRoots::registered`), read by the core for this call.
    #[serde(with = "paths")]
    pub registered: Vec<PathBuf>,
    /// The session's selected directories beyond its cwd (`TrustedRoots::selected`).
    #[serde(with = "paths")]
    pub selected: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub text: String,
    /// The absolute paths the answer depends on, for the tool-result cache; `None` when the call recorded none (such an
    /// answer is never cached), which is not the same as an empty list.
    #[serde(with = "opt_paths")]
    pub dependency_roots: Option<Vec<PathBuf>>,
    /// False when the answer is known partial (a federated section failed, the graph hit its file cap, the output was
    /// capped): the result must not be reused.
    pub complete: bool,
    pub timings: Timings,
}

/// Where one call's time went in the helper, for its trace row.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Timings {
    /// From the helper reading the request to its build thread taking it; filled by the serve loop.
    pub queue_ms: u64,
    pub run_ms: u64,
    pub prune_ms: u64,
    pub wrap_ms: u64,
    pub root_wait_ms: u64,
    pub inventory_ms: u64,
    pub verify_ms: u64,
    pub resolver_check_ms: u64,
    pub cache_load_ms: u64,
    pub parse_ms: u64,
    pub link_ms: u64,
    pub assemble_ms: u64,
    pub admission_ms: u64,
    pub files_reused: u64,
    pub files_parsed: u64,
    pub files_omitted: u64,
    pub files_verified: u64,
    /// Whether the published generation was kept (`None`: the call took no generation).
    pub retained: Option<bool>,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerFailure {
    pub kind: FailureKind,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// The helper's own fault (a panic, a reply it could not send).
    Internal,
    /// The filesystem refused the work.
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prewarm {
    /// The directory whose project is built (the implicit walk: a home or temp folder is never adopted).
    #[serde(with = "path")]
    pub cwd: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Warmed {
    /// The directory belongs to a project and its build ran.
    pub built: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Changed {
    /// In the order the writes were noticed.
    pub files: Vec<FileIdentity>,
}

/// A written path as the core resolved it when the write was noticed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileIdentity {
    /// The path's link-resolved location (the engine's identity key).
    Known { identity: String },
    /// The path had no resolvable identity: a change at an unknown location, which every root projects.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgetRoot {
    /// Only this exact root; nested roots are other roots.
    #[serde(with = "path")]
    pub root: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forgot {
    /// What was removed.
    pub removed: Vec<String>,
    /// The files that matched but could not be deleted.
    #[serde(with = "paths")]
    pub kept: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MaintenanceResult {
    Warmed { warmed: Warmed },
    Forgot { forgot: Forgot },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrainAck {
    /// Why the staged writes could not all be flushed, if they could not.
    pub failure: Option<WorkerFailure>,
}

#[cfg(unix)]
type Unit = u8;
#[cfg(windows)]
type Unit = u16;

#[derive(Serialize)]
#[serde(untagged)]
enum PathOut<'a> {
    Text(&'a str),
    Raw { raw: Vec<Unit> },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PathIn {
    Text(String),
    Raw { raw: Vec<Unit> },
}

fn path_out(path: &Path) -> PathOut<'_> {
    match path.to_str() {
        Some(text) => PathOut::Text(text),
        None => PathOut::Raw { raw: units(path) },
    }
}

#[cfg(unix)]
fn units(path: &Path) -> Vec<Unit> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn units(path: &Path) -> Vec<Unit> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().collect()
}

fn path_in(path: PathIn) -> PathBuf {
    match path {
        PathIn::Text(text) => PathBuf::from(text),
        PathIn::Raw { raw } => PathBuf::from(os_string(raw)),
    }
}

#[cfg(unix)]
fn os_string(raw: Vec<Unit>) -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(raw)
}

#[cfg(windows)]
fn os_string(raw: Vec<Unit>) -> OsString {
    use std::os::windows::ffi::OsStringExt;
    OsString::from_wide(&raw)
}

mod path {
    use super::*;

    pub(super) fn serialize<S: Serializer>(path: &Path, serializer: S) -> Result<S::Ok, S::Error> {
        path_out(path).serialize(serializer)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<PathBuf, D::Error> {
        PathIn::deserialize(deserializer).map(path_in)
    }
}

mod paths {
    use super::*;

    pub(super) fn serialize<S: Serializer>(paths: &[PathBuf], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(paths.iter().map(|path| path_out(path)))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<PathBuf>, D::Error> {
        Vec::<PathIn>::deserialize(deserializer).map(|paths| paths.into_iter().map(path_in).collect())
    }
}

mod opt_paths {
    use super::*;

    pub(super) fn serialize<S: Serializer>(paths: &Option<Vec<PathBuf>>, serializer: S) -> Result<S::Ok, S::Error> {
        match paths {
            Some(paths) => serializer.serialize_some(&paths.iter().map(|path| path_out(path)).collect::<Vec<_>>()),
            None => serializer.serialize_none(),
        }
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<PathBuf>>, D::Error> {
        Option::<Vec<PathIn>>::deserialize(deserializer).map(|paths| paths.map(|paths| paths.into_iter().map(path_in).collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(message: &FromWorker) -> FromWorker {
        serde_json::from_slice(&serde_json::to_vec(message).unwrap()).unwrap()
    }

    fn answer(dependency_roots: Option<Vec<PathBuf>>) -> FromWorker {
        let answer = Answer { text: "t".into(), dependency_roots, complete: false, timings: Timings::default() };
        FromWorker::Reply { id: 7, reply: Reply::Answer { answer } }
    }

    #[test]
    fn absent_and_empty_dependency_roots_stay_distinct() {
        for roots in [None, Some(Vec::new()), Some(vec![PathBuf::from("/a"), PathBuf::from("b c")])] {
            assert_eq!(round_trip(&answer(roots.clone())), answer(roots));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_unicode_crosses_unchanged() {
        use std::os::unix::ffi::OsStringExt;
        let root = PathBuf::from(OsString::from_vec(vec![b'/', 0xff, b'x']));
        assert_eq!(round_trip(&answer(Some(vec![root.clone()]))), answer(Some(vec![root])));
    }

    #[cfg(windows)]
    #[test]
    fn a_path_that_is_not_unicode_crosses_unchanged() {
        use std::os::windows::ffi::OsStringExt;
        let root = PathBuf::from(OsString::from_wide(&[u16::from(b'C'), u16::from(b':'), 0xd800, u16::from(b'x')]));
        assert_eq!(round_trip(&answer(Some(vec![root.clone()]))), answer(Some(vec![root])));
    }
}
