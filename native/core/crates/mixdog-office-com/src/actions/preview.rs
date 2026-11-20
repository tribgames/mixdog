//! The read-only open of the file preview and the second-application check of a document: `Open-ValidationDocument`,
//! `Assert-PreviewNotEncrypted`, `Open-PreviewDocument` and `Validate-NativeDocument` of `office-com-host.ps1`.

use std::io::Read;

use mixdog_fsio::WriteProof;

use super::Actions;
use super::empty_payload;
use super::failed_cleanup;
use super::file_error;
use super::path_extension;
use super::text;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::host::Emitter;
use crate::office::close_office_document;
use crate::office::new_hidden_application;
use crate::office::office_document_count;
use crate::office::prog_id_for_format;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::fingerprint::snapshot_fingerprint;
use crate::ps::payload;
use crate::ps::pipeline_items;

/// What the preview answers for a file that needs a password nobody gave.
pub const PASSWORD_PROTECTED: &str = "This file is password-protected. (OFFICE_PREVIEW_PASSWORD_PROTECTED)";

/// What the preview answers for a password that did not open the file.
pub const WRONG_PASSWORD: &str = "That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)";

/// The password every slot gets when the request carries none, so a protected legacy file fails at once instead of
/// waiting on a prompt nobody can see.
const PLACEHOLDER_PASSWORD: &str = "mixdog-preview-no-password";

/// Word's "the password is incorrect" (`0x800A1520`).
const WORD_PASSWORD_INCORRECT: i32 = 0x800A_1520_u32 as i32;

/// The extensions of Office Open XML packages, which are ZIP files unless they are encrypted.
const OOXML_EXTENSIONS: [&str; 7] = ["docx", "docm", "dotx", "xlsx", "xlsm", "pptx", "pptm"];

/// The signature of an OLE container, which is what an encrypted package is.
const OLE_SIGNATURE: [u8; 4] = [0xD0, 0xCF, 0x11, 0xE0];

fn document_of(value: Com) -> Result<Obj> {
    value.into_obj().ok_or_else(|| Error::host("Microsoft Office did not answer a document."))
}

/// `Open-ValidationDocument`: the document opened read-only in the second application.
pub fn open_validation_document(app: &Obj, format: &str, path: &str) -> Result<Obj> {
    let opened = match format {
        "docx" => app.get("Documents")?.call_member("Open", &[Com::from(path), Com::Bool(false), Com::Bool(true), Com::Bool(false)])?,
        "xlsx" => app.get("Workbooks")?.call_member("Open", &[Com::from(path), Com::I4(0), Com::Bool(true)])?,
        "pptx" => app.get("Presentations")?.call_member("Open", &[Com::from(path), Com::Bool(true), Com::Bool(true), Com::Bool(false)])?,
        _ => Com::Null,
    };
    document_of(opened)
}

/// `Assert-PreviewNotEncrypted`: an encrypted Office Open XML package is an OLE container, not a ZIP. Office would stop to
/// ask for the password, and a hidden application cannot show the question, so the request is refused up front.
pub fn assert_preview_not_encrypted<P: WriteProof>(actions: &Actions<'_, P>, path: &str) -> std::result::Result<(), String> {
    let extension = path_extension(path).trim_start_matches('.').to_lowercase();
    if !OOXML_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(());
    }
    let mut header = [0_u8; 4];
    let read = {
        let mut file = mixdog_fsio::File::open(actions.proof, path).map_err(|error| file_error("Open", 4, path, &error))?;
        file.read(&mut header).map_err(|error| file_error("Read", 3, path, &error))?
    };
    if read == header.len() && header == OLE_SIGNATURE {
        return Err(PASSWORD_PROTECTED.to_owned());
    }
    Ok(())
}

/// `Open-PreviewDocument`: the read-only open of the file preview. Word and Excel get the user's password when the
/// request carries one, else a placeholder; PowerPoint takes none. Links are not updated, macros stay off and alerts are off
/// (`New-HiddenApplication`). Word's "password is incorrect" becomes the plain message: the protected one without a
/// password, the wrong-password one with it.
pub fn open_preview_document(app: &Obj, format: &str, path: &str, password: &str) -> Result<Obj> {
    let open_password = if password.is_empty() { PLACEHOLDER_PASSWORD } else { password };
    let opened = match format {
        "docx" => app.get("Documents").and_then(|documents| {
            documents.call_member(
                "Open",
                &[
                    Com::from(path),
                    Com::Bool(false),
                    Com::Bool(true),
                    Com::Bool(false),
                    Com::from(open_password),
                    Com::from(PLACEHOLDER_PASSWORD),
                    Com::Bool(false),
                    Com::from(PLACEHOLDER_PASSWORD),
                    Com::from(PLACEHOLDER_PASSWORD),
                ],
            )
        }),
        // No WriteResPassword: Excel rejects one for a workbook without write reservation (0x800A03EC), and a read-only
        // open never asks for it.
        "xlsx" => app.get("Workbooks").and_then(|books| {
            books.call_member("Open", &[Com::from(path), Com::I4(0), Com::Bool(true), Com::Missing, Com::from(open_password), Com::Missing, Com::Bool(true)])
        }),
        "pptx" => app.get("Presentations").and_then(|decks| decks.call_member("Open", &[Com::from(path), Com::Bool(true), Com::Bool(true), Com::Bool(false)])),
        _ => Ok(Com::Null),
    };
    match opened {
        Ok(value) => document_of(value),
        Err(Error::Com(error)) if format == "docx" && error.inner_hresult == WORD_PASSWORD_INCORRECT => {
            Err(Error::host(if password.is_empty() { PASSWORD_PROTECTED } else { WRONG_PASSWORD }))
        }
        Err(error) => Err(error),
    }
}

/// The handles of the second application, which are released whatever happened.
#[derive(Default)]
struct Held {
    app: Option<Obj>,
    document: Option<Obj>,
}

fn validate<P: WriteProof>(actions: &Actions<'_, P>, held: &mut Held, path: &str, format: &str) -> std::result::Result<Value, String> {
    let prog_id = prog_id_for_format(format).ok_or_else(|| format!("Unsupported Office format: {format}"))?;
    let app = new_hidden_application(&actions.env, format, prog_id).map_err(text)?;
    let opened = open_validation_document(&app, format, path);
    held.app = Some(app);
    let document = opened.map_err(text)?;
    held.document = Some(document.clone());
    let snapshot = actions.snapshot(&document, format, &empty_payload()).map_err(text)?;
    let inspection = actions.issues(&document, format, Some(&empty_payload())).map_err(text)?;
    let issue_count = convert::to_int(&payload::property(&inspection, "issueCount"))?;
    Ok(Value::object(
        ObjectKind::Ordered,
        vec![
            ("ok", Value::Bool(convert::to_bool(&payload::property(&inspection, "ok")))),
            ("opened", Value::Bool(true)),
            ("issueCount", Value::Int(issue_count)),
            ("issues", Value::Array(pipeline_items(&payload::property(&inspection, "issues")))),
            ("snapshotFingerprint", Value::String(snapshot_fingerprint(&snapshot))),
        ],
    ))
}

/// `Validate-NativeDocument`: the file opened read-only in a second hidden application and read and inspected there. Its
/// handles are dropped before this answers, and a cleanup that failed goes to the host's cleanup channel.
pub fn validate_native_document<P: WriteProof>(actions: &Actions<'_, P>, out: &mut Emitter, path: &str, format: &str) -> Value {
    let mut held = Held::default();
    let answer = match validate(actions, &mut held, path, format) {
        Ok(value) => value,
        Err(message) => Value::object(ObjectKind::Ordered, vec![("ok", Value::Bool(false)), ("opened", Value::Bool(false)), ("error", Value::String(message))]),
    };
    if let Some(document) = held.document.take() {
        if let Err(error) = close_office_document(&document, format) {
            out.cleanup_failure(&failed_cleanup(&format!("Validation document close failed: {}", error.message())));
        }
        drop(document);
    }
    if let Some(app) = held.app.take() {
        let quit = office_document_count(&app, format).and_then(|count| if count == 0 { app.call("Quit", &[]).map(|_| ()) } else { Ok(()) });
        if let Err(error) = quit {
            out.cleanup_failure(&failed_cleanup(&format!("Validation application cleanup failed: {}", error.message())));
        }
        drop(app);
    }
    answer
}
