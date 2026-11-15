//! The session record of the office engine and the registry that holds it: the session part of
//! `core/office-core.mjs` (`sessions`, `documentSessions`, `emptyOfficeDesignState`, `microsoftOfficeOpenFields`, the
//! design binding of a session).
//!
//! A [`Session`] is one open document. Everything later code reads or a result shows has a typed field: identity (id,
//! source, target, format, backend, mode), the Microsoft Office fields ([`ComFields`]), the design in force and the
//! design-review counters ([`DesignState`]), the transaction as an explicit state ([`SessionState`]), the caches that
//! belong to one snapshot version ([`SessionCaches`]) and the thread that owns the session. Values whose shape belongs to
//! the task that produces them (a snapshot, a render result, an audit) stay `serde_json` values.
//!
//! - [`design`]: binding a session's design once per call (native documents stay native; a library-backed design is
//!   resolved through `mixdog-office-design`'s library and its binding persisted).
//! - [`registry`]: the sessions map and the document index, keyed by the absolute path (case-folded on Windows), and the
//!   pin rule of the worker (a thread whose calls left a live session is pinned).

pub mod create;
pub mod design;
pub mod mode;
pub mod open;
pub mod registry;
pub mod working_copy;

use std::path::PathBuf;

use mixdog_rt::CancellationToken;
use serde_json::{Map, Value};

use crate::digest::ResultSession;

pub use design::{DesignContext, EnsureOptions, ensure_office_session_design, merge_office_design_request, resolve_office_design_context};
pub use registry::{Registry, SessionHandle, ThreadPins, document_session_key};

/// `session.backend`: what runs the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    MixdogOoxml,
    MixdogPdf,
    MixdogTabular,
    MicrosoftOfficeCom,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::MixdogOoxml => "mixdog-ooxml",
            Backend::MixdogPdf => "mixdog-pdf",
            Backend::MixdogTabular => "mixdog-tabular",
            Backend::MicrosoftOfficeCom => "microsoft-office-com",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [Backend::MixdogOoxml, Backend::MixdogPdf, Backend::MixdogTabular, Backend::MicrosoftOfficeCom].into_iter().find(|backend| backend.as_str() == text)
    }
}

/// `session.mode`: how the document is held. `live` is spelled `attach`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Background,
    Portable,
    Attach,
    Visible,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Background => "background",
            Mode::Portable => "portable",
            Mode::Attach => "attach",
            Mode::Visible => "visible",
        }
    }

    /// The mode a name stands for (`live` is `attach`); `None` for any other text.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "background" => Some(Mode::Background),
            "portable" => Some(Mode::Portable),
            "attach" | "live" => Some(Mode::Attach),
            "visible" => Some(Mode::Visible),
            _ => None,
        }
    }

    /// `isInteractiveOfficeSession`: the user's own Office window holds the document.
    pub fn is_interactive(self) -> bool {
        matches!(self, Mode::Attach | Mode::Visible)
    }
}

/// `transaction.phase`: where a transaction is, as the journal records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransactionPhase {
    Active,
    Committing,
    RollingBack,
}

impl TransactionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            TransactionPhase::Active => "active",
            TransactionPhase::Committing => "committing",
            TransactionPhase::RollingBack => "rolling_back",
        }
    }

    /// The phase a journal names; an absent or unknown one is `active`, as the recovery reads it.
    pub fn parse(text: &str) -> Self {
        match text {
            "committing" => TransactionPhase::Committing,
            "rolling_back" => TransactionPhase::RollingBack,
            _ => TransactionPhase::Active,
        }
    }
}

/// `session.transaction`: the checkpoint and what the batches since changed.
#[derive(Clone, Debug)]
pub struct Transaction {
    pub id: String,
    pub started_at: String,
    pub checkpoint: String,
    pub baseline_pdf: String,
    pub before_fingerprint: Value,
    pub expected_fingerprint: Value,
    pub before_document: Value,
    pub current_document: Value,
    pub operation_changes: Vec<Value>,
    pub undo_units: u64,
    pub diff: Value,
    pub phase: TransactionPhase,
    pub review: Option<Value>,
    /// The journal file once it has been written.
    pub journal_path: Option<String>,
}

/// Whether a transaction is open on the session.
#[derive(Clone, Debug, Default)]
pub enum SessionState {
    #[default]
    Idle,
    InTransaction(Box<Transaction>),
}

impl SessionState {
    pub fn transaction(&self) -> Option<&Transaction> {
        match self {
            SessionState::Idle => None,
            SessionState::InTransaction(transaction) => Some(transaction),
        }
    }

    pub fn transaction_mut(&mut self) -> Option<&mut Transaction> {
        match self {
            SessionState::Idle => None,
            SessionState::InTransaction(transaction) => Some(transaction),
        }
    }

    /// `session.transaction = null`: answers the transaction that was open.
    pub fn close(&mut self) -> Option<Transaction> {
        match std::mem::take(self) {
            SessionState::Idle => None,
            SessionState::InTransaction(transaction) => Some(*transaction),
        }
    }
}

/// `session.designState`: the design-review counters of a session.
#[derive(Clone, Debug, PartialEq)]
pub struct DesignState {
    /// The snapshot version last rendered (`null` before the first render).
    pub rendered_version: Value,
    pub semantic_count: u64,
    pub requires_visual_review: bool,
    /// The deck plans; `None` for a format that never carries one (PDF and delimited files).
    pub slide_plans: Option<Vec<Value>>,
    pub compositions: Vec<Value>,
    /// What the render and review steps record beside the counters.
    pub review_token: Option<Value>,
    pub rendered_coverage: Option<Value>,
    pub rendered_max_width: Option<Value>,
    pub rendered_page_count: Option<Value>,
}

impl DesignState {
    /// `emptyOfficeDesignState({ requiresVisualReview, includeSlidePlans })`.
    pub fn empty(requires_visual_review: bool, include_slide_plans: bool) -> Self {
        Self {
            rendered_version: Value::Null,
            semantic_count: 0,
            requires_visual_review,
            slide_plans: include_slide_plans.then(Vec::new),
            compositions: Vec::new(),
            review_token: None,
            rendered_coverage: None,
            rendered_max_width: None,
            rendered_page_count: None,
        }
    }

    /// The state as Node's object: the counters in their order, then what was recorded beside them.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("renderedVersion".to_owned(), self.rendered_version.clone());
        map.insert("semanticCount".to_owned(), Value::from(self.semantic_count));
        map.insert("requiresVisualReview".to_owned(), Value::Bool(self.requires_visual_review));
        if let Some(plans) = &self.slide_plans {
            map.insert("slidePlans".to_owned(), Value::Array(plans.clone()));
        }
        map.insert("compositions".to_owned(), Value::Array(self.compositions.clone()));
        for (key, value) in [
            ("reviewToken", &self.review_token),
            ("renderedCoverage", &self.rendered_coverage),
            ("renderedMaxWidth", &self.rendered_max_width),
            ("renderedPageCount", &self.rendered_page_count),
        ] {
            if let Some(value) = value {
                map.insert(key.to_owned(), value.clone());
            }
        }
        Value::Object(map)
    }
}

impl Default for DesignState {
    fn default() -> Self {
        Self::empty(false, true)
    }
}

/// The Microsoft Office fields of a session (`microsoftOfficeOpenFields`): what the COM host answered when it opened or
/// attached the document. A field the host did not name is absent, as `undefined` is in Node.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ComFields {
    pub mode: Option<String>,
    pub ownership: Option<String>,
    pub visible: Option<bool>,
    pub app_pid: Option<Value>,
    pub window_hwnd: Option<Value>,
    pub foreground_activated: bool,
    /// `opened.backgroundIsolation || null`.
    pub background_isolation: Option<Value>,
    pub document_id: Option<Value>,
}

impl ComFields {
    /// `microsoftOfficeOpenFields(opened)`: identity copied from the host's answer without inventing a mode.
    pub fn from_opened(opened: &Value) -> Self {
        let field = |name: &str| opened.get(name).cloned();
        let text = |name: &str| opened.get(name).and_then(Value::as_str).map(str::to_owned);
        Self {
            mode: text("mode"),
            ownership: text("ownership"),
            visible: opened.get("visible").and_then(Value::as_bool),
            app_pid: field("appPid"),
            window_hwnd: field("windowHwnd"),
            foreground_activated: opened.get("foregroundActivated") == Some(&Value::Bool(true)),
            background_isolation: opened.get("backgroundIsolation").filter(|value| mixdog_office_base::values::truthy(value)).cloned(),
            document_id: field("documentId"),
        }
    }

    /// The fields as Node's object: absent ones are left out, the isolation is `null` when none.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        if let Some(mode) = &self.mode {
            map.insert("mode".to_owned(), Value::String(mode.clone()));
        }
        if let Some(ownership) = &self.ownership {
            map.insert("ownership".to_owned(), Value::String(ownership.clone()));
        }
        if let Some(visible) = self.visible {
            map.insert("visible".to_owned(), Value::Bool(visible));
        }
        if let Some(pid) = &self.app_pid {
            map.insert("appPid".to_owned(), pid.clone());
        }
        if let Some(hwnd) = &self.window_hwnd {
            map.insert("windowHwnd".to_owned(), hwnd.clone());
        }
        map.insert("foregroundActivated".to_owned(), Value::Bool(self.foreground_activated));
        map.insert("backgroundIsolation".to_owned(), self.background_isolation.clone().unwrap_or(Value::Null));
        if let Some(id) = &self.document_id {
            map.insert("documentId".to_owned(), id.clone());
        }
        Value::Object(map)
    }
}

/// `microsoftOfficeOpenFields(opened)` as Node's object.
pub fn microsoft_office_open_fields(opened: &Value) -> Value {
    ComFields::from_opened(opened).to_value()
}

/// `session.snapshotCache`: a snapshot kept for the version and request it answered.
#[derive(Clone, Debug)]
pub struct SnapshotCache {
    pub key: String,
    pub value: Value,
}

/// `session.recalculationCache`: the recalculation of one snapshot version.
#[derive(Clone, Debug)]
pub struct RecalculationCache {
    pub version: u64,
    pub result: Value,
}

/// What a session keeps between calls that belongs to one snapshot version or one delivery.
#[derive(Clone, Debug, Default)]
pub struct SessionCaches {
    pub snapshot: Option<SnapshotCache>,
    pub render: Option<Value>,
    pub page_render: Option<Value>,
    pub recalculation: Option<RecalculationCache>,
    pub preview_export_key: Option<String>,
    pub inline_audit: Option<Value>,
    pub trust_review: Option<Value>,
    /// The design as last delivered (`session.deliveredDesign`): the serialised design without its creative brief.
    pub delivered_design: Option<String>,
    /// The review guidance as last delivered (`session.deliveredModelReview`).
    pub delivered_model_review: Option<String>,
    pub delivered_receipt: Option<Value>,
}

/// What a deck authored by script and an HTML-sourced PDF record on the session.
#[derive(Clone, Debug, Default)]
pub struct AuthoredFields {
    /// `session.authored === true`: a deck written by script.
    pub authored: bool,
    pub brief: Option<Value>,
    pub frame: bool,
    pub frame_audit: Option<Value>,
    pub frame_receipt: Option<Value>,
    pub frame_design_issues: Option<Value>,
    pub html_source: Option<String>,
    pub html_source_edits: u64,
    pub print_sheet: bool,
    pub autofit_ranges: Vec<Value>,
}

/// One open document.
#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    /// The file the session was opened from.
    pub source: String,
    /// The file it reads and edits: the source itself, or its working copy (`<name>.mixdog-edit.<ext>`).
    pub target: String,
    pub file_kind: String,
    pub format: String,
    pub mode: Mode,
    pub backend: Backend,
    /// ISO time the session was opened.
    pub opened_at: String,
    pub data_dir: PathBuf,
    pub created: bool,
    /// Set by create: whether the target did not exist before.
    pub created_new_file: Option<bool>,
    /// Counts the edits that changed the document; every cache is keyed on it.
    pub snapshot_version: u64,
    /// The design in force; `None` until [`ensure_office_session_design`] bound one.
    pub design: Option<Value>,
    pub design_request: Option<Value>,
    pub design_library: Option<Value>,
    pub design_state: DesignState,
    pub state: SessionState,
    pub com: ComFields,
    /// The thread whose call created the session (the worker's pin rule).
    pub owner_thread: Option<String>,
    /// The session reads the source itself; the first edit makes the working copy.
    pub reads_source: bool,
    /// The legacy binary file this package was converted from.
    pub converted_from: String,
    pub create_receipt: Option<Value>,
    pub authored: AuthoredFields,
    pub caches: SessionCaches,
    /// The call's cancellation while an action runs on the session.
    pub active_signal: Option<CancellationToken>,
}

/// What a session is made of when it is opened or created (`buildOfficeSessionRecord`).
pub struct SessionInit {
    pub id: String,
    pub source: String,
    pub target: String,
    pub file_kind: String,
    pub format: String,
    pub mode: Mode,
    pub backend: Backend,
    pub opened_at: String,
    pub data_dir: PathBuf,
    pub created: bool,
    pub created_new_file: Option<bool>,
    pub design_state: DesignState,
}

impl Session {
    pub fn new(init: SessionInit) -> Self {
        Self {
            id: init.id,
            source: init.source,
            target: init.target,
            file_kind: init.file_kind,
            format: init.format,
            mode: init.mode,
            backend: init.backend,
            opened_at: init.opened_at,
            data_dir: init.data_dir,
            created: init.created,
            created_new_file: init.created_new_file,
            snapshot_version: 0,
            design: None,
            design_request: None,
            design_library: None,
            design_state: init.design_state,
            state: SessionState::Idle,
            com: ComFields::default(),
            owner_thread: None,
            reads_source: false,
            converted_from: String::new(),
            create_receipt: None,
            authored: AuthoredFields::default(),
            caches: SessionCaches::default(),
            active_signal: None,
        }
    }

    /// `isMicrosoftOfficeSession`.
    pub fn is_microsoft_office(&self) -> bool {
        self.backend == Backend::MicrosoftOfficeCom
    }

    /// `isInteractiveOfficeSession`.
    pub fn is_interactive(&self) -> bool {
        self.mode.is_interactive()
    }

    /// The session edits a copy of the document (the target is not the source) rather than the file itself.
    pub fn has_working_copy(&self) -> bool {
        self.target != self.source
    }

    /// `Object.assign(session, microsoftOfficeOpenFields(opened))`: what the COM host answered. A mode the host did not
    /// name leaves the session's own.
    pub fn apply_com_fields(&mut self, opened: &Value) {
        let fields = ComFields::from_opened(opened);
        if let Some(mode) = fields.mode.as_deref().and_then(Mode::parse) {
            self.mode = mode;
        }
        self.com = fields;
    }

    /// `Object.assign(session, designContext)`.
    pub fn apply_design_context(&mut self, context: DesignContext) {
        self.design_request = Some(context.design_request);
        self.design_library = context.design_library;
        self.design = Some(context.design);
    }

    /// The fields the result digest reads and keeps between results.
    pub fn result_session(&self) -> ResultSession {
        ResultSession {
            target: self.target.clone(),
            format: self.format.clone(),
            file_kind: self.file_kind.clone(),
            authored: self.authored.authored,
            facts_mode_sample: self.authored.brief.as_ref().and_then(|brief| brief.get("factsMode")).and_then(Value::as_str) == Some("sample"),
            delivered_design: self.caches.delivered_design.clone(),
            delivered_model_review: self.caches.delivered_model_review.clone(),
        }
    }

    /// Keeps what the digest delivered (`session.deliveredDesign`, `session.deliveredModelReview`).
    pub fn absorb_result_session(&mut self, delivered: ResultSession) {
        self.caches.delivered_design = delivered.delivered_design;
        self.caches.delivered_model_review = delivered.delivered_model_review;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // Port of `design-state defaults keep slide plans except for portable create` (core/office-session-record.test.mjs).
    #[test]
    fn design_state_defaults_keep_slide_plans_except_for_portable_create() {
        assert_eq!(
            mixdog_js::json_stringify(&DesignState::default().to_value()),
            r#"{"renderedVersion":null,"semanticCount":0,"requiresVisualReview":false,"slidePlans":[],"compositions":[]}"#
        );
        assert!(DesignState::empty(false, false).slide_plans.is_none());
        assert!(DesignState::empty(false, false).to_value().get("slidePlans").is_none());
        assert!(DesignState::empty(true, true).requires_visual_review);
    }

    // Port of `COM open fields copy identity without inventing a mode`.
    #[test]
    fn com_open_fields_copy_identity_without_inventing_a_mode() {
        let opened = json!({
            "mode": "background", "ownership": "owned", "visible": false, "appPid": 12, "windowHwnd": 34,
            "foregroundActivated": true, "backgroundIsolation": { "desktop": "mixdog" }, "documentId": "doc-1"
        });
        assert_eq!(microsoft_office_open_fields(&opened), opened);
        let empty = ComFields::from_opened(&json!({}));
        assert!(!empty.foreground_activated);
        assert!(empty.background_isolation.is_none());
        assert!(empty.mode.is_none());
        assert_eq!(empty.to_value(), json!({ "foregroundActivated": false, "backgroundIsolation": null }));
    }

    #[test]
    fn modes_and_backends_round_trip_their_names() {
        for mode in [Mode::Background, Mode::Portable, Mode::Attach, Mode::Visible] {
            assert_eq!(Mode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(Mode::parse("live"), Some(Mode::Attach));
        assert!(Mode::Visible.is_interactive() && Mode::Attach.is_interactive());
        assert!(!Mode::Background.is_interactive() && !Mode::Portable.is_interactive());
        for backend in [Backend::MixdogOoxml, Backend::MixdogPdf, Backend::MixdogTabular, Backend::MicrosoftOfficeCom] {
            assert_eq!(Backend::parse(backend.as_str()), Some(backend));
        }
    }

    #[test]
    fn a_transaction_closes_once() {
        let mut state = SessionState::InTransaction(Box::new(Transaction {
            id: "office_tx_1".to_owned(),
            started_at: String::new(),
            checkpoint: String::new(),
            baseline_pdf: String::new(),
            before_fingerprint: Value::Null,
            expected_fingerprint: Value::Null,
            before_document: Value::Null,
            current_document: Value::Null,
            operation_changes: Vec::new(),
            undo_units: 0,
            diff: Value::Null,
            phase: TransactionPhase::parse("rolling_back"),
            review: None,
            journal_path: None,
        }));
        assert_eq!(state.transaction().map(|transaction| transaction.phase), Some(TransactionPhase::RollingBack));
        assert_eq!(state.close().map(|transaction| transaction.id), Some("office_tx_1".to_owned()));
        assert!(state.close().is_none() && state.transaction().is_none());
    }
}
