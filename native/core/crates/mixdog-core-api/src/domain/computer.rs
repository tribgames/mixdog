//! The one computer-use backend (DS §11, SPEC §4.8): serves the `computer`
//! tool and remote screen control from a paired phone, and is the frame
//! source for screen share. The secure desktop (UAC, lock screen) is part of
//! the same backend.

use async_trait::async_trait;
use mixdog_protocol::JsonValue;
use tokio_util::sync::CancellationToken;

use super::media::MediaFrameSource;
use super::tool::ToolPart;

/// `computer` tool actions (`tool-schemas.json`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ComputerAction {
    List,
    Diagnose,
    Capture,
    Verify,
    WaitForUser,
    Act,
    Window,
    Menu,
    Clipboard,
    Launch,
    SavedLogin,
}

impl ComputerAction {
    pub const ALL: [ComputerAction; 11] = [
        Self::List,
        Self::Diagnose,
        Self::Capture,
        Self::Verify,
        Self::WaitForUser,
        Self::Act,
        Self::Window,
        Self::Menu,
        Self::Clipboard,
        Self::Launch,
        Self::SavedLogin,
    ];

    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Diagnose => "diagnose",
            Self::Capture => "capture",
            Self::Verify => "verify",
            Self::WaitForUser => "wait_for_user",
            Self::Act => "act",
            Self::Window => "window",
            Self::Menu => "menu",
            Self::Clipboard => "clipboard",
            Self::Launch => "launch",
            Self::SavedLogin => "saved_login",
        }
    }

    pub fn from_wire(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|a| a.wire_name() == name)
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ComputerRequest {
    pub action: ComputerAction,
    /// The tool's `input` object, schema-validated.
    pub input: JsonValue,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ComputerError {
    /// Backend or permission missing on this OS/session.
    Unavailable {
        reason: String,
    },
    InvalidInput {
        reason: String,
    },
    /// PC access not approved.
    Denied,
    Cancelled,
    Failed {
        code: String,
        message: String,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PointerButton {
    Left,
    Right,
    Middle,
}

/// Remote-control input in display pixels of the shared screen.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ScreenInput {
    Move {
        x: i32,
        y: i32,
    },
    Button {
        button: PointerButton,
        down: bool,
        at: Option<(i32, i32)>,
    },
    Wheel {
        x: i32,
        y: i32,
        dx: i32,
        dy: i32,
    },
    Key {
        vk: u32,
        scan: u32,
        extended: bool,
        down: bool,
    },
    Text(String),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InputOutcome {
    Applied,
    /// The input desktop changed (secure desktop up, session switch).
    Rejected,
}

/// Where injected input lands now.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DesktopIdentity {
    pub session: u32,
    /// Input desktop object name, lower-cased.
    pub desktop: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct DisplayId(pub u32);

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DisplayInfo {
    pub id: DisplayId,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Scale factor in percent (100 = 1.0).
    pub scale_percent: u32,
}

/// Published as section `computer` for the overlay.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ComputerStatus {
    pub active: bool,
    pub observe_only: bool,
    pub controller: Option<String>,
}

#[async_trait]
pub trait ComputerBackend: Send + Sync {
    /// One `computer` tool action; runs on the backend's session thread.
    async fn run(
        &self,
        request: ComputerRequest,
        cancel: CancellationToken,
    ) -> Result<Vec<ToolPart>, ComputerError>;
    /// Phone remote-control input, injected in-process.
    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError>;
    /// Releases every key and button this backend holds down; returns the count.
    fn release_input(&self) -> Result<u32, ComputerError>;
    /// `None` while the input desktop is unreadable.
    fn input_desktop(&self) -> Option<DesktopIdentity>;
    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError>;
    fn screen_source(&self, display: DisplayId)
    -> Result<Box<dyn MediaFrameSource>, ComputerError>;
    fn status(&self) -> ComputerStatus;
}
