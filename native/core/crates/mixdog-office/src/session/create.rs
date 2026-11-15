//! Creating a document: `createSession`, `createAuthoredSession`, `registerHtmlPdfSession`, `releaseOverwrittenSession`,
//! `initialOfficeOperations` and the create-time faults of `core/office-sessions.mjs`.
//!
//! - Content handed to create under a field the format never writes (blocks for Word, operations for PDF, a top-level
//!   `values`, a `script`, facts with nothing to write them) is refused with the field that does write it, every fault of the
//!   request in one answer: a blank file with a success answer cost the caller a turn.
//! - The initial operations are validated by the contract engine before anything is written, and again against the backend
//!   the mode selected.
//! - A target that exists is refused unless `overwrite:true`; an overwrite closes the session this runtime holds on the old
//!   file first, and is refused when that session holds a document the user has open or has a transaction open.
//! - A PDF is written from blocks, CSV and TSV start empty, Word, Excel and PowerPoint start as a portable package, or as a
//!   document Microsoft Office creates.

use std::borrow::Cow;
use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_js::{js_trim, value_to_string};
use mixdog_office_base::formats::{
    FORMATS, document_file_kind, document_format, is_tabular_format, normalize_office_format,
};
use mixdog_office_base::ids::office_session_id;
use mixdog_office_base::values::truthy;
use mixdog_office_design::design_system::apply_pdf_design;
use mixdog_office_pdf::writer::create_pdf;
use mixdog_ooxml::package::{
    CreateOptions, create_portable_ooxml_document, portable_create_supported,
};
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use serde_json::{Map, Value, json};

use super::design::{DesignContext, resolve_office_design_context};
use super::mode::{OfficeHost, requested_mode, select_mode, validate_author_mode};
use super::open::{
    OpenedSession, Record, SessionCloser, SessionEnv, attach_microsoft_office, build_session,
    mark_owned, portable_create_design_state, review_design_state, text_arg,
};
use super::registry::lock;
use super::working_copy::{dirname, exists, full_path, stem};
use super::{Backend, DesignState, Mode, Session, SessionHandle};
use crate::contracts::assert_office_operation_contracts;
use crate::tabular;

/// What a PDF is written with: the fonts it chooses among and the SVG fonts its charts are drawn with.
pub struct CreateTools<'a, C: SessionCloser> {
    pub closer: &'a C,
    pub fonts: &'a FontEnv,
    pub svg_fonts: &'a SvgFonts,
}

/// What `createSession` answers: the session, and the initial operations after the contract engine rewrote the names a caller
/// drifted on (later stages read the rewritten form).
pub struct Created {
    pub session: OpenedSession,
    pub operations: Vec<Value>,
}

/// What one create call settled before it picks the writer (`creation` of `createSession`).
struct Creation {
    target: String,
    file_kind: String,
    format: String,
    target_existed: bool,
    design_context: DesignContext,
}

fn filled_list(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

fn upper(format: &str) -> String {
    format.to_ascii_uppercase()
}

fn content_field_fault(format: &str, args: &Value) -> String {
    if format == "pdf" {
        if !filled_list(args.get("operations")) {
            return String::new();
        }
        return "PDF create writes blocks, not operations: pass blocks:[{ type:'heading', text }, …] (and fields for a form), or create the file first and edit it with action:'batch' operations:[…].".to_owned();
    }
    if !filled_list(args.get("blocks")) {
        return String::new();
    }
    format!(
        "{} create writes operations, not blocks: pass operations:[{{ op: … }}]. blocks is the PDF create field.",
        upper(format)
    )
}

/// Facts and claims describe what the deliverable must carry; they do not write it. Handed over with nothing that does, the call
/// produced an empty file and reported success, and the caller found out only on opening it.
fn script_fault(format: &str, args: &Value) -> String {
    let script = args
        .get("script")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or_default();
    if format == "pdf" || script.is_empty() {
        return String::new();
    }
    let hint = if format == "pptx" {
        " A deck written from a script uses action:'author' with script."
    } else {
        ""
    };
    format!("{} create takes no script.{hint}", upper(format))
}

fn content_without_writer_fault(format: &str, args: &Value) -> String {
    let content = args
        .pointer("/design/content")
        .filter(|content| content.is_object());
    let carries = content.is_some_and(|content| {
        filled_list(content.get("facts"))
            || filled_list(content.get("claims"))
            || ["objective", "decision"]
                .iter()
                .find_map(|key| content.get(key).filter(|value| truthy(value)))
                .is_some_and(|value| !js_trim(&value_to_string(value)).is_empty())
    });
    let writes = if format == "pdf" {
        filled_list(args.get("blocks")) || filled_list(args.get("fields"))
    } else {
        filled_list(args.get("operations"))
    };
    if !carries || writes {
        return String::new();
    }
    let route = match format {
        "pptx" => {
            "author the deck with action:'author' script:… (design travels on that call), or add slides here with operations:[{ op: 'add_slide' }, …]"
        }
        "docx" => {
            "pass operations:[{ op: 'compose_document', … }] or the append_text/add_table operations that write it"
        }
        "xlsx" => {
            "pass operations:[{ op: 'compose_sheet', … }] or the set_range/add_chart operations that write it"
        }
        "pdf" => "pass blocks:[{ type: 'heading', text }, …] (and fields for a form)",
        _ => "pass the operations that write it",
    };
    format!(
        "{} create writes nothing from design.content on its own: {route}.",
        upper(format)
    )
}

/// `assertCreateContentFields(format, args)`: each shape a format never reads is refused with the field that does write it.
fn assert_create_content_fields(format: &str, args: &Value) -> Result<(), String> {
    let values = if filled_list(args.get("values")) {
        format!(
            "{} create takes no top-level values: pass operations:[{{ op: 'set_range', range: 'A1:B2', values: [[…]] }}].",
            upper(format)
        )
    } else {
        String::new()
    };
    let faults: Vec<String> = [
        content_field_fault(format, args),
        values,
        script_fault(format, args),
        content_without_writer_fault(format, args),
    ]
    .into_iter()
    .filter(|fault| !fault.is_empty())
    .collect();
    match faults.len() {
        0 => Ok(()),
        1 => Err(faults.into_iter().next().unwrap_or_default()),
        count => Err(format!(
            "This create request breaks {count} input contracts; fix them together. {}",
            faults.join(" ")
        )),
    }
}

/// `initialOfficeOperations(args)`: the operations the call names, or those of its `design`.
pub fn initial_office_operations(args: &Value) -> Vec<Value> {
    if let Some(operations) = args
        .get("operations")
        .and_then(Value::as_array)
        .filter(|operations| !operations.is_empty())
    {
        return operations.clone();
    }
    args.pointer("/design/operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The call's arguments as the rest of `createSession` reads them: the contract engine rewrote the initial operations in place
/// (`args.operations`, or `args.design.operations` when those were the ones taken), so the design context and the design request
/// the session keeps see the rewritten form.
fn with_rewritten_operations<'a>(args: &'a Value, operations: &[Value]) -> Cow<'a, Value> {
    let pointer = if filled_list(args.get("operations")) {
        "/operations"
    } else if args.pointer("/design/operations").is_some_and(Value::is_array) {
        "/design/operations"
    } else {
        return Cow::Borrowed(args);
    };
    if args
        .pointer(pointer)
        .and_then(Value::as_array)
        .is_some_and(|written| written.as_slice() == operations)
    {
        return Cow::Borrowed(args);
    }
    let mut rewritten = args.clone();
    if let Some(slot) = rewritten.pointer_mut(pointer) {
        *slot = Value::Array(operations.to_vec());
    }
    Cow::Owned(rewritten)
}

/// `firstListed(direct, designed)`: `design` is where authoring intent and content go for every other format, so blocks named
/// there are the document's content, not an unknown key to drop: dropping them wrote an empty PDF and reported success.
fn first_listed(direct: Option<&Value>, designed: Option<&Value>) -> Vec<Value> {
    if filled_list(direct) {
        return direct
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
    }
    designed
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `{ ...value }` of an object into `into` (the one value a `properties` argument is).
fn spread_object(into: &mut Map<String, Value>, value: Option<&Value>) {
    if let Some(Value::Object(map)) = value {
        for (key, item) in map {
            into.insert(key.clone(), item.clone());
        }
    }
}

/// `releaseOverwrittenSession(target, overwrite)`: overwriting a document replaces it. A session this runtime still holds on the
/// old file is closed first, never left registered beside the new one (PDF) or handed back in place of the document the caller
/// asked to write. A session on a document the user has open is theirs, so the overwrite is refused instead.
pub async fn release_overwritten_session<P: WriteProof, H: OfficeHost, C: SessionCloser>(
    env: &SessionEnv<'_, P, H>,
    closer: &C,
    target: &str,
    overwrite: bool,
) -> Result<(), String> {
    if !overwrite {
        return Ok(());
    }
    let Some(existing) = env.registry.for_document(env.design.env, target) else {
        return Ok(());
    };
    let (id, ownership, in_transaction) = {
        let session = lock(&existing);
        (
            session.id.clone(),
            session.com.ownership.clone().unwrap_or_default(),
            session.state.transaction().is_some(),
        )
    };
    if ownership != "owned" {
        let held = if ownership.is_empty() {
            "a shared document"
        } else {
            ownership.as_str()
        };
        return Err(format!(
            "Office create cannot overwrite {target}: session {id} holds it as {held}; close that session first"
        ));
    }
    if in_transaction {
        return Err(format!(
            "Office create cannot overwrite {target}: session {id} has an open transaction; commit or roll it back, then create again"
        ));
    }
    closer.close(&existing).await
}

fn assert_create_target_available(
    target: &str,
    existed: bool,
    overwrite: bool,
) -> Result<(), String> {
    if existed && !overwrite {
        return Err(format!("Office create target already exists: {target}"));
    }
    Ok(())
}

/// `registerCreatedSession(creation, fields)`: registers the session record of a document this create call produced.
fn register_created<P: WriteProof, H: OfficeHost>(
    env: &SessionEnv<'_, P, H>,
    creation: &Creation,
    id: Option<String>,
    mode: Mode,
    backend: Backend,
    design_state: DesignState,
    extra: impl FnOnce(&mut Session),
) -> SessionHandle {
    let mut session = build_session(
        env,
        Record {
            id: id.unwrap_or_else(office_session_id),
            source: creation.target.clone(),
            target: creation.target.clone(),
            file_kind: creation.file_kind.clone(),
            format: creation.format.clone(),
            mode,
            backend,
            created: true,
            created_new_file: Some(!creation.target_existed),
            design_context: creation.design_context.clone(),
            design_state,
        },
    );
    extra(&mut session);
    env.registry.register(env.design, session)
}

fn make_parent<P: WriteProof, H: OfficeHost>(
    env: &SessionEnv<'_, P, H>,
    target: &str,
) -> Result<(), String> {
    mixdog_fsio::create_dir_all(env.design.lane, dirname(target)).map_err(|error| error.to_string())
}

fn create_pdf_session<P: WriteProof, H: OfficeHost, C: SessionCloser>(
    env: &SessionEnv<'_, P, H>,
    tools: &CreateTools<'_, C>,
    creation: &Creation,
    args: &Value,
) -> Result<SessionHandle, String> {
    let target = &creation.target;
    make_parent(env, target)?;
    let blocks = first_listed(args.get("blocks"), args.pointer("/design/blocks"));
    let fields = first_listed(args.get("fields"), args.pointer("/design/fields"));
    let mut resolved = Vec::with_capacity(blocks.len());
    for block in &blocks {
        let path = block.get("path").filter(|path| truthy(path));
        let Some(path) = path else {
            resolved.push(block.clone());
            continue;
        };
        let mut block = block.clone();
        if let Some(map) = block.as_object_mut() {
            map.insert(
                "path".to_owned(),
                Value::String(full_path(&value_to_string(path), env.cwd)?),
            );
        }
        resolved.push(block);
    }
    let context = &creation.design_context;
    let designed = apply_pdf_design(
        &resolved,
        &context.design_request,
        context.design_library.as_ref(),
    )?;
    let mut properties = Map::new();
    spread_object(&mut properties, designed.get("properties"));
    spread_object(&mut properties, args.get("properties"));
    if let Some(font_path) = args
        .pointer("/properties/fontPath")
        .filter(|path| truthy(path))
    {
        properties.insert(
            "fontPath".to_owned(),
            Value::String(full_path(&value_to_string(font_path), env.cwd)?),
        );
    }
    let designed_blocks = designed
        .get("blocks")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let block_count = designed_blocks.as_array().map_or(0, Vec::len);
    let spec = json!({ "blocks": designed_blocks, "fields": fields, "properties": Value::Object(properties) });
    let written = create_pdf(env.design.lane, tools.fonts, tools.svg_fonts, target, &spec)
        .map_err(|error| error.message().to_owned())?;
    // What the writer decided (numbering, the font it embedded) rides on the create result so the caller need not re-open the file
    // to learn it. What it actually flowed: a document with nothing in it is a result the caller has to see, not a silent success.
    let mut receipt = Map::new();
    for key in ["pageNumbers", "font"] {
        if let Some(value) = written.get(key) {
            receipt.insert(key.to_owned(), value.clone());
        }
    }
    receipt.insert("blocks".to_owned(), Value::from(block_count));
    receipt.insert("fields".to_owned(), Value::from(fields.len()));
    if written.pointer("/form/issueCount").is_some_and(truthy) {
        receipt.insert(
            "formIssues".to_owned(),
            written
                .pointer("/form/issues")
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    Ok(register_created(
        env,
        creation,
        None,
        Mode::Portable,
        Backend::MixdogPdf,
        portable_create_design_state(),
        |session| {
            session.create_receipt = Some(Value::Object(receipt));
            mark_owned(session);
        },
    ))
}

/// `registerHtmlPdfSession(args, dataDir, target, { targetExisted, receipt })`: a PDF the author action printed from HTML is
/// already on disk; its session is registered as a created PDF's is, so it goes through the same render, review, and finalize.
pub fn register_html_pdf_session<P: WriteProof, H: OfficeHost>(
    env: &SessionEnv<'_, P, H>,
    args: &Value,
    target: &str,
    target_existed: bool,
    receipt: Value,
) -> Result<SessionHandle, String> {
    let design_context =
        resolve_office_design_context(env.design, env.data_dir, args, target, "", "pdf", true)?;
    let creation = Creation {
        target: target.to_owned(),
        file_kind: document_file_kind(target)?,
        format: "pdf".to_owned(),
        target_existed,
        design_context,
    };
    Ok(register_created(
        env,
        &creation,
        None,
        Mode::Portable,
        Backend::MixdogPdf,
        portable_create_design_state(),
        |session| {
            session.create_receipt = Some(receipt);
            mark_owned(session);
        },
    ))
}

fn create_tabular_session<P: WriteProof, H: OfficeHost>(
    env: &SessionEnv<'_, P, H>,
    creation: &Creation,
) -> Result<SessionHandle, String> {
    make_parent(env, &creation.target)?;
    tabular::create(env.design.lane, env.note, Path::new(&creation.target))?;
    Ok(register_created(
        env,
        creation,
        None,
        Mode::Portable,
        Backend::MixdogTabular,
        portable_create_design_state(),
        mark_owned,
    ))
}

fn create_portable_ooxml_session<P: WriteProof, H: OfficeHost>(
    env: &SessionEnv<'_, P, H>,
    creation: &Creation,
) -> Result<SessionHandle, String> {
    if !portable_create_supported(&creation.file_kind) {
        return Err(format!(
            "Creating .{} without Microsoft Office is unsupported; open Microsoft Office or choose a docx, xlsx, or pptx target",
            creation.file_kind
        ));
    }
    make_parent(env, &creation.target)?;
    let title = stem(&creation.target);
    create_portable_ooxml_document(
        env.design.lane,
        env.note,
        Path::new(&creation.target),
        &CreateOptions {
            file_kind: &creation.file_kind,
            title: &title,
            sheet_name: "",
        },
    )?;
    let design_state = review_design_state(&creation.design_context.design, &creation.format);
    Ok(register_created(
        env,
        creation,
        None,
        Mode::Portable,
        Backend::MixdogOoxml,
        design_state,
        mark_owned,
    ))
}

async fn create_microsoft_office_session<P: WriteProof, H: OfficeHost>(
    env: &SessionEnv<'_, P, H>,
    creation: &Creation,
    args: &Value,
    mode: Mode,
) -> Result<SessionHandle, String> {
    let id = office_session_id();
    let payload = json!({
        "session": id,
        "format": creation.format,
        "fileKind": creation.file_kind,
        "mode": mode.as_str(),
        "path": creation.target,
        "create": true,
        "overwrite": args.get("overwrite") == Some(&Value::Bool(true)),
    });
    let opened = env.host.open_session(&payload, env.cancel).await;
    if !opened.get("ok").is_some_and(truthy) {
        return Err(opened
            .get("error")
            .filter(|error| truthy(error))
            .map_or_else(
                || "Microsoft Office document creation failed".to_owned(),
                value_to_string,
            ));
    }
    let design_state = review_design_state(&creation.design_context.design, &creation.format);
    Ok(register_created(
        env,
        creation,
        Some(id),
        mode,
        Backend::MicrosoftOfficeCom,
        design_state,
        |session| session.apply_com_fields(&opened),
    ))
}

/// `createSession(args, cwd, dataDir)`.
pub async fn create_session<P: WriteProof, H: OfficeHost, C: SessionCloser>(
    env: &SessionEnv<'_, P, H>,
    tools: &CreateTools<'_, C>,
    args: &Value,
) -> Result<Created, String> {
    let proof = env.design.lane;
    let named = ["path", "output"]
        .iter()
        .find_map(|key| args.get(key).filter(|value| truthy(value)))
        .map(value_to_string)
        .unwrap_or_default();
    let requested = js_trim(&named);
    if requested.is_empty() {
        return Err("create requires path or output".to_owned());
    }
    let target = full_path(requested, env.cwd)?;
    let file_kind = document_file_kind(&target)?;
    let inferred = document_format(&target)?;
    let format = match args.get("format").filter(|format| truthy(format)) {
        Some(format) => normalize_office_format(&value_to_string(format))?,
        None => inferred,
    };
    if format != inferred {
        return Err(format!(
            "Office create format {} does not match target .{file_kind}",
            text_arg(args, "format")
        ));
    }
    assert_create_content_fields(format, args)?;
    let mut operations = initial_office_operations(args);
    assert_office_operation_contracts(format, "", &mut operations)?;
    let rewritten = with_rewritten_operations(args, &operations);
    let args = &*rewritten;
    // Whether this call brings the file into being decides what a failed create may clean up afterwards: a file it wrote itself,
    // never one already there.
    let target_existed = exists(proof, &target);
    env.note.note_write(Path::new(&target));
    let design_context =
        resolve_office_design_context(env.design, env.data_dir, args, &target, "", format, true)?;
    let creation = Creation {
        target,
        file_kind,
        format: format.to_owned(),
        target_existed,
        design_context,
    };
    let overwrite = args.get("overwrite") == Some(&Value::Bool(true));
    release_overwritten_session(env, tools.closer, &creation.target, overwrite).await?;
    let created = |handle: SessionHandle, operations: Vec<Value>| Created {
        session: OpenedSession::fresh(handle),
        operations,
    };
    if format == "pdf" {
        assert_create_target_available(&creation.target, target_existed, overwrite)?;
        return Ok(created(
            create_pdf_session(env, tools, &creation, args)?,
            operations,
        ));
    }
    if !FORMATS.contains(&format) {
        return Err(
            "Office create currently supports Word, Excel, PowerPoint, CSV, and TSV files"
                .to_owned(),
        );
    }
    assert_create_target_available(&creation.target, target_existed, overwrite)?;
    if let Some(existing) = env.registry.for_document(env.design.env, &creation.target) {
        return Ok(Created {
            session: OpenedSession::reused(existing),
            operations,
        });
    }
    if is_tabular_format(format) {
        return Ok(created(create_tabular_session(env, &creation)?, operations));
    }
    let mode = requested_mode(args.get("mode"));
    if mode == "attach" || mode == "live" {
        return Err("Office create requires visible, background, or portable mode".to_owned());
    }
    let selected = select_mode(
        env.host,
        Some(&Value::String(mode)),
        format,
        &creation.target,
    )
    .await?;
    assert_office_operation_contracts(format, selected.backend.as_str(), &mut operations)?;
    if selected.backend == Backend::MixdogOoxml {
        return Ok(created(
            create_portable_ooxml_session(env, &creation)?,
            operations,
        ));
    }
    Ok(created(
        create_microsoft_office_session(env, &creation, args, selected.mode).await?,
        operations,
    ))
}

/// `createAuthoredSession(args, cwd, dataDir, target)`: a deck written by an authoring script already exists on disk; the session
/// owns that file in place so render, critique, and finalize treat it like a created deliverable while the design gates know a
/// script, not the composer, decided the layout.
pub async fn create_authored_session<P: WriteProof, H: OfficeHost>(
    env: &SessionEnv<'_, P, H>,
    args: &Value,
    target: &str,
) -> Result<SessionHandle, String> {
    let file_kind = document_file_kind(target)?;
    let format = document_format(target)?;
    if !["pptx", "docx", "xlsx"].contains(&format) {
        return Err("author writes PowerPoint, Word, Excel, and PDF targets only".to_owned());
    }
    let requested = validate_author_mode(args.get("mode"))?;
    let selected = select_mode(env.host, Some(&Value::String(requested)), format, target).await?;
    let mut context =
        resolve_office_design_context(env.design, env.data_dir, args, target, "", format, true)?;
    // The script's brief owns the background plan and the slide roles; the composer's deck plan (sandwich/dark/light) would only
    // contradict it.
    if let Value::Object(design) = &mut context.design {
        let mut deck = match design.get("deck") {
            Some(Value::Object(deck)) => deck.clone(),
            _ => Map::new(),
        };
        deck.insert("backgroundMode".to_owned(), Value::from("custom"));
        deck.insert("enforce".to_owned(), Value::Bool(false));
        design.insert("deck".to_owned(), Value::Object(deck));
    }
    let design_state = DesignState::empty(
        context
            .design
            .pointer("/review/required")
            .is_some_and(truthy),
        true,
    );
    let mut session = build_session(
        env,
        Record {
            id: office_session_id(),
            source: target.to_owned(),
            target: target.to_owned(),
            file_kind: file_kind.clone(),
            format: format.to_owned(),
            mode: selected.mode,
            backend: selected.backend,
            created: true,
            created_new_file: None,
            design_context: context,
            design_state,
        },
    );
    session.authored.authored = true;
    mark_owned(&mut session);
    if selected.backend == Backend::MicrosoftOfficeCom {
        attach_microsoft_office(env.host, &mut session, Some(&file_kind), env.cancel).await?;
    }
    Ok(env.registry.register(env.design, session))
}

/// The file half of `discardFailedOfficeSession`: a create whose own operations failed must not leave the empty file it just
/// wrote (the obvious retry would hit "target already exists" and the caller would be stuck choosing between overwrite and
/// delete). Only a file this call brought into being is removed; a session that was reused, or whose initial edit settled, keeps
/// its file.
pub fn remove_failed_create<P: mixdog_fsio::WriteProof>(
    proof: &P,
    created: &OpenedSession,
    initial_edit_settled: bool,
) {
    if created.reused || initial_edit_settled {
        return;
    }
    let (brought_into_being, target) = {
        let session = lock(&created.handle);
        (
            session.created && session.created_new_file == Some(true),
            session.target.clone(),
        )
    };
    if brought_into_being {
        // `rm(target, { force: true })`: a file that is already gone, or cannot be removed, is not an error.
        let _ = mixdog_fsio::remove_file(proof, &target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_in_a_field_the_format_never_writes_is_refused_with_the_field_that_does() {
        let word = json!({ "blocks": [{ "type": "heading" }] });
        assert_eq!(
            assert_create_content_fields("docx", &word),
            Err("DOCX create writes operations, not blocks: pass operations:[{ op: … }]. blocks is the PDF create field.".to_owned())
        );
        let pdf = json!({ "operations": [{ "op": "x" }] });
        assert!(
            assert_create_content_fields("pdf", &pdf)
                .expect_err("refused")
                .starts_with("PDF create writes blocks, not operations")
        );
        assert_eq!(
            assert_create_content_fields("xlsx", &json!({ "operations": [] })),
            Ok(())
        );
    }

    #[test]
    fn every_fault_of_a_request_is_said_at_once() {
        let args = json!({ "blocks": [1], "values": [[1]], "script": " x ", "design": { "content": { "facts": ["a"] } } });
        let error = assert_create_content_fields("pptx", &args).expect_err("refused");
        assert!(error.starts_with("This create request breaks 4 input contracts; fix them together. PPTX create writes operations, not blocks"));
        assert!(error.contains(" PPTX create takes no top-level values: pass operations:[{ op: 'set_range', range: 'A1:B2', values: [[…]] }]. "));
        assert!(error.contains(" PPTX create takes no script. A deck written from a script uses action:'author' with script. "));
        assert!(error.ends_with("add slides here with operations:[{ op: 'add_slide' }, …]."));
    }

    #[test]
    fn facts_with_nothing_to_write_them_are_refused_per_format() {
        let args = json!({ "design": { "content": { "objective": "  sell more  " } } });
        assert!(
            assert_create_content_fields("docx", &args)
                .expect_err("refused")
                .ends_with("append_text/add_table operations that write it.")
        );
        assert!(
            assert_create_content_fields("csv", &args)
                .expect_err("refused")
                .ends_with("pass the operations that write it.")
        );
        let writes = json!({ "operations": [{ "op": "append_text" }], "design": { "content": { "objective": "x" } } });
        assert_eq!(assert_create_content_fields("docx", &writes), Ok(()));
        assert_eq!(
            assert_create_content_fields(
                "docx",
                &json!({ "design": { "content": { "objective": "  " } } })
            ),
            Ok(())
        );
    }

    #[test]
    fn the_initial_operations_come_from_the_call_or_its_design() {
        assert_eq!(
            initial_office_operations(
                &json!({ "operations": [1], "design": { "operations": [2] } })
            ),
            vec![json!(1)]
        );
        assert_eq!(
            initial_office_operations(
                &json!({ "operations": [], "design": { "operations": [2] } })
            ),
            vec![json!(2)]
        );
        assert!(initial_office_operations(&json!({ "design": { "operations": "x" } })).is_empty());
    }

    #[test]
    fn the_rest_of_create_reads_the_operations_the_contract_engine_rewrote() {
        let rewritten = [json!({ "op": "compose_document" })];
        let direct = json!({ "operations": [{ "op": " compose_document " }], "design": { "operations": [1] } });
        assert_eq!(
            *with_rewritten_operations(&direct, &rewritten),
            json!({ "operations": [{ "op": "compose_document" }], "design": { "operations": [1] } })
        );
        let designed = json!({ "operations": [], "design": { "operations": [{ "op": " compose_document " }] } });
        assert_eq!(
            *with_rewritten_operations(&designed, &rewritten),
            json!({ "operations": [], "design": { "operations": [{ "op": "compose_document" }] } })
        );
        let unchanged = json!({ "operations": [{ "op": "compose_document" }] });
        assert!(matches!(with_rewritten_operations(&unchanged, &rewritten), Cow::Borrowed(_)));
        assert!(matches!(with_rewritten_operations(&json!({}), &[]), Cow::Borrowed(_)));
    }

    #[test]
    fn a_target_that_exists_is_refused_unless_it_is_overwritten() {
        assert_eq!(
            assert_create_target_available("a.docx", true, false),
            Err("Office create target already exists: a.docx".to_owned())
        );
        assert_eq!(assert_create_target_available("a.docx", true, true), Ok(()));
        assert_eq!(
            assert_create_target_available("a.docx", false, false),
            Ok(())
        );
    }
}
