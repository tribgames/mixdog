//! The messages between the core and its search helper. Both ends are the same executable; [`Ready`] carries
//! [`PROTOCOL_VERSION`] so a helper of another build is refused rather than misread.
//!
//! A walk or a text search crosses as its request and comes back one item at a time, as the helper finds them. Each item
//! holds its room in the helper's queue until the core says its consumer took it ([`ToWorker::Taken`]), so a stream's
//! producer runs as far ahead of the core's consumer as the engine lets it run ahead of one in its own process
//! (`mixdog_workspace::localfs::QUEUE` items, `QUEUE_BYTES` bytes), and neither end holds more. A deadline crosses as the
//! time left to it when the request is written. Paths cross losslessly (`mixdog_graph_host::wire::path`).

use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::Descent;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::FsStep;
use mixdog_core_api::domain::fs::NameGuard;
use mixdog_core_api::domain::fs::SearchClass;
use mixdog_core_api::domain::fs::SearchMatch;
use mixdog_core_api::domain::fs::SearchRequest;
use mixdog_core_api::domain::fs::WalkRequest;
use serde::Deserialize;
use serde::Serialize;

/// The version a helper announces in [`Ready`]; the core refuses any other.
pub const PROTOCOL_VERSION: u32 = 1;

/// A stream's id, unique within one host.
pub type StreamId = u64;

/// The helper's first message, written once it holds to its owner (`mixdog_spawn::owned::hold_to_parent`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ready {
    pub version: u32,
    pub pid: u32,
}

/// Core to helper.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToWorker {
    /// A new stream: `FileService::walk`.
    Walk { id: StreamId, walk: Walk },
    /// A new stream: `FileService::search_text`, or `search_summary` when `summary`.
    Search { id: StreamId, search: Search, summary: bool },
    /// The core's consumer took the stream's next `items` items: their room in the queue is the producer's again.
    Taken { id: StreamId, items: u32 },
    /// `EventSource::close`: answered [`FromWorker::Closed`] once nothing of the stream's producer runs.
    Close { id: StreamId },
    /// The core let go of the stream without waiting: its producer is stopped, and nothing more is answered.
    Release { id: StreamId },
}

/// Helper to core.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FromWorker {
    Ready { ready: Ready },
    /// The stream's next item.
    Item { id: StreamId, item: Item },
    /// The stream has no more items.
    End { id: StreamId },
    /// The stream's close is done.
    Closed { id: StreamId },
}

/// A path, lossless.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WirePath(#[serde(with = "mixdog_graph_host::wire::path")] pub PathBuf);

impl WirePath {
    fn of(path: &AbsPath) -> Self {
        Self(path.as_path().to_path_buf())
    }

    fn abs(self) -> Result<AbsPath, String> {
        let text = self.0.to_string_lossy().into_owned();
        AbsPath::new(self.0).ok_or_else(|| format!("a path that is not absolute: {text}"))
    }
}

fn abs_all(paths: Vec<WirePath>) -> Result<Vec<AbsPath>, String> {
    paths.into_iter().map(WirePath::abs).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Class {
    Interactive,
    Bulk,
    Fuzzy,
}

impl From<SearchClass> for Class {
    fn from(class: SearchClass) -> Self {
        match class {
            SearchClass::Interactive => Class::Interactive,
            SearchClass::Bulk => Class::Bulk,
            SearchClass::Fuzzy => Class::Fuzzy,
        }
    }
}

impl From<Class> for SearchClass {
    fn from(class: Class) -> Self {
        match class {
            Class::Interactive => SearchClass::Interactive,
            Class::Bulk => SearchClass::Bulk,
            Class::Fuzzy => SearchClass::Fuzzy,
        }
    }
}

/// [`NameGuard`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guard {
    pub whole: Option<String>,
    pub rest: Option<String>,
    pub fragment: Option<String>,
    pub path: bool,
    pub noise: Vec<String>,
    pub dotted: bool,
}

/// [`WalkRequest`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Walk {
    pub root: WirePath,
    pub recursive: bool,
    pub include_hidden: bool,
    pub respect_ignore: bool,
    pub require_git: bool,
    pub include_dirs: bool,
    pub prune: Vec<WirePath>,
    pub max_depth: Option<usize>,
    pub bare: Vec<String>,
    pub bare_dotted: bool,
    pub guard: Option<Guard>,
    pub server: Option<Class>,
}

impl Walk {
    pub fn of(request: &WalkRequest) -> Self {
        let Descent { max_depth, bare, bare_dotted, guard } = &request.descent;
        Self {
            root: WirePath::of(&request.root),
            recursive: request.recursive,
            include_hidden: request.include_hidden,
            respect_ignore: request.respect_ignore,
            require_git: request.require_git,
            include_dirs: request.include_dirs,
            prune: request.prune.iter().map(WirePath::of).collect(),
            max_depth: *max_depth,
            bare: bare.clone(),
            bare_dotted: *bare_dotted,
            guard: guard.as_ref().map(|guard| Guard {
                whole: guard.whole.clone(),
                rest: guard.rest.clone(),
                fragment: guard.fragment.clone(),
                path: guard.path,
                noise: guard.noise.clone(),
                dotted: guard.dotted,
            }),
            server: request.server.map(Class::from),
        }
    }

    pub fn request(self) -> Result<WalkRequest, String> {
        Ok(WalkRequest {
            root: self.root.abs()?,
            recursive: self.recursive,
            include_hidden: self.include_hidden,
            respect_ignore: self.respect_ignore,
            require_git: self.require_git,
            include_dirs: self.include_dirs,
            prune: abs_all(self.prune)?,
            descent: Descent {
                max_depth: self.max_depth,
                bare: self.bare,
                bare_dotted: self.bare_dotted,
                guard: self.guard.map(|guard| NameGuard {
                    whole: guard.whole,
                    rest: guard.rest,
                    fragment: guard.fragment,
                    path: guard.path,
                    noise: guard.noise,
                    dotted: guard.dotted,
                }),
            },
            server: self.server.map(SearchClass::from),
        })
    }
}

/// [`SearchRequest`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    pub root: WirePath,
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub include_hidden: bool,
    pub respect_ignore: bool,
    pub multiline: bool,
    pub pcre2: bool,
    pub binary_as_text: bool,
    pub limit: Option<usize>,
    pub first_per_file: bool,
    /// The time left to [`SearchRequest::deadline`] at `now` of [`Search::of`], in nanoseconds.
    pub deadline_in_ns: Option<u64>,
    pub class: Class,
}

impl Search {
    /// `request` as it is written at `now`.
    pub fn of(request: &SearchRequest, now: Instant) -> Self {
        Self {
            root: WirePath::of(&request.root),
            pattern: request.pattern.clone(),
            regex: request.regex,
            case_sensitive: request.case_sensitive,
            include_globs: request.include_globs.clone(),
            exclude_globs: request.exclude_globs.clone(),
            include_hidden: request.include_hidden,
            respect_ignore: request.respect_ignore,
            multiline: request.multiline,
            pcre2: request.pcre2,
            binary_as_text: request.binary_as_text,
            limit: request.limit,
            first_per_file: request.first_per_file,
            deadline_in_ns: request.deadline.map(|at| u64::try_from(at.saturating_duration_since(now).as_nanos()).unwrap_or(u64::MAX)),
            class: request.class.into(),
        }
    }

    /// The request as read at `now`. A deadline past what an instant can hold is none.
    pub fn request(self, now: Instant) -> Result<SearchRequest, String> {
        Ok(SearchRequest {
            root: self.root.abs()?,
            pattern: self.pattern,
            regex: self.regex,
            case_sensitive: self.case_sensitive,
            include_globs: self.include_globs,
            exclude_globs: self.exclude_globs,
            include_hidden: self.include_hidden,
            respect_ignore: self.respect_ignore,
            multiline: self.multiline,
            pcre2: self.pcre2,
            binary_as_text: self.binary_as_text,
            limit: self.limit,
            first_per_file: self.first_per_file,
            deadline: self.deadline_in_ns.and_then(|ns| now.checked_add(Duration::from_nanos(ns))),
            class: self.class.into(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Special,
}

impl From<EntryKind> for Kind {
    fn from(kind: EntryKind) -> Self {
        match kind {
            EntryKind::File => Kind::File,
            EntryKind::Dir => Kind::Dir,
            EntryKind::Symlink => Kind::Symlink,
            EntryKind::Special => Kind::Special,
        }
    }
}

impl From<Kind> for EntryKind {
    fn from(kind: Kind) -> Self {
        match kind {
            Kind::File => EntryKind::File,
            Kind::Dir => EntryKind::Dir,
            Kind::Symlink => EntryKind::Symlink,
            Kind::Special => EntryKind::Special,
        }
    }
}

/// One item of a stream: a walk's entry, a search's match, or either's error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Item {
    Entry { path: WirePath, kind: Kind },
    Match { path: WirePath, line: u64, column: u64, text: String, count: u64 },
    Failure { failure: Failure },
}

/// What an item stands for on the core's side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Found {
    Entry(DirEntry),
    Match(SearchMatch),
}

impl Item {
    pub fn entry(item: Result<DirEntry, FsError>) -> Self {
        match item {
            Ok(DirEntry { path, kind }) => Item::Entry { path: WirePath::of(&path), kind: kind.into() },
            Err(error) => Item::Failure { failure: Failure::of(&error) },
        }
    }

    pub fn found(item: Result<SearchMatch, FsError>) -> Self {
        match item {
            Ok(SearchMatch { path, line, column, text, count }) => Item::Match { path: WirePath::of(&path), line, column, text, count },
            Err(error) => Item::Failure { failure: Failure::of(&error) },
        }
    }

    /// The item as the core's consumer is given it; the outer error is a malformed item.
    pub fn read(self) -> Result<Result<Found, FsError>, String> {
        Ok(match self {
            Item::Entry { path, kind } => Ok(Found::Entry(DirEntry { path: path.abs()?, kind: kind.into() })),
            Item::Match { path, line, column, text, count } => Ok(Found::Match(SearchMatch { path: path.abs()?, line, column, text, count })),
            Item::Failure { failure } => Err(failure.error()?),
        })
    }
}

/// [`FsError`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub kind: FailureKind,
    pub path: Option<WirePath>,
    pub step: Option<Step>,
}

/// [`FsErrorKind`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FailureKind {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    NotADirectory,
    IsADirectory,
    Special,
    PreconditionFailed { actual: Option<Vec<u8>> },
    OutcomeUnknown,
    Cancelled { left: Vec<WirePath> },
    Io { os_code: Option<i32> },
    InvalidPattern { message: String },
    TimedOut,
    Saturated,
    CancelStalled { search: String, grace_ms: u64 },
}

/// [`FsStep`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Step {
    Open { path: WirePath },
    Write,
    Fsync,
    Rename { from: WirePath, to: WirePath },
    Unlink,
}

impl Failure {
    pub fn of(error: &FsError) -> Self {
        let kind = match &error.kind {
            FsErrorKind::NotFound => FailureKind::NotFound,
            FsErrorKind::PermissionDenied => FailureKind::PermissionDenied,
            FsErrorKind::AlreadyExists => FailureKind::AlreadyExists,
            FsErrorKind::NotADirectory => FailureKind::NotADirectory,
            FsErrorKind::IsADirectory => FailureKind::IsADirectory,
            FsErrorKind::Special => FailureKind::Special,
            FsErrorKind::PreconditionFailed { actual } => FailureKind::PreconditionFailed { actual: actual.clone() },
            FsErrorKind::OutcomeUnknown => FailureKind::OutcomeUnknown,
            FsErrorKind::Cancelled { left } => FailureKind::Cancelled { left: left.iter().map(WirePath::of).collect() },
            FsErrorKind::Io { os_code } => FailureKind::Io { os_code: *os_code },
            FsErrorKind::InvalidPattern { message } => FailureKind::InvalidPattern { message: message.clone() },
            FsErrorKind::TimedOut => FailureKind::TimedOut,
            FsErrorKind::Saturated => FailureKind::Saturated,
            FsErrorKind::CancelStalled { search, grace_ms } => FailureKind::CancelStalled { search: search.clone(), grace_ms: *grace_ms },
        };
        let step = error.step.as_ref().map(|step| match step {
            FsStep::Open { path } => Step::Open { path: WirePath::of(path) },
            FsStep::Write => Step::Write,
            FsStep::Fsync => Step::Fsync,
            FsStep::Rename { from, to } => Step::Rename { from: WirePath::of(from), to: WirePath::of(to) },
            FsStep::Unlink => Step::Unlink,
        });
        Self { kind, path: error.path.as_ref().map(WirePath::of), step }
    }

    pub fn error(self) -> Result<FsError, String> {
        let kind = match self.kind {
            FailureKind::NotFound => FsErrorKind::NotFound,
            FailureKind::PermissionDenied => FsErrorKind::PermissionDenied,
            FailureKind::AlreadyExists => FsErrorKind::AlreadyExists,
            FailureKind::NotADirectory => FsErrorKind::NotADirectory,
            FailureKind::IsADirectory => FsErrorKind::IsADirectory,
            FailureKind::Special => FsErrorKind::Special,
            FailureKind::PreconditionFailed { actual } => FsErrorKind::PreconditionFailed { actual },
            FailureKind::OutcomeUnknown => FsErrorKind::OutcomeUnknown,
            FailureKind::Cancelled { left } => FsErrorKind::Cancelled { left: abs_all(left)? },
            FailureKind::Io { os_code } => FsErrorKind::Io { os_code },
            FailureKind::InvalidPattern { message } => FsErrorKind::InvalidPattern { message },
            FailureKind::TimedOut => FsErrorKind::TimedOut,
            FailureKind::Saturated => FsErrorKind::Saturated,
            FailureKind::CancelStalled { search, grace_ms } => FsErrorKind::CancelStalled { search, grace_ms },
        };
        let step = match self.step {
            None => None,
            Some(Step::Open { path }) => Some(FsStep::Open { path: path.abs()? }),
            Some(Step::Write) => Some(FsStep::Write),
            Some(Step::Fsync) => Some(FsStep::Fsync),
            Some(Step::Rename { from, to }) => Some(FsStep::Rename { from: from.abs()?, to: to.abs()? }),
            Some(Step::Unlink) => Some(FsStep::Unlink),
        };
        Ok(FsError { kind, path: self.path.map(WirePath::abs).transpose()?, step })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crossed<T: Serialize + serde::de::DeserializeOwned>(message: &T) -> T {
        serde_json::from_slice(&serde_json::to_vec(message).unwrap()).unwrap()
    }

    fn abs(text: &str) -> AbsPath {
        AbsPath::new(std::env::temp_dir().join(text)).unwrap()
    }

    #[test]
    fn a_walk_request_crosses_whole() {
        let request = WalkRequest {
            root: abs("root"),
            recursive: true,
            include_hidden: false,
            respect_ignore: true,
            require_git: false,
            include_dirs: true,
            prune: vec![abs("root/a"), abs("root/b c")],
            descent: Descent {
                max_depth: Some(3),
                bare: vec!["node_modules".into()],
                bare_dotted: true,
                guard: Some(NameGuard {
                    whole: Some("^a.*$".into()),
                    rest: None,
                    fragment: Some("a".into()),
                    path: true,
                    noise: vec![".git".into()],
                    dotted: true,
                }),
            },
            server: Some(SearchClass::Fuzzy),
        };
        let message = ToWorker::Walk { id: 3, walk: Walk::of(&request) };
        let ToWorker::Walk { walk, .. } = crossed(&message) else { panic!("not a walk") };
        assert_eq!(walk.request().unwrap(), request);
    }

    #[test]
    fn a_search_deadline_crosses_as_the_time_left_to_it() {
        let written = Instant::now();
        let request = SearchRequest {
            root: abs("root"),
            pattern: "needle(".into(),
            regex: true,
            case_sensitive: false,
            include_globs: vec!["*.rs".into()],
            exclude_globs: vec!["**/target/**".into()],
            include_hidden: true,
            respect_ignore: false,
            multiline: true,
            pcre2: true,
            binary_as_text: true,
            limit: Some(7),
            first_per_file: true,
            deadline: Some(written + Duration::from_millis(1500)),
            class: SearchClass::Bulk,
        };
        let message = ToWorker::Search { id: 9, search: Search::of(&request, written), summary: true };
        let ToWorker::Search { search, summary, .. } = crossed(&message) else { panic!("not a search") };
        assert!(summary);
        let read = written + Duration::from_secs(2);
        let back = search.request(read).unwrap();
        assert_eq!(back.deadline, Some(read + Duration::from_millis(1500)));
        assert_eq!(SearchRequest { deadline: request.deadline, ..back }, request);
        let passed = Search::of(&SearchRequest { deadline: Some(written), ..request.clone() }, written + Duration::from_secs(1));
        assert_eq!(passed.deadline_in_ns, Some(0), "a deadline already passed crosses as passed");
    }

    #[test]
    fn items_and_every_error_kind_cross_unchanged() {
        let found = SearchMatch { path: abs("root/a.txt"), line: 4, column: 2, text: "a needle\u{1f600}".into(), count: 3 };
        let entry = DirEntry { path: abs("root/b"), kind: EntryKind::Dir };
        let errors = [
            FsErrorKind::NotFound,
            FsErrorKind::PermissionDenied,
            FsErrorKind::AlreadyExists,
            FsErrorKind::NotADirectory,
            FsErrorKind::IsADirectory,
            FsErrorKind::Special,
            FsErrorKind::PreconditionFailed { actual: Some(vec![0, 255]) },
            FsErrorKind::PreconditionFailed { actual: None },
            FsErrorKind::OutcomeUnknown,
            FsErrorKind::Cancelled { left: vec![abs("root/t")] },
            FsErrorKind::Io { os_code: Some(5) },
            FsErrorKind::Io { os_code: None },
            FsErrorKind::InvalidPattern { message: "regex parse error".into() },
            FsErrorKind::TimedOut,
            FsErrorKind::Saturated,
            FsErrorKind::CancelStalled { search: "content".into(), grace_ms: 1000 },
        ];
        let read = |item: Item| crossed(&FromWorker::Item { id: 1, item });
        let FromWorker::Item { item, .. } = read(Item::found(Ok(found.clone()))) else { panic!() };
        assert_eq!(item.read().unwrap(), Ok(Found::Match(found)));
        let FromWorker::Item { item, .. } = read(Item::entry(Ok(entry.clone()))) else { panic!() };
        assert_eq!(item.read().unwrap(), Ok(Found::Entry(entry)));
        for kind in errors {
            for path in [None, Some(abs("root/c.txt"))] {
                let error = FsError { kind: kind.clone(), path, step: Some(FsStep::Rename { from: abs("root/x"), to: abs("root/y") }) };
                let FromWorker::Item { item, .. } = read(Item::found(Err(error.clone()))) else { panic!() };
                assert_eq!(item.read().unwrap(), Err(error));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_path_that_is_not_unicode_crosses_unchanged() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        let mut wide: Vec<u16> = std::env::temp_dir().as_os_str().to_string_lossy().encode_utf16().collect();
        wide.extend([u16::from(b'\\'), 0xd800, u16::from(b'x')]);
        let path = AbsPath::new(OsString::from_wide(&wide)).unwrap();
        let entry = DirEntry { path, kind: EntryKind::File };
        let FromWorker::Item { item, .. } = crossed(&FromWorker::Item { id: 1, item: Item::entry(Ok(entry.clone())) }) else { panic!() };
        assert_eq!(item.read().unwrap(), Ok(Found::Entry(entry)));
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_unicode_crosses_unchanged() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let path = AbsPath::new(OsString::from_vec(vec![b'/', 0xff, b'x'])).unwrap();
        let entry = DirEntry { path, kind: EntryKind::File };
        let FromWorker::Item { item, .. } = crossed(&FromWorker::Item { id: 1, item: Item::entry(Ok(entry.clone())) }) else { panic!() };
        assert_eq!(item.read().unwrap(), Ok(Found::Entry(entry)));
    }
}
