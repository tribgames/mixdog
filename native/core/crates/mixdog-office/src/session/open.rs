//! Opening a document: `openSession`, `packageSource`, `attachMicrosoftOffice`, `officeOpenFailure`, `resolveSession` and the
//! session record both open and create build (`buildOfficeSessionRecord`) of `core/office-sessions.mjs`.
//!
//! - A legacy binary file (`.doc`, `.xls`, `.ppt`) is saved once as its package beside the original, the step a user would
//!   take by hand, and that package is what the session reads and edits. An earlier conversion, or a file of the same name, is
//!   never overwritten: the caller is sent to it instead.
//! - A read opens the file itself (a copy overwrote the working copy an earlier edit had been told was saved); an edit works on
//!   `<name>.mixdog-edit.<ext>` (or the `output` the caller named), so the user's document is never written in place.
//! - A second open of the same path answers the session that already holds it.
//! - A document held by Microsoft Office is attached through the host, and the host's identity of it rides on the session.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use mixdog_fsio::WriteProof;
use mixdog_js::{JsRegex, js_trim, value_to_string};
use mixdog_office_base::formats::{document_file_kind, document_format, legacy_package_kind};
use mixdog_office_base::ids::office_session_id;
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_design::library::{Context, iso_string};
use mixdog_ooxml::soffice::{ScratchHooks, Soffice};
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value};
use std::sync::LazyLock;

use super::design::{DesignContext, resolve_office_design_context};
use super::mode::{OfficeHost, select_mode};
use super::registry::Registry;
use super::working_copy::{dirname, editable_target, exists, full_path, join, stem};
use super::{Backend, DesignState, Mode, Session, SessionHandle, SessionInit};

/// What saves a legacy binary file as its package (`convertLegacyOffice(path, output, { signal })`). The file is converted to
/// `output` and an `output` that is there is never replaced.
pub trait LegacyConverter {
    fn convert(&self, path: &Path, output: &Path) -> Result<(), String>;
}

/// LibreOffice as the converter of legacy files; the call's cancellation is the flag the driver watches.
pub struct SofficeConverter<'a, P: WriteProof> {
    pub soffice: &'a Soffice,
    pub proof: &'a P,
    pub cancel: Option<&'a AtomicBool>,
}

impl<P: WriteProof> LegacyConverter for SofficeConverter<'_, P> {
    fn convert(&self, path: &Path, output: &Path) -> Result<(), String> {
        self.soffice.convert_legacy_office(self.proof, path, output, self.cancel, &ScratchHooks::default()).map(drop).map_err(|error| error.to_string())
    }
}

/// What open, create and attach run with: the design library, the write note of the call, the registry, the Office host and
/// the legacy converter, the Office data directory, the call's folder and its cancellation.
pub struct SessionEnv<'a, P: WriteProof, H: OfficeHost> {
    pub design: &'a Context<'a, P>,
    pub note: &'a dyn WriteNote,
    pub registry: &'a Registry,
    pub host: &'a H,
    pub legacy: &'a dyn LegacyConverter,
    pub data_dir: &'a Path,
    /// `cwd` of the call; empty when it names none (the process's folder).
    pub cwd: &'a str,
    /// `args.__signal`.
    pub cancel: Option<&'a CancellationToken>,
}

/// A session open and create answered. `reused` is `session.reused === true`: the document already had a session, and this
/// is it.
#[derive(Clone)]
pub struct OpenedSession {
    pub handle: SessionHandle,
    pub reused: bool,
}

impl OpenedSession {
    pub(crate) fn reused(handle: SessionHandle) -> Self {
        Self { handle, reused: true }
    }

    pub(crate) fn fresh(handle: SessionHandle) -> Self {
        Self { handle, reused: false }
    }
}

/// `args[name]` as the text `String(args[name])` gives when it is truthy, else empty.
pub(crate) fn text_arg(args: &Value, name: &str) -> String {
    args.get(name).filter(|value| truthy(value)).map(value_to_string).unwrap_or_default()
}

// Word, Excel, and PowerPoint answer a damaged file with their own wording, in the language they are installed in, and nothing
// else: the caller still needs to know which file refused to open and what to do about it. The application refusing to automate
// is not a damaged document: sending the caller to repair an intact file wastes the turn, while the route that works (no
// Office at all, or co-editing the instance already running) goes unsaid.
static APPLICATION_REFUSAL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"shared or unidentified application|already running|RPC server|automation server|is busy|call was rejected", "i"));
static TRAILING_DOTS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\.+$", ""));

/// `officeOpenFailure(reason, path)`.
pub fn office_open_failure(reason: Option<&Value>, path: &str) -> String {
    let text = reason.filter(|reason| truthy(reason)).map(value_to_string).unwrap_or_default();
    let message = TRAILING_DOTS.replace_all_with(js_trim(&text), |_| String::new());
    if message.is_empty() {
        return format!("Microsoft Office could not open {path}");
    }
    if message.contains(path) {
        return message;
    }
    if APPLICATION_REFUSAL.is_match(&message) {
        return format!(
            "Microsoft Office could not open {path}: {message}. This is the Office application, not the file: retry with mode:'portable' (no Office needed), or mode:'attach' to co-edit the instance that is already open."
        );
    }
    format!(
        "Microsoft Office could not open {path}: {message}. If the file is damaged or incomplete, ask for an intact copy or let Office repair it and save a fresh file."
    )
}

/// `pptxReviewDesignState(design, format)`.
pub(crate) fn review_design_state(design: &Value, format: &str) -> DesignState {
    DesignState::empty(format == "pptx" && design.pointer("/review/required").is_some_and(truthy), true)
}

/// `portableCreateDesignState()`.
pub(crate) fn portable_create_design_state() -> DesignState {
    DesignState::empty(false, false)
}

/// What `buildOfficeSessionRecord` is given.
pub(crate) struct Record {
    pub id: String,
    pub source: String,
    pub target: String,
    pub file_kind: String,
    pub format: String,
    pub mode: Mode,
    pub backend: Backend,
    pub created: bool,
    pub created_new_file: Option<bool>,
    pub design_context: DesignContext,
    pub design_state: DesignState,
}

/// `buildOfficeSessionRecord({...})`: the session record, not yet registered.
pub(crate) fn build_session<P: WriteProof, H: OfficeHost>(env: &SessionEnv<'_, P, H>, record: Record) -> Session {
    let mut session = Session::new(SessionInit {
        id: record.id,
        source: record.source,
        target: record.target,
        file_kind: record.file_kind,
        format: record.format,
        mode: record.mode,
        backend: record.backend,
        opened_at: iso_string((env.design.env.now_ms)()),
        data_dir: PathBuf::from(env.data_dir),
        created: record.created,
        created_new_file: record.created_new_file,
        design_state: record.design_state,
    });
    session.apply_design_context(record.design_context);
    session
}

/// `ownership: 'owned', visible: false` of a session the portable backends hold.
pub(crate) fn mark_owned(session: &mut Session) {
    session.com.ownership = Some("owned".to_owned());
    session.com.visible = Some(false);
}

/// `attachMicrosoftOffice(session, { id, format, fileKind, mode, target, signal })`: Office opens the document and answers its
/// identity. The file a caller can act on is the one they named, not the working copy.
pub(crate) async fn attach_microsoft_office<H: OfficeHost>(
    host: &H,
    session: &mut Session,
    file_kind: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> Result<(), String> {
    let mut payload = Map::new();
    payload.insert("session".to_owned(), Value::from(session.id.clone()));
    payload.insert("format".to_owned(), Value::from(session.format.clone()));
    if let Some(kind) = file_kind.filter(|kind| !kind.is_empty()) {
        payload.insert("fileKind".to_owned(), Value::from(kind));
    }
    payload.insert("mode".to_owned(), Value::from(session.mode.as_str()));
    payload.insert("path".to_owned(), Value::from(session.target.clone()));
    let opened = host.open_session(&Value::Object(payload), cancel).await;
    if !opened.get("ok").is_some_and(truthy) {
        let named = if session.source.is_empty() { &session.target } else { &session.source };
        return Err(office_open_failure(opened.get("error"), named));
    }
    session.apply_com_fields(&opened);
    Ok(())
}

/// `packageSource(path, signal)`: a legacy binary file is saved once as its package beside the original, and that package is
/// what the session reads and edits. An earlier conversion or a file of the same name is never overwritten: the caller is sent
/// to it instead. Answers the file to open and the legacy file it came from (empty when there was none).
fn package_source<P: WriteProof, H: OfficeHost>(env: &SessionEnv<'_, P, H>, path: &str) -> Result<(String, String), String> {
    let kind = legacy_package_kind(path);
    if kind.is_empty() {
        return Ok((path.to_owned(), String::new()));
    }
    let converted = join(&dirname(path), &format!("{}.{kind}", stem(path)));
    if exists(env.design.lane, &converted) {
        return Err(format!("{path} is a legacy binary file and {converted} already exists; open {converted} directly, or move it aside to convert again."));
    }
    env.note.note_write(Path::new(&converted));
    env.legacy.convert(Path::new(path), Path::new(&converted))?;
    Ok((converted, path.to_owned()))
}

/// `openSession(args, cwd, dataDir, { readOnly })`.
pub async fn open_session<P: WriteProof, H: OfficeHost>(env: &SessionEnv<'_, P, H>, args: &Value, read_only: bool) -> Result<OpenedSession, String> {
    let proof = env.design.lane;
    let requested = full_path(&text_arg(args, "path"), env.cwd)?;
    if !exists(proof, &requested) {
        return Err(format!("Office document not found: {requested}"));
    }
    let (source, converted_from) = package_source(env, &requested)?;
    let file_kind = document_file_kind(&source)?;
    let format = document_format(&source)?;
    let selected = select_mode(env.host, args.get("mode"), format, &source).await?;
    // Reading a document does not need a copy of it, and making one overwrote the working copy an earlier edit had already been
    // told was saved: the next read of the same path silently threw that edit away. A read opens the file itself; the working
    // copy appears when an edit does.
    let reads =
        read_only && !args.get("output").is_some_and(truthy) && matches!(selected.backend, Backend::MixdogOoxml | Backend::MixdogPdf | Backend::MixdogTabular);
    let copies = !reads && matches!(selected.mode, Mode::Background | Mode::Portable);
    let target = if copies { editable_target(proof, args, env.cwd, &source)? } else { source.clone() };
    if let Some(existing) = env.registry.for_document(env.design.env, &target) {
        return Ok(OpenedSession::reused(existing));
    }
    if copies {
        mixdog_fsio::create_dir_all(proof, dirname(&target)).map_err(|error| error.to_string())?;
        env.note.note_write(Path::new(&target));
        mixdog_fsio::copy(proof, &source, &target).map_err(|error| error.to_string())?;
    }
    let design_context = resolve_office_design_context(env.design, env.data_dir, args, &target, &source, format, false)?;
    let design_state = review_design_state(&design_context.design, format);
    let mut session = build_session(
        env,
        Record {
            id: office_session_id(),
            source,
            target: target.clone(),
            file_kind,
            format: format.to_owned(),
            mode: selected.mode,
            backend: selected.backend,
            created: false,
            created_new_file: None,
            design_context,
            design_state,
        },
    );
    if selected.backend == Backend::MixdogOoxml {
        mark_owned(&mut session);
    }
    // The session reads the file itself; the first edit gives it a working copy so the user's document is never written in place.
    session.reads_source = reads;
    session.converted_from = converted_from;
    if selected.backend == Backend::MicrosoftOfficeCom {
        attach_microsoft_office(env.host, &mut session, None, env.cancel).await?;
    }
    Ok(OpenedSession::fresh(env.registry.register(env.design, session)))
}

/// What `resolveSession` answers: the session, and whether the call opened it from a path (`implicit`).
pub struct ResolvedSession {
    pub opened: OpenedSession,
    pub implicit: bool,
}

/// `resolveSession(args, cwd, dataDir, { readOnly })`: the session an action names by id, or the one opened implicitly from
/// its path.
pub async fn resolve_session<P: WriteProof, H: OfficeHost>(env: &SessionEnv<'_, P, H>, args: &Value, read_only: bool) -> Result<ResolvedSession, String> {
    if args.get("session").is_some_and(truthy) {
        let id = text_arg(args, "session");
        let Some(handle) = env.registry.get(&id) else {
            return Err(format!("Unknown or closed Office Use session: {id}"));
        };
        return Ok(ResolvedSession { opened: OpenedSession::fresh(handle), implicit: false });
    }
    if !args.get("path").is_some_and(truthy) {
        return Err("session or path is required".to_owned());
    }
    Ok(ResolvedSession { opened: open_session(env, args, read_only).await?, implicit: true })
}

/// A future that answers a session's close (`closeSession(session)` of the finalize stage): the Office document saved and
/// closed, the session released.
pub trait SessionCloser {
    fn close(&self, handle: &SessionHandle) -> impl Future<Output = Result<(), String>>;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_failed_open_names_the_file_and_the_way_forward() {
        let path = "C:\\work\\a.docx";
        assert_eq!(office_open_failure(None, path), "Microsoft Office could not open C:\\work\\a.docx");
        assert_eq!(office_open_failure(Some(&json!("  ")), path), "Microsoft Office could not open C:\\work\\a.docx");
        assert_eq!(office_open_failure(Some(&json!("it said C:\\work\\a.docx is bad.")), path), "it said C:\\work\\a.docx is bad");
        assert_eq!(
            office_open_failure(Some(&json!("File is damaged...")), path),
            "Microsoft Office could not open C:\\work\\a.docx: File is damaged. If the file is damaged or incomplete, ask for an intact copy or let Office repair it and save a fresh file."
        );
    }

    #[test]
    fn the_application_refusing_is_not_a_damaged_file() {
        let text = office_open_failure(Some(&json!("The RPC server is unavailable.")), "a.docx");
        assert_eq!(
            text,
            "Microsoft Office could not open a.docx: The RPC server is unavailable. This is the Office application, not the file: retry with mode:'portable' (no Office needed), or mode:'attach' to co-edit the instance that is already open."
        );
    }

    #[test]
    fn a_review_is_required_only_of_a_deck_that_says_so() {
        let design = json!({ "review": { "required": true } });
        assert!(review_design_state(&design, "pptx").requires_visual_review);
        assert!(!review_design_state(&design, "docx").requires_visual_review);
        assert!(!review_design_state(&json!({ "review": {} }), "pptx").requires_visual_review);
        assert!(portable_create_design_state().slide_plans.is_none());
    }
}
