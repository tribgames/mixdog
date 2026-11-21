//! One OCR engine per language set and cache, shared by the callers that use it at once (`pdf/ocr-engine.mjs`).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use mixdog_rt::time;
use mixdog_rt::{CancellationToken, LaneTokens};
use tokio::sync::watch;
use tokio::task::AbortHandle;

use super::install::{self, ENGINE_ASSETS};
use super::lane_job;

/// The start includes the first-use download; without network it fails or hangs.
pub const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a page that was cancelled is given to stop its program and remove its files.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// The code an error carries when the engine cannot be had here and now.
pub const UNAVAILABLE: &str = "OCR_UNAVAILABLE";

/// A failure of the engine: the message of the error Node threw, and its `code` when it had one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrError {
    pub code: Option<&'static str>,
    pub message: String,
}

impl OcrError {
    pub fn plain(message: impl Into<String>) -> Self {
        OcrError { code: None, message: message.into() }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        OcrError { code: Some(UNAVAILABLE), message: message.into() }
    }

    pub fn cancelled() -> Self {
        OcrError::plain("PDF OCR was cancelled")
    }
}

impl std::fmt::Display for OcrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OcrError {}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What an engine is started for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineConfig {
    /// `eng+kor`.
    pub languages: String,
    /// Where each language's data is kept.
    pub cache_path: PathBuf,
    /// Where the data is downloaded from instead of the default CDN.
    pub lang_path: Option<String>,
    /// `<dataDir>/office/ocr`: the program is under `engine/`, a page's files under `work/`.
    pub ocr_root: PathBuf,
}

/// A page to read: a file, or the bytes of an image.
#[derive(Debug, Clone)]
pub enum Image {
    Path(PathBuf),
    Bytes(Vec<u8>),
}

/// What the engine read from a page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recognition {
    pub text: String,
    /// The table of words, when it was asked for.
    pub tsv: String,
}

/// A running engine.
pub trait EngineProcess: Send + Sync + 'static {
    /// Reads one page (its table of words too when `with_words`). A page that `cancel` ends stops what it started and
    /// answers with an error.
    fn recognize<'a>(&'a self, image: Image, with_words: bool, cancel: &'a CancellationToken) -> BoxFuture<'a, Result<Recognition, String>>;

    /// Ends the engine and the page in recognition.
    fn terminate(&self);
}

/// Makes engines. The future it returns holds everything the start downloads or runs: dropping it ends them.
pub trait EngineStarter: Send + Sync + 'static {
    fn start(&self, config: EngineConfig) -> BoxFuture<'static, Result<Arc<dyn EngineProcess>, String>>;
}

#[derive(Clone)]
enum Phase {
    Starting,
    Ready(Arc<dyn EngineProcess>),
    Closed(OcrError),
}

struct Entry {
    key: String,
    phase: watch::Sender<Phase>,
    holders: AtomicUsize,
    tasks: Mutex<Vec<AbortHandle>>,
}

/// The engines that are running, by language set and cache.
pub struct OcrEngines {
    starter: Arc<dyn EngineStarter>,
    entries: Mutex<HashMap<String, Arc<Entry>>>,
}

/// What an engine is asked for.
#[derive(Debug, Clone)]
pub struct AcquireOptions {
    pub languages: String,
    pub cache_path: PathBuf,
    pub lang_path: Option<String>,
    pub ocr_root: PathBuf,
    /// The caller's cancellation.
    pub cancel: Option<CancellationToken>,
    pub timeout: Duration,
}

impl AcquireOptions {
    pub fn new(languages: impl Into<String>, ocr_root: impl Into<PathBuf>) -> Self {
        let ocr_root = ocr_root.into();
        AcquireOptions { languages: languages.into(), cache_path: ocr_root.join("languages"), lang_path: None, ocr_root, cancel: None, timeout: START_TIMEOUT }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl OcrEngines {
    pub fn new(starter: Arc<dyn EngineStarter>) -> Self {
        OcrEngines { starter, entries: Mutex::new(HashMap::new()) }
    }

    /// How many engines are running (for diagnostics and tests).
    pub fn live(&self) -> usize {
        locked(&self.entries).len()
    }

    /// Ends the engine: its start and every page it still owes.
    fn close(&self, entry: &Arc<Entry>, error: OcrError) {
        let previous = entry.phase.send_replace(Phase::Closed(error));
        if matches!(previous, Phase::Closed(_)) {
            // Already closed: keep the first reason.
            entry.phase.send_replace(previous);
            return;
        }
        {
            let mut entries = locked(&self.entries);
            if entries.get(&entry.key).is_some_and(|found| Arc::ptr_eq(found, entry)) {
                entries.remove(&entry.key);
            }
        }
        for task in locked(&entry.tasks).drain(..) {
            task.abort();
        }
        if let Phase::Ready(process) = previous {
            process.terminate();
        }
    }

    fn start(self: &Arc<Self>, key: String, config: EngineConfig, timeout: Duration) -> Arc<Entry> {
        let (phase, _) = watch::channel(Phase::Starting);
        let entry = Arc::new(Entry { key: key.clone(), phase, holders: AtomicUsize::new(0), tasks: Mutex::new(Vec::new()) });
        locked(&self.entries).insert(key, Arc::clone(&entry));
        let starting = self.starter.start(config);
        let (engines, started) = (Arc::clone(self), Arc::clone(&entry));
        let start = tokio::spawn(async move {
            match starting.await {
                Ok(process) => {
                    let ready = started.phase.send_if_modified(|phase| {
                        let starting = matches!(phase, Phase::Starting);
                        if starting {
                            *phase = Phase::Ready(Arc::clone(&process));
                        }
                        starting
                    });
                    if !ready {
                        process.terminate();
                    }
                }
                Err(message) => engines.close(&started, OcrError::unavailable(format!("OCR could not start: {message}"))),
            }
        });
        let (engines, waiting) = (Arc::clone(self), Arc::clone(&entry));
        let timer = tokio::spawn(async move {
            time::sleep(timeout).await;
            if matches!(*waiting.phase.borrow(), Phase::Starting) {
                engines.close(&waiting, OcrError::unavailable("OCR language data did not load in time (it downloads on first use)"));
            }
        });
        let mut tasks = locked(&entry.tasks);
        tasks.push(start.abort_handle());
        tasks.push(timer.abort_handle());
        drop(tasks);
        entry
    }

    /// The engine for `options.languages` with its data cached at `options.cache_path`, started on first use. It is ready
    /// when this returns; the caller releases it when done. Fails with code [`UNAVAILABLE`] when it does not start within
    /// the timeout, and with a cancellation when the caller's token ends, ending the start if no one else waits on it.
    pub async fn acquire(self: &Arc<Self>, options: AcquireOptions) -> Result<OcrEngine, OcrError> {
        let cancel = options.cancel.clone().unwrap_or_default();
        if cancel.is_cancelled() {
            return Err(OcrError::cancelled());
        }
        let key = format!("{}\0{}\0{}", options.cache_path.display(), options.languages, options.lang_path.as_deref().unwrap_or(""));
        let entry = {
            let existing = locked(&self.entries).get(&key).cloned();
            match existing {
                Some(entry) => entry,
                None => {
                    let config = EngineConfig {
                        languages: options.languages.clone(),
                        cache_path: options.cache_path.clone(),
                        lang_path: options.lang_path.clone(),
                        ocr_root: options.ocr_root.clone(),
                    };
                    self.start(key, config, options.timeout)
                }
            }
        };
        entry.holders.fetch_add(1, Ordering::SeqCst);
        let handle = OcrEngine { engines: Arc::clone(self), entry: Arc::clone(&entry), released: AtomicBool::new(false) };
        let mut phase = entry.phase.subscribe();
        loop {
            let current = phase.borrow_and_update().clone();
            match current {
                Phase::Ready(_) => return Ok(handle),
                Phase::Closed(error) => return Err(error),
                Phase::Starting => {}
            }
            tokio::select! {
                changed = phase.changed() => {
                    if changed.is_err() {
                        return Err(OcrError::plain("OCR engine released"));
                    }
                }
                () = cancel.cancelled() => return Err(OcrError::cancelled()),
            }
        }
    }
}

/// An engine a caller holds. Letting go of it (or dropping it) releases it; the engine ends with its last holder.
pub struct OcrEngine {
    engines: Arc<OcrEngines>,
    entry: Arc<Entry>,
    released: AtomicBool,
}

impl OcrEngine {
    /// Reads one page. A cancelled page cannot be stopped inside the engine: the engine ends with it unless another
    /// caller still uses it, which then gets the page's (discarded) answer before its own.
    pub async fn recognize(&self, image: Image, with_words: bool, cancel: Option<&CancellationToken>) -> Result<Recognition, OcrError> {
        let process = match self.entry.phase.borrow().clone() {
            Phase::Ready(process) => process,
            Phase::Closed(error) => return Err(error),
            Phase::Starting => return Err(OcrError::plain("OCR engine is not ready")),
        };
        let never = CancellationToken::new();
        let cancel = cancel.unwrap_or(&never);
        if cancel.is_cancelled() {
            return Err(OcrError::cancelled());
        }
        let page = CancellationToken::new();
        let mut closed = self.entry.phase.subscribe();
        let mut answer = std::pin::pin!(process.recognize(image, with_words, &page));
        let outcome = tokio::select! {
            result = &mut answer => return result.map_err(|message| OcrError::plain(format!("OCR failed: {message}"))),
            () = cancel.cancelled() => OcrError::cancelled(),
            error = async {
                loop {
                    if let Phase::Closed(error) = closed.borrow_and_update().clone() {
                        break error;
                    }
                    if closed.changed().await.is_err() {
                        break OcrError::plain("OCR engine released");
                    }
                }
            } => error,
        };
        // The page stops its program and removes its files; it is given a moment, not forever.
        page.cancel();
        if outcome == OcrError::cancelled() && self.entry.holders.load(Ordering::SeqCst) <= 1 {
            self.engines.close(&self.entry, OcrError::cancelled());
        }
        let _ = time::timeout(STOP_GRACE, &mut answer).await;
        Err(outcome)
    }

    /// Lets go of the engine; the last holder ends it.
    pub fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.entry.holders.fetch_sub(1, Ordering::SeqCst) <= 1 {
            self.engines.close(&self.entry, OcrError::plain("OCR engine released"));
        }
    }
}

impl Drop for OcrEngine {
    fn drop(&mut self) {
        self.release();
    }
}

/// The engines of the process, started by the managed program.
pub fn shared(lanes: LaneTokens) -> &'static Arc<OcrEngines> {
    static SHARED: OnceLock<Arc<OcrEngines>> = OnceLock::new();
    SHARED.get_or_init(|| Arc::new(OcrEngines::new(Arc::new(ManagedTesseract::new(lanes)))))
}

// the managed Tesseract program

/// Starts the managed Tesseract: the program and each language's data are fetched when missing.
pub struct ManagedTesseract {
    lanes: LaneTokens,
}

impl ManagedTesseract {
    pub fn new(lanes: LaneTokens) -> Self {
        ManagedTesseract { lanes }
    }
}

impl EngineStarter for ManagedTesseract {
    fn start(&self, config: EngineConfig) -> BoxFuture<'static, Result<Arc<dyn EngineProcess>, String>> {
        let lanes = self.lanes;
        Box::pin(async move {
            // The start is shared by its callers; it ends when they all let go, not by one's token.
            let cancel = CancellationToken::new();
            let program = install::ensure_engine(&lanes, &config.ocr_root.join("engine"), ENGINE_ASSETS, &install::platform_key(), &cancel).await?;
            install::ensure_languages(&lanes, &config.languages, &config.cache_path, config.lang_path.as_deref(), &cancel).await?;
            let process: Arc<dyn EngineProcess> = Arc::new(TesseractProcess {
                program,
                languages: config.languages,
                tessdata: config.cache_path,
                work_root: config.ocr_root.join("work"),
                lanes,
                serial: tokio::sync::Mutex::new(()),
                ended: CancellationToken::new(),
            });
            Ok(process)
        })
    }
}

struct TesseractProcess {
    program: PathBuf,
    languages: String,
    tessdata: PathBuf,
    work_root: PathBuf,
    lanes: LaneTokens,
    /// One page at a time, in arrival order: the engine itself is serial.
    serial: tokio::sync::Mutex<()>,
    ended: CancellationToken,
}

/// The files the engine wrote, read and removed (the folder is the page's own).
async fn collect(lanes: &LaneTokens, folder: PathBuf, with_words: bool) -> Result<Recognition, String> {
    let never = CancellationToken::new();
    lane_job(lanes.durability_io, &never, move |lane| {
        let text = mixdog_fsio::read_to_string(lane, folder.join("page.txt"));
        let tsv = if with_words { mixdog_fsio::read_to_string(lane, folder.join("page.tsv")).map_err(|error| error.to_string()) } else { Ok(String::new()) };
        // The engine ends each page's text with a form feed.
        text.map_err(|error| error.to_string()).and_then(|text| tsv.map(|tsv| Recognition { text: text.trim_end_matches('\u{c}').to_owned(), tsv }))
    })
    .await?
}

async fn remove_folder(lanes: &LaneTokens, folder: PathBuf) {
    let never = CancellationToken::new();
    let _ = lane_job(lanes.durability_io, &never, move |lane| {
        let _ = mixdog_fsio::remove_dir_all(lane, &folder);
    })
    .await;
}

impl TesseractProcess {
    async fn run(&self, folder: &Path, image: Image, with_words: bool, cancel: &CancellationToken) -> Result<Recognition, String> {
        // The page is read from a file of the page folder under a plain name, with the folder as the working directory:
        // the program opens its files by the narrow path, which a user name outside ASCII breaks.
        let (written, never) = (folder.join("input.png"), CancellationToken::new());
        let placed = match image {
            Image::Path(path) => lane_job(self.lanes.durability_io, &never, move |lane| mixdog_fsio::copy(lane, &path, &written).map(|_| ())).await?,
            Image::Bytes(bytes) => lane_job(self.lanes.durability_io, &never, move |lane| mixdog_fsio::write(lane, &written, bytes)).await?,
        };
        placed.map_err(|error| error.to_string())?;
        let mut command = tokio::process::Command::new(&self.program);
        command
            .current_dir(folder)
            .args(["input.png", "page", "-l"])
            .arg(&self.languages)
            .args(["--oem", "1", "--psm", "6", "--tessdata-dir"])
            .arg(&self.tessdata)
            // The outputs are asked for by variable: the `txt` and `tsv` config files live in a `configs` folder of the
            // tessdata directory, which the language cache does not have.
            .args(["-c", "tessedit_create_txt=1"]);
        if with_words {
            command.args(["-c", "tessedit_create_tsv=1"]);
        }
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let child = command.spawn().map_err(|error| format!("spawn {} failed: {error}", self.program.display()))?;
        let output = tokio::select! {
            output = child.wait_with_output() => output.map_err(|error| error.to_string())?,
            () = cancel.cancelled() => return Err("the page was cancelled".to_owned()),
            () = self.ended.cancelled() => return Err("OCR engine ended".to_owned()),
        };
        if !output.status.success() {
            let said = String::from_utf8_lossy(&output.stderr);
            let said = said.trim();
            return Err(if said.is_empty() { format!("tesseract exited with {}", output.status) } else { said.to_owned() });
        }
        collect(&self.lanes, folder.to_path_buf(), with_words).await
    }
}

impl EngineProcess for TesseractProcess {
    fn recognize<'a>(&'a self, image: Image, with_words: bool, cancel: &'a CancellationToken) -> BoxFuture<'a, Result<Recognition, String>> {
        Box::pin(async move {
            let _turn = tokio::select! {
                turn = self.serial.lock() => turn,
                () = cancel.cancelled() => return Err("the page was cancelled".to_owned()),
                () = self.ended.cancelled() => return Err("OCR engine ended".to_owned()),
            };
            let folder = self.work_root.join(uuid::Uuid::new_v4().to_string());
            let made = folder.clone();
            let never = CancellationToken::new();
            lane_job(self.lanes.durability_io, &never, move |lane| mixdog_fsio::create_dir_all(lane, &made)).await?.map_err(|error| error.to_string())?;
            let result = self.run(&folder, image, with_words, cancel).await;
            remove_folder(&self.lanes, folder).await;
            result
        })
    }

    fn terminate(&self) {
        self.ended.cancel();
    }
}
