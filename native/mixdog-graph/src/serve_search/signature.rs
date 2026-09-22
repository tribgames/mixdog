// Trigram content signatures and the file metadata cache: what lets a
// literal search skip a file without reading it, with USN-journal and
// watcher-backed trust deciding when a cached entry may be reused.
use super::*;

#[derive(Clone)]
pub(super) struct TrigramSignature {
    pub(super) bits: [u64; CONTENT_SIGNATURE_WORDS],
    pub(super) folded_bits: [u64; CONTENT_SIGNATURE_WORDS],
    pub(super) previous: [u8; 2],
    pub(super) folded_previous: [u8; 2],
    pub(super) seen: usize,
    pub(super) complete: bool,
}

impl TrigramSignature {
    pub(super) fn new() -> Self {
        Self {
            bits: [0; CONTENT_SIGNATURE_WORDS],
            folded_bits: [0; CONTENT_SIGNATURE_WORDS],
            previous: [0; 2],
            folded_previous: [0; 2],
            seen: 0,
            complete: false,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.seen >= 2 {
                let (first, second) = trigram_bits(self.previous[0], self.previous[1], byte);
                self.bits[first / 64] |= 1u64 << (first % 64);
                self.bits[second / 64] |= 1u64 << (second % 64);
                let folded = byte.to_ascii_lowercase();
                let (folded_first, folded_second) =
                    trigram_bits(self.folded_previous[0], self.folded_previous[1], folded);
                self.folded_bits[folded_first / 64] |= 1u64 << (folded_first % 64);
                self.folded_bits[folded_second / 64] |= 1u64 << (folded_second % 64);
            }
            self.previous[0] = self.previous[1];
            self.previous[1] = byte;
            self.folded_previous[0] = self.folded_previous[1];
            self.folded_previous[1] = byte.to_ascii_lowercase();
            self.seen = self.seen.saturating_add(1);
        }
    }

    pub(super) fn contains(&self, first: usize, second: usize, folded: bool) -> bool {
        let bits = if folded {
            &self.folded_bits
        } else {
            &self.bits
        };
        (bits[first / 64] & (1u64 << (first % 64))) != 0
            && (bits[second / 64] & (1u64 << (second % 64))) != 0
    }
}

#[derive(Clone)]
pub(super) struct ContentSignatureEntry {
    pub(super) size: u64,
    pub(super) modified_ns: u128,
    pub(super) identity: Option<crate::serve_search_usn::FileIdentity>,
    pub(super) persisted: bool,
    pub(super) signature: TrigramSignature,
}

#[derive(Clone)]
pub(super) struct FileMetadataEntry {
    pub(super) size: u64,
    pub(super) modified_ns: u128,
    pub(super) mtime_ms: u128,
    pub(super) identity: Option<crate::serve_search_usn::FileIdentity>,
}

pub(super) static CONTENT_SIGNATURE_CACHE: OnceLock<
    [Mutex<HashMap<PathBuf, ContentSignatureEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS],
> = OnceLock::new();
// Not a OnceLock: an in-process server releases this cache on idle and must be
// able to reload it from the snapshot on the next search, exactly as a fresh
// standalone process would. A OnceLock can never be re-armed.
pub(super) static CONTENT_SIGNATURE_CACHE_LOADED: AtomicBool = AtomicBool::new(false);
pub(super) static CONTENT_SIGNATURE_CACHE_LOAD: Mutex<()> = Mutex::new(());
pub(super) static CONTENT_SIGNATURE_CACHE_DIRTY: AtomicUsize = AtomicUsize::new(0);
pub(super) static CONTENT_SIGNATURE_CACHE_PERSISTING: AtomicBool = AtomicBool::new(false);
pub(super) static FILE_METADATA_CACHE: OnceLock<
    [Mutex<HashMap<PathBuf, FileMetadataEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS],
> = OnceLock::new();
pub(super) static TRUSTED_USN_VOLUMES: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
pub(super) static TRUSTED_WATCH_ROOTS: OnceLock<RwLock<HashSet<PathBuf>>> = OnceLock::new();

pub(super) fn content_signature_cache(
) -> &'static [Mutex<HashMap<PathBuf, ContentSignatureEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS] {
    ensure_content_signature_cache_loaded();
    raw_content_signature_cache()
}

pub(super) fn raw_content_signature_cache(
) -> &'static [Mutex<HashMap<PathBuf, ContentSignatureEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS] {
    CONTENT_SIGNATURE_CACHE.get_or_init(|| std::array::from_fn(|_| Mutex::new(HashMap::new())))
}

pub(super) fn content_signature_snapshot_path() -> Option<PathBuf> {
    let data_dir = std::env::var_os("MIXDOG_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            let home = std::env::var_os("MIXDOG_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))?;
            Some(home.join(if std::env::var_os("MIXDOG_HOME").is_some() {
                "data"
            } else {
                ".mixdog/data"
            }))
        })?;
    Some(data_dir.join("search-index/content-signatures-v2.bin"))
}

/// Magic, version, signature width and the two counts the rest of the
/// signature snapshot is framed by. A width this build does not use makes
/// every stored signature meaningless, so it is rejected with the header.
fn read_signature_header<R: Read>(reader: &mut R) -> io::Result<(usize, usize)> {
    let mut magic = [0u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != CONTENT_SIGNATURE_SNAPSHOT_MAGIC
        || read_snapshot_u32(reader)? != CONTENT_SIGNATURE_SNAPSHOT_VERSION
        || read_snapshot_u32(reader)? as usize != CONTENT_SIGNATURE_WORDS
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "signature snapshot header",
        ));
    }
    let checkpoint_count = read_snapshot_u32(reader)? as usize;
    let entry_count = read_snapshot_u32(reader)? as usize;
    if checkpoint_count > 256 || entry_count > CONTENT_SIGNATURE_CACHE_MAX {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "signature snapshot count",
        ));
    }
    Ok((checkpoint_count, entry_count))
}

/// One persisted signature: the file it describes, the size/mtime/identity it
/// was computed from, and both trigram bit planes. A restored entry is
/// complete by construction — only whole signatures are written.
fn read_signature_entry<R: Read>(reader: &mut R) -> io::Result<(PathBuf, ContentSignatureEntry)> {
    let path_len = read_snapshot_u32(reader)? as usize;
    if path_len == 0 || path_len > CONTENT_SIGNATURE_SNAPSHOT_MAX_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "signature snapshot path",
        ));
    }
    let mut path_bytes = vec![0u8; path_len];
    reader.read_exact(&mut path_bytes)?;
    let path = PathBuf::from(
        String::from_utf8(path_bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "signature snapshot utf8"))?,
    );
    let size = read_snapshot_u64(reader)?;
    let modified_ns = read_snapshot_u128(reader)?;
    let identity = crate::serve_search_usn::FileIdentity {
        volume: read_snapshot_u32(reader)?,
        file_id: read_snapshot_u64(reader)?,
    };
    let mut bits = [0u64; CONTENT_SIGNATURE_WORDS];
    let mut folded_bits = [0u64; CONTENT_SIGNATURE_WORDS];
    for word in &mut bits {
        *word = read_snapshot_u64(reader)?;
    }
    for word in &mut folded_bits {
        *word = read_snapshot_u64(reader)?;
    }
    Ok((
        path,
        ContentSignatureEntry {
            size,
            modified_ns,
            identity: Some(identity),
            persisted: true,
            signature: TrigramSignature {
                bits,
                folded_bits,
                previous: [0; 2],
                folded_previous: [0; 2],
                seen: 0,
                complete: true,
            },
        },
    ))
}

pub(super) fn load_content_signature_cache_binary(path: &Path) -> bool {
    if fs::metadata(path)
        .ok()
        .is_none_or(|metadata| metadata.len() > CONTENT_SIGNATURE_SNAPSHOT_MAX_BYTES)
    {
        return false;
    }
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let mut inserted = Vec::new();
    let loaded = (|| -> io::Result<Vec<crate::serve_search_usn::JournalCheckpoint>> {
        let (checkpoint_count, entry_count) = read_signature_header(&mut reader)?;
        let checkpoints = read_snapshot_checkpoints(&mut reader, checkpoint_count)?;
        inserted.reserve(entry_count);
        for _ in 0..entry_count {
            let (path, entry) = read_signature_entry(&mut reader)?;
            lock_recover(&raw_content_signature_cache()[content_signature_shard(&path)])
                .insert(path.clone(), entry);
            inserted.push(path);
        }
        Ok(checkpoints)
    })();
    match loaded {
        Ok(checkpoints) if !checkpoints.is_empty() => {
            crate::serve_search_usn::restore_journal_checkpoints(&checkpoints);
            true
        }
        _ => {
            for path in inserted {
                lock_recover(&raw_content_signature_cache()[content_signature_shard(&path)])
                    .remove(&path);
            }
            false
        }
    }
}

pub(super) fn ensure_content_signature_cache_loaded() {
    if CONTENT_SIGNATURE_CACHE_LOADED.load(Ordering::Acquire) {
        return;
    }
    let _guard = lock_recover(&CONTENT_SIGNATURE_CACHE_LOAD);
    // Re-check under the lock: the snapshot read is expensive enough that two
    // threads racing here would both pay for it.
    if CONTENT_SIGNATURE_CACHE_LOADED.load(Ordering::Acquire) {
        return;
    }
    if let Some(path) = content_signature_snapshot_path() {
        let _ = load_content_signature_cache_binary(&path);
    }
    // A missing snapshot path still counts as loaded: there is nothing to read
    // and retrying per call would probe the environment on every search.
    CONTENT_SIGNATURE_CACHE_LOADED.store(true, Ordering::Release);
}

pub(super) fn persist_content_signature_cache() {
    let dirty = CONTENT_SIGNATURE_CACHE_DIRTY.swap(0, Ordering::AcqRel);
    if dirty == 0 {
        return;
    }
    let mut volumes = HashSet::new();
    for shard in content_signature_cache() {
        let cache = lock_recover(shard);
        for path in cache.keys() {
            if let Some(volume) = crate::serve_search_usn::volume_for_path(path) {
                volumes.insert(volume);
            }
        }
    }
    for volume in volumes {
        apply_content_signature_journal_sync(crate::serve_search_usn::sync_volume(volume));
    }
    let checkpoints = crate::serve_search_usn::journal_checkpoints();
    if checkpoints.is_empty() {
        return;
    }
    let trusted_serials = checkpoints
        .iter()
        .map(|checkpoint| checkpoint.volume_serial)
        .collect::<HashSet<_>>();
    let Some(path) = content_signature_snapshot_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(dirty, Ordering::Relaxed);
        return;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = (|| -> io::Result<()> {
        let file = File::create(&temp)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(CONTENT_SIGNATURE_SNAPSHOT_MAGIC)?;
        writer.write_all(&CONTENT_SIGNATURE_SNAPSHOT_VERSION.to_le_bytes())?;
        writer.write_all(&(CONTENT_SIGNATURE_WORDS as u32).to_le_bytes())?;
        writer.write_all(&(checkpoints.len() as u32).to_le_bytes())?;
        writer.write_all(&0u32.to_le_bytes())?;
        for checkpoint in &checkpoints {
            writer.write_all(&checkpoint.volume.to_le_bytes())?;
            writer.write_all(&checkpoint.volume_serial.to_le_bytes())?;
            writer.write_all(&checkpoint.journal_id.to_le_bytes())?;
            writer.write_all(&checkpoint.next_usn.to_le_bytes())?;
        }
        let mut entry_count = 0u32;
        for shard in content_signature_cache() {
            let cache = lock_recover(shard);
            for (path, entry) in cache.iter() {
                let Some(identity) = entry
                    .identity
                    .filter(|identity| trusted_serials.contains(&identity.volume))
                else {
                    continue;
                };
                let path_bytes = path.to_string_lossy();
                let path_bytes = path_bytes.as_bytes();
                if path_bytes.is_empty()
                    || path_bytes.len() > CONTENT_SIGNATURE_SNAPSHOT_MAX_PATH_BYTES
                {
                    continue;
                }
                writer.write_all(&(path_bytes.len() as u32).to_le_bytes())?;
                writer.write_all(path_bytes)?;
                writer.write_all(&entry.size.to_le_bytes())?;
                writer.write_all(&entry.modified_ns.to_le_bytes())?;
                writer.write_all(&identity.volume.to_le_bytes())?;
                writer.write_all(&identity.file_id.to_le_bytes())?;
                for word in entry.signature.bits {
                    writer.write_all(&word.to_le_bytes())?;
                }
                for word in entry.signature.folded_bits {
                    writer.write_all(&word.to_le_bytes())?;
                }
                entry_count = entry_count.saturating_add(1);
            }
        }
        writer.flush()?;
        writer.seek(SeekFrom::Start(20))?;
        writer.write_all(&entry_count.to_le_bytes())?;
        writer.flush()
    })()
    .is_ok();
    if !written
        || (path.exists() && fs::remove_file(&path).is_err())
        || fs::rename(&temp, &path).is_err()
    {
        let _ = fs::remove_file(&temp);
        CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(dirty, Ordering::Relaxed);
    }
}

pub(super) fn schedule_content_signature_cache_persist() {
    if CONTENT_SIGNATURE_CACHE_DIRTY.load(Ordering::Acquire) == 0
        || CONTENT_SIGNATURE_CACHE_PERSISTING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(50));
        persist_content_signature_cache();
        CONTENT_SIGNATURE_CACHE_PERSISTING.store(false, Ordering::Release);
        if CONTENT_SIGNATURE_CACHE_DIRTY.load(Ordering::Acquire) > 0 {
            schedule_content_signature_cache_persist();
        }
    });
}

pub(super) fn file_metadata_cache(
) -> &'static [Mutex<HashMap<PathBuf, FileMetadataEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS] {
    FILE_METADATA_CACHE.get_or_init(|| std::array::from_fn(|_| Mutex::new(HashMap::new())))
}

pub(super) fn trusted_usn_volumes() -> &'static Mutex<HashSet<u32>> {
    TRUSTED_USN_VOLUMES.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(super) fn trusted_watch_roots() -> &'static RwLock<HashSet<PathBuf>> {
    TRUSTED_WATCH_ROOTS.get_or_init(|| RwLock::new(HashSet::new()))
}

#[derive(Clone)]
pub(super) struct TrustSnapshot {
    pub(super) usn_volumes: Arc<HashSet<u32>>,
    pub(super) watch_roots: Arc<Vec<PathBuf>>,
}

impl TrustSnapshot {
    pub(super) fn capture() -> Self {
        Self {
            usn_volumes: Arc::new(lock_recover(trusted_usn_volumes()).clone()),
            watch_roots: Arc::new(
                read_recover(trusted_watch_roots())
                    .iter()
                    .cloned()
                    .collect(),
            ),
        }
    }

    pub(super) fn watcher_covers(&self, path: &Path) -> bool {
        self.watch_roots
            .iter()
            .any(|root| path.starts_with(root) || path_starts_with(path, root))
    }
}

pub(super) fn apply_content_signature_journal_sync(result: crate::serve_search_usn::SyncResult) {
    let mut trusted = lock_recover(trusted_usn_volumes());
    let Some(serial) = result.volume_serial.filter(|_| result.trusted) else {
        trusted.clear();
        drop(trusted);
        for shard in raw_content_signature_cache() {
            lock_recover(shard).retain(|_, entry| !entry.persisted);
        }
        CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(1, Ordering::Relaxed);
        return;
    };
    trusted.insert(serial);
    drop(trusted);
    if result.changed.is_empty() {
        return;
    }
    CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(1, Ordering::Relaxed);
    for shard in content_signature_cache() {
        lock_recover(shard).retain(|_, entry| {
            !entry.identity.is_some_and(|identity| {
                identity.volume == serial && result.changed.contains(&identity.file_id)
            })
        });
    }
    for shard in file_metadata_cache() {
        let mut cache = lock_recover(shard);
        cache.retain(|_, entry| {
            !entry.identity.is_some_and(|identity| {
                identity.volume == serial && result.changed.contains(&identity.file_id)
            })
        });
    }
}

pub(super) fn refresh_content_signature_journals(targets: &[String], cwd: &Path) {
    ensure_content_signature_cache_loaded();
    let absolute_targets = targets
        .iter()
        .map(|target| {
            let target_path = Path::new(target);
            if target_path.is_absolute() {
                target_path.to_path_buf()
            } else {
                cwd.join(target_path)
            }
        })
        .collect::<Vec<_>>();
    let mut volumes = HashSet::new();
    for absolute in absolute_targets {
        if let Some(volume) = crate::serve_search_usn::volume_for_path(&absolute) {
            volumes.insert(volume);
        }
    }
    for volume in volumes {
        apply_content_signature_journal_sync(crate::serve_search_usn::sync_volume(volume));
    }
}

pub(super) fn content_signature_shard(path: &Path) -> usize {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish() as usize & (CONTENT_SIGNATURE_CACHE_SHARDS - 1)
}

pub(super) fn trigram_bits(first: u8, second: u8, third: u8) -> (usize, usize) {
    let packed = ((first as u32) << 16) | ((second as u32) << 8) | third as u32;
    let one = packed.wrapping_mul(0x9E37_79B1) as usize & (CONTENT_SIGNATURE_BITS - 1);
    let two =
        packed.rotate_left(13).wrapping_mul(0x85EB_CA6B) as usize & (CONTENT_SIGNATURE_BITS - 1);
    (one, two)
}

pub(super) fn literal_trigram_requirements(
    parsed: &ParsedArgs,
) -> Option<Vec<Vec<(usize, usize)>>> {
    if parsed.patterns.is_empty() {
        return None;
    }
    let mut all = Vec::with_capacity(parsed.patterns.len());
    for pattern in &parsed.patterns {
        let literal = if parsed.fixed_strings {
            pattern.as_bytes().to_vec()
        } else {
            mandatory_regex_literal(pattern)?
        };
        if literal.len() < 3 || (parsed.case_insensitive && !literal.is_ascii()) {
            return None;
        }
        let folded;
        let bytes = if parsed.case_insensitive {
            folded = literal
                .iter()
                .map(|byte| byte.to_ascii_lowercase())
                .collect::<Vec<_>>();
            folded.as_slice()
        } else {
            literal.as_slice()
        };
        all.push(
            bytes
                .windows(3)
                .map(|window| trigram_bits(window[0], window[1], window[2]))
                .collect(),
        );
    }
    Some(all)
}

pub(super) fn mandatory_regex_literal(pattern: &str) -> Option<Vec<u8>> {
    let bytes = pattern.as_bytes();
    let mut index = usize::from(bytes.first() == Some(&b'^'));
    let end = bytes
        .len()
        .saturating_sub(usize::from(bytes.last() == Some(&b'$')));
    let mut runs = Vec::<Vec<u8>>::new();
    let mut current = Vec::new();
    while index < end {
        if bytes[index] == b'\\' {
            index += 1;
            let escaped = *bytes.get(index)?;
            if !b".*+?()[]{}|^$\\".contains(&escaped) {
                return None;
            }
            current.push(escaped);
            index += 1;
            continue;
        }
        if bytes[index] == b'.' {
            if !current.is_empty() {
                runs.push(std::mem::take(&mut current));
            }
            index += 1;
            if index < end && matches!(bytes[index], b'*' | b'+') {
                index += 1;
            }
            continue;
        }
        if b"*+?()[]{}|^$".contains(&bytes[index]) {
            return None;
        }
        current.push(bytes[index]);
        index += 1;
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs.into_iter().max_by_key(Vec::len)
}

pub(super) fn file_content_fingerprint(path: &Path) -> Option<(u64, u128)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified_ns = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((metadata.len(), modified_ns))
}

pub(super) fn file_mtime_ms(path: &Path, trust: &TrustSnapshot) -> Option<u128> {
    let shard = content_signature_shard(path);
    let cached = {
        let cache = lock_recover(&file_metadata_cache()[shard]);
        cache.get(path).cloned()
    };
    if let Some(entry) = cached.as_ref() {
        if entry
            .identity
            .is_some_and(|identity| trust.usn_volumes.contains(&identity.volume))
        {
            return Some(entry.mtime_ms);
        }
    }
    let (metadata, identity) = crate::serve_search_usn::metadata_and_identity(path)?;
    let modified_ns = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    if cached
        .as_ref()
        .is_some_and(|entry| entry.size == metadata.len() && entry.modified_ns == modified_ns)
    {
        return cached.map(|entry| entry.mtime_ms);
    }
    let entry = FileMetadataEntry {
        size: metadata.len(),
        modified_ns,
        mtime_ms: modified_ns / 1_000_000,
        identity,
    };
    let mtime_ms = entry.mtime_ms;
    lock_recover(&file_metadata_cache()[shard]).insert(path.to_path_buf(), entry);
    Some(mtime_ms)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CachedSignatureState {
    Missing,
    Reusable,
    Excludes,
}

pub(super) fn cached_signature_state(
    path: &Path,
    requirements: &[Vec<(usize, usize)>],
    folded: bool,
    trust: &TrustSnapshot,
) -> CachedSignatureState {
    let shard = content_signature_shard(path);
    let watcher_trusted = trust.watcher_covers(path);
    let entry = {
        let cache = lock_recover(&content_signature_cache()[shard]);
        let Some(entry) = cache.get(path) else {
            return CachedSignatureState::Missing;
        };
        let usn_trusted = entry
            .identity
            .is_some_and(|identity| trust.usn_volumes.contains(&identity.volume));
        if usn_trusted || (!entry.persisted && watcher_trusted) {
            return if !requirements.is_empty()
                && signature_excludes_requirements(&entry.signature, requirements, folded)
            {
                CachedSignatureState::Excludes
            } else {
                CachedSignatureState::Reusable
            };
        }
        entry.clone()
    };
    let Some((size, modified_ns)) = file_content_fingerprint(path) else {
        return CachedSignatureState::Missing;
    };
    if entry.size != size || entry.modified_ns != modified_ns {
        let mut cache = lock_recover(&content_signature_cache()[shard]);
        cache.remove(path);
        return CachedSignatureState::Missing;
    }
    if !requirements.is_empty()
        && signature_excludes_requirements(&entry.signature, requirements, folded)
    {
        CachedSignatureState::Excludes
    } else {
        CachedSignatureState::Reusable
    }
}

pub(super) fn signature_excludes_requirements(
    signature: &TrigramSignature,
    requirements: &[Vec<(usize, usize)>],
    folded: bool,
) -> bool {
    requirements.iter().all(|pattern| {
        pattern
            .iter()
            .any(|&(first, second)| !signature.contains(first, second, folded))
    })
}

pub(super) fn remember_content_signature(
    path: &Path,
    signature: &TrigramSignature,
    identity: Option<crate::serve_search_usn::FileIdentity>,
) {
    if !signature.complete {
        return;
    }
    let Some((size, modified_ns)) = file_content_fingerprint(path) else {
        return;
    };
    let mut cache = lock_recover(&content_signature_cache()[content_signature_shard(path)]);
    if cache.len() >= CONTENT_SIGNATURE_CACHE_MAX / CONTENT_SIGNATURE_CACHE_SHARDS {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        path.to_path_buf(),
        ContentSignatureEntry {
            size,
            modified_ns,
            identity,
            persisted: false,
            signature: signature.clone(),
        },
    );
    CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(1, Ordering::Relaxed);
}

pub(super) static SIGNATURE_PREWARM_RUNNING: AtomicBool = AtomicBool::new(false);

pub(super) fn schedule_signature_prewarm(files: Arc<Vec<PathBuf>>) {
    if SIGNATURE_PREWARM_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        let mut total_bytes = 0u64;
        let mut buffer = vec![0u8; 256 * 1024];
        for path in files.iter().take(8_192) {
            if lock_recover(&raw_content_signature_cache()[content_signature_shard(path)])
                .contains_key(path)
            {
                continue;
            }
            let Ok(metadata) = fs::metadata(path) else {
                continue;
            };
            total_bytes = total_bytes.saturating_add(metadata.len());
            if total_bytes > 256 * 1024 * 1024 {
                break;
            }
            let Ok(mut file) = File::open(path) else {
                continue;
            };
            let identity = crate::serve_search_usn::file_identity(&file);
            let mut signature = TrigramSignature::new();
            loop {
                match file.read(&mut buffer) {
                    Ok(0) => {
                        signature.complete = true;
                        break;
                    }
                    Ok(read) => signature.push(&buffer[..read]),
                    Err(_) => break,
                }
            }
            remember_content_signature(path, &signature, identity);
        }
        SIGNATURE_PREWARM_RUNNING.store(false, Ordering::Release);
    });
}

/// Drop cached entries for `paths` from one sharded path-keyed cache.
///
/// The two accessors are deliberately separate. A per-path removal only has to
/// touch what is already in memory (`resident`), because a not-yet-loaded
/// snapshot is validated against the USN journal when it loads. A recursive
/// invalidation must reach the loading accessor (`whole`, called lazily), or a
/// later load would resurrect entries this call was meant to drop.
fn invalidate_path_keyed_shards<T>(
    resident: &'static [Mutex<HashMap<PathBuf, T>>; CONTENT_SIGNATURE_CACHE_SHARDS],
    whole: impl FnOnce() -> &'static [Mutex<HashMap<PathBuf, T>>; CONTENT_SIGNATURE_CACHE_SHARDS],
    paths: &[PathBuf],
    recursive: bool,
) {
    if !recursive && !paths.is_empty() {
        for path in paths {
            lock_recover(&resident[content_signature_shard(path)]).remove(path);
        }
        return;
    }
    for shard in whole() {
        let mut cache = lock_recover(shard);
        if paths.is_empty() {
            cache.clear();
        } else {
            cache.retain(|cached, _| {
                !paths
                    .iter()
                    .any(|changed| FileListStore::paths_overlap(cached, changed))
            });
        }
    }
}

pub(super) fn invalidate_content_signatures(paths: &[PathBuf], recursive: bool) {
    invalidate_path_keyed_shards(
        raw_content_signature_cache(),
        content_signature_cache,
        paths,
        recursive,
    );
}

pub(super) fn invalidate_file_metadata(paths: &[PathBuf], recursive: bool) {
    invalidate_path_keyed_shards(file_metadata_cache(), file_metadata_cache, paths, recursive);
}
