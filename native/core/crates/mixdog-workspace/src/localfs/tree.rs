//! The walks of a file listing and of a text search: ignore's single-threaded `Walk` in what it yields and in what
//! order (siblings in path order, depth first, a folder before its entries), except that the walk's exclusion rules
//! apply to an entry before anything opens it. ignore's `Walk` reads a folder (walkdir `IntoIter::push`,
//! walkdir-2.5.0 lib.rs:901-907) before its rules skip it (`Walk::next`, ignore-0.4.34 walk.rs:1220-1231), so an
//! excluded folder on a dead mount held the walk. Node's server walks with ignore's parallel walker, which applies the
//! rules before it reads a folder (`should_skip_entry` before a folder becomes work, walk.rs:2085), so an excluded
//! folder is never read there either, nor is its read error reported.
//!
//! The rules are ignore's own, through its `IncrementalIgnore` (the same rules and precedence as its walk: overrides,
//! `.ignore`, `.gitignore`, `.git/info/exclude`, the global ignore file, parent folders' ignore files), asked of an
//! entry's path relative to the root; hidden entries are judged here, as ignore judges them, after those rules
//! (`Ignore::matched_dir_entry`). Everything about an entry the rules need is in its folder's listing, so nothing is
//! asked of the entry itself before they let it in:
//! - its path (prune list, overrides, ignore files) and its name (a hidden name starts with `.`): the listing's;
//! - on Windows the hidden attribute: the listing's own (`FindNextFileW` data, which `std`'s `DirEntry::metadata`
//!   returns without a call);
//! - its type, which only a rule that reads differently for a folder than for a file needs (a pattern ending in `/`,
//!   or one that whitelists only one of the two): asked only then. The type is the listing's (Windows find data, Unix
//!   `d_type`), except on a Unix filesystem whose listing has no type, where `std` would `lstat` the entry; a mount
//!   point there is told a folder from the mount table ([`RealDirs`]), so a dead mount below the root is never asked.
//!   An entry whose rules read the same either way is judged without its type.

use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use ignore::IncrementalIgnore;
use ignore::WalkBuilder;
use mixdog_core_api::domain::fs::EntryKind;

/// An entry of a folder's listing.
pub trait Listed: Send {
    fn path(&self) -> &Path;
    /// Windows: whether the listing marks it hidden. Elsewhere `false`: a hidden entry is one whose name starts with `.`.
    fn hidden_attribute(&self) -> bool;
    /// Its type as `std` tells it from the listing ([module docs](self)).
    fn listed_kind(&self) -> io::Result<EntryKind>;
}

/// The filesystem calls a walk makes; the tests put a gate in front of them.
pub trait Dirs: Send {
    /// The root's type (`symlink_metadata`) and whether the walk reads it as a folder (a link to a folder, by
    /// `metadata`, as walkdir follows a root link).
    fn root(&mut self, root: &Path) -> io::Result<(EntryKind, bool)>;
    /// A folder's entries, as its listing gives them.
    fn list(&mut self, dir: &Path) -> io::Result<Vec<io::Result<Box<dyn Listed>>>>;
    /// An entry's type.
    fn kind(&mut self, entry: &dyn Listed) -> io::Result<EntryKind>;
}

/// The real filesystem.
pub struct RealDirs {
    #[cfg(unix)]
    root: PathBuf,
    /// The mount points under the root, as the walk names them; read from the mount table once a type is asked.
    #[cfg(unix)]
    mounts: Option<std::collections::HashSet<PathBuf>>,
}

impl RealDirs {
    pub fn new(root: &Path) -> Self {
        #[cfg(not(unix))]
        let _ = root;
        Self {
            #[cfg(unix)]
            root: root.to_path_buf(),
            #[cfg(unix)]
            mounts: None,
        }
    }
}

struct Real {
    path: PathBuf,
    entry: std::fs::DirEntry,
}

impl Listed for Real {
    fn path(&self) -> &Path {
        &self.path
    }

    fn hidden_attribute(&self) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt as _;
            const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
            self.entry.metadata().is_ok_and(|m| m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
        }
        #[cfg(not(windows))]
        false
    }

    fn listed_kind(&self) -> io::Result<EntryKind> {
        Ok(super::entry_kind(self.entry.file_type()?))
    }
}

impl Dirs for RealDirs {
    fn root(&mut self, root: &Path) -> io::Result<(EntryKind, bool)> {
        let kind = std::fs::symlink_metadata(root)?.file_type();
        let dir = if kind.is_symlink() { std::fs::metadata(root)?.is_dir() } else { kind.is_dir() };
        Ok((super::entry_kind(kind), dir))
    }

    fn list(&mut self, dir: &Path) -> io::Result<Vec<io::Result<Box<dyn Listed>>>> {
        Ok(std::fs::read_dir(dir)?.map(|entry| entry.map(|entry| Box::new(Real { path: entry.path(), entry }) as Box<dyn Listed>)).collect())
    }

    fn kind(&mut self, entry: &dyn Listed) -> io::Result<EntryKind> {
        #[cfg(unix)]
        {
            let root = &self.root;
            let mounts = self.mounts.get_or_insert_with(|| {
                let Ok(canonical) = std::fs::canonicalize(root) else { return Default::default() };
                let table = super::unix_io::MountTable::read();
                table.under(&canonical).into_iter().filter_map(|(point, _)| point.strip_prefix(&canonical).ok().map(|rel| root.join(rel))).collect()
            });
            if mounts.contains(entry.path()) {
                return Ok(EntryKind::Dir);
            }
        }
        entry.listed_kind()
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

/// A walk's exclusion rules ([module docs](self)): shared by its walk and, on Unix, the mount points it may enter
/// ([`super::Volumes`]).
pub struct Rules {
    root: PathBuf,
    fresh: IncrementalIgnore,
    matcher: IncrementalIgnore,
    entered: usize,
    hidden: bool,
    prune: Vec<PathBuf>,
}

pub type SharedRules = Arc<Mutex<Rules>>;

impl Rules {
    /// The rules `builder` holds for its one root (its overrides and ignore sources; its hidden flag is ignored),
    /// hidden entries excluded when `hidden`, and the entries at `prune`.
    pub fn new(root: &Path, builder: &mut WalkBuilder, hidden: bool, prune: Vec<PathBuf>) -> SharedRules {
        builder.hidden(false);
        let fresh = builder.build_matchers().pop().expect("a matcher per root");
        Arc::new(Mutex::new(Self { root: root.to_path_buf(), matcher: fresh.clone(), fresh, entered: 0, hidden, prune }))
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

    /// Whether the walk leaves out the folder at `path` (a mount point): by its path and name alone.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn excludes_folder(&mut self, path: &Path) -> bool {
        self.pruned(path) || match self.verdict(path, true) {
            Verdict::Ignore => true,
            Verdict::Whitelist => false,
            Verdict::None => self.hidden_name(path),
        }
    }

    fn entered(&mut self) {
        self.entered += 1;
        if self.entered % FOLDERS_REMEMBERED == 0 {
            self.matcher = self.fresh.clone();
        }
    }
}

/// An entry the walk gives, at its depth below the root.
pub struct Entry {
    pub path: PathBuf,
    pub kind: EntryKind,
    pub depth: usize,
}

/// The walk ([module docs](self)).
pub struct Tree {
    dirs: Box<dyn Dirs>,
    root: PathBuf,
    rules: SharedRules,
    max_depth: Option<usize>,
    started: bool,
    /// The folders the walk is in, each its entries not yet given, in path order.
    stack: Vec<std::vec::IntoIter<io::Result<Box<dyn Listed>>>>,
}

impl Tree {
    pub fn new(root: &Path, rules: SharedRules, max_depth: Option<usize>, dirs: Box<dyn Dirs>) -> Self {
        Self { dirs, root: root.to_path_buf(), rules, max_depth, started: false, stack: Vec::new() }
    }

    /// Reads `dir`'s entries for the walk to go through: errors first, then the entries in path order (walkdir's
    /// sort with ignore's `sort_by_file_path`).
    fn enter(&mut self, dir: &Path) -> io::Result<()> {
        let mut entries = self.dirs.list(dir)?;
        entries.sort_by(|a, b| match (a, b) {
            (Ok(a), Ok(b)) => a.path().cmp(b.path()),
            (Err(_), Err(_)) => std::cmp::Ordering::Equal,
            (Ok(_), Err(_)) => std::cmp::Ordering::Greater,
            (Err(_), Ok(_)) => std::cmp::Ordering::Less,
        });
        self.stack.push(entries.into_iter());
        locked(&self.rules).entered();
        Ok(())
    }

    /// The entry's type if the rules let it in, asked of the filesystem only when they read it differently for a folder
    /// than for a file, or once it is in.
    fn admit(&mut self, entry: &dyn Listed) -> io::Result<Option<EntryKind>> {
        let mut rules = locked(&self.rules);
        let path = entry.path();
        if rules.pruned(path) {
            return Ok(None);
        }
        let (as_dir, as_file) = (rules.verdict(path, true), rules.verdict(path, false));
        let mut kind = None;
        let verdict = if as_dir == as_file {
            as_dir
        } else {
            let told = self.dirs.kind(entry)?;
            kind = Some(told);
            if told == EntryKind::Dir { as_dir } else { as_file }
        };
        let excluded = match verdict {
            Verdict::Ignore => true,
            Verdict::Whitelist => false,
            Verdict::None => rules.hidden_name(path) || (rules.hidden && entry.hidden_attribute()),
        };
        drop(rules);
        if excluded {
            return Ok(None);
        }
        Ok(Some(match kind {
            Some(kind) => kind,
            None => self.dirs.kind(entry)?,
        }))
    }
}

pub fn locked(rules: &SharedRules) -> std::sync::MutexGuard<'_, Rules> {
    rules.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Iterator for Tree {
    type Item = io::Result<Entry>;

    fn next(&mut self) -> Option<io::Result<Entry>> {
        if !self.started {
            self.started = true;
            let root = self.root.clone();
            let (kind, dir) = match self.dirs.root(&root) {
                Ok(told) => told,
                Err(error) => return Some(Err(error)),
            };
            // A folder the walk cannot read is an error in its place, as walkdir gives it.
            if dir && let Err(error) = self.enter(&root) {
                return Some(Err(error));
            }
            return Some(Ok(Entry { path: root, kind, depth: 0 }));
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
            let kind = match self.admit(&*listed) {
                Ok(Some(kind)) => kind,
                Ok(None) => continue,
                Err(error) => return Some(Err(error)),
            };
            let path = listed.path().to_path_buf();
            drop(listed);
            if kind == EntryKind::Dir && self.max_depth.is_none_or(|max| depth < max) && let Err(error) = self.enter(&path) {
                return Some(Err(error));
            }
            return Some(Ok(Entry { path, kind, depth }));
        }
    }
}
