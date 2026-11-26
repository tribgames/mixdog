//! Call API of the office/PDF extension pool (RL §11). The dispatcher keeps
//! a FIFO per session, round-robin across sessions, a per-session in-flight
//! cap of ⌈W/2⌉ and a global pending cap (beyond it: `Overloaded`). Chunks
//! flow under a per-call byte window; consuming a chunk returns its credit.

use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;

use super::common::AbsPath;
use super::common::EventSource;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ExtCall {
    /// Fairness key (per-session FIFO, round-robin).
    pub thread: ThreadId,
    pub method: String,
    pub params: JsonValue,
    /// Approved absolute paths the call may touch.
    pub paths: Vec<AbsPath>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExtExit {
    Code(i32),
    Signal(i32),
    /// Ended by "Stop office worker".
    Stopped,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExtError {
    /// Global pending cap reached.
    Overloaded,
    Cancelled,
    /// The worker exited while serving the call.
    HostExited {
        exit: ExtExit,
    },
    /// No extension host on this machine (e.g. SSH server without Node).
    Unavailable {
        reason: String,
    },
    Failed {
        code: String,
        message: String,
    },
    UnknownWorker,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExtFrame {
    Chunk(Vec<u8>),
    /// Last frame.
    Done(Result<JsonValue, ExtError>),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ExtWorkerId(pub u32);

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExtWorkerState {
    Idle,
    /// No timer reclaims a busy slot.
    Busy {
        call: u64,
        since_seq: u64,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ExtWorkerStatus {
    pub id: ExtWorkerId,
    pub state: ExtWorkerState,
}

/// What keeps the shared render browser open: dropping it ends the use (Node's pool slot).
pub type BrowserHold = Box<dyn std::any::Any + Send>;

/// The shared render browser: the DevTools WebSocket URL of a running browser,
/// launching it when none is, together with the hold that keeps it from closing
/// for idleness until the caller is done. Implemented by the extension host, which
/// owns the browser's launch, idle close and process guarding. There is no way to
/// get the URL without the hold, as Node's pool gives no browser without a slot.
#[async_trait::async_trait]
pub trait BrowserEndpoint: Send + Sync {
    async fn lease(&self) -> Result<(String, BrowserHold), String>;
}

/// The text provider lowering gives an attached document (`media-normalization.mjs`), computed by
/// the extension host's Node so it equals Node's byte for byte. The bytes arrive base64, as a
/// message part carries them. `thread` is the call's fairness key.
#[async_trait::async_trait]
pub trait DocumentText: Send + Sync {
    /// `officeTextForFile` for a docx/xlsx/pptx/xlsm: the extracted text, or `None` when the
    /// container cannot be read or is over the lowering caps (the caller then uses the plain
    /// description). `filename` picks the format, else the package's own parts do.
    async fn office_text(&self, thread: &ThreadId, filename: &str, data_base64: &str) -> Result<Option<String>, ExtError>;

    /// `extractPdfText`: the text of the PDF's first pages, or the fixed "PDF text unavailable"
    /// text for bytes the parser rejects. An environment failure (the machine, not the bytes) is
    /// an error and must never become text.
    async fn pdf_text(&self, thread: &ThreadId, data_base64: &str) -> Result<String, ExtError>;

    /// The text-layer counts Node's PDF intake prices a PDF with (`inspectPdfBuffer` with
    /// `measureText`, `attachments/store.mjs`): the counts, or the parser's own message for bytes
    /// it rejects (the text Node's intake throws). A native-PDF provider's page limit is the
    /// caller's to apply to `page_count`. An environment failure or the 60 s intake timeout is an
    /// error.
    async fn pdf_counts(&self, thread: &ThreadId, data_base64: &str) -> Result<PdfIntake, ExtError>;

    /// `convertLegacyOfficeBuffer` (`attachments/legacy-office.mjs`): a legacy Office attachment (`.doc`, `.xls`, `.ppt`) saved
    /// by LibreOffice as the OOXML package `kind` (`docx`, `xlsx`, `pptx`). A conversion that cannot run (LibreOffice missing, a
    /// damaged or protected file, bytes that are not a legacy file) is `ExtError::Failed` carrying the converter's message, which
    /// the caller shows the model as text. A host with no document engine answers the same way.
    async fn legacy_office(&self, thread: &ThreadId, filename: &str, kind: &str, data_base64: &str) -> Result<LegacyPackage, ExtError> {
        let _ = (thread, filename, data_base64);
        Err(ExtError::Failed {
            code: "unavailable".to_owned(),
            message: format!(
                "converting a legacy Office file to .{kind} needs the document engine, which is not available here. Open it in Microsoft Office and save it as .{kind}, then attach that copy."
            ),
        })
    }
}

/// A legacy Office attachment saved as an OOXML package.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LegacyPackage {
    /// The package, base64.
    pub data_base64: String,
    /// `<stem>.<kind>`.
    pub filename: String,
}

/// `resizeImageBuffer`'s answer for the read tool: the (possibly re-encoded) image and its sizes.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ResizedImage {
    /// Base64, as Node returns it.
    pub data_base64: String,
    /// `image/<format>`.
    pub mime: String,
    pub original_w: u32,
    pub original_h: u32,
    pub display_w: u32,
    pub display_h: u32,
}

/// Why an image could not be resized, other than there being no resizer.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ImageResizeError {
    /// Node's `INVALID_IMAGE_DATA`: the decoder rejected the bytes.
    Invalid,
    /// The resizer's host failed (a dead worker): the image was not judged, and this is never
    /// the same as there being no `sharp`.
    Host(ExtError),
}

/// The read tool's image resize (`resizeImageBuffer(bytes, ext)` in `read-image-resize.mjs`),
/// run by the extension host's `sharp` so the bytes equal Node's. `Ok(None)` is Node's `null`: no
/// resizer (no `sharp`, or an empty buffer). `ext` is the format name (`png`, `jpeg`, `gif`,
/// `webp`); `thread` is the call's fairness key.
#[async_trait::async_trait]
pub trait ImageResizer: Send + Sync {
    async fn resize(&self, thread: &ThreadId, bytes: &[u8], ext: &str) -> Result<Option<ResizedImage>, ImageResizeError>;
}
/// A tool's image fitted for an agent's history.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FittedToolImage {
    pub data: Vec<u8>,
    /// `image/<format>`.
    pub mime: String,
    pub original_w: u32,
    pub original_h: u32,
    pub display_w: u32,
    pub display_h: u32,
    /// Re-encoded at a lower quality than its source.
    pub recompressed: bool,
}

/// Why a tool's image is left out of what the agent is given.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ToolImageFitError {
    /// Empty, or the decoder rejected the bytes.
    Unreadable,
    /// Over the agent's byte ceiling even at the lowest quality.
    TooLarge,
    /// The fitter's host failed: the image was not judged.
    Host(ExtError),
}

/// Fits a tool's image (format `ext`) to the display box and the history budget inside `max_raw_bytes`, the agent's
/// own ceiling, outside the core's process.
#[async_trait::async_trait]
pub trait ToolImageFitter: Send + Sync {
    async fn fit(&self, bytes: &[u8], ext: &str, max_raw_bytes: usize) -> Result<FittedToolImage, ToolImageFitError>;
}

/// The image profile of a provider (`imageProfileForProvider`): the edge and patch limits
/// `resizeImageBuffer` fits an image into.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImageProfile {
    Anthropic,
    OpenAi,
}

/// Why the composer's resize gave no image other than there being no `sharp`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ProfiledResizeError {
    /// The decoder rejected the bytes: Node's `invalid or corrupt image data: ...` sentence.
    Invalid(String),
    Host(ExtError),
}

/// The composer's image resize (`resizeImageBuffer(bytes, ext, { profile })` from
/// `imageAttachmentFromBuffer`). `Ok(None)` is Node's `null`: no resizer.
#[async_trait::async_trait]
pub trait ProfiledImageResizer: Send + Sync {
    async fn resize_profiled(&self, thread: &ThreadId, bytes: &[u8], ext: &str, profile: ImageProfile) -> Result<Option<ResizedImage>, ProfiledResizeError>;
}

/// What Node's PDF intake made of the bytes.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PdfIntake {
    Counts(PdfCounts),
    /// The parser rejected the bytes; the message is exactly what Node's intake throws.
    Rejected(String),
}

/// How much of a PDF reads as text: its pages, the pages with a text layer, and the characters
/// those hold.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PdfCounts {
    pub page_count: u64,
    pub text_pages: u64,
    pub text_chars: u64,
}

pub trait ExtPool: Send + Sync {
    /// Queues the call. Dropping the returned stream sends `cancel`; the
    /// worker's slot stays occupied until it answers or exits.
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError>;
    fn status(&self) -> Vec<ExtWorkerStatus>;
    /// Terminates the worker's job object; its call ends `HostExited{Stopped}`.
    fn stop_worker(&self, worker: ExtWorkerId) -> Result<(), ExtError>;
}
