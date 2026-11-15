//! The session state of `office-com-session-host.ps1` and the lifecycle around it.
//!
//! * [`open`]: `Open-SessionState` (ownership, finding the document a running application holds, a new application whose
//!   process is identified before anything is opened) and the `open_session` answer.
//! * [`create`]: `Create-OwnedDocument`, the new document with the portable template's defaults.
//! * [`isolation`]: `Enforce-BackgroundIsolation` and `Session-Response`.
//! * [`cleanup`]: `Close-SessionState`, the `close_session` request and `Write-OfficeCleanupFailure`'s record.
//! * [`chart_excel`]: the Excel applications embedded chart data starts, and their cleanup.
//!
//! The state holds the only long-lived references to the application and the document: a reference dropped is a reference
//! released, so an application that accepted `Quit` really goes (the PowerShell host forced that with `GC.Collect`).

pub mod chart_excel;
pub mod cleanup;
pub mod create;
pub mod isolation;
pub mod open;

use crate::com::Obj;
use crate::identity::Ownership;
use crate::platform::Platform;

pub use chart_excel::ChartExcel;
pub use cleanup::Cleanup;
pub use cleanup::close_session;
pub use cleanup::close_session_state;
pub use isolation::session_response;
pub use open::open_session_response;
pub use open::open_session_state;

/// How the session sees its application.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The user's running application and the document it holds.
    Attach,
    /// A new application the user can see.
    Visible,
    /// A new application of the host's own, kept out of sight.
    Background,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Attach => "attach",
            Mode::Visible => "visible",
            Mode::Background => "background",
        }
    }
}

/// `$state.Ownership` as the answers spell it.
pub fn ownership_text(ownership: Ownership) -> &'static str {
    match ownership {
        Ownership::Owned => "owned",
        Ownership::Attached => "attached",
    }
}

/// What a failed open is cleaned up from: the references and what decides how they are ended.
pub(crate) struct Leftovers {
    pub format: String,
    pub mode: Mode,
    pub ownership: Ownership,
    pub owns_application: bool,
    pub app_pid: i32,
    pub app_start_ticks: i64,
    pub app: Option<Obj>,
    pub document: Option<Obj>,
}

/// `$state` of the session host.
pub struct SessionState {
    pub id: String,
    pub format: String,
    pub path: String,
    pub mode: Mode,
    pub ownership: Ownership,
    /// The application is this host's own process (it was started by this session and no other session shares it).
    pub owns_application: bool,
    /// .NET ticks of the application process's start: the identity a forced cleanup is held to.
    pub app_start_ticks: i64,
    pub app: Option<Obj>,
    pub document: Option<Obj>,
    pub visible: bool,
    pub app_pid: i32,
    pub window_hwnd: i64,
    pub foreground_activated: bool,
    pub foreground_before_action: i64,
    pub isolated_process: bool,
    pub background_isolation_checks: i32,
    pub background_hidden_windows: i32,
    pub background_focus_restorations: i32,
    pub excel_dpi_repairs: i32,
    pub pptx_exports: i32,
    /// `<format>:<lowercased path>`.
    pub document_id: String,
    /// The Excel applications chart data of this session's slides started.
    pub chart_excel: ChartExcel,
}

impl SessionState {
    pub(crate) fn from_leftovers(leftovers: Leftovers) -> SessionState {
        SessionState {
            id: String::new(),
            format: leftovers.format,
            path: String::new(),
            mode: leftovers.mode,
            ownership: leftovers.ownership,
            owns_application: leftovers.owns_application,
            app_start_ticks: leftovers.app_start_ticks,
            app: leftovers.app,
            document: leftovers.document,
            visible: leftovers.mode != Mode::Background,
            app_pid: leftovers.app_pid,
            window_hwnd: 0,
            foreground_activated: false,
            foreground_before_action: 0,
            isolated_process: false,
            background_isolation_checks: 0,
            background_hidden_windows: 0,
            background_focus_restorations: 0,
            excel_dpi_repairs: 0,
            pptx_exports: 0,
            document_id: String::new(),
            chart_excel: ChartExcel::default(),
        }
    }

    /// `$state.ForegroundBeforeAction = ForegroundWindow()`, before every action of an open session.
    pub fn record_foreground(&mut self, platform: &dyn Platform) {
        self.foreground_before_action = platform.foreground_window();
    }
}
