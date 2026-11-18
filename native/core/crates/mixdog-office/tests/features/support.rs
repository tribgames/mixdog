//! The world a call runs in: no Microsoft Office, no browser, no network, a fixed clock and a data folder of its own.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

use mixdog_core_api::domain::ext::{BrowserEndpoint, BrowserHold};
use mixdog_fonts::discovery::{HostEnv, scan};
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_fsio::Unlaned;
use mixdog_office::batch::BatchHost;
use mixdog_office::engine::{Engine, Platform};
use mixdog_office_base::ledger::CallLedger;
use mixdog_office_com::{OfficeCom, OfficeComConfig};
use mixdog_office_design::library::{Environment, Fetch, FetchRequest, FetchResponse, TemplateIndexer};
use mixdog_office_design::templates::OfficeTemplateIndexer;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, LaneTokens};
use serde_json::{Value, json};

const CLOCK: f64 = 1_700_000_000_000.0;

struct NoBriefs;

impl BriefReadings for NoBriefs {
    fn html_brief_script(&self, _html: &str) -> String {
        String::new()
    }
    fn parse_authoring_brief(&self, _script: &str) -> Value {
        json!({ "present": false })
    }
    fn review_fact_coverage(&self, _document: &Value, _brief: &Value) -> Vec<Value> {
        Vec::new()
    }
    fn review_source_grounding(&self, _brief: &Value) -> Vec<Value> {
        Vec::new()
    }
}

/// The machine of a batch: no chart is drawn and no brief read.
pub struct World;

impl BatchHost for World {
    fn pdf_operations(&self, _data_dir: &Path, cancel: Option<CancellationToken>) -> ContentOperations {
        ContentOperations::new(FontEnv::host(), SvgFonts::none(), None, cancel)
    }
    fn chart_picture(&self, _block: &Value, _width: f64, _pdf: &Path) -> impl Future<Output = Result<String, String>> {
        async { Err("no chart is drawn here".to_owned()) }
    }
    fn brief_readings(&self) -> &dyn BriefReadings {
        &NoBriefs
    }
}

struct NoNetwork;

impl Fetch for NoNetwork {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        Err(format!("no network: {}", request.url))
    }
}

struct NoBrowser;

impl BrowserEndpoint for NoBrowser {
    fn lease<'life0, 'async_trait>(&'life0 self) -> Pin<Box<dyn Future<Output = Result<(String, BrowserHold), String>> + Send + 'async_trait>>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async { Err("no browser here".to_owned()) })
    }
}

fn system_fonts() -> Arc<FontRegistry> {
    static FONTS: LazyLock<Arc<FontRegistry>> = LazyLock::new(|| {
        let home = std::env::home_dir().unwrap_or_default();
        let env = HostEnv::current(&|name| std::env::var(name).ok(), &home);
        Arc::new(scan(&Unlaned, &env).registry)
    });
    Arc::clone(&FONTS)
}

pub struct TestPlatform {
    lanes: LaneTokens,
    office: OfficeCom,
    fonts: Arc<FontRegistry>,
    font_env: FontEnv,
    svg_fonts: SvgFonts,
    environment: Environment,
    validator: ValidatorEnvironment,
}

impl TestPlatform {
    pub fn new(dir: &Path, data: &Path) -> Self {
        let lanes = mixdog_rt::testing::tokens();
        Self {
            lanes,
            office: OfficeCom::new(OfficeComConfig::new(data.join("office-com"), lanes)),
            fonts: system_fonts(),
            font_env: FontEnv::host(),
            svg_fonts: SvgFonts::none(),
            environment: Environment {
                library_config: String::new(),
                pack_url: String::new(),
                pack_key_id: String::new(),
                pack_public_key: String::new(),
                template_dirs: String::new(),
                windows: cfg!(windows),
                program_files: String::new(),
                program_files_x86: String::new(),
                app_data: String::new(),
                home: dir.display().to_string(),
                cwd: dir.to_path_buf(),
                bundled_templates: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-office-design/assets/templates"),
                now_ms: Arc::new(|| CLOCK),
            },
            validator: ValidatorEnvironment { disabled: true, ..ValidatorEnvironment::from_process() },
        }
    }
}

impl Platform for TestPlatform {
    type Batch = World;

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
        &NoBrowser
    }
    fn design_environment(&self) -> &Environment {
        &self.environment
    }
    fn fetch(&self) -> &dyn Fetch {
        &NoNetwork
    }
    fn indexer(&self) -> &dyn TemplateIndexer<Unlaned> {
        &OfficeTemplateIndexer
    }
    fn validator(&self) -> &ValidatorEnvironment {
        &self.validator
    }
    fn batch_host(&self) -> &World {
        &World
    }
}

/// An engine over a temporary folder: documents live in `docs`, the Office data in `data`.
pub struct Harness {
    _root: tempfile::TempDir,
    pub docs: PathBuf,
    pub data: PathBuf,
    pub engine: Arc<Engine<TestPlatform>>,
    runtime: tokio::runtime::Runtime,
}

impl Harness {
    pub fn new() -> Self {
        let root = tempfile::tempdir().expect("temp dir");
        let docs = root.path().join("docs");
        let data = root.path().join("data");
        for folder in [&docs, &data] {
            mixdog_fsio::create_dir_all(&Unlaned, folder).expect("folder");
        }
        let engine = Engine::new(TestPlatform::new(root.path(), &data));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        Self { _root: root, docs, data, engine, runtime }
    }

    pub fn put(&self, name: &str, text: &str) -> PathBuf {
        let path = self.docs.join(name);
        mixdog_fsio::write(&Unlaned, &path, text.as_bytes()).expect("write");
        path
    }

    pub fn read(&self, name: &str) -> String {
        String::from_utf8(mixdog_fsio::read(&Unlaned, self.docs.join(name)).expect("read")).expect("utf8")
    }

    /// The text of the answer to one call, and whether the call was cancelled first.
    pub fn text_of(&self, args: Value, cancelled: bool) -> String {
        let cancel = CancellationToken::new();
        if cancelled {
            cancel.cancel();
        }
        let ledger = Arc::new(CallLedger::new(&self.docs, &self.data).expect("ledger"));
        let (result, _changes) = self.runtime.block_on(self.engine.execute(args, self.docs.clone(), Some(self.data.clone()), Some(ledger), cancel));
        result["content"][0]["text"].as_str().expect("a text answer").to_owned()
    }

    /// The JSON answer of one call; an error answer is `{"error": "<text>"}`.
    pub fn call(&self, args: Value) -> Value {
        let text = self.text_of(args, false);
        serde_json::from_str(&text).unwrap_or_else(|_| json!({ "error": text }))
    }
}

/// The first value under `key` anywhere in `value`.
pub fn find<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key).or_else(|| map.values().find_map(|inner| find(inner, key))),
        Value::Array(items) => items.iter().find_map(|inner| find(inner, key)),
        _ => None,
    }
}
