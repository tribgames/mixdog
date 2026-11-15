//! `office.run` (`officeRun`, `emitBlob` and `closeOfficeSessions` of `src/ext-host/methods.mjs`): one call of the Office tool,
//! served by the Office engine of this process.
//!
//! The call carries `{args, cwd, dataDir}`. `args.path` and `args.output` are refused unless the approved paths cover them (the
//! worker's path guard, the exact approved path substituted for the text that was given), the engine runs the call inside a write
//! ledger, and the files the call changed go back as receipts: for each change, in order, the bytes before and then the bytes after
//! follow as chunks, and the answer is `{result, writes}` with each side `null` (the file was absent), `{bytes: n}` (its chunk
//! was sent) or `{uncaptured: true, size, reason?}` (the file changed but its bytes were not captured: no undo).
//!
//! Sessions live in the engine of this process, so the thread that owns one keeps coming back to this worker: the answer pins the
//! thread while it owns a live session. The worker's end gives every Microsoft Office session host its cleanup (closing its
//! document and quitting the application it owns) and waits for it, so no application is left running with its file open.
//!
//! The platform below is what this process supplies to the engine: the lanes, the Office transport, the system fonts, the design
//! library's folders and network, the schema validator, the shared render browser ([`super::office_browser`]) and the machine of a
//! batch (the PDF operation set, a Word chart drawn as a picture, the brief readings).

use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_fsio::Unlaned;
use mixdog_js::js_trim;
use mixdog_office::batch::BatchHost;
use mixdog_office::engine::Engine;
use mixdog_office::engine::Platform;
use mixdog_office_base::data_dir::default_office_data_dir;
use mixdog_office_base::ledger::CallLedger;
use mixdog_office_base::ledger::ChangeSide;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_com::OfficeCom;
use mixdog_office_com::OfficeComConfig;
use mixdog_office_design::library::Environment as DesignEnvironment;
use mixdog_office_design::library::Fetch;
use mixdog_office_design::library::HttpsFetch;
use mixdog_office_design::library::TemplateIndexer;
use mixdog_office_design::templates::OfficeTemplateIndexer;
use mixdog_office_pdf::OcrContext;
use mixdog_office_pdf::RenderPagesOptions;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_pdf::render_pdf_pages;
use mixdog_office_pdf::writer::create_chart_pdf;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;
use serde_json::json;
use tokio::sync::OnceCell;

use super::office_browser::CallBrowser;
use super::pdf_render::fonts;
use super::pdf_render::lanes;
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::HandlerResult;
use crate::registry::Outcome;
use crate::registry::Registry;

pub(super) fn register(registry: &mut Registry) {
    registry.register("office.run", office_run);
    // The worker's end: `closeOfficeSessions`. A process that never ran an Office call has nothing to give back.
    registry.on_exit(|| async {
        if let Some(office) = OFFICE.get() {
            office.engine.shutdown().await;
        }
    });
}

// ---- the platform of the engine -------------------------------------------------------------------------------------------

/// The brief parser and readings of the authoring crate.
struct AuthoringBriefs;

impl BriefReadings for AuthoringBriefs {
    fn html_brief_script(&self, html: &str) -> String {
        mixdog_office_author::brief::html_brief_script(html)
    }

    fn parse_authoring_brief(&self, script: &str) -> Value {
        mixdog_office_author::brief::parse_authoring_brief(script)
    }

    fn review_fact_coverage(&self, document: &Value, brief: &Value) -> Vec<Value> {
        mixdog_office_author::brief::review_fact_coverage(document, brief)
    }

    fn review_source_grounding(&self, brief: &Value) -> Vec<Value> {
        mixdog_office_author::brief::review_source_grounding(brief)
    }
}

/// The machine of a batch: the PDF operation set, a Word chart drawn into a PDF and its first page rasterised three pixels a
/// point, and the brief readings.
struct Machine {
    lanes: LaneTokens,
    fonts: Arc<FontRegistry>,
    font_env: FontEnv,
    svg_fonts: SvgFonts,
}

impl BatchHost for Machine {
    fn pdf_operations(&self, data_dir: &Path, cancel: Option<CancellationToken>) -> ContentOperations {
        let ocr = OcrContext::new(self.lanes, Arc::clone(&self.fonts), Arc::new(NoWriteNote), data_dir);
        ContentOperations::new(self.font_env.clone(), self.svg_fonts.clone(), Some(ocr), cancel)
    }

    fn chart_picture(&self, block: &Value, width: f64, pdf: &Path) -> impl Future<Output = Result<String, String>> {
        let (block, pdf, lanes, fonts, font_env) = (block.clone(), pdf.to_path_buf(), self.lanes, Arc::clone(&self.fonts), self.font_env.clone());
        async move {
            create_chart_pdf(&Unlaned, &font_env, &pdf.to_string_lossy(), &block, width, None).map_err(|error| error.to_string())?;
            let note: Arc<dyn WriteNote> = Arc::new(NoWriteNote);
            let options = RenderPagesOptions { pages: Some(vec![1.0]), max_width: (width * 3.0).round(), maximum_scale: 3.0, cancel: None, write_images: true };
            let rendered = render_pdf_pages(lanes, fonts, note, &pdf, options).await.map_err(|error| error.to_string())?;
            rendered.images.first().map(|image| image.path().to_owned()).ok_or_else(|| "the chart rendered no page".to_owned())
        }
    }

    fn brief_readings(&self) -> &dyn BriefReadings {
        &AuthoringBriefs
    }
}

/// What this process supplies to the engine.
struct WorkerPlatform {
    lanes: LaneTokens,
    office: OfficeCom,
    fonts: Arc<FontRegistry>,
    font_env: FontEnv,
    svg_fonts: SvgFonts,
    environment: DesignEnvironment,
    validator: ValidatorEnvironment,
    machine: Machine,
    browser: Arc<CallBrowser>,
}

impl Platform for WorkerPlatform {
    type Batch = Machine;

    fn lanes(&self) -> LaneTokens {
        self.lanes
    }

    fn office(&self) -> &OfficeCom {
        &self.office
    }

    fn fonts(&self) -> Arc<FontRegistry> {
        Arc::clone(&self.fonts)
    }

    fn font_env(&self) -> &FontEnv {
        &self.font_env
    }

    fn svg_fonts(&self) -> &SvgFonts {
        &self.svg_fonts
    }

    fn endpoint(&self) -> &dyn BrowserEndpoint {
        self.browser.as_ref()
    }

    fn design_environment(&self) -> &DesignEnvironment {
        &self.environment
    }

    fn fetch(&self) -> &dyn Fetch {
        &HttpsFetch
    }

    fn indexer(&self) -> &dyn TemplateIndexer<MaintenanceIo> {
        &OfficeTemplateIndexer
    }

    fn validator(&self) -> &ValidatorEnvironment {
        &self.validator
    }

    fn batch_host(&self) -> &Machine {
        &self.machine
    }
}

/// The engine of this process and the browser endpoint its platform leases through.
struct Office {
    engine: Arc<Engine<WorkerPlatform>>,
    browser: Arc<CallBrowser>,
}

static OFFICE: OnceCell<Office> = OnceCell::const_new();

/// The engine of this process, made on the first call (the system's fonts are scanned once, and the Office transport keeps its
/// scripts under the Office data folder), so a worker that is only asked about a PDF starts as fast as before.
async fn office(cancel: &CancellationToken) -> Result<&'static Office, CodedError> {
    OFFICE
        .get_or_try_init(|| async {
            let lanes = lanes()?;
            let fonts = fonts(lanes, cancel).await?;
            let lost = |error: String| {
                if cancel.is_cancelled() { CodedError::cancelled() } else { CodedError::failed(format!("the font scan failed: {error}")) }
            };
            let faces = Arc::clone(&fonts);
            let svg = lanes
                .interactive_io
                .submit_wait(cancel, move |lane| SvgFonts::from_registry(lane, &faces))
                .await
                .map_err(|error| lost(error.to_string()))?;
            let svg_fonts = svg.await.map_err(|error| lost(error.to_string()))?;
            let data_dir = default_office_data_dir().unwrap_or_else(|_| std::env::temp_dir());
            let font_env = FontEnv::host();
            let browser = Arc::new(CallBrowser::default());
            let platform = WorkerPlatform {
                lanes,
                office: OfficeCom::new(OfficeComConfig::new(data_dir, lanes)),
                fonts: Arc::clone(&fonts),
                font_env: font_env.clone(),
                svg_fonts: svg_fonts.clone(),
                environment: DesignEnvironment::process(),
                validator: ValidatorEnvironment::from_process(),
                machine: Machine { lanes, fonts, font_env, svg_fonts },
                browser: Arc::clone(&browser),
            };
            Ok(Office { engine: Engine::new(platform), browser })
        })
        .await
}

// ---- the call -------------------------------------------------------------------------------------------------------------

/// Execution gets the exact path that was approved, not the text that was given: `args.path` and `args.output`, each a string with
/// something in it, are replaced by what `approve` makes of them against `cwd`.
fn substitute_approved(args: &mut Value, cwd: &str, approve: impl Fn(&str, &str) -> Result<PathBuf, CodedError>) -> Result<(), CodedError> {
    let Some(map) = args.as_object_mut() else { return Ok(()) };
    for key in ["path", "output"] {
        let Some(Value::String(given)) = map.get(key) else { continue };
        if js_trim(given).is_empty() {
            continue;
        }
        let approved = approve(given, cwd)?;
        map.insert(key.to_owned(), Value::String(approved.to_string_lossy().into_owned()));
    }
    Ok(())
}

/// The receipt of a side whose bytes were not captured.
fn uncaptured_receipt(size: u64, reason: Option<&str>) -> Value {
    let mut receipt = json!({"uncaptured": true, "size": size});
    if let Some(reason) = reason {
        receipt["reason"] = json!(reason);
    }
    receipt
}

/// `emitBlob`: one side of a change, its bytes sent as chunks.
async fn emit_side(ctx: &CallCtx, side: &ChangeSide) -> Result<Value, CodedError> {
    match side {
        ChangeSide::Absent => Ok(Value::Null),
        ChangeSide::Bytes(bytes) => {
            ctx.emit(bytes).await?;
            Ok(json!({"bytes": bytes.len()}))
        }
        ChangeSide::Uncaptured { size, reason } => Ok(uncaptured_receipt(*size, reason.as_deref())),
    }
}

fn text_param<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or_default()
}

async fn office_run(ctx: CallCtx) -> HandlerResult {
    let ctx = Arc::new(ctx);
    let cwd = text_param(&ctx.params, "cwd").to_owned();
    let data_dir = Some(PathBuf::from(text_param(&ctx.params, "dataDir"))).filter(|folder| !folder.as_os_str().is_empty());
    let mut args = ctx.params.get("args").cloned().unwrap_or_else(|| json!({}));
    substitute_approved(&mut args, &cwd, |path, base| ctx.approved_path(path, base))?;
    let ledger = CallLedger::new(Path::new(&cwd), data_dir.as_deref().unwrap_or(Path::new(""))).map_err(|error| CodedError::failed(error.to_string()))?;
    let office = office(&ctx.cancel).await?;
    let known = office.engine.known_sessions();
    let (result, changes) = {
        let _serving = office.browser.serve(Arc::clone(&ctx));
        office.engine.execute(args, PathBuf::from(&cwd), data_dir, Some(Arc::new(ledger)), ctx.cancel.clone()).await
    };
    let pinned = office.engine.finish_call(&ctx.thread, &known);
    // The files the call wrote go back to the core as receipts: before and after bytes follow as chunks in this order (before,
    // then after, per change), so the core's turn review can offer undo.
    let mut writes = Vec::with_capacity(changes.len());
    for change in &changes {
        let before = emit_side(&ctx, &change.before).await?;
        let after = emit_side(&ctx, &change.after).await?;
        writes.push(json!({"path": change.path.to_string_lossy(), "before": before, "after": after}));
    }
    let value = json!({"result": result, "writes": writes});
    Ok(if pinned { Outcome::pinned(value) } else { Outcome::value(value) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pathguard;

    fn refuse_all(_path: &str, _base: &str) -> Result<PathBuf, CodedError> {
        Err(CodedError::new("path_not_approved", "no"))
    }

    #[test]
    fn the_approved_path_replaces_the_given_text_of_path_and_output() {
        let mut args = json!({"action": "create", "path": " a.docx ", "output": "b.pdf", "format": "docx"});
        substitute_approved(&mut args, "/work", |path, base| Ok(PathBuf::from(format!("{base}/{}", path.trim())))).unwrap();
        assert_eq!(args["path"], "/work/a.docx");
        assert_eq!(args["output"], "/work/b.pdf");
        assert_eq!(args["format"], "docx");
    }

    #[test]
    fn a_blank_or_absent_or_non_text_path_is_left_alone_and_never_asked_about() {
        for mut args in [json!({"path": "   "}), json!({"path": ""}), json!({"path": 3}), json!({"output": null}), json!({}), json!([1]), Value::Null] {
            let before = args.clone();
            substitute_approved(&mut args, "/work", refuse_all).unwrap();
            assert_eq!(args, before);
        }
    }

    #[test]
    fn a_path_outside_the_approved_set_refuses_the_call() {
        let mut args = json!({"path": "x.docx"});
        let error = substitute_approved(&mut args, "/work", refuse_all).unwrap_err();
        assert_eq!(error.code, "path_not_approved");
    }

    #[test]
    fn the_worker_guard_refuses_a_relative_path_without_a_folder() {
        let approved = vec![std::env::temp_dir().to_string_lossy().into_owned()];
        let mut args = json!({"path": "x.docx"});
        let error = substitute_approved(&mut args, "", |path, base| pathguard::approved_path(&approved, path, base)).unwrap_err();
        assert_eq!(error.code, "path_not_approved");
    }

    #[test]
    fn an_uncaptured_side_carries_its_size_and_reason_when_there_is_one() {
        assert_eq!(uncaptured_receipt(9, Some("binary")), json!({"uncaptured": true, "size": 9, "reason": "binary"}));
        assert_eq!(uncaptured_receipt(9, None), json!({"uncaptured": true, "size": 9}));
    }

    #[test]
    fn a_text_parameter_that_is_not_text_is_empty() {
        let params = json!({"cwd": "/w", "dataDir": 3});
        assert_eq!(text_param(&params, "cwd"), "/w");
        assert_eq!(text_param(&params, "dataDir"), "");
        assert_eq!(text_param(&params, "missing"), "");
    }
}
