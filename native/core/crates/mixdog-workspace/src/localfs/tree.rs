//! The walks of a file listing and of a text search: ignore's single-threaded `Walk` in what it yields and in what
//! order (siblings in path order, depth first, a folder before its entries), except that the walk's exclusion rules
//! apply to an entry before anything opens it. ignore's `Walk` reads a folder (walkdir `IntoIter::push`,
//! walkdir-2.5.0 lib.rs:901-907) before its rules skip it (`Walk::next`, ignore-0.4.34 walk.rs:1220-1231), so an
//! excluded folder on a dead mount held the walk. Node's server walks with ignore's parallel walker, which applies the
//! rules before it reads a folder (`should_skip_entry` before a folder becomes work, walk.rs:2085), so an excluded
//! folder is never read there either, nor is its read error reported.
//!
//! An entry is held as its folder's listing gave it ([`Listed`]: its path and, on Windows, its type and hidden attribute
//! from the find data `std` keeps without a call). The one way to anything that costs a filesystem call on it — its type
//! when the listing did not give it (an `lstat`), its listing as a folder, and so the open of a file, which is only ever
//! of an entry the walk gave — is [`gate::probe`]. It takes the rules' decision on the entry ([`gate::Decision`]) as its
//! argument and names the volume the call reads on before making it ([`super::Volumes::name`]): the call is the
//! producer's bounded probe, a stall in it charged to that volume and its thread given up within the bounds
//! ([`super::SchedulerConfig::max_stranded_per_volume`]). Only [`gate::judge`] and [`gate::decide`] make a decision, and
//! neither makes one for an entry the rules exclude: they drop it, so nothing can be asked of it. The calls themselves
//! ([`Dirs`]) take an [`Asked`], which only `probe` makes (its constructors are private to [`gate`]).
//!
//! The rules are ignore's own, through its `IncrementalIgnore` (the same rules and precedence as its walk: overrides,
//! `.ignore`, `.gitignore`, `.git/info/exclude`, the global ignore file, parent folders' ignore files), asked of an
//! entry's path relative to the root; hidden entries are judged here, as ignore judges them, after those rules
//! (`Ignore::matched_dir_entry`). What the rules need of an entry:
//! - its path (prune list, overrides, ignore files) and its name (a hidden name starts with `.`): the listing's;
//! - on Windows the hidden attribute: the listing's own (`FindNextFileW` data, which `std`'s `DirEntry::metadata`
//!   returns without a call);
//! - its type, which only a rule that reads differently for a folder than for a file needs (a pattern ending in `/`,
//!   or one that whitelists only one of the two). The listing's when it gave one (Windows); else (Unix, whose `std`
//!   type is the listing's `d_type` or else an `lstat`) asked through `probe` to decide, on the bounded probe, never
//!   inline; a mount point the mount table names is a folder, told without a call. An entry whose rules read the same
//!   either way is judged without its type.
//!
//! The calls of a walk that do not go through `probe`: the root's telling ([`super::Volumes::start`]), and ignore's own
//! as it loads the rules (ignore-0.4.34 incremental.rs `root_ignore`, dir.rs `add_child_path`): the root's `is_dir`, the
//! ignore files of the root's parent folders, of the root and of each folder the walk entered, and in each of those
//! folders a `metadata` of `.git` and an `exists` of `.jj` (which the walk itself excludes), as Node's server's ignore
//! makes them. They are all in the root, its parents and folders the rules let in: an excluded folder's entries are
//! never asked about, so it is never a folder ignore loads the rules of.

use std::io;
use std::path::Path;
use std::path::PathBuf;

use ignore::IncrementalIgnore;
use ignore::WalkBuilder;
use mixdog_core_api::domain::fs::EntryKind;

pub use gate::Asked;
pub use gate::Listed;
use gate::Call;
use gate::Decision;
use gate::Told;

/// The filesystem calls a walk makes, each on what [`gate::probe`] hands over: the tests put a gate in front of them.
pub trait Dirs: Send {
    /// The root's type (`symlink_metadata`) and whether the walk reads it as a folder (a link to a folder, by
    /// `metadata`, as walkdir follows a root link).
    fn root(&mut self, root: &Asked<'_>) -> io::Result<(EntryKind, bool)>;
    /// A folder's entries, as its listing gives them.
    fn list(&mut self, dir: &Asked<'_>) -> io::Result<Vec<io::Result<Listed>>>;
    /// An entry's type, which its listing did not give.
    fn kind(&mut self, entry: &Asked<'_>) -> io::Result<EntryKind>;
}

/// The real filesystem.
pub struct RealDirs;

impl Dirs for RealDirs {
    fn root(&mut self, root: &Asked<'_>) -> io::Result<(EntryKind, bool)> {
        let kind = std::fs::symlink_metadata(root.path())?.file_type();
        let dir = if kind.is_symlink() { std::fs::metadata(root.path())?.is_dir() } else { kind.is_dir() };
        Ok((super::entry_kind(kind), dir))
    }

    fn list(&mut self, dir: &Asked<'_>) -> io::Result<Vec<io::Result<Listed>>> {
        Ok(std::fs::read_dir(dir.path())?.map(|entry| entry.map(Listed::of)).collect())
    }

    fn kind(&mut self, entry: &Asked<'_>) -> io::Result<EntryKind> {
        entry.stat()
    }
}

/// The one way to a filesystem call on a walk's entry ([module docs](super)): the rules' decision, made only here, and
/// the one function that makes calls with it.
pub mod gate {
    use std::io;
    use std::path::Path;
    use std::path::PathBuf;

    use mixdog_core_api::domain::fs::EntryKind;

    use super::super::Halt;
    use super::super::SharedVolumes;
    use super::super::entry_kind;
    use super::super::locked;
    use super::Dirs;
    use super::Rules;
    use super::Verdict;

    /// An entry as its folder's listing gave it, and nothing that would cost a call on it.
    pub struct Listed {
        path: PathBuf,
        /// Windows: whether the listing marks it hidden (find data). Elsewhere `false`: a hidden entry is one whose name
        /// starts with `.`.
        hidden: bool,
        /// Its type when the listing gave it without a call: Windows' find data. `None` on Unix, whose `std` type is
        /// the listing's `d_type` or else an `lstat` of the entry, which only [`probe`] may ask for.
        kind: Option<EntryKind>,
        /// Unix: the listing's entry, which `std` is asked its type of ([`Asked::stat`]).
        #[cfg(unix)]
        entry: std::fs::DirEntry,
    }

    impl Listed {
        pub(super) fn of(entry: std::fs::DirEntry) -> Self {
            let path = entry.path();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt as _;
                const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
                // On Windows `DirEntry::metadata` is the listing's find data, read without a call.
                let (hidden, kind) = match entry.metadata() {
                    Ok(m) => (m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0, Some(entry_kind(m.file_type()))),
                    Err(_) => (false, None),
                };
                Self { path, hidden, kind }
            }
            #[cfg(unix)]
            return Self { path, hidden: false, kind: None, entry };
            #[cfg(not(any(unix, windows)))]
            {
                drop(entry);
                Self { path, hidden: false, kind: None }
            }
        }

        pub fn path(&self) -> &Path {
            &self.path
        }

        /// The entry as a listing that gives no type gives it (a Unix filesystem without `d_type`).
        #[cfg(test)]
        pub fn untyped(self) -> Self {
            Self { kind: None, ..self }
        }
    }

    /// What a call of [`Dirs`] is made on: made only by [`probe`].
    pub struct Asked<'a> {
        path: &'a Path,
        #[cfg(unix)]
        entry: Option<&'a std::fs::DirEntry>,
    }

    impl<'a> Asked<'a> {
        fn root(path: &'a Path) -> Self {
            Self {
                path,
                #[cfg(unix)]
                entry: None,
            }
        }

        fn entry(listed: &'a Listed) -> Self {
            Self {
                path: &listed.path,
                #[cfg(unix)]
                entry: Some(&listed.entry),
            }
        }

        pub fn path(&self) -> &Path {
            self.path
        }

        /// The entry's type as `std` tells it: on Unix from the listing's entry (its `d_type`, else an `lstat`), else
        /// by `symlink_metadata`.
        pub fn stat(&self) -> io::Result<EntryKind> {
            #[cfg(unix)]
            if let Some(entry) = self.entry {
                return Ok(entry_kind(entry.file_type()?));
            }
            Ok(entry_kind(std::fs::symlink_metadata(self.path)?.file_type()))
        }
    }

    /// The rules' decision on an entry ([`judge`], [`decide`]), the argument [`probe`] reaches it through, or the walk's
    /// root, which no rule judges.
    pub struct Decision(State);

    enum State {
        Root(PathBuf),
        /// Let in; its type once told.
        Admitted { listed: Listed, kind: Option<EntryKind> },
        /// Read differently for a folder than for a file, its listing having given no type: only its type may be asked.
        Undecided { listed: Listed, kind: Option<EntryKind>, as_dir: Verdict, as_file: Verdict },
    }

    impl Decision {
        pub(super) fn root(path: PathBuf) -> Self {
            Self(State::Root(path))
        }

        pub fn path(&self) -> &Path {
            match &self.0 {
                State::Root(path) => path,
                State::Admitted { listed, .. } | State::Undecided { listed, .. } => &listed.path,
            }
        }

        pub fn into_path(self) -> PathBuf {
            match self.0 {
                State::Root(path) => path,
                State::Admitted { listed, .. } | State::Undecided { listed, .. } => listed.path,
            }
        }
    }

    /// The rules' decision on `listed`: `None`, dropping it, when they exclude it whatever its type, or by the type its
    /// listing gave; undecided when they read it differently for a folder than for a file and the listing gave none.
    pub fn judge(rules: &mut Rules, listed: Listed) -> Option<Decision> {
        if rules.pruned(&listed.path) {
            return None;
        }
        let (as_dir, as_file) = (rules.verdict(&listed.path, true), rules.verdict(&listed.path, false));
        let verdict = match (as_dir == as_file, listed.kind) {
            (true, _) => as_dir,
            (false, Some(kind)) => if kind == EntryKind::Dir { as_dir } else { as_file },
            (false, None) => return Some(Decision(State::Undecided { listed, kind: None, as_dir, as_file })),
        };
        let kind = listed.kind;
        (!rules.excludes(verdict, &listed.path, listed.hidden)).then(|| Decision(State::Admitted { listed, kind }))
    }

    /// An undecided `decision` judged by the type [`probe`] told: `None`, dropping it, when the rules exclude it.
    pub fn decide(rules: &mut Rules, decision: Decision) -> Option<Decision> {
        match decision.0 {
            State::Undecided { listed, kind: Some(kind), as_dir, as_file } => {
                let verdict = if kind == EntryKind::Dir { as_dir } else { as_file };
                (!rules.excludes(verdict, &listed.path, listed.hidden)).then(|| Decision(State::Admitted { listed, kind: Some(kind) }))
            }
            state => Some(Decision(state)),
        }
    }

    /// A call [`probe`] makes.
    #[derive(Debug, Clone, Copy)]
    pub enum Call {
        /// The root's type.
        Root,
        /// An entry's type.
        Kind,
        /// A folder's entries.
        List,
    }

    /// What a [`Call`] told.
    pub enum Told {
        Root(EntryKind, bool),
        Kind(EntryKind),
        Listing(Vec<io::Result<Listed>>),
    }

    /// The one function that makes a filesystem call on a walk's entry ([module docs](super)): `call` on what
    /// `decision` holds, through `dirs`, once the volume it reads on is named ([`super::super::Volumes::name`]), which
    /// makes it the producer's bounded probe. An entry's type its listing gave, or that the mount table tells (a
    /// mount point is a folder), costs no call. An undecided entry may only be asked its type; the root its type and
    /// its entries; an admitted entry its type and its entries.
    pub fn probe(dirs: &mut dyn Dirs, volumes: &SharedVolumes, decision: &mut Decision, call: Call) -> io::Result<Told> {
        match (&mut decision.0, call) {
            (State::Root(path), Call::Root) => {
                name(volumes, path)?;
                let (kind, dir) = dirs.root(&Asked::root(path))?;
                Ok(Told::Root(kind, dir))
            }
            (State::Root(path), Call::List) => {
                name(volumes, path)?;
                Ok(Told::Listing(dirs.list(&Asked::root(path))?))
            }
            (State::Admitted { listed, .. }, Call::List) => {
                name(volumes, &listed.path)?;
                Ok(Told::Listing(dirs.list(&Asked::entry(listed))?))
            }
            (State::Admitted { listed, kind } | State::Undecided { listed, kind, .. }, Call::Kind) => {
                if let Some(kind) = *kind {
                    return Ok(Told::Kind(kind));
                }
                let told = if locked(volumes).mount_point(&listed.path) {
                    EntryKind::Dir
                } else {
                    name(volumes, &listed.path)?;
                    dirs.kind(&Asked::entry(listed))?
                };
                *kind = Some(told);
                Ok(Told::Kind(told))
            }
            (_, call) => Err(io::Error::other(format!("{call:?}: not a call this decision allows"))),
        }
    }

    /// Names the volume a call on `path` reads on; its refusal, or the producer's give-up, as the walk's error.
    fn name(volumes: &SharedVolumes, path: &Path) -> io::Result<()> {
        locked(volumes).name(path).map_err(|refusal| io::Error::other(refusal.map_or(Halt::Stopped, Halt::Refused)))
    }
}

/// How the rules read an entry's path.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Ignore,
    Whitelist,
    None,
}

/// After this many folders entered, the rules forget the ignore files they loaded (reloaded for the folders the walk is
/// still in as it asks about their entries), so what they keep stays bounded on a tree of any size.
const FOLDERS_REMEMBERED: usize = 4_096;

/// A walk's exclusion rules ([module docs](self)).
pub struct Rules {
    root: PathBuf,
    fresh: IncrementalIgnore,
    matcher: IncrementalIgnore,
    entered: usize,
    hidden: bool,
    prune: Vec<PathBuf>,
}

impl Rules {
    /// The rules `builder` holds for its one root (its overrides and ignore sources; its hidden flag is ignored),
    /// hidden entries excluded when `hidden`, and the entries at `prune`.
    pub fn new(root: &Path, builder: &mut WalkBuilder, hidden: bool, prune: Vec<PathBuf>) -> Self {
        builder.hidden(false);
        let fresh = builder.build_matchers().pop().expect("a matcher per root");
        Self { root: root.to_path_buf(), matcher: fresh.clone(), fresh, entered: 0, hidden, prune }
    }

    fn verdict(&mut self, path: &Path, is_dir: bool) -> Verdict {
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        let matched = self.matcher.matched(rel, is_dir);
        if matched.is_ignore() {
            Verdict::Ignore
        } else if matched.is_whitelist() {
            Verdict::Whitelist
        } else {
            Verdict::None
        }
    }

    fn pruned(&self, path: &Path) -> bool {
        self.prune.iter().any(|p| p == path)
    }

    fn hidden_name(&self, path: &Path) -> bool {
        self.hidden && path.file_name().is_some_and(|name| name.as_encoded_bytes().starts_with(b"."))
    }

    /// Whether `verdict` leaves out the entry at `path`, which its listing marks hidden or not (`hidden_attribute`).
    fn excludes(&self, verdict: Verdict, path: &Path, hidden_attribute: bool) -> bool {
        match verdict {
            Verdict::Ignore => true,
            Verdict::Whitelist => false,
            Verdict::None => self.hidden_name(path) || (self.hidden && hidden_attribute),
        }
    }

    fn entered(&mut self) {
        self.entered += 1;
        if self.entered % FOLDERS_REMEMBERED == 0 {
            self.matcher = self.fresh.clone();
        }
    }
}

/// An entry the walk gives, at its depth below the root: one the rules let in.
pub struct Entry {
    pub path: PathBuf,
    pub kind: EntryKind,
    pub depth: usize,
}

/// The walk ([module docs](self)). A call refused by its volume's bound, or made after the producer was given up, is an
/// error holding [`super::Halt`].
pub struct Tree {
    dirs: Box<dyn Dirs>,
    volumes: super::SharedVolumes,
    root: PathBuf,
    rules: Rules,
    max_depth: Option<usize>,
    /// Folders given but never read: those named here, and dotted ones when `bare_dotted`.
    bare: Vec<String>,
    bare_dotted: bool,
    started: bool,
    /// The folders the walk is in, each its entries not yet given, in path order.
    stack: Vec<std::vec::IntoIter<io::Result<Listed>>>,
}

impl Tree {
    pub fn new(root: &Path, rules: Rules, max_depth: Option<usize>, dirs: Box<dyn Dirs>, volumes: super::SharedVolumes) -> Self {
        Self { dirs, volumes, root: root.to_path_buf(), rules, max_depth, bare: Vec::new(), bare_dotted: false, started: false, stack: Vec::new() }
    }

    /// The walk gives, and does not read, the folders named `names` (and the dotted ones when `dotted`).
    pub fn bare(mut self, names: Vec<String>, dotted: bool) -> Self {
        self.bare = names;
        self.bare_dotted = dotted;
        self
    }

    fn is_bare(&self, dir: &Decision) -> bool {
        let Some(name) = dir.path().file_name().map(|n| n.to_string_lossy()) else { return false };
        (self.bare_dotted && name.starts_with('.')) || self.bare.iter().any(|b| *b == *name)
    }

    fn probe(&mut self, decision: &mut Decision, call: Call) -> io::Result<Told> {
        gate::probe(&mut *self.dirs, &self.volumes, decision, call)
    }

    /// Reads `dir`'s entries for the walk to go through: errors first, then the entries in path order (walkdir's
    /// sort with ignore's `sort_by_file_path`).
    fn enter(&mut self, dir: &mut Decision) -> io::Result<()> {
        let Told::Listing(mut entries) = self.probe(dir, Call::List)? else { unreachable!("a listing is told a listing") };
        entries.sort_by(|a, b| match (a, b) {
            (Ok(a), Ok(b)) => a.path().cmp(b.path()),
            (Err(_), Err(_)) => std::cmp::Ordering::Equal,
            (Ok(_), Err(_)) => std::cmp::Ordering::Greater,
            (Err(_), Ok(_)) => std::cmp::Ordering::Less,
        });
        self.stack.push(entries.into_iter());
        self.rules.entered();
        Ok(())
    }

    /// `listed` and its type if the rules let it in; its type asked to judge it only when they read it differently for a
    /// folder than for a file and its listing gave none.
    fn admit(&mut self, listed: Listed) -> io::Result<Option<(Decision, EntryKind)>> {
        let Some(mut decision) = gate::judge(&mut self.rules, listed) else { return Ok(None) };
        let Told::Kind(kind) = self.probe(&mut decision, Call::Kind)? else { unreachable!("a type is told a type") };
        Ok(gate::decide(&mut self.rules, decision).map(|decision| (decision, kind)))
    }
}

impl Iterator for Tree {
    type Item = io::Result<Entry>;

    fn next(&mut self) -> Option<io::Result<Entry>> {
        if !self.started {
            self.started = true;
            let mut root = Decision::root(self.root.clone());
            let (kind, dir) = match self.probe(&mut root, Call::Root) {
                Ok(Told::Root(kind, dir)) => (kind, dir),
                Ok(_) => unreachable!("the root is told the root"),
                Err(error) => return Some(Err(error)),
            };
            // A folder the walk cannot read is an error in its place, as walkdir gives it.
            if dir && let Err(error) = self.enter(&mut root) {
                return Some(Err(error));
            }
            return Some(Ok(Entry { path: root.into_path(), kind, depth: 0 }));
        }
        loop {
            let depth = self.stack.len();
            let item = self.stack.last_mut()?.next();
            let Some(item) = item else {
                self.stack.pop();
                continue;
            };
            let listed = match item {
                Ok(listed) => listed,
                Err(error) => return Some(Err(error)),
            };
            let (mut decision, kind) = match self.admit(listed) {
                Ok(Some(admitted)) => admitted,
                Ok(None) => continue,
                Err(error) => return Some(Err(error)),
            };
            if kind == EntryKind::Dir && self.max_depth.is_none_or(|max| depth < max) && !self.is_bare(&decision) && let Err(error) = self.enter(&mut decision) {
                return Some(Err(error));
            }
            return Some(Ok(Entry { path: decision.into_path(), kind, depth }));
        }
    }
}
