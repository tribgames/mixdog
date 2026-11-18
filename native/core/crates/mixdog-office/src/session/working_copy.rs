//! The paths and working copies of a session: `fullPath`, `defaultOutput`, `defaultRenderOutput`, `assertDocumentOutput`,
//! `editableTarget` and `materializeWorkingCopy` of `core/office-sessions.mjs`.
//!
//! The user's own document is never written in place. A session that edits works on `<name>.mixdog-edit.<ext>` beside the
//! source (or on the `output` the caller named); a session that only reads opens the source itself and takes the working
//! copy when the first edit comes.
//!
//! `readComSavedCopy` (the live Office document saved to a copy and read as a package) lives in the snapshot module, where the
//! snapshot of a protected sheet needs it; it is re-exported here so open, create and the snapshot use one.

use std::path::Path;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{js_to_lowercase, nodepath};
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_design::library::Environment;
use serde_json::Value;

use super::SessionHandle;
use super::registry::{Registry, lock};

pub use crate::snapshot::read_com_saved_copy;

/// The file name of a path and the folder it is in (`basename` and `dirname`).
fn split(path: &str) -> (String, String) {
    let location = Path::new(path);
    let name = location
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let folder = location
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .filter(|folder| !folder.is_empty())
        .unwrap_or_else(|| ".".to_owned());
    (folder, name)
}

/// `path.extname(name)` of a file name: from the last dot, none when the dot starts the name.
fn extension_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot..],
        _ => "",
    }
}

/// `join(folder, name)`.
pub(crate) fn join(folder: &str, name: &str) -> String {
    Path::new(folder).join(name).to_string_lossy().into_owned()
}

/// `dirname(path)`.
pub(crate) fn dirname(path: &str) -> String {
    split(path).0
}

/// `basename(path, extname(path))`.
pub(crate) fn stem(path: &str) -> String {
    let name = split(path).1;
    let extension = extension_of(&name).len();
    name[..name.len() - extension].to_owned()
}

/// `defaultOutput(source)`: `<name>.mixdog-edit.<ext>` beside the source.
pub fn default_output(source: &str) -> String {
    let (folder, name) = split(source);
    let extension = extension_of(&name);
    join(
        &folder,
        &format!(
            "{}.mixdog-edit{extension}",
            &name[..name.len() - extension.len()]
        ),
    )
}

/// `defaultRenderOutput(source)`: the preview keeps the source's extension (`stores.docx`, `stores.pdf` and `stores.xlsx` side by
/// side render to `stores.docx.mixdog-preview.pdf` and its siblings, and each render no longer overwrites the pages the last one
/// had been reviewed from).
pub fn default_render_output(source: &str) -> String {
    let (folder, name) = split(source);
    join(&folder, &format!("{name}.mixdog-preview.pdf"))
}

/// `exists(path)`: the file can be read.
pub fn exists<P: ReadProof>(proof: &P, path: &str) -> bool {
    mixdog_fsio::exists(proof, path).unwrap_or(false)
}

/// `assertDocumentOutput(output, source)`: several operations take a folder (split_pages, rendered page images), so a caller
/// naturally points output at one here too. Writing the document onto a directory fails deep in a copy with an OS error that
/// names neither the field nor the document: the answer says what output is for, and what to pass.
pub fn assert_document_output<P: ReadProof>(
    proof: &P,
    output: String,
    source: &str,
) -> Result<String, String> {
    let Ok(entry) = mixdog_fsio::metadata(proof, &output) else {
        return Ok(output);
    };
    if !entry.is_dir() {
        return Ok(output);
    }
    let suggestion = join(&output, &split(&default_output(source)).1);
    Err(format!(
        "Office output is the file to write, not a folder: {output} is a directory. Pass a file path such as {suggestion}."
    ))
}

/// `materializeWorkingCopy(session)`: a session opened for reading holds the user's own file. Before the first edit it takes the
/// working copy it would have had, so the edit lands beside the document instead of inside it. Answers the file the edit
/// writes.
pub fn materialize_working_copy<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    env: &Environment,
    registry: &Registry,
    handle: &SessionHandle,
) -> Result<String, String> {
    let (reads_source, source, current) = {
        let session = lock(handle);
        (
            session.reads_source,
            session.source.clone(),
            session.target.clone(),
        )
    };
    if !reads_source {
        return Ok(current);
    }
    let target = default_output(&source);
    if js_to_lowercase(&target) == js_to_lowercase(&source) {
        return Err(
            "portable editing requires an output path different from the source".to_owned(),
        );
    }
    mixdog_fsio::create_dir_all(proof, dirname(&target)).map_err(|error| error.to_string())?;
    note.note_write(Path::new(&target));
    mixdog_fsio::copy(proof, &source, &target).map_err(|error| error.to_string())?;
    registry.retarget(env, handle, target.clone());
    lock(handle).reads_source = false;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_working_copy_sits_beside_the_source_and_keeps_its_extension() {
        let source = Path::new("work")
            .join("report.v2.docx")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            default_output(&source),
            Path::new("work")
                .join("report.v2.mixdog-edit.docx")
                .to_string_lossy()
        );
        assert_eq!(
            default_render_output(&source),
            Path::new("work")
                .join("report.v2.docx.mixdog-preview.pdf")
                .to_string_lossy()
        );
        assert_eq!(stem(&source), "report.v2");
        assert_eq!(dirname("report.docx"), ".");
    }


    #[test]
    fn a_path_is_required_and_a_relative_one_follows_the_call_folder() {
        assert_eq!(full_path("", "x"), Err("path is required".to_owned()));
        let base = std::env::temp_dir().to_string_lossy().into_owned();
        assert_eq!(
            full_path("a/b.docx", &base).expect("path"),
            nodepath::resolve_host(&[&base, "a/b.docx"])
        );
    }
}


/// `fullPath(path, cwd)`: an absolute path stays itself, a relative one is taken against the call's folder (the process's
/// when the call names none).
pub fn full_path(path: &str, cwd: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("path is required".to_owned());
    }
    Ok(nodepath::resolve_host(&[cwd, path]))
}
/// `editableTarget(args, cwd, source)`: the file an edit lands in. It is never the source itself.
pub fn editable_target<P: ReadProof>(
    proof: &P,
    args: &Value,
    cwd: &str,
    source: &str,
) -> Result<String, String> {
    let output = args
        .get("output")
        .filter(|output| mixdog_office_base::values::truthy(output));
    let target = match output {
        Some(output) => assert_document_output(
            proof,
            full_path(&mixdog_js::value_to_string(output), cwd)?,
            source,
        )?,
        None => default_output(source),
    };
    if js_to_lowercase(&target) == js_to_lowercase(source) {
        return Err(
            "background/portable editing requires an output path different from the source"
                .to_owned(),
        );
    }
    Ok(target)
}
