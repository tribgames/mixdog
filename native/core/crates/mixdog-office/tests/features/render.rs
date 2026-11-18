//! The render preview: what is exported, drawn and reused, and when a held preview or its approval stops being valid.


use std::cell::{Cell, RefCell};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::json_number;
use mixdog_office::render::page_cache::{PageSignature, pptx_page_signatures};
use mixdog_office::render::preview::{PreviewOptions, View, cached_office_preview, render_office_preview};
use mixdog_office::render::{RenderEngine, recalculate_for_review, render};
use mixdog_office::session::registry::lock;
use mixdog_office::session::{Backend, DesignState, Mode, Session, SessionHandle, SessionInit};
use mixdog_office_author::review_artifacts::Receipts;
use mixdog_office_base::write_note::{NoWriteNote, WriteNote};
use mixdog_ooxml::package::{load_package, save_package};
use mixdog_ooxml::zipio::Package;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

/// An engine that draws nothing: it counts what a render asks of it and writes stand-in files.
struct Fake {
    fonts: Registry,
    page_count: usize,
    exports: Cell<usize>,
    rasters: RefCell<Vec<Option<Vec<f64>>>>,
    fail_export: Cell<bool>,
    fail_raster: Cell<bool>,
    fill: Cell<u32>,
    recalculations: Cell<usize>,
    recalculation: RefCell<Value>,
    refits: RefCell<Vec<Vec<Value>>>,
}

impl Fake {
    fn new(page_count: usize) -> Self {
        Self {
            fonts: Registry::new(),
            page_count,
            exports: Cell::new(0),
            rasters: RefCell::new(Vec::new()),
            fail_export: Cell::new(false),
            fail_raster: Cell::new(false),
            fill: Cell::new(0),
            recalculations: Cell::new(0),
            recalculation: RefCell::new(json!({ "needed": false })),
            refits: RefCell::new(Vec::new()),
        }
    }
}

impl RenderEngine for Fake {
    fn note(&self) -> &dyn WriteNote {
        &NoWriteNote
    }

    fn fonts(&self) -> &Registry {
        &self.fonts
    }

    async fn exists(&self, path: &Path) -> bool {
        mixdog_fsio::exists(&Unlaned, path).unwrap_or(false)
    }

    async fn make_directory(&self, directory: &Path) -> Result<(), String> {
        mixdog_fsio::create_dir_all(&Unlaned, directory).map_err(|error| error.to_string())
    }

    async fn page_signatures(&self, target: &Path) -> Result<Vec<PageSignature>, String> {
        pptx_page_signatures(&Unlaned, target)
    }

    async fn export_document(&self, _session: &View, output: &Path) -> Result<(), String> {
        if self.fail_export.get() {
            return Err("export failed".to_owned());
        }
        self.exports.set(self.exports.get() + 1);
        mixdog_fsio::write(&Unlaned, output, "export").map_err(|error| error.to_string())
    }

    async fn rasterize(&self, output: &Path, pages: Option<&[f64]>, _max_width: f64, _cancel: Option<CancellationToken>) -> Result<Value, String> {
        self.rasters.borrow_mut().push(pages.map(<[f64]>::to_vec));
        if self.fail_raster.get() {
            return Err("raster failed".to_owned());
        }
        let wanted: Vec<f64> = pages.map_or_else(|| (1..=self.page_count).map(|page| page as f64).collect(), <[f64]>::to_vec);
        let mut images = Vec::new();
        for page in &wanted {
            let path = format!("{}-{}.png", output.display(), page);
            let data = format!("pixels-p{page}-f{}", self.fill.get());
            mixdog_fsio::write(&Unlaned, &path, &data).map_err(|error| error.to_string())?;
            images.push(json!({ "page": json_number(*page), "path": path, "width": 800, "height": 450, "mimeType": "image/png", "data": data }));
        }
        Ok(json!({
            "pageCount": self.page_count,
            "images": images,
            "visualCoverage": {
                "complete": wanted.len() == self.page_count,
                "reviewedPages": wanted.iter().map(|page| json_number(*page)).collect::<Vec<_>>(),
                "reviewed": wanted.len(),
                "total": self.page_count,
            },
        }))
    }

    async fn recalculate_workbook(&self, _target: &Path, _force: bool, _cancel: Option<CancellationToken>) -> Result<Value, String> {
        self.recalculations.set(self.recalculations.get() + 1);
        Ok(self.recalculation.borrow().clone())
    }

    async fn refit_columns(&self, _target: &Path, operations: &[Value]) -> Result<Vec<Value>, String> {
        self.refits.borrow_mut().push(operations.to_vec());
        Ok(vec![json!({ "columns": 2 }), json!({ "columns": 1 })])
    }
}

struct NoReceipts;

impl Receipts for NoReceipts {
    fn composition_receipt(&self) -> Option<Value> {
        None
    }

    fn attach_rendered_air(&self, _receipt: &mut Value, _images: &[Value]) {}

    fn for_delivery(&self, receipt: Value) -> Value {
        receipt
    }
}

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().build().expect("runtime").block_on(future)
}

fn session(format: &str, backend: Backend, mode: Mode, target: &Path) -> SessionHandle {
    let target = target.to_string_lossy().into_owned();
    let mut session = Session::new(SessionInit {
        id: "preview".to_owned(),
        source: target.clone(),
        target,
        file_kind: format.to_owned(),
        format: format.to_owned(),
        mode,
        backend,
        opened_at: String::new(),
        data_dir: PathBuf::new(),
        created: false,
        created_new_file: None,
        design_state: DesignState::default(),
    });
    session.com.ownership = Some("owned".to_owned());
    session.com.visible = Some(false);
    Arc::new(Mutex::new(session))
}

/// A session of the Microsoft Office backend, held in the background.
fn office_session(format: &str, target: &Path) -> SessionHandle {
    session(format, Backend::MicrosoftOfficeCom, Mode::Background, target)
}

fn draw(engine: &Fake, handle: &SessionHandle, args: Value, cwd: &Path) -> Result<Value, String> {
    run(render_office_preview(engine, handle, &args, cwd, PreviewOptions::default()))
}

fn reuse(engine: &Fake, handle: &SessionHandle, args: Value, cwd: &Path) -> Result<Option<Value>, String> {
    run(cached_office_preview(engine, handle, &args, cwd, true))
}

fn pages_of(result: &Value) -> Vec<Value> {
    result["_images"].as_array().expect("images").iter().map(|image| image["page"].clone()).collect()
}

/// A package of the named parts.
fn package_of(parts: impl IntoIterator<Item = (String, String)>) -> Package {
    let mut zip = Package::new();
    for (name, text) in parts {
        zip.set(&name, text);
    }
    zip
}

/// A deck of one slide per text, its parts the way a package lists them.
fn deck(texts: &[&str]) -> Package {
    let relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    let (mut ids, mut rels) = (String::new(), String::new());
    let mut parts: Vec<(String, String)> = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        let number = index + 1;
        ids.push_str(&format!("<p:sldId id=\"{}\" r:id=\"rId{number}\"/>", 255 + number));
        rels.push_str(&format!("<Relationship Id=\"rId{number}\" Type=\"{relationships}/slide\" Target=\"slides/slide{number}.xml\"/>"));
        parts.push((format!("ppt/slides/slide{number}.xml"), format!("<p:sld><p:txBody>{text}</p:txBody></p:sld>")));
        parts.push((
            format!("ppt/slides/_rels/slide{number}.xml.rels"),
            format!("<Relationships><Relationship Id=\"rId1\" Type=\"{relationships}/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/></Relationships>"),
        ));
    }
    parts.push(("ppt/presentation.xml".to_owned(), format!("<p:presentation xmlns:r=\"{relationships}\"><p:sldIdLst>{ids}</p:sldIdLst></p:presentation>")));
    parts.push(("ppt/_rels/presentation.xml.rels".to_owned(), format!("<Relationships>{rels}</Relationships>")));
    parts.push(("ppt/theme/theme1.xml".to_owned(), "<a:theme name=\"Office\"/>".to_owned()));
    package_of(parts)
}

fn write_deck(path: &Path, zip: &Package) {
    save_package(&Unlaned, &NoWriteNote, zip, path).expect("write the deck");
}

fn edit_part(path: &Path, part: &str, change: impl FnOnce(String) -> String) {
    let mut zip = load_package(&Unlaned, path).expect("read the deck");
    let next = change(zip.text(part));
    zip.set(part, next);
    write_deck(path, &zip);
}

#[test]
fn complete_custom_preview_is_reused_without_exporting_and_caller_edits_do_not_contaminate_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(2), office_session("pptx", &dir.path().join("deck.pptx")));
    let mut first = draw(&engine, &handle, json!({ "output": "chosen.pdf", "maxWidth": 1600 }), dir.path()).expect("first");
    let token = first["reviewToken"].clone();
    first["_images"][0]["page"] = json!(99);
    first["visualCoverage"]["complete"] = json!(false);
    let reused = run(render_office_preview(&engine, &handle, &json!({}), dir.path(), PreviewOptions { reuse_latest: true })).expect("reused");
    assert_eq!(reused["reused"], json!(true));
    assert_eq!(reused["output"], json!(dir.path().join("chosen.pdf").to_string_lossy().into_owned()));
    assert_eq!(reused["reviewToken"], token);
    assert_eq!(pages_of(&reused), [json!(1), json!(2)]);
    assert_eq!(reused["visualCoverage"]["complete"], json!(true));
    assert_eq!((engine.exports.get(), engine.rasters.borrow().len()), (1, 1));
    assert!(reuse(&engine, &handle, json!({ "maxWidth": 800 }), dir.path()).expect("width").is_none());
    assert!(reuse(&engine, &handle, json!({ "output": "other.pdf" }), dir.path()).expect("output").is_none());
}

#[test]
fn persisted_images_remain_usable_without_the_intermediate_pdf_but_missing_images_require_refresh() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(2), office_session("pptx", &dir.path().join("deck.pptx")));
    let first = draw(&engine, &handle, json!({}), dir.path()).expect("first");
    mixdog_fsio::remove_file(&Unlaned, first["output"].as_str().expect("output")).expect("remove the pdf");
    let cached = draw(&engine, &handle, json!({}), dir.path()).expect("cached");
    assert_eq!((cached["reused"].clone(), cached["exportAvailable"].clone()), (json!(true), json!(false)));
    assert_eq!((engine.exports.get(), engine.rasters.borrow().len()), (1, 1));
    mixdog_fsio::remove_file(&Unlaned, first["_images"][0]["path"].as_str().expect("path")).expect("remove an image");
    let refreshed = draw(&engine, &handle, json!({}), dir.path()).expect("refreshed");
    assert_eq!(refreshed["exportAvailable"], json!(true));
    assert_eq!(refreshed["reviewToken"], first["reviewToken"], "identical restored pixels preserve the review identity");
    assert_eq!((engine.exports.get(), engine.rasters.borrow().len()), (2, 2));
}

#[test]
fn changed_documents_and_partial_previews_cannot_reuse_complete_deck_approval() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(2), office_session("pptx", &dir.path().join("deck.pptx")));
    let first = draw(&engine, &handle, json!({}), dir.path()).expect("first");
    lock(&handle).snapshot_version += 1;
    assert!(reuse(&engine, &handle, json!({}), dir.path()).expect("after an edit").is_none());
    let partial = draw(&engine, &handle, json!({ "pages": [2] }), dir.path()).expect("partial");
    assert_ne!(partial["reviewToken"], first["reviewToken"]);
    assert_eq!(partial["visualCoverage"]["complete"], json!(false));
    assert!(reuse(&engine, &handle, json!({}), dir.path()).expect("after a partial").is_none());
}

#[test]
fn a_failed_refresh_does_not_retain_approval() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(2), office_session("pptx", &dir.path().join("deck.pptx")));
    draw(&engine, &handle, json!({}), dir.path()).expect("first");
    assert!(lock(&handle).design_state.rendered_version.is_number());
    engine.fail_export.set(true);
    let failed = draw(&engine, &handle, json!({ "maxWidth": 700 }), dir.path());
    assert_eq!(failed.expect_err("the export fails"), "export failed");
    {
        let session = lock(&handle);
        assert_eq!(session.design_state.rendered_version, Value::Null);
        assert_eq!(session.design_state.review_token, Some(json!("")));
        assert!(session.caches.render.is_none());
    }
    assert!(reuse(&engine, &handle, json!({}), dir.path()).expect("after a failure").is_none());
}

#[test]
fn visible_and_attached_documents_refresh_instead_of_using_owned_session_caches() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(2), office_session("pptx", &dir.path().join("deck.pptx")));
    let changes: [&dyn Fn(&mut Session); 3] = [
        &|session: &mut Session| session.com.visible = Some(true),
        &|session: &mut Session| {
            session.com.ownership = Some("attached".to_owned());
            session.com.visible = Some(false);
        },
        &|session: &mut Session| {
            session.com.ownership = Some("owned".to_owned());
            session.mode = Mode::Attach;
        },
    ];
    for change in changes {
        change(&mut lock(&handle));
        let first = draw(&engine, &handle, json!({}), dir.path()).expect("first");
        let second = draw(&engine, &handle, json!({}), dir.path()).expect("second");
        assert_eq!(second["reviewToken"], first["reviewToken"], "unchanged visible pixels can still be finalized");
        assert!(second.get("reused").is_none());
    }
    assert_eq!((engine.exports.get(), engine.rasters.borrow().len()), (6, 6));
    let previous = lock(&handle).design_state.review_token.clone();
    engine.fill.set(1);
    let changed = draw(&engine, &handle, json!({}), dir.path()).expect("changed");
    assert_ne!(Some(changed["reviewToken"].clone()), previous, "external visual changes invalidate approval without a batch revision");
}

#[test]
fn cancelled_reads_do_not_hand_back_cached_visual_evidence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(2), office_session("pptx", &dir.path().join("deck.pptx")));
    draw(&engine, &handle, json!({}), dir.path()).expect("first");
    let signal = CancellationToken::new();
    signal.cancel();
    lock(&handle).active_signal = Some(signal);
    assert_eq!(draw(&engine, &handle, json!({}), dir.path()).expect_err("aborted"), "This operation was aborted");
}

// ---- incremental decks ----

// The edit is made to the package here, as a batch would make it.
#[test]
fn one_slide_edit_rasterizes_only_its_page_and_a_detail_read_restores_complete_coverage_without_another_export() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("incremental.pptx");
    write_deck(&target, &deck(&["Revenue", "Growth", "Spending"]));
    let (engine, handle) = (Fake::new(3), session("pptx", Backend::MixdogOoxml, Mode::Portable, &target));
    let first = draw(&engine, &handle, json!({}), dir.path()).expect("first");
    assert_eq!(first["changedPages"], json!([1, 2, 3]));
    edit_part(&target, "ppt/slides/slide2.xml", |xml| xml.replace("Growth", "Updated growth"));
    lock(&handle).snapshot_version += 1;
    engine.fill.set(1);
    let changed = draw(&engine, &handle, json!({ "pages": [2] }), dir.path()).expect("changed");
    assert_eq!(changed["changedPages"], json!([2]));
    assert_eq!(changed["visualCoverage"]["complete"], json!(false));
    assert_eq!(changed["pageIdentities"], json!([{ "page": 2, "slideId": 257 }]));
    let full = draw(&engine, &handle, json!({}), dir.path()).expect("full");
    assert_eq!((full["changedPages"].clone(), full["reusedPages"].clone()), (json!([]), json!([1, 2, 3])));
    assert_eq!(full["visualCoverage"]["complete"], json!(true));
    assert_ne!(full["reviewToken"], first["reviewToken"]);
    assert_eq!(full["_images"][0]["data"], first["_images"][0]["data"]);
    assert_eq!(full["_images"][1]["data"], json!("pixels-p2-f1"));
    assert_eq!(*engine.rasters.borrow(), [Some(vec![1.0, 2.0, 3.0]), Some(vec![2.0])]);
    assert_eq!(engine.exports.get(), 2);
}

#[test]
fn a_copy_edited_in_part_draws_only_the_pages_that_changed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("copy.pptx");
    write_deck(&target, &deck(&["Revenue", "Growth", "Spending"]));
    let (engine, handle) = (Fake::new(3), session("pptx", Backend::MixdogOoxml, Mode::Portable, &target));
    assert_eq!(lock(&handle).com.ownership.as_deref(), Some("owned"));
    draw(&engine, &handle, json!({}), dir.path()).expect("first");
    edit_part(&target, "ppt/slides/slide2.xml", |xml| xml.replace("Growth", "Changed copy only"));
    lock(&handle).snapshot_version += 1;
    let rendered = draw(&engine, &handle, json!({}), dir.path()).expect("rendered");
    assert_eq!((rendered["changedPages"].clone(), rendered["reusedPages"].clone()), (json!([2]), json!([1, 3])));
}

#[test]
fn a_hidden_slide_owns_no_exported_page() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("appendix.pptx");
    write_deck(&target, &deck(&["Body", "Appendix"]));
    let before = pptx_page_signatures(&Unlaned, &target).expect("signatures");
    assert_eq!(before.len(), 2);
    edit_part(&target, "ppt/slides/slide2.xml", |xml| xml.replace("<p:sld>", "<p:sld show=\"0\">"));
    let after = pptx_page_signatures(&Unlaned, &target).expect("signatures");
    assert_eq!(after.len(), 1, "the hidden slide must not claim a rendered page");
    assert_eq!((after[0].page, after[0].slide_id), (1, before[0].slide_id));
}

#[test]
fn shared_resource_changes_invalidate_all_page_signatures_and_a_failed_refresh_clears_reusable_visual_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("incremental.pptx");
    write_deck(&target, &deck(&["Revenue", "Growth", "Spending"]));
    let (engine, handle) = (Fake::new(3), session("pptx", Backend::MixdogOoxml, Mode::Portable, &target));
    let before = pptx_page_signatures(&Unlaned, &target).expect("signatures");
    draw(&engine, &handle, json!({}), dir.path()).expect("first");
    edit_part(&target, "ppt/theme/theme1.xml", |xml| xml.replace("Office", "Changed Theme"));
    let after = pptx_page_signatures(&Unlaned, &target).expect("signatures");
    assert!(after.iter().zip(&before).all(|(now, then)| now.signature != then.signature));
    lock(&handle).snapshot_version += 1;
    engine.fail_raster.set(true);
    assert_eq!(draw(&engine, &handle, json!({}), dir.path()).expect_err("the raster fails"), "raster failed");
    let session = lock(&handle);
    assert_eq!(session.design_state.rendered_version, Value::Null);
    assert!(session.caches.render.is_none() && session.caches.page_render.is_none());
}

// ---- what the render action adds ------------------------------------------------------------------------------------------------

#[test]
fn a_deck_refuses_more_than_twelve_explicit_pages_and_pages_outside_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("deck.pptx");
    write_deck(&target, &deck(&["One", "Two"]));
    let (engine, handle) = (Fake::new(2), session("pptx", Backend::MixdogOoxml, Mode::Portable, &target));
    let message = "render accepts at most 12 explicit pages, within the presentation range";
    assert_eq!(draw(&engine, &handle, json!({ "pages": [3] }), dir.path()).expect_err("outside"), message);
    assert_eq!(draw(&engine, &handle, json!({ "pages": [1.5] }), dir.path()).expect_err("fraction"), message);
    let many: Vec<u32> = (1..=13).collect();
    assert_eq!(draw(&engine, &handle, json!({ "pages": many }), dir.path()).expect_err("thirteen"), message);
    assert_eq!(engine.exports.get(), 0);
}

#[test]
fn the_result_names_its_renderer_and_keeps_its_key_order() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(1), session("docx", Backend::MixdogOoxml, Mode::Portable, &dir.path().join("a.docx")));
    let portable = draw(&engine, &handle, json!({}), dir.path()).expect("portable");
    assert_eq!(portable["renderer"], json!("LibreOffice"));
    let keys: Vec<&str> = portable.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(keys, ["session", "backend", "output", "format", "renderer", "pageCount", "visualCoverage", "images", "_images", "reviewToken", "exportAvailable"]);
    assert!(portable["images"][0].get("data").is_none() && portable["_images"][0].get("data").is_some());
    assert_eq!(portable["output"], json!(dir.path().join("a.docx.mixdog-preview.pdf").to_string_lossy().into_owned()));
    for (format, name) in [("docx", "Microsoft Word"), ("xlsx", "Microsoft Excel"), ("pptx", "Microsoft PowerPoint")] {
        let office = office_session(format, &dir.path().join(format!("b.{format}")));
        assert_eq!(draw(&engine, &office, json!({}), dir.path()).expect("office")["renderer"], json!(name));
    }
    let pdf = session("pdf", Backend::MixdogPdf, Mode::Portable, &dir.path().join("c.pdf"));
    assert_eq!(draw(&engine, &pdf, json!({}), dir.path()).expect("pdf")["renderer"], json!("pdfjs"));
}

#[test]
fn a_render_of_a_document_that_is_not_a_deck_is_the_preview_itself() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(1), office_session("docx", &dir.path().join("a.docx")));
    let rendered = run(render(&engine, &Unlaned, &handle, &json!({}), dir.path(), &NoReceipts)).expect("render");
    assert!(rendered.get("receipt").is_none() && rendered.get("contactSheet").is_none());
    assert_eq!(rendered["pageCount"], json!(1));
    assert_eq!(engine.recalculations.get(), 0);
}

#[test]
fn a_workbook_is_calculated_once_per_version_and_its_fit_repeated_when_values_arrived() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, handle) = (Fake::new(1), session("xlsx", Backend::MixdogOoxml, Mode::Portable, &dir.path().join("a.xlsx")));
    *engine.recalculation.borrow_mut() = json!({ "needed": true, "recalculated": true });
    lock(&handle).authored.autofit_ranges = vec![json!({ "sheet": "S", "range": "A:B" })];
    lock(&handle).design_state.rendered_version = json!(0);
    let result = run(recalculate_for_review(&engine, &handle)).expect("calculated").expect("a workbook");
    assert_eq!(result["refittedColumns"], json!(3));
    assert_eq!(engine.refits.borrow()[0], [json!({ "op": "autofit_range", "sheet": "S", "range": "A:B" })]);
    assert_eq!(lock(&handle).design_state.rendered_version, Value::Null);
    let again = run(recalculate_for_review(&engine, &handle)).expect("cached").expect("a workbook");
    assert_eq!((again, engine.recalculations.get()), (result, 1));
    lock(&handle).snapshot_version += 1;
    run(recalculate_for_review(&engine, &handle)).expect("after an edit");
    assert_eq!(engine.recalculations.get(), 2);
    // A document that is not a portable workbook is left alone.
    let other = session("docx", Backend::MixdogOoxml, Mode::Portable, &dir.path().join("a.docx"));
    assert!(run(recalculate_for_review(&engine, &other)).expect("not a workbook").is_none());
}
