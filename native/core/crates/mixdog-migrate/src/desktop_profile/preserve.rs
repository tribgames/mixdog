//! Preserve-move items (SPEC §4.11): the remote-access identity, selected-file grants,
//! PC-access revokes, editor backups and editor recovery move from `<P>` to `<D>`. Bytes
//! are unchanged; secrets are copied into the stage with owner-only access created with
//! the file, so the move never leaves a readable copy. The source is deleted by the
//! disposal phase, after verification.

use std::path::Path;
use std::path::PathBuf;

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::Target;
use sha2::Digest as _;
use sha2::Sha256;

use super::Staged;
use super::error::ApplyError;
use super::error::Step;
use super::fsx;
use super::source;
use crate::durable;
use crate::error::Blocked;
use crate::framework::ItemContext;
use crate::json::hex;

const PAYLOAD_DIR: &str = "payload";

/// The profile directory a tree item takes its files from; single-file items have none.
pub(super) fn source_dir(kind: ItemKind) -> Option<&'static str> {
    match kind {
        ItemKind::EditorBackups => Some("editor-backups"),
        ItemKind::EditorRecovery => Some("editor-recovery"),
        _ => None,
    }
}

fn target_path(item: &ManifestItem) -> Step<&str> {
    match &item.target {
        Some(Target::File {
            root: Root::Data,
            path,
        }) => Ok(path),
        _ => Err(ApplyError::quarantine(
            QuarantineCode::SchemaViolation,
            "a preserve item has no data-dir file target",
        )),
    }
}

/// Where `file` lands, relative to the target (`""` for a single file).
fn relative_to_target(item: &ManifestItem, file: &SourceFile) -> String {
    match source_dir(item.kind) {
        Some(dir) => file.path[dir.len() + 1..].to_owned(),
        None => String::new(),
    }
}

fn resolve(base: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

fn target_file(data: &Path, item: &ManifestItem, file: &SourceFile) -> Step<PathBuf> {
    let target = resolve(data, target_path(item)?);
    Ok(resolve(&target, &relative_to_target(item, file)))
}

fn staged_file(stage_dir: &Path, item: &ManifestItem, file: &SourceFile) -> Step<PathBuf> {
    let relative = relative_to_target(item, file);
    let payload = stage_dir.join(PAYLOAD_DIR);
    if relative.is_empty() {
        let name = target_path(item)?.rsplit('/').next().unwrap_or_default();
        return Ok(payload.join(name));
    }
    Ok(resolve(&payload, &relative))
}

/// A preserved JSON file must parse (FORMAT.md §10.6: SHA-256 plus strict parse). A
/// single file is JSON by its target name, so a restored `.bak` is checked too.
fn strict_parse(item: &ManifestItem, file: &SourceFile, path: &Path) -> Step<()> {
    let name = if source_dir(item.kind).is_some() {
        file.path.as_str()
    } else {
        target_path(item)?
    };
    if !name.ends_with(".json") {
        return Ok(());
    }
    source::parse_json(&durable::read(path)?).map(|_| ())
}

/// Single file: its hash. Tree: the hash of `"<relative>\0<hash>\n"` lines in source order.
fn output_hash(item: &ManifestItem, files: &[(String, String)]) -> String {
    match (source_dir(item.kind), files) {
        (None, [(_, hash)]) => hash.clone(),
        _ => {
            let mut hasher = Sha256::new();
            for (relative, hash) in files {
                hasher.update(format!("{relative}\0{hash}\n"));
            }
            hex(&hasher.finalize())
        }
    }
}

pub(super) fn stage(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<Staged> {
    let stage_dir = cx.stage_dir(item.key.as_str());
    let mut files = Vec::with_capacity(item.sources.len());
    for file in &item.sources {
        let from = cx.source_path(file)?;
        let to = staged_file(&stage_dir, item, file)?;
        let (size, hash) = fsx::copy_new(&from, &to, file.secret).map_err(|error| ApplyError::io("write", &to, error))?;
        if size != file.size || hash != file.sha256 {
            return Err(Blocked::SourceChanged { path: from }.into());
        }
        strict_parse(item, file, &to)?;
        files.push((relative_to_target(item, file), hash));
    }
    Ok(Staged {
        output_sha256: output_hash(item, &files),
        replaced_surrogates: 0,
    })
}

/// Moves each staged file into the data dir; a target already holding the same bytes is
/// a file published by an earlier run, any other is a conflict.
pub(super) fn publish(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<()> {
    let stage_dir = cx.stage_dir(item.key.as_str());
    for file in &item.sources {
        let to = target_file(&cx.roots.data, item, file)?;
        if durable::exists(&to)? {
            if durable::hash_file(&to)?.1 == file.sha256 {
                continue;
            }
            return Err(Blocked::TargetConflict {
                key: item.key.as_str().to_owned(),
                path: to,
            }
            .into());
        }
        let from = staged_file(&stage_dir, item, file)?;
        if let Some(parent) = to.parent() {
            durable::create_dir_all(parent)?;
        }
        durable::durable_rename(&from, &to)?;
    }
    Ok(())
}

/// Removes what `publish` moved into the data dir, before the sources are quarantined.
pub(super) fn withdraw(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<()> {
    for file in &item.sources {
        durable::remove_file(&target_file(&cx.roots.data, item, file)?)?;
    }
    Ok(())
}

pub(super) fn verify(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<Digest> {
    let mismatch = |detail: &str| ApplyError::quarantine(QuarantineCode::DigestMismatch, detail);
    let mut files = Vec::with_capacity(item.sources.len());
    for file in &item.sources {
        let to = target_file(&cx.roots.data, item, file)?;
        let (_, hash) = durable::hash_file(&to)?;
        if hash != file.sha256 {
            return Err(mismatch("a moved file differs from its source"));
        }
        if file.secret && !fsx::is_owner_only(&to).map_err(|error| ApplyError::io("read", &to, error))? {
            return Err(mismatch("a moved secret is not owner-only"));
        }
        strict_parse(item, file, &to)?;
        files.push((relative_to_target(item, file), hash));
    }
    Ok(source::digest_of_hash(&output_hash(item, &files)))
}
