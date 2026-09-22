// Binary framing for on-disk caches plus the file-list (inventory)
// snapshot: load at startup, persist on a debounced background thread.
use super::*;

pub(super) const INVENTORY_SNAPSHOT_MAGIC: &[u8; 8] = b"MDINV001";
pub(super) const INVENTORY_SNAPSHOT_VERSION: u32 = 3;
pub(super) const INVENTORY_SNAPSHOT_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub(super) const INVENTORY_SNAPSHOT_MAX_STRING_BYTES: usize = 1024 * 1024;

pub(super) fn inventory_snapshot_path() -> Option<PathBuf> {
    content_signature_snapshot_path().map(|path| path.with_file_name("file-inventories-v1.bin"))
}

pub(super) fn read_snapshot_string<R: Read>(reader: &mut R) -> io::Result<String> {
    let len = read_snapshot_u32(reader)? as usize;
    if len == 0 || len > INVENTORY_SNAPSHOT_MAX_STRING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inventory string length",
        ));
    }
    let mut bytes = vec![0u8; len];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "inventory utf8"))
}

pub(super) fn write_snapshot_string<W: Write>(writer: &mut W, value: &Path) -> io::Result<()> {
    let value = value.to_string_lossy();
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > INVENTORY_SNAPSHOT_MAX_STRING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inventory path length",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)
}

pub(super) fn read_snapshot_u16<R: Read>(reader: &mut R) -> io::Result<u16> {
    let mut bytes = [0u8; 2];
    reader.read_exact(&mut bytes)?;
    Ok(u16::from_le_bytes(bytes))
}

pub(super) fn read_snapshot_u32<R: Read>(reader: &mut R) -> io::Result<u32> {
    let mut bytes = [0u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

pub(super) fn read_snapshot_u64<R: Read>(reader: &mut R) -> io::Result<u64> {
    let mut bytes = [0u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

pub(super) fn read_snapshot_u128<R: Read>(reader: &mut R) -> io::Result<u128> {
    let mut bytes = [0u8; 16];
    reader.read_exact(&mut bytes)?;
    Ok(u128::from_le_bytes(bytes))
}

pub(super) fn read_snapshot_i64<R: Read>(reader: &mut R) -> io::Result<i64> {
    let mut bytes = [0u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(i64::from_le_bytes(bytes))
}

/// The journal checkpoints a snapshot carries, in file order. Both on-disk
/// caches frame them identically, so they are decoded in one place.
pub(super) fn read_snapshot_checkpoints<R: Read>(
    reader: &mut R,
    count: usize,
) -> io::Result<Vec<crate::serve_search_usn::JournalCheckpoint>> {
    let mut checkpoints = Vec::with_capacity(count);
    for _ in 0..count {
        checkpoints.push(crate::serve_search_usn::JournalCheckpoint {
            volume: read_snapshot_u16(reader)?,
            volume_serial: read_snapshot_u32(reader)?,
            journal_id: read_snapshot_u64(reader)?,
            next_usn: read_snapshot_i64(reader)?,
        });
    }
    Ok(checkpoints)
}

/// Magic, version and the two counts the rest of the inventory snapshot is
/// framed by. Counts past the cache bounds mean a file this build cannot
/// trust, not a cache to load partially.
fn read_inventory_header<R: Read>(reader: &mut R) -> io::Result<(usize, usize)> {
    let mut magic = [0u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != INVENTORY_SNAPSHOT_MAGIC
        || read_snapshot_u32(reader)? != INVENTORY_SNAPSHOT_VERSION
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inventory header",
        ));
    }
    let checkpoint_count = read_snapshot_u32(reader)? as usize;
    let entry_count = read_snapshot_u32(reader)? as usize;
    if checkpoint_count > 256 || entry_count > FILE_LIST_CACHE_MAX {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inventory counts",
        ));
    }
    Ok((checkpoint_count, entry_count))
}

/// One cached inventory: the walk key it answers, its sorted file list and the
/// accounting a restored cache entry carries. Sorting here keeps a restored
/// inventory in the same deterministic order the walk published.
fn read_inventory_entry<R: Read>(
    reader: &mut R,
    now: Instant,
    ttl: Duration,
) -> io::Result<(WalkKey, ReadyEntry)> {
    let operand = PathBuf::from(wire_path(Path::new(&read_snapshot_string(reader)?)));
    let root_identity = Some(crate::serve_search_usn::FileIdentity {
        volume: read_snapshot_u32(reader)?,
        file_id: read_snapshot_u64(reader)?,
    });
    let mut flags = [0u8; 1];
    reader.read_exact(&mut flags)?;
    let max_depth = read_snapshot_u32(reader)?;
    let prune_count = read_snapshot_u32(reader)? as usize;
    let iglob_count = read_snapshot_u32(reader)? as usize;
    let file_count = read_snapshot_u32(reader)? as usize;
    if prune_count > 4096 || iglob_count > 4096 || file_count > 2_000_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inventory entry counts",
        ));
    }
    let mut prune = Vec::with_capacity(prune_count);
    for _ in 0..prune_count {
        prune.push(read_snapshot_string(reader)?);
    }
    let mut iglobs = Vec::with_capacity(iglob_count);
    for _ in 0..iglob_count {
        iglobs.push(read_snapshot_string(reader)?);
    }
    let mut files = Vec::with_capacity(file_count);
    for _ in 0..file_count {
        files.push(PathBuf::from(wire_path(Path::new(&read_snapshot_string(
            reader,
        )?))));
    }
    files.par_sort_unstable();
    files.dedup();
    let estimated_bytes = paths_storage_bytes(&files);
    Ok((
        WalkKey {
            operand,
            hidden: flags[0] & 1 != 0,
            no_ignore: flags[0] & 2 != 0,
            no_require_git: flags[0] & 4 != 0,
            directories: flags[0] & 8 != 0,
            max_depth: (max_depth != u32::MAX).then_some(max_depth as usize),
            prune,
            iglobs,
        },
        ReadyEntry {
            files: Arc::new(files),
            directory_failures: Arc::new(Vec::new()),
            expires_at: now + ttl,
            generation: 0,
            touched_at: now,
            estimated_bytes,
            root_identity,
        },
    ))
}

pub(super) fn load_file_list_snapshot() -> (
    HashMap<WalkKey, ReadyEntry>,
    Option<Vec<crate::serve_search_usn::JournalCheckpoint>>,
) {
    ensure_content_signature_cache_loaded();
    let Some(ttl) = file_list_ttl() else {
        return (HashMap::new(), None);
    };
    let Some(path) = inventory_snapshot_path() else {
        return (HashMap::new(), None);
    };
    if fs::metadata(&path)
        .ok()
        .is_none_or(|metadata| metadata.len() > INVENTORY_SNAPSHOT_MAX_BYTES)
    {
        return (HashMap::new(), None);
    }
    let Ok(file) = File::open(path) else {
        return (HashMap::new(), None);
    };
    let loaded = (|| -> io::Result<_> {
        let mut reader = BufReader::new(file);
        let (checkpoint_count, entry_count) = read_inventory_header(&mut reader)?;
        let checkpoints = read_snapshot_checkpoints(&mut reader, checkpoint_count)?;
        let mut ready = HashMap::new();
        let now = Instant::now();
        let mut total_bytes = 0usize;
        for _ in 0..entry_count {
            let (key, entry) = read_inventory_entry(&mut reader, now, ttl)?;
            total_bytes = total_bytes.saturating_add(entry.estimated_bytes);
            if total_bytes > file_list_cache_bytes() {
                continue;
            }
            ready.insert(key, entry);
        }
        Ok((ready, checkpoints))
    })();
    match loaded {
        Ok((ready, checkpoints)) if !checkpoints.is_empty() => {
            crate::serve_search_usn::restore_journal_checkpoints(&checkpoints);
            (ready, Some(checkpoints))
        }
        _ => (HashMap::new(), None),
    }
}

pub(super) fn persist_file_list_snapshot(ready_cache: &Mutex<HashMap<WalkKey, ReadyEntry>>) {
    let Some(path) = inventory_snapshot_path() else {
        return;
    };
    let checkpoints = crate::serve_search_usn::journal_checkpoints();
    if checkpoints.is_empty() {
        return;
    }
    let entries = lock_recover(ready_cache)
        .iter()
        .filter(|(_, entry)| entry.directory_failures.is_empty())
        .filter_map(|(key, entry)| {
            entry
                .root_identity
                .map(|identity| (key.clone(), Arc::clone(&entry.files), identity))
        })
        .collect::<Vec<_>>();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = (|| -> io::Result<()> {
        let file = File::create(&temp)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(INVENTORY_SNAPSHOT_MAGIC)?;
        writer.write_all(&INVENTORY_SNAPSHOT_VERSION.to_le_bytes())?;
        writer.write_all(&(checkpoints.len() as u32).to_le_bytes())?;
        writer.write_all(&0u32.to_le_bytes())?;
        for checkpoint in &checkpoints {
            writer.write_all(&checkpoint.volume.to_le_bytes())?;
            writer.write_all(&checkpoint.volume_serial.to_le_bytes())?;
            writer.write_all(&checkpoint.journal_id.to_le_bytes())?;
            writer.write_all(&checkpoint.next_usn.to_le_bytes())?;
        }
        let mut count = 0u32;
        for (key, files, root_identity) in &entries {
            write_snapshot_string(&mut writer, &key.operand)?;
            writer.write_all(&root_identity.volume.to_le_bytes())?;
            writer.write_all(&root_identity.file_id.to_le_bytes())?;
            let flags = u8::from(key.hidden)
                | (u8::from(key.no_ignore) << 1)
                | (u8::from(key.no_require_git) << 2)
                | (u8::from(key.directories) << 3);
            writer.write_all(&[flags])?;
            writer.write_all(
                &key.max_depth
                    .map(|depth| depth as u32)
                    .unwrap_or(u32::MAX)
                    .to_le_bytes(),
            )?;
            writer.write_all(&(key.prune.len() as u32).to_le_bytes())?;
            writer.write_all(&(key.iglobs.len() as u32).to_le_bytes())?;
            writer.write_all(&(files.len() as u32).to_le_bytes())?;
            for prune in &key.prune {
                write_snapshot_string(&mut writer, Path::new(prune))?;
            }
            for glob in &key.iglobs {
                write_snapshot_string(&mut writer, Path::new(glob))?;
            }
            for file in files.iter() {
                write_snapshot_string(&mut writer, file)?;
            }
            count = count.saturating_add(1);
        }
        writer.flush()?;
        writer.seek(SeekFrom::Start(16))?;
        writer.write_all(&count.to_le_bytes())?;
        writer.flush()
    })()
    .is_ok();
    if !written
        || (path.exists() && fs::remove_file(&path).is_err())
        || fs::rename(&temp, &path).is_err()
    {
        let _ = fs::remove_file(temp);
    }
}

pub(super) static INVENTORY_SNAPSHOT_DIRTY: AtomicBool = AtomicBool::new(false);
pub(super) static INVENTORY_SNAPSHOT_WRITING: AtomicBool = AtomicBool::new(false);

pub(super) fn schedule_file_list_snapshot(ready: Arc<Mutex<HashMap<WalkKey, ReadyEntry>>>) {
    INVENTORY_SNAPSHOT_DIRTY.store(true, Ordering::Release);
    if INVENTORY_SNAPSHOT_WRITING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        loop {
            INVENTORY_SNAPSHOT_DIRTY.store(false, Ordering::Release);
            persist_file_list_snapshot(&ready);
            if !INVENTORY_SNAPSHOT_DIRTY.swap(false, Ordering::AcqRel) {
                break;
            }
        }
        INVENTORY_SNAPSHOT_WRITING.store(false, Ordering::Release);
        if INVENTORY_SNAPSHOT_DIRTY.load(Ordering::Acquire) {
            schedule_file_list_snapshot(ready);
        }
    });
}
