//! The core's blob store (`BLOB_DIR`) is given every blob of 1.4.5's (`LEGACY_BLOB_DIR`) once, before any other step of
//! the migration reads or writes a blob, and before the core serves.
//!
//! Each legacy blob gets its own name in the core's store: a hard link to the same file where the volume allows one (no
//! second copy of the bytes), else a copy (another volume, a filesystem without links). 1.4.5 changes a blob file only by
//! unlinking its name or renaming a new file over it, never by writing into it, so nothing it does to its tree afterwards
//! (its census, a rollback's writes, a repair of a corrupt file) changes or removes what a core name holds. The legacy tree
//! is only read: it stays whole for a rollback.
//!
//! The marker is published once every name and its directory are durable: a run cut before it starts over and keeps the
//! names already made. A link or copy is staged and checked before a no-clobber install.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "one-time migration: blocking std::fs on the migration thread")]

use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use mixdog_store::blobs::digest_of_reference;
use mixdog_store::fsio;
use mixdog_store::schema::blob::BLOB_DIR;
use mixdog_store::schema::blob::LEGACY_BLOB_DIR;
use mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;

/// Gives every 1.4.5 blob of `data` its name in the core's store, unless the marker says that was done.
pub fn import(data: &Path, fault: &dyn Fn(&str) -> Result<()>) -> Result<()> {
    import_with(data, fault, &|from, to| std::fs::hard_link(from, to))
}

/// [`import`] with the way a name is linked given, so a test can make a volume that cannot link.
pub(crate) fn import_with(data: &Path, fault: &dyn Fn(&str) -> Result<()>, link: &dyn Fn(&Path, &Path) -> std::io::Result<()>) -> Result<()> {
    let marker = data.join(LEGACY_BLOBS_IMPORTED);
    let core = data.join(BLOB_DIR);
    let complete = durable::exists(&marker)?;
    let needs_replacement = recover_displacements(&core, !complete)?;
    if complete {
        return Ok(());
    }
    let legacy = data.join(LEGACY_BLOB_DIR);
    for (shard, is_dir) in durable::list_dir(&legacy)? {
        if !is_dir {
            continue;
        }
        let (from, to) = (legacy.join(&shard), core.join(&shard));
        let entries = match std::fs::read_dir(&from) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(Blocked::io("list", &from, e)),
        };
        let mut created = false;
        for entry in entries {
            let entry = entry.map_err(|e| Blocked::io("list", &from, e))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // A blob is a regular file (never a link to follow) named by its digest in its own shard; a cut write's tmp
            // and anything else is not one.
            let is_file = entry.file_type().map_err(|e| Blocked::io("stat", &entry.path(), e))?.is_file();
            if !is_file || digest_of_reference(&name).is_none() || shard.as_str() != &name[..2] {
                continue;
            }
            let target = to.join(&name);
            let source = entry.path();
            if digest_at(&target)?.as_deref() == Some(name.as_str()) {
                continue;
            }
            if !created {
                durable::create_dir_all(&to)?;
                created = true;
            }
            install(&source, &target, &name, fault, link)?;
        }
    }
    if needs_replacement {
        recover_displacements(&core, false)?;
    }
    // Every shard that exists in the core's store is synced, found there and not through the legacy tree: a run cut after
    // linking and before this sync leaves names the resuming run skips, and 1.4.5 may have removed the legacy shard since.
    // Then the shards' names in `blobs/sha256` and its own name in `blobs`, whether or not this run made the directories.
    if durable::exists(&core)? {
        for (shard, is_dir) in durable::list_dir(&core)? {
            if is_dir {
                fault("legacy-blobs:shard")?;
                durable::sync_dir(&core.join(shard))?;
            }
        }
        fault("legacy-blobs:names")?;
        durable::sync_dir(&core)?;
        durable::sync_dir(core.parent().expect("the store has a parent"))?;
    }
    fault("legacy-blobs:marker")?;
    durable::publish_file(&marker, b"")
}

fn digest_at(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => durable::hash_file(path).map(|(_, hash)| Some(hash)),
        Ok(_) => Err(Blocked::io("stat blob", path, io::ErrorKind::InvalidData.into())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Blocked::io("stat blob", path, error)),
    }
}

const DISPLACED: &str = ".mixdog-migrated";

fn aside_path(target: &Path, observed: &str) -> PathBuf {
    let mut path = target.as_os_str().to_owned();
    path.push(format!("{DISPLACED}.{observed}"));
    path.into()
}

fn recover_displacements(core: &Path, defer_replacement: bool) -> Result<bool> {
    let mut needs_replacement = false;
    for (shard, is_dir) in durable::list_dir(core)? {
        if !is_dir || shard.len() != 2 || !shard.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            continue;
        }
        let dir = core.join(&shard);
        for (name, _) in durable::list_dir(&dir)? {
            let Some((digest, suffix)) = name.split_once(DISPLACED) else { continue };
            if digest_of_reference(digest).is_none() || !digest.starts_with(&shard) {
                continue;
            }
            let observed = match suffix {
                "" => None, // Earlier builds did not record the digest they intended to remove.
                suffix => {
                    let Some(hash) = suffix.strip_prefix('.').filter(|hash| digest_of_reference(hash).is_some()) else {
                        continue;
                    };
                    Some(hash)
                }
            };
            let aside = dir.join(&name);
            if !finish_displacement(&aside, &dir.join(digest), digest, observed)? {
                if !defer_replacement {
                    return Err(replacement_required(&aside));
                }
                needs_replacement = true;
            }
        }
    }
    Ok(needs_replacement)
}

/// Use the same no-clobber primitive for displacement and recovery. In
/// particular, recovery must work without hard links wherever displacement did.
fn move_noclobber(source: &Path, target: &Path) -> io::Result<()> {
    let mut path = tempfile::TempPath::try_from_path(source)?;
    path.disable_cleanup(true);
    path.persist_noclobber(target).map_err(|error| error.error)
}

fn checked_displacement(aside: &Path, digest: &str, observed: Option<&str>) -> Result<Option<String>> {
    let hash = digest_at(aside)?;
    if hash.as_deref().is_some_and(|hash| hash != digest && Some(hash) != observed) {
        return Err(Blocked::SourceChanged { path: aside.to_path_buf() });
    }
    Ok(hash)
}

fn replacement_required(aside: &Path) -> Blocked {
    Blocked::io("repair blob", aside, io::Error::new(io::ErrorKind::InvalidData, "displaced corrupt blob has no verified replacement"))
}

/// Returns false while the original corrupt bytes must stay aside for recovery.
fn finish_displacement(aside: &Path, target: &Path, digest: &str, observed: Option<&str>) -> Result<bool> {
    let Some(hash) = checked_displacement(aside, digest, observed)? else { return Ok(true) };
    let parent = target.parent().expect("a blob has a shard");
    if hash == digest {
        match move_noclobber(aside, target) {
            Ok(()) => {
                durable::sync_dir(parent)?;
                return Ok(true);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && digest_at(target)?.as_deref() == Some(digest) => {}
            Err(error) => return Err(Blocked::io("restore blob", target, error)),
        }
    } else if digest_at(target)?.as_deref() != Some(digest) {
        return Ok(false);
    }
    // The canonical name must be durable before dropping its backup.
    durable::sync_dir(parent)?;
    durable::remove_file(aside)?;
    Ok(true)
}

fn install(source: &Path, target: &Path, digest: &str, fault: &dyn Fn(&str) -> Result<()>, link: &dyn Fn(&Path, &Path) -> io::Result<()>) -> Result<()> {
    let parent = target.parent().expect("a blob has a shard");
    let tmp = tempfile::Builder::new().prefix(".mixdog-tmp-").tempfile_in(parent).map_err(|e| Blocked::io("create blob temp", parent, e))?.into_temp_path();
    let stage: &Path = tmp.as_ref();
    fs::remove_file(stage).map_err(|e| Blocked::io("remove empty blob temp", stage, e))?;
    match link(source, stage) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            let mut input = match fs::File::open(source) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(Blocked::io("open blob", source, error)),
            };
            let mut output = fsio::create_new_file(stage, fsio::Access::Inherit).map_err(Blocked::fsio)?;
            io::copy(&mut input, &mut output).map_err(|e| Blocked::io("copy blob", stage, e))?;
            fsio::sync_file(&output, stage).map_err(Blocked::fsio)?;
        }
    }
    if digest_at(stage)?.as_deref() != Some(digest) {
        return Ok(());
    }
    let mut displaced = None;
    if let Some(hash) = digest_at(target)? {
        if hash == digest {
            return Ok(());
        }
        let aside = aside_path(target, &hash);
        fault("legacy-blobs:displace")?;
        match move_noclobber(target, &aside) {
            Ok(()) => {
                fault("legacy-blobs:displaced")?;
                if checked_displacement(&aside, digest, Some(&hash))?.as_deref() == Some(digest) {
                    return require_finished(&aside, target, digest, &hash);
                }
                displaced = Some((aside, hash));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(Blocked::io("displace blob", target, error)),
        }
    }
    fault("legacy-blobs:install")?;
    match tmp.persist_noclobber(target) {
        Ok(()) => Ok(()),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists && digest_at(target)?.as_deref() == Some(digest) => Ok(()),
        Err(error) => Err(Blocked::io("install blob", target, error.error)),
    }?;
    if let Some((aside, observed)) = displaced {
        require_finished(&aside, target, digest, &observed)?;
    }
    Ok(())
}

fn require_finished(aside: &Path, target: &Path, digest: &str, observed: &str) -> Result<()> {
    if finish_displacement(aside, target, digest, Some(observed))? { Ok(()) } else { Err(replacement_required(aside)) }
}
