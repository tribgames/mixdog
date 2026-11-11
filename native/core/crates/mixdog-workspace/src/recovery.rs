#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Host-private byte journals for multi-file edits (port of
//! `project-recovery-store.ts` and `project-recovery.ts`). Publication precedes
//! the first target mutation; this module never restores a file without an
//! approved revision. The store lives outside the project tree.
//!
//! Layout: `<base>/<sha256(root)>/<record>/{manifest.json,state.json,N.before,N.after}`
//! where `<record>` is `<id>` at rest, `<id>--<pid>--<instance>--<uuid>` while owned
//! by a running operation, and `retired-` prefixed once removal began.

use std::collections::HashSet;
use std::fs;
use std::fs::File;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::ident::FileId;
use crate::ident::path_id;
use crate::inplace::open_authorized_rw;
use crate::inplace::read_all;
use crate::inplace::rewrite_or_restore;
use crate::pathguard::canonical;
use crate::pathguard::comparable;
use crate::pathguard::lexical;
use crate::pathguard::project_entry_path;

pub const RECOVERY_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const RECOVERY_MAX_RECORDS: usize = 20;
const MANIFEST_MAX: u64 = 131_072;
const STATE_MAX: u64 = 65_536;

pub fn recovery_err(code: &'static str, message: &str) -> WsError {
    WsError::new(Reason::Recovery(code), format!("{code}: {message}"))
}

pub fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub dev: String,
    pub ino: String,
}

impl From<FileId> for Identity {
    fn from(id: FileId) -> Self {
        Self { dev: id.volume.to_string(), ino: id.index.to_string() }
    }
}

pub fn identity_of(path: &Path) -> io::Result<Identity> {
    Ok(path_id(path)?.into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ByteRef {
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryFile {
    pub rel_path: String,
    pub destination: PathBuf,
    pub parent: Identity,
    pub mode: u32,
    pub before: ByteRef,
    pub after: ByteRef,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub id: String,
    pub created_at: i64,
    pub root: PathBuf,
    pub root_identity: Identity,
    pub files: Vec<RecoveryFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatePhase {
    Failed,
    Recovered,
    Complete,
    Restoring,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub phase: StatePhase,
    pub message: String,
    pub restored: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Interrupted,
    Failed,
    Recovered,
    Completed,
    Active,
    Invalid,
    Retired,
}

fn settled_phase(state: Option<&State>) -> Phase {
    match state.map(|s| s.phase) {
        Some(StatePhase::Complete) => Phase::Completed,
        Some(StatePhase::Failed) => Phase::Failed,
        Some(StatePhase::Recovered) => Phase::Recovered,
        _ => Phase::Interrupted,
    }
}

pub struct PreparedFile {
    pub rel_path: String,
    pub destination: PathBuf,
    pub parent: Identity,
    pub mode: u32,
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}

struct Location {
    id: String,
    retired: bool,
    pid: Option<u32>,
    instance: Option<String>,
}

pub fn is_record_id(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    groups.len() == 5
        && groups
            .iter()
            .zip(lens)
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn location_name(name: &str) -> Option<Location> {
    let retired = name.starts_with("retired-");
    let rest = if retired { &name[8..] } else { name };
    let parts: Vec<&str> = rest.split("--").collect();
    if !is_record_id(parts[0]) {
        return None;
    }
    if parts.len() == 1 {
        return Some(Location { id: parts[0].into(), retired, pid: None, instance: None });
    }
    let pid: u32 = parts.get(1)?.parse().ok().filter(|p| *p >= 1)?;
    if parts.len() != 4 || !is_record_id(parts[2]) || !is_record_id(parts[3]) {
        return None;
    }
    Some(Location { id: parts[0].into(), retired, pid: Some(pid), instance: Some(parts[2].into()) })
}

fn base_name(dir: &Path) -> String {
    dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only probes; permission errors conservatively keep ownership.
    unsafe { libc::kill(pid as i32, 0) == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    use windows_sys::Win32::System::Threading::OpenProcess;
    // SAFETY: plain query of a process id; the handle is closed at once.
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return io::Error::last_os_error().raw_os_error() == Some(ERROR_ACCESS_DENIED as i32);
        }
        // A process that has exited can stay openable for a while (crash handling, a held
        // handle): only a still-active one owns its record.
        let mut code = 0u32;
        let queried = windows_sys::Win32::System::Threading::GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        queried == 0 || code == 259
    }
}

fn stamp(meta: &fs::Metadata) -> (u64, Option<SystemTime>) {
    (meta.len(), meta.modified().ok())
}

pub struct ReadLimit;

/// Reads a record file that must stay a regular file of unchanged stamp while read.
pub fn read_checked(file: &Path, max: u64) -> WsResult<Result<Vec<u8>, ReadLimit>> {
    let first = fs::symlink_metadata(file)?;
    if !first.is_file() {
        return Err(WsError::new(Reason::Io, "Recovery file is invalid."));
    }
    if first.len() > max {
        return Ok(Err(ReadLimit));
    }
    let mut handle = File::open(file)?;
    if stamp(&handle.metadata()?) != stamp(&first) {
        return Err(WsError::new(Reason::Changed, "Recovery file changed while opening."));
    }
    let mut bytes = Vec::with_capacity(first.len() as usize + 1);
    (&mut handle).take(first.len() + 1).read_to_end(&mut bytes)?;
    let last = fs::symlink_metadata(file)?;
    if bytes.len() as u64 != first.len() || !last.is_file() || stamp(&last) != stamp(&first) {
        return Err(WsError::new(Reason::Changed, "Recovery file changed while reading."));
    }
    Ok(Ok(bytes))
}

fn read_limited(file: &Path, max: u64) -> WsResult<Vec<u8>> {
    read_checked(file, max)?.map_err(|_| WsError::new(Reason::TooLarge, "Recovery file is oversized."))
}

fn private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Process-crash durability of a rename; not a power-loss guarantee on Windows.
fn sync_directory(path: &Path) -> io::Result<()> {
    if cfg!(windows) {
        return Ok(());
    }
    File::open(path)?.sync_all()
}

fn require_directory(path: &Path) -> WsResult<()> {
    let meta = fs::symlink_metadata(path)?;
    let regular = meta.is_dir() && !meta.file_type().is_symlink();
    if !regular || comparable(&canonical(path)?) != comparable(&lexical(path)) {
        return Err(recovery_err("RECOVERY_STORAGE", "Recovery storage is not a regular private directory."));
    }
    Ok(())
}

fn validate_directory(directory: &Path) -> WsResult<()> {
    let parent = directory.parent().unwrap_or(directory);
    require_directory(parent.parent().unwrap_or(parent))?;
    require_directory(parent)?;
    require_directory(directory)
}

fn storage_error(error: WsError) -> WsError {
    let denied = matches!(error.reason, Reason::PermissionDenied | Reason::Io)
        && ["No space", "not enough space", "disk full", "Read-only"].iter().any(|t| error.message.contains(t));
    if denied {
        recovery_err("RECOVERY_STORAGE", "Recovery storage is unavailable. Check free space and permissions.")
    } else {
        error
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(1)
}

/// The folder of the data dir that holds every project's journal store (Node kept them in `<userData>/editor-recovery`).
pub const JOURNALS_DIR: &str = "recovery";

/// The journal store of one process.
pub struct RecoveryStore {
    base: PathBuf,
    instance: String,
    active: Mutex<HashSet<PathBuf>>,
}

pub struct Journal {
    pub id: String,
    pub directory: PathBuf,
}

pub struct Record {
    pub manifest: Manifest,
    pub state: Option<State>,
    pub fingerprint: String,
}

impl RecoveryStore {
    pub fn new(base: PathBuf) -> Self {
        Self { base, instance: uuid::Uuid::new_v4().to_string(), active: Mutex::new(HashSet::new()) }
    }

    fn active_set(&self) -> std::sync::MutexGuard<'_, HashSet<PathBuf>> {
        self.active.lock().expect("recovery active set")
    }

    /// The per-project record folder.
    pub fn store_path(&self, root: &Path) -> PathBuf {
        let key = hex_digest(lexical(root).to_string_lossy().as_bytes());
        self.base.join(key)
    }

    fn owned_name(&self, id: &str) -> String {
        format!("{id}--{}--{}--{}", std::process::id(), self.instance, uuid::Uuid::new_v4())
    }

    pub fn is_active(&self, directory: &Path) -> bool {
        let Some(owner) = location_name(&base_name(directory)) else { return false };
        let Some(pid) = owner.pid else { return false };
        if owner.instance.as_deref() == Some(self.instance.as_str()) {
            return self.active_set().contains(directory);
        }
        pid_alive(pid)
    }

    pub fn is_retired(directory: &Path) -> bool {
        location_name(&base_name(directory)).is_some_and(|l| l.retired)
    }

    fn locations(&self, root: &Path) -> WsResult<Vec<PathBuf>> {
        let parent = self.store_path(root);
        match require_directory(parent.parent().unwrap_or(&parent)).and_then(|_| require_directory(&parent)) {
            Ok(()) => {}
            Err(e) if e.reason == Reason::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        }
        let mut result = Vec::new();
        for (seen, entry) in fs::read_dir(&parent)?.enumerate() {
            let entry = entry?;
            if seen + 1 > RECOVERY_MAX_RECORDS * 3 {
                return Err(recovery_err("RECOVERY_STORAGE", "Recovery storage needs manual inspection: too many entries."));
            }
            let kind = entry.file_type()?;
            if location_name(&entry.file_name().to_string_lossy()).is_none() || !kind.is_dir() || kind.is_symlink() {
                return Err(recovery_err(
                    "RECOVERY_MANUAL_INSPECTION",
                    "Recovery storage contains unrecognized entries. Inspect the host recovery folder manually.",
                ));
            }
            result.push(entry.path());
        }
        Ok(result)
    }

    pub fn location(&self, root: &Path, id: &str) -> WsResult<PathBuf> {
        if !is_record_id(id) {
            return Err(WsError::invalid("Invalid recovery ID."));
        }
        let mut matches: Vec<PathBuf> = self
            .locations(root)?
            .into_iter()
            .filter(|p| location_name(&base_name(p)).is_some_and(|l| l.id == id))
            .collect();
        if matches.len() != 1 {
            return Err(recovery_err("RECOVERY_UNAVAILABLE", "Recovery record moved or is unavailable. Refresh the list."));
        }
        Ok(matches.remove(0))
    }

    /// Retirement lives in the directory name, outside the files being removed: a
    /// partial recursive deletion can never make a finished batch restorable again.
    pub fn retire(&self, directory: &Path) -> WsResult<PathBuf> {
        validate_directory(directory)?;
        if Self::is_retired(directory) {
            return Ok(directory.to_path_buf());
        }
        let retired = directory.with_file_name(format!("retired-{}", base_name(directory)));
        fs::rename(directory, &retired)?;
        let mut active = self.active_set();
        active.remove(directory);
        active.insert(retired.clone());
        Ok(retired)
    }

    pub fn remove(&self, directory: &Path) -> WsResult<()> {
        if !Self::is_retired(directory) {
            return Err(WsError::new(Reason::InvalidParams, "Recovery record must be retired before removal."));
        }
        validate_directory(directory)?;
        sync_directory(directory.parent().unwrap_or(directory))?;
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    fn file_stamp(meta: &fs::Metadata) -> String {
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
        format!("{}:{modified}", meta.len())
    }

    /// Bounded inventory of a record's flat store: regular files only.
    pub fn storage_inventory(&self, directory: &Path) -> WsResult<Vec<(String, String, String)>> {
        validate_directory(directory)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entries.len() >= 300 {
                return Err(recovery_err("RECOVERY_STORAGE", "Recovery record has too many entries for automatic removal."));
            }
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.is_dir() {
                return Err(recovery_err("RECOVERY_STORAGE", "Recovery record contains an unexpected directory."));
            }
            if !meta.is_file() {
                return Err(recovery_err("RECOVERY_STORAGE", "Recovery record contains an entry that is not a regular file."));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let digest = if meta.len() <= 131_072 && (name == "manifest.json" || name == "state.json") {
                hex_digest(&read_limited(&entry.path(), 131_072)?)
            } else {
                String::new()
            };
            entries.push((name, Self::file_stamp(&meta), digest));
        }
        validate_directory(directory)?;
        entries.sort();
        Ok(entries)
    }

    pub fn write_state(&self, directory: &Path, state: &State) -> WsResult<()> {
        validate_directory(directory)?;
        let mut clipped = state.clone();
        clipped.message = clipped.message.chars().take(8000).collect();
        let temp = directory.join(format!("state-{}.tmp", uuid::Uuid::new_v4()));
        let outcome = (|| -> WsResult<()> {
            private_file(&temp, &serde_json::to_vec(&clipped).expect("state json"))?;
            validate_directory(directory)?;
            fs::rename(&temp, directory.join("state.json"))?;
            sync_directory(directory)?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&temp);
        }
        outcome
    }

    pub fn read_record(&self, directory: &Path) -> WsResult<Record> {
        validate_directory(directory)?;
        let id = location_name(&base_name(directory))
            .map(|l| l.id)
            .ok_or_else(|| WsError::new(Reason::InvalidParams, "Recovery location is invalid."))?;
        let raw = read_limited(&directory.join("manifest.json"), MANIFEST_MAX)?;
        let manifest: Manifest = serde_json::from_slice(&raw)
            .map_err(|_| WsError::new(Reason::InvalidParams, "Recovery manifest is invalid. No file will be restored."))?;
        if !valid_manifest(&manifest, &id) {
            return Err(WsError::new(Reason::InvalidParams, "Recovery manifest is invalid. No file will be restored."));
        }
        let state_bytes = match read_limited(&directory.join("state.json"), STATE_MAX) {
            Ok(b) => b,
            Err(e) if e.reason == Reason::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        let state = if state_bytes.is_empty() {
            None
        } else {
            // Node cuts the message at 8000 UTF-16 units, inside an emoji too: half of one is U+FFFD here. A restored path is no
            // free text: one that held a lone surrogate leaves the state invalid, as a manifest path holding one leaves the
            // manifest invalid (plain serde above; decisions.md "frame-lone-surrogate").
            let state: State = serde_json::from_slice(&mixdog_js::json_well_formed(&state_bytes))
                .map_err(|_| WsError::new(Reason::InvalidParams, "Recovery state is invalid. No file will be restored."))?;
            let lone_path = std::str::from_utf8(&state_bytes)
                .map(mixdog_js::json_lone_surrogate_pointers)
                .unwrap_or_default()
                .iter()
                .any(|pointer| pointer != "/message");
            let known = |rel: &String| manifest.files.iter().any(|f| &f.rel_path == rel);
            if lone_path || state.message.chars().count() > 8000 || state.restored.len() > manifest.files.len() || !state.restored.iter().all(known) {
                return Err(WsError::new(Reason::InvalidParams, "Recovery state is invalid. No file will be restored."));
            }
            Some(state)
        };
        let fingerprint = hex_digest(&[raw, state_bytes].concat());
        Ok(Record { manifest, state, fingerprint })
    }

    pub fn read_payload(&self, directory: &Path, file: &RecoveryFile, index: usize, side: Side) -> WsResult<Vec<u8>> {
        validate_directory(directory)?;
        let (name, expected) = match side {
            Side::Before => (format!("{index}.before"), &file.before),
            Side::After => (format!("{index}.after"), &file.after),
        };
        let bytes = read_limited(&directory.join(name), expected.size)?;
        if bytes.len() as u64 != expected.size || hex_digest(&bytes) != expected.sha256 {
            return Err(WsError::new(Reason::Changed, "Recovery backup failed its integrity check."));
        }
        Ok(bytes)
    }

    pub fn list(&self, root: &Path) -> WsResult<Vec<Summary>> {
        let mut records = Vec::new();
        for directory in self.locations(root)? {
            let id = location_name(&base_name(&directory)).expect("validated location").id;
            let busy = self.is_active(&directory);
            if Self::is_retired(&directory) {
                records.push(Summary::new(id, 0, 0, None, if busy { Phase::Active } else { Phase::Retired }));
                continue;
            }
            match self.read_record(&directory) {
                Ok(Record { manifest, state, .. }) => {
                    let payload = manifest.files.iter().map(|f| f.before.size + f.after.size).sum();
                    let phase = if busy { Phase::Active } else { settled_phase(state.as_ref()) };
                    records.push(Summary::new(id, manifest.created_at, manifest.files.len(), Some(payload), phase));
                }
                Err(_) => records.push(Summary::new(id, 0, 0, None, if busy { Phase::Active } else { Phase::Invalid })),
            }
        }
        records.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        Ok(records)
    }

    /// Leases an at-rest record to this operation (renamed to an owned name).
    pub fn claim(&self, directory: &Path) -> WsResult<PathBuf> {
        validate_directory(directory)?;
        if self.is_active(directory) {
            return Err(recovery_err("RECOVERY_BUSY", "Recovery record is still owned by a running operation."));
        }
        let owner = location_name(&base_name(directory)).expect("validated location");
        let prefix = if owner.retired { "retired-" } else { "" };
        let owned = directory.with_file_name(format!("{prefix}{}", self.owned_name(&owner.id)));
        fs::rename(directory, &owned)?;
        self.active_set().insert(owned.clone());
        Ok(owned)
    }

    pub fn release(&self, directory: &Path) -> WsResult<()> {
        self.active_set().remove(directory);
        let Some(owner) = location_name(&base_name(directory)) else { return Ok(()) };
        let prefix = if owner.retired { "retired-" } else { "" };
        let target = directory.with_file_name(format!("{prefix}{}", owner.id));
        match fs::rename(directory, &target) {
            Ok(()) => sync_directory(target.parent().unwrap_or(&target)).map_err(Into::into),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(WsError::new(Reason::Io, "Recovery data was retained but could not be published.")),
        }
    }

    /// Publishes a journal before the first target mutation.
    pub fn begin(&self, root: &Path, files: Vec<PreparedFile>) -> WsResult<Journal> {
        self.prepare(root, files).map_err(storage_error)
    }

    fn prepare(&self, root: &Path, files: Vec<PreparedFile>) -> WsResult<Journal> {
        let total: u64 = files.iter().map(|f| (f.before.len() + f.after.len()) as u64).sum();
        if files.is_empty() || files.len() > 100 || total > RECOVERY_MAX_BYTES {
            return Err(recovery_err(
                "RECOVERY_BATCH_LIMIT",
                "Workspace edit exceeds the recovery budget. Split the edit into smaller batches.",
            ));
        }
        let parent = self.store_path(root);
        let grand = parent.parent().expect("store has a parent").to_path_buf();
        fs::create_dir_all(&grand)?;
        require_directory(&grand)?;
        fs::create_dir_all(&parent)?;
        require_directory(&parent)?;
        if self.locations(root)?.len() >= RECOVERY_MAX_RECORDS {
            return Err(recovery_err(
                "RECOVERY_CAPACITY",
                "Recovery storage is full. Inspect and explicitly discard records before another workspace edit.",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let directory = parent.join(self.owned_name(&id));
        fs::create_dir(&directory)?;
        crate::killpoint::hit("journal-dir");
        self.active_set().insert(directory.clone());
        let written = (|| -> WsResult<Manifest> {
            let manifest = Manifest {
                version: 1,
                id: id.clone(),
                created_at: now_ms(),
                root: canonical(root)?,
                root_identity: identity_of(root)?,
                files: files
                    .iter()
                    .map(|f| RecoveryFile {
                        rel_path: f.rel_path.clone(),
                        destination: f.destination.clone(),
                        parent: f.parent.clone(),
                        mode: f.mode,
                        before: ByteRef { size: f.before.len() as u64, sha256: hex_digest(&f.before) },
                        after: ByteRef { size: f.after.len() as u64, sha256: hex_digest(&f.after) },
                    })
                    .collect(),
            };
            if !valid_manifest(&manifest, &id) {
                return Err(WsError::invalid("Recovery input is invalid."));
            }
            let bytes = serde_json::to_vec(&manifest).expect("manifest json");
            if bytes.len() as u64 > MANIFEST_MAX {
                return Err(WsError::invalid("Recovery manifest exceeds its size limit."));
            }
            for (index, file) in files.iter().enumerate() {
                validate_directory(&directory)?;
                private_file(&directory.join(format!("{index}.before")), &file.before)?;
                private_file(&directory.join(format!("{index}.after")), &file.after)?;
            }
            crate::killpoint::hit("payloads");
            private_file(&directory.join("manifest.json"), &bytes)?;
            crate::killpoint::hit("manifest");
            sync_directory(&directory)?;
            sync_directory(&parent)?;
            crate::killpoint::hit("published");
            Ok(manifest)
        })();
        match written {
            Ok(_) => Ok(Journal { id, directory }),
            Err(error) => {
                self.active_set().remove(&directory);
                let _ = fs::remove_dir_all(&directory);
                Err(error)
            }
        }
    }

    /// Settles a batch's record once its writes ran: a completed batch retires and
    /// removes it, a failed one keeps it, marked with what was restored. Returns
    /// the bookkeeping errors, if any.
    pub fn settle(&self, journal: &mut Journal, failed: bool, failure: &str, restored: &HashSet<String>) -> Vec<WsError> {
        let mut errors = Vec::new();
        let state = State {
            phase: if failed { StatePhase::Failed } else { StatePhase::Complete },
            message: if failed { failure.to_owned() } else { String::new() },
            restored: restored.iter().cloned().collect(),
        };
        let result = (|| -> WsResult<()> {
            self.write_state(&journal.directory, &state)?;
            crate::killpoint::hit("state-written");
            if !failed {
                journal.directory = self.retire(&journal.directory)?;
                crate::killpoint::hit("retired");
                let _ = self.remove(&journal.directory);
                crate::killpoint::hit("removed");
            }
            Ok(())
        })();
        if let Err(e) = result {
            errors.push(e);
        }
        if let Err(e) = self.release(&journal.directory) {
            errors.push(e);
        }
        errors
    }
}

#[derive(Clone, Copy)]
pub enum Side {
    Before,
    After,
}

fn valid_identity(id: &Identity) -> bool {
    let ok = |s: &str| !s.is_empty() && s.len() <= 30 && s.bytes().all(|b| b.is_ascii_digit());
    ok(&id.dev) && ok(&id.ino)
}

fn valid_manifest(m: &Manifest, id: &str) -> bool {
    if m.version != 1 || m.id != id || m.created_at < 1 || !m.root.is_absolute() || !valid_identity(&m.root_identity) {
        return false;
    }
    if m.files.is_empty() || m.files.len() > 100 {
        return false;
    }
    let mut paths = HashSet::new();
    let mut bytes = 0u64;
    for f in &m.files {
        let sha = |r: &ByteRef| r.size <= RECOVERY_MAX_BYTES && r.sha256.len() == 64 && r.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if f.rel_path.is_empty()
            || f.rel_path.len() > 4096
            || Path::new(&f.rel_path).is_absolute()
            || f.rel_path.contains('\0')
            || !f.destination.is_absolute()
            || !valid_identity(&f.parent)
            || f.mode > 0o177_777
            || !sha(&f.before)
            || !sha(&f.after)
            || !paths.insert(f.rel_path.clone())
        {
            return false;
        }
        bytes += f.before.size + f.after.size;
    }
    bytes <= RECOVERY_MAX_BYTES
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub created_at: i64,
    pub phase: Phase,
    pub file_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_bytes: Option<u64>,
}

impl Summary {
    fn new(id: String, created_at: i64, file_count: usize, payload_bytes: Option<u64>, phase: Phase) -> Self {
        Self { id, created_at, phase, file_count, payload_bytes }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Original,
    Written,
    Restored,
    External,
    Missing,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileDetail {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub status: FileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    #[serde(flatten)]
    pub summary: Summary,
    pub revision: String,
    pub active: bool,
    pub files: Vec<FileDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub used_records: usize,
    pub max_records: usize,
    pub unresolved_records: usize,
    pub resolved_records: usize,
    pub payload_bytes: u64,
    pub unknown_size_records: usize,
    pub max_batch_bytes: u64,
    pub max_batch_files: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub records: Vec<Summary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<Storage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Detail>,
}

#[derive(Clone, Debug)]
pub enum Action {
    List,
    Inspect { id: String },
    Restore { id: String, revision: String },
    Discard { id: String, revision: String },
}

impl Action {
    pub fn parse(action: &str, id: Option<&str>, revision: Option<&str>) -> WsResult<Self> {
        if action == "list" {
            return Ok(Self::List);
        }
        let id = id.filter(|i| is_record_id(i)).ok_or_else(|| WsError::invalid("Invalid recovery ID."))?;
        match action {
            "inspect" => Ok(Self::Inspect { id: id.into() }),
            "restore" | "discard" => {
                let revision = revision
                    .filter(|r| r.len() == 64 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
                    .ok_or_else(|| WsError::invalid("Invalid recovery action or revision."))?;
                Ok(if action == "restore" {
                    Self::Restore { id: id.into(), revision: revision.into() }
                } else {
                    Self::Discard { id: id.into(), revision: revision.into() }
                })
            }
            _ => Err(WsError::invalid("Invalid recovery action or revision.")),
        }
    }
}

fn validate_target(root: &Path, manifest: &Manifest, entry: &RecoveryFile) -> WsResult<PathBuf> {
    if comparable(&canonical(root)?) != comparable(&manifest.root) || identity_of(root)? != manifest.root_identity {
        return Err(WsError::new(Reason::Changed, "Project root changed."));
    }
    let file = project_entry_path(root, &entry.rel_path)?;
    let parent = canonical(file.parent().unwrap_or(&file))?;
    let destination = parent.join(file.file_name().unwrap_or_default());
    // Node's `join(realpath(parent), basename(file)) !== entry.destination` (project-recovery.ts:45): the strings, case and all.
    if destination.as_os_str() != entry.destination.as_os_str() || identity_of(&parent)? != entry.parent {
        return Err(WsError::new(Reason::Changed, "Project directory changed."));
    }
    Ok(file)
}

fn belongs_to(root: &Path, manifest: &Manifest) -> bool {
    comparable(&manifest.root) == comparable(&lexical(root)) || canonical(root).is_ok_and(|r| comparable(&r) == comparable(&manifest.root))
}

impl RecoveryStore {
    fn inspect_storage(&self, directory: &Path, leased: bool) -> WsResult<Detail> {
        validate_directory(directory)?;
        let owner = location_name(&base_name(directory)).expect("validated location");
        let before = identity_of(directory)?;
        let entries = self.storage_inventory(directory)?;
        if identity_of(directory)? != before {
            return Err(WsError::new(Reason::Changed, "Recovery record changed."));
        }
        let busy = !leased && self.is_active(directory);
        let phase = if busy {
            Phase::Active
        } else if owner.retired {
            Phase::Retired
        } else {
            Phase::Invalid
        };
        let revision = hex_digest(format!("{:?}", (&owner.id, owner.retired, &before, &entries)).as_bytes());
        Ok(Detail { summary: Summary::new(owner.id, 0, 0, None, phase), revision, active: busy, files: Vec::new(), message: None })
    }

    fn inspect_directory(&self, root: &Path, directory: &Path, leased: bool) -> WsResult<Detail> {
        if Self::is_retired(directory) {
            return self.inspect_storage(directory, leased);
        }
        let Ok(record) = self.read_record(directory) else { return self.inspect_storage(directory, leased) };
        let Record { manifest, state, fingerprint } = record;
        let busy = !leased && self.is_active(directory);
        let mut observations = vec![fingerprint.clone(), format!("{:?}", (identity_of(directory)?, self.storage_inventory(directory)?))];
        let mut files = Vec::new();
        for (index, entry) in manifest.files.iter().enumerate() {
            let outcome = (|| -> WsResult<(FileStatus, String)> {
                let file = validate_target(root, &manifest, entry)?;
                self.read_payload(directory, entry, index, Side::Before)?;
                self.read_payload(directory, entry, index, Side::After)?;
                let meta = fs::symlink_metadata(&file)?;
                if !meta.is_file() {
                    return Err(WsError::new(Reason::NotAFile, "Target is not a regular file."));
                }
                let bytes = read_limited(&file, entry.before.size.max(entry.after.size))?;
                validate_target(root, &manifest, entry)?;
                let digest = hex_digest(&bytes);
                let observed = format!("{:?}", (&entry.rel_path, &digest, crate::ident::mtime_ns(&meta)));
                let size = bytes.len() as u64;
                let status = if size == entry.before.size && digest == entry.before.sha256 {
                    if state.as_ref().is_some_and(|s| s.restored.contains(&entry.rel_path)) { FileStatus::Restored } else { FileStatus::Original }
                } else if size == entry.after.size && digest == entry.after.sha256 {
                    FileStatus::Written
                } else {
                    FileStatus::External
                };
                Ok((status, observed))
            })();
            match outcome {
                Ok((status, observed)) => {
                    observations.push(observed);
                    files.push(FileDetail { rel_path: entry.rel_path.clone(), status, reason: None });
                }
                Err(error) => {
                    let status = if error.reason == Reason::NotFound { FileStatus::Missing } else { FileStatus::Unavailable };
                    observations.push(format!("{:?}", (&entry.rel_path, status)));
                    files.push(FileDetail {
                        rel_path: entry.rel_path.clone(),
                        status,
                        reason: Some(error.message.chars().take(512).collect()),
                    });
                }
            }
        }
        if self.read_record(directory)?.fingerprint != fingerprint {
            return Err(recovery_err("RECOVERY_CHANGED", "Recovery record changed while inspecting. Refresh it."));
        }
        let phase = if busy { Phase::Active } else { settled_phase(state.as_ref()) };
        Ok(Detail {
            summary: Summary::new(manifest.id.clone(), manifest.created_at, manifest.files.len(), None, phase),
            revision: hex_digest(observations.join("\n").as_bytes()),
            active: busy,
            files,
            message: state.as_ref().map(|s| s.message.clone()).filter(|m| !m.is_empty()),
        })
    }

    fn overview(&self, root: &Path) -> WsResult<Response> {
        let records = self.list(root)?;
        let root_available = fs::symlink_metadata(root).is_ok_and(|m| m.is_dir())
            && canonical(root).is_ok_and(|r| comparable(&r) == comparable(root));
        let resolved = records
            .iter()
            .filter(|r| matches!(r.phase, Phase::Completed | Phase::Recovered | Phase::Retired))
            .count();
        Ok(Response {
            storage: Some(Storage {
                used_records: records.len(),
                max_records: RECOVERY_MAX_RECORDS,
                unresolved_records: records.len() - resolved,
                resolved_records: resolved,
                payload_bytes: records.iter().map(|r| r.payload_bytes.unwrap_or(0)).sum(),
                unknown_size_records: records.iter().filter(|r| r.payload_bytes.is_none()).count(),
                max_batch_bytes: RECOVERY_MAX_BYTES,
                max_batch_files: 100,
            }),
            records,
            root_available: Some(root_available),
            detail: None,
        })
    }

    /// The project root must be resolved through the registry on every request. No client
    /// path or backup body is ever accepted as restoration authority. The caller holds the
    /// project mutation claim for a restore.
    pub fn execute(&self, root: &Path, action: Action) -> WsResult<Response> {
        let (id, revision, discard) = match &action {
            Action::List => return self.overview(root),
            Action::Inspect { id } => {
                let directory = self.location(root, id)?;
                let detail = self.inspect_directory(root, &directory, false)?;
                return Ok(Response { detail: Some(detail), ..self.overview(root)? });
            }
            Action::Restore { id, revision } => (id.clone(), revision.clone(), false),
            Action::Discard { id, revision } => (id.clone(), revision.clone(), true),
        };
        let directory = self.location(root, &id)?;
        let mut owned = self.claim(&directory)?;
        let mut removed = false;
        let outcome = (|| -> WsResult<()> {
            if discard {
                let approved = self.inspect_directory(root, &owned, true)?;
                require_revision(&approved, &revision)?;
                if !Self::is_retired(&owned) {
                    if let Ok(record) = self.read_record(&owned) {
                        if !belongs_to(root, &record.manifest) {
                            return Err(recovery_err(
                                "RECOVERY_MANUAL_INSPECTION",
                                "Recovery record belongs to another project root. Inspect the host recovery folder manually.",
                            ));
                        }
                    }
                }
                owned = self.retire(&owned)?;
                self.remove(&owned)?;
                removed = true;
                Ok(())
            } else {
                self.restore(root, &owned, &revision)
            }
        })();
        let released = if removed { Ok(()) } else { self.release(&owned) };
        outcome?;
        released?;
        let overview = self.overview(root)?;
        if removed {
            return Ok(overview);
        }
        let again = self.location(root, &id)?;
        Ok(Response { detail: Some(self.inspect_directory(root, &again, false)?), ..overview })
    }

    fn restore(&self, root: &Path, owned: &Path, revision: &str) -> WsResult<()> {
        let not_restorable = || recovery_err("RECOVERY_NOT_RESTORABLE", "This record cannot restore files; recovery is not an undo command.");
        if Self::is_retired(owned) {
            return Err(not_restorable());
        }
        let Record { manifest, state, .. } = self.read_record(owned).map_err(|_| not_restorable())?;
        if state.as_ref().is_some_and(|s| s.phase == StatePhase::Complete) {
            return Err(recovery_err("RECOVERY_NOT_RESTORABLE", "This batch completed successfully; recovery is not an undo command."));
        }
        let approved = self.inspect_directory(root, owned, true)?;
        require_revision(&approved, revision)?;
        if matches!(approved.summary.phase, Phase::Invalid | Phase::Retired | Phase::Completed) {
            return Err(recovery_err("RECOVERY_NOT_RESTORABLE", "Recovery record is no longer restorable."));
        }
        let mut restored: HashSet<String> = approved
            .files
            .iter()
            .filter(|f| f.status == FileStatus::Restored)
            .map(|f| f.rel_path.clone())
            .collect();
        let mut failures = Vec::new();
        self.write_state(owned, &State { phase: StatePhase::Restoring, message: String::new(), restored: restored.iter().cloned().collect() })?;
        for index in (0..manifest.files.len()).rev() {
            let entry = &manifest.files[index];
            if approved.files[index].status != FileStatus::Written {
                continue;
            }
            let attempt = (|| -> WsResult<()> {
                let file = validate_target(root, &manifest, entry)?;
                let before = self.read_payload(owned, entry, index, Side::Before)?;
                let after = self.read_payload(owned, entry, index, Side::After)?;
                if !fs::symlink_metadata(&file)?.is_file() {
                    return Err(WsError::new(Reason::NotAFile, "Target is not a regular file."));
                }
                let mut opened = open_authorized_rw(&file, root)?;
                if read_all(&mut opened.file)? != after {
                    return Err(WsError::precondition("", ""));
                }
                if validate_target(root, &manifest, entry)? != file {
                    return Err(WsError::new(Reason::Changed, "Recovery destination changed."));
                }
                rewrite_or_restore(&mut opened.file, &before, &after)?;
                restored.insert(entry.rel_path.clone());
                Ok(())
            })();
            if let Err(error) = attempt {
                let message = if matches!(error.reason, Reason::PreconditionFailed { .. }) {
                    "File changed on disk. Reload or keep your edits before saving.".to_owned()
                } else {
                    error.message
                };
                failures.push(format!("{:?}: {message}", entry.rel_path));
            }
        }
        let skipped = approved
            .files
            .iter()
            .filter(|f| matches!(f.status, FileStatus::External | FileStatus::Missing | FileStatus::Unavailable))
            .count();
        let incomplete = !failures.is_empty() || skipped > 0;
        self.write_state(
            owned,
            &State {
                phase: if incomplete { StatePhase::Failed } else { StatePhase::Recovered },
                restored: restored.into_iter().collect(),
                message: if incomplete {
                    format!(
                        "{} restoration failures; {skipped} changed or unavailable files were left untouched. {}",
                        failures.len(),
                        failures.join("; ")
                    )
                } else {
                    "Original bytes restored. No changed, missing or unavailable file was overwritten.".to_owned()
                },
            },
        )
    }
}

fn require_revision(approved: &Detail, revision: &str) -> WsResult<()> {
    if approved.revision != revision {
        return Err(recovery_err("RECOVERY_CHANGED", "Files or recovery data changed since inspection. Inspect and confirm again."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// A record Node wrote after a failure whose message it cut at 8000 units inside an emoji
    /// (`native/core/fixtures/lone-surrogate-files`, record-lone-surrogate-files.mjs): the core reads its state as Node's
    /// `readRecoveryRecord` does (the half emoji as U+FFFD), so the record stays restorable.
    #[test]
    fn a_state_node_cut_inside_an_emoji_is_read_as_node_reads_it() {
        let set = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lone-surrogate-files");
        let cases: Value = serde_json::from_slice(&fs::read(set.join("cases.json")).unwrap()).unwrap();
        let case = cases.as_array().unwrap().iter().find(|c| c["name"] == "project-recovery").unwrap();
        let base = tempfile::tempdir().unwrap();
        let directory = base.path().join("store").join(case["recordId"].as_str().unwrap());
        fs::create_dir_all(&directory).unwrap();
        for entry in fs::read_dir(set.join("project-recovery/before/record")).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), directory.join(entry.file_name())).unwrap();
        }
        let store = RecoveryStore::new(base.path().to_path_buf());
        let record = store.read_record(&directory).unwrap();
        assert_eq!(serde_json::to_value(&record.state).unwrap(), case["nodeRead"]);
        assert_eq!(serde_json::to_value(&record.manifest).unwrap(), case["before"]["record/manifest.json"]);
        // Node's own rewrite of the state it read (the phase moved on): the core writes the same document (U+FFFD where
        // Node wrote the escape, decisions.md "frame-lone-surrogate").
        let mut state = record.state.unwrap();
        state.phase = serde_json::from_value(case["op"]["writeRecoveryState"]["phase"].clone()).unwrap();
        store.write_state(&directory, &state).unwrap();
        let written: Value = serde_json::from_slice(&fs::read(directory.join("state.json")).unwrap()).unwrap();
        assert_eq!(written, case["after"]["record/state.json"]);
    }

    /// A journal whose paths held a lone surrogate (Node writes one for a desktop batch edit of such a name: relPath and
    /// destination with the escape, `native/core/fixtures/lone-surrogate-files` `project-recovery-lone-path`). A path is no
    /// free text and no shipped client sends one holding a lone unit (decisions.md "frame-lone-surrogate"): the record is
    /// invalid and nothing is restored, not over the file whose name holds a real U+FFFD either, whether the two paths held
    /// the same lone unit or different ones (`\ud800` and `\udc00` read as the same U+FFFD).
    #[test]
    fn a_journal_whose_paths_held_a_lone_surrogate_restores_nothing() {
        for edit in [(|raw: String| raw) as fn(String) -> String, |raw: String| raw.replacen(r"\ud83d", r"\ud800", 1).replacen(r"\ud83d", r"\udc00", 1)] {
            let (_project, _base, root, store, id, _case) = node_record("project-recovery-lone-path", "b\u{fffd}.txt", edit);
            let inspected = store.execute(&root, Action::Inspect { id: id.clone() }).unwrap().detail.unwrap();
            assert_eq!(serde_json::to_value(&inspected).unwrap()["phase"], "invalid");
            let restored = store.execute(&root, Action::Restore { id, revision: inspected.revision.clone() });
            assert!(restored.as_ref().map_or(true, |done| serde_json::to_value(&done.detail).unwrap()["phase"] != "recovered"), "{restored:?}");
            assert_eq!(fs::read_to_string(root.join("src").join("b\u{fffd}.txt")).unwrap(), "after\n");
        }
    }

    /// A destination naming the file in another case than the relPath does (`src/A.txt` against `...\\src\\a.txt`): Node's
    /// `join(parent, basename(file)) !== entry.destination` (project-recovery.ts:45) compares the strings and refuses it,
    /// where a case-folded comparison would restore over the file.
    #[test]
    fn a_destination_in_another_case_than_its_relpath_is_refused() {
        let (_project, _base, root, store, id, _case) =
            node_record("project-recovery", "a.txt", |raw| raw.replacen(r#""relPath":"src/a.txt""#, r#""relPath":"src/A.txt""#, 1));
        let inspected = store.execute(&root, Action::Inspect { id: id.clone() }).unwrap().detail.unwrap();
        let restored = store.execute(&root, Action::Restore { id, revision: inspected.revision.clone() });
        assert!(restored.as_ref().map_or(true, |done| serde_json::to_value(&done.detail).unwrap()["phase"] != "recovered"), "{restored:?}");
        assert_eq!(fs::read_to_string(root.join("src").join("a.txt")).unwrap(), "after\n");
    }

    /// Node's record of case `name`, moved onto a fresh project root (its scratch root and identities replaced, every other
    /// byte as Node wrote it, then `edit`ed), with `src/<file>` holding the record's after bytes.
    #[allow(clippy::type_complexity)]
    fn node_record(name: &str, file: &str, edit: impl Fn(String) -> String) -> (tempfile::TempDir, tempfile::TempDir, PathBuf, RecoveryStore, String, Value) {
        let set = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lone-surrogate-files");
        let cases: Value = serde_json::from_slice(&fs::read(set.join("cases.json")).unwrap()).unwrap();
        let case = cases.as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        let node_record = set.join(name).join("before/record");
        let raw = String::from_utf8(fs::read(node_record.join("manifest.json")).unwrap()).unwrap();
        // The record names Node's scratch root and its identities: moved onto this test's root, every other byte as Node wrote it.
        let node_manifest = &case["before"]["record/manifest.json"];
        let project = tempfile::tempdir().unwrap();
        let root = canonical(project.path()).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src").join(file), "after\n").unwrap();
        let escaped = |path: &Path| serde_json::to_string(&path.to_string_lossy()).unwrap().trim_matches('"').to_owned();
        let node_root = serde_json::to_string(node_manifest["root"].as_str().unwrap()).unwrap().trim_matches('"').to_owned();
        let identity = |path: &Path| serde_json::to_value(identity_of(path).unwrap()).unwrap();
        let mut moved = raw.replace(&node_root, &escaped(&root));
        for (node, ours) in [(&node_manifest["rootIdentity"], identity(&root)), (&node_manifest["files"][0]["parent"], identity(&root.join("src")))] {
            for key in ["dev", "ino"] {
                moved = moved.replacen(&format!("\"{key}\":\"{}\"", node[key].as_str().unwrap()), &format!("\"{key}\":\"{}\"", ours[key].as_str().unwrap()), 1);
            }
        }
        let base = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(base.path().to_path_buf());
        let id = node_manifest["id"].as_str().unwrap();
        let directory = store.store_path(&root).join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("manifest.json"), edit(moved)).unwrap();
        for name in ["state.json", "0.before", "0.after"] {
            fs::copy(node_record.join(name), directory.join(name)).unwrap();
        }
        let id = id.to_owned();
        let case = case.clone();
        (project, base, root, store, id, case)
    }
}
