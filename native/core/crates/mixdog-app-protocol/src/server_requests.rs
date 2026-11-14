//! Requests from the core to clients (P §8.1, R18, R41, DS §12.3–12.4).
//! `mcpServer/elicitation/request` is not in the 1.4.6 set (R41).

#[cfg(feature = "codegen")]
use mixdog_protocol::JsonValue;
#[cfg(feature = "codegen")]
use mixdog_protocol::ToolApprovalDecision;

use crate::v2::approval::*;
use crate::v2::host::*;
use crate::v2::computer_host::*;
use crate::v2::browser_engine::*;
use crate::v2::connections::*;

crate::server_request_definitions! {
    /// Every tool approval, including human gates (`kind: humanGate`).
    ToolRequestApproval => "item/tool/requestApproval" {
        params: ToolApprovalRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// `ask_user` questions, including room hand-off questions.
    ToolRequestUserInput => "item/tool/requestUserInput" {
        params: UserInputRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    PermissionsRequestApproval => "item/permissions/requestApproval" {
        params: PermissionsRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// Raised by the core's browser policy; any eligible client presents it.
    BrowserRequestApproval => "item/browser/requestApproval" {
        params: BrowserApprovalRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// PC access for computer use.
    ComputerRequestApproval => "item/computer/requestApproval" {
        params: ComputerApprovalRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// `browser` / `browser_devtools` tool actions and UI browser commands.
    HostBrowserCommand => "host/browser/command" {
        params: HostCommandParams,
        result: JsonValue,
        requires: Some("host.browser"),
    },
    /// A phone's live-view resize or video limit for a viewed browser page.
    HostBrowserLiveControl => "host/browser/liveControl" {
        params: HostBrowserLiveControlParams,
        result: JsonValue,
        requires: Some("host.browser"),
    },
    /// The page a session's command works on, opened or adopted when needed.
    HostBrowserPagesResolve => "host/browser/pages/resolve" {
        params: HostBrowserPagesResolveParams,
        result: HostBrowserPagesResolveResult,
        requires: Some("host.browserEngine"),
    },
    /// The pages of a session.
    HostBrowserPagesList => "host/browser/pages/list" {
        params: HostBrowserPagesListParams,
        result: HostBrowserPagesListResult,
        requires: Some("host.browserEngine"),
    },
    /// Close a page.
    HostBrowserPagesClose => "host/browser/pages/close" {
        params: HostBrowserPagesCloseParams,
        result: HostBrowserPagesCloseResult,
        requires: Some("host.browserEngine"),
    },
    /// Show, hide or hand off the pane of a session.
    HostBrowserPagesSurface => "host/browser/pages/surface" {
        params: HostBrowserPagesSurfaceParams,
        result: HostBrowserPagesSurfaceResult,
        requires: Some("host.browserEngine"),
    },
    /// Navigate a page (url, reload, back, forward).
    HostBrowserPageNavigate => "host/browser/page/navigate" {
        params: HostBrowserPageNavigateParams,
        result: HostBrowserPageNavigateResult,
        requires: Some("host.browserEngine"),
    },
    /// Stop a page's loading.
    HostBrowserPageStop => "host/browser/page/stop" {
        params: HostBrowserPageStopParams,
        result: HostBrowserPageFactsResult,
        requires: Some("host.browserEngine"),
    },
    /// Evaluate an expression in a page or frame.
    HostBrowserPageEval => "host/browser/page/eval" {
        params: HostBrowserPageEvalParams,
        result: HostBrowserPageEvalResult,
        requires: Some("host.browserEngine"),
    },
    /// Read a page's text, documents or frames.
    HostBrowserPageRead => "host/browser/page/read" {
        params: HostBrowserPageReadParams,
        result: HostBrowserPageReadResult,
        requires: Some("host.browserEngine"),
    },
    /// Wait for a page's next render.
    HostBrowserPageRenderCheckpoint => "host/browser/page/renderCheckpoint" {
        params: HostBrowserPageRenderCheckpointParams,
        result: HostBrowserPageRenderCheckpointResult,
        requires: Some("host.browserEngine"),
    },
    /// Wait until a page's DOM stopped changing.
    HostBrowserPageDomQuiet => "host/browser/page/domQuiet" {
        params: HostBrowserPageDomQuietParams,
        result: HostBrowserPageDomQuietResult,
        requires: Some("host.browserEngine"),
    },
    /// Answer the dialog a page is blocked on.
    HostBrowserPageDialogAnswer => "host/browser/page/dialog/answer" {
        params: HostBrowserPageDialogAnswerParams,
        result: HostBrowserPageDialogAnswerResult,
        requires: Some("host.browserEngine"),
    },
    /// Resync a page's facts and console floor after a seq gap.
    HostBrowserPageSync => "host/browser/page/sync" {
        params: HostBrowserPageSyncParams,
        result: HostBrowserPageSyncResult,
        requires: Some("host.browserEngine"),
    },
    /// The accessibility snapshot of a page.
    HostBrowserSnapshot => "host/browser/snapshot" {
        params: HostBrowserSnapshotParams,
        result: HostBrowserSnapshotResult,
        requires: Some("host.browserEngine"),
    },
    /// Call a function on the element a snapshot ref names.
    HostBrowserRefCall => "host/browser/ref/call" {
        params: HostBrowserRefCallParams,
        result: HostBrowserRefCallResult,
        requires: Some("host.browserEngine"),
    },
    /// Mint refs for the nodes a CSS selector names in the top document.
    HostBrowserRefMint => "host/browser/ref/mint" {
        params: HostBrowserRefMintParams,
        result: HostBrowserRefMintResult,
        requires: Some("host.browserEngine"),
    },
    /// Dispatch a batch of keyboard and pointer steps.
    HostBrowserInputBatch => "host/browser/input/batch" {
        params: HostBrowserInputBatchParams,
        result: HostBrowserInputBatchResult,
        requires: Some("host.browserEngine"),
    },
    /// Capture a page.
    HostBrowserScreenshot => "host/browser/screenshot" {
        params: HostBrowserScreenshotParams,
        result: HostBrowserScreenshotResult,
        requires: Some("host.browserEngine"),
    },
    /// Send an allowlisted CDP command through the host's fenced executor.
    HostBrowserCdpSend => "host/browser/cdp/send" {
        params: HostBrowserCdpSendParams,
        result: HostBrowserCdpSendResult,
        requires: Some("host.browserEngine"),
    },
    /// Read or change a page's cookies.
    HostBrowserCookies => "host/browser/cookies" {
        params: HostBrowserCookiesParams,
        result: HostBrowserCookiesResult,
        requires: Some("host.browserEngine"),
    },
    /// Read or change a page's local or session storage.
    HostBrowserStorage => "host/browser/storage" {
        params: HostBrowserStorageParams,
        result: HostBrowserStorageResult,
        requires: Some("host.browserEngine"),
    },
    /// Add, remove or list scripts run on every new document.
    HostBrowserInitScripts => "host/browser/initScripts" {
        params: HostBrowserInitScriptsParams,
        result: HostBrowserInitScriptsResult,
        requires: Some("host.browserEngine"),
    },
    /// Add, remove or list request intercept rules.
    HostBrowserIntercept => "host/browser/intercept" {
        params: HostBrowserInterceptParams,
        result: HostBrowserInterceptResult,
        requires: Some("host.browserEngine"),
    },
    /// Start or stop a performance trace, or read metrics.
    HostBrowserPerformance => "host/browser/performance" {
        params: HostBrowserPerformanceParams,
        result: HostBrowserPerformanceResult,
        requires: Some("host.browserEngine"),
    },
    /// Set or clear a page's emulation overrides (the host owns the Emulation domain).
    HostBrowserEmulation => "host/browser/emulation" {
        params: HostBrowserEmulationParams,
        result: HostBrowserEmulationResult,
        requires: Some("host.browserEngine"),
    },
    /// List or take a session's downloads.
    HostBrowserDownloads => "host/browser/downloads" {
        params: HostBrowserDownloadsParams,
        result: HostBrowserDownloadsResult,
        requires: Some("host.browserEngine"),
    },
    /// Put files into a file input, chooser, drop target or picker.
    HostBrowserUpload => "host/browser/upload" {
        params: HostBrowserUploadParams,
        result: HostBrowserUploadResult,
        requires: Some("host.browserEngine"),
    },
    /// The frame document an upload would land in now: the one the ref's element lives in, or the picker the page already opened (no ref).
    HostBrowserUploadReceiver => "host/browser/upload/receiver" {
        params: HostBrowserUploadReceiverParams,
        result: HostBrowserUploadReceiverResult,
        requires: Some("host.browserEngine"),
    },
    /// The sign-in state the desktop keeps for the page: before a click, fill or type it notes the field the agent names (provider sign-in), and after
    /// a command it signs in with a saved login when the page asks for one and answers the note, and the identity line a provider flow last used.
    HostBrowserSignIn => "host/browser/signIn" {
        params: HostBrowserSignInParams,
        result: HostBrowserSignInResult,
        requires: Some("host.browserEngine"),
    },
    /// `fill` with a saved account: the desktop writes the stored login's password into the page and answers whether the form took it.
    HostBrowserCredentialsFill => "host/browser/credentials/fill" {
        params: HostBrowserCredentialsFillParams,
        result: HostBrowserCredentialsFillResult,
        requires: Some("host.browserEngine"),
    },
    /// A session's turn ended, or the session was released: the desktop drops what it remembered of them.
    HostBrowserTurn => "host/browser/turn" {
        params: HostBrowserTurnParams,
        result: HostBrowserTurnResult,
        requires: Some("host.browserEngine"),
    },
    /// The displays of this PC's screen, for the phone's remote-screen picker.
    HostScreenDisplays => "host/screen/displays" {
        params: ScreenDisplaysParams,
        result: JsonValue,
        requires: Some("host.browser"),
    },
    /// A Computer Use screen capture, taken and encoded by the desktop's computer host.
    HostComputerCapture => "host/computer/capture" {
        params: HostComputerCaptureParams,
        result: HostComputerCaptureResult,
        requires: Some("host.computer"),
    },
    /// The displays of this PC as the computer host reports them.
    HostComputerDisplays => "host/computer/displays" {
        params: HostComputerDisplaysParams,
        result: Vec<HostComputerDisplay>,
        requires: Some("host.computer"),
    },
    /// A Computer Use helper's foreground-lock request, relayed to the desktop that owns the lease.
    HostComputerForegroundLease => "host/computer/foregroundLease" {
        params: HostComputerForegroundLeaseParams,
        result: HostComputerForegroundLeaseResult,
        requires: Some("host.computer"),
    },
    /// The desktop's own Computer Use windows, which the core leaves out of every window list.
    HostComputerInternalWindows => "host/computer/internalWindows" {
        params: HostComputerInternalWindowsParams,
        result: HostComputerInternalWindowsResult,
        requires: Some("host.computer"),
    },
    /// A Computer Use helper's pointer progress, for the overlay's arrow.
    HostComputerPointerFeedback => "host/computer/pointerFeedback" {
        params: HostComputerPointerFeedbackParams,
        result: (),
        requires: Some("host.computer"),
    },
    /// A Computer Use capture, encoded by the desktop and uploaded with blob/put.
    HostComputerPixels => "host/computer/pixels" {
        params: HostComputerPixelsParams,
        result: HostComputerPixelsResult,
        requires: Some("host.computer"),
    },
    /// The desktop's own windows a session may read and drive.
    HostComputerAppWindows => "host/computer/appWindows" {
        params: HostComputerAppWindowsParams,
        result: HostComputerAppWindowsResult,
        requires: Some("host.computer"),
    },
    /// Input into one of the desktop's own windows through its renderer.
    HostComputerAppInput => "host/computer/appInput" {
        params: HostComputerAppInputParams,
        result: HostComputerAppInputResult,
        requires: Some("host.computer"),
    },
    /// Ready the agent's arrow (answered within 750 ms).
    HostComputerCursorPrepare => "host/computer/cursorPrepare" {
        params: HostComputerCursorPrepareParams,
        result: HostComputerCursorPrepareResult,
        requires: Some("host.computer"),
    },
    /// The OS grants the desktop reads.
    HostComputerPermissions => "host/computer/permissions" {
        params: HostComputerPermissionsParams,
        result: HostComputerPermissionsResult,
        requires: Some("host.computer"),
    },
    /// A whole bridge command for the legacy Windows PowerShell host (dual path only).
    HostComputerCommand => "host/computer/command" {
        params: HostComputerCommandParams,
        result: HostComputerCommandResult,
        requires: Some("host.computer"),
    },
    HostVisualizeCommand => "host/visualize/command" {
        params: HostVisualizeCommandParams,
        result: Option<JsonValue>,
        requires: Some("host.visualize"),
    },
    HostSystemProxyResolve => "host/systemProxy/resolve" {
        params: HostSystemProxyResolveParams,
        result: HostSystemProxyResolveResponse,
        requires: Some("host.systemProxy"),
    },
    /// This PC's notification support and system idle time, which decides whether paired
    /// devices hold their pushes (Node's host method `notificationStatus`).
    HostNotificationStatus => "host/notification/status" {
        params: HostNotificationStatusParams,
        result: HostNotificationStatus,
        requires: Some("host.notifications"),
    },
    HostUpdateCommand => "host/update/command" {
        params: HostUpdateCommandParams,
        result: JsonValue,
        requires: Some("host.updater"),
    },
    HostCaptureFileSnapshot => "host/capture/fileSnapshot" {
        params: HostFileSnapshotParams,
        result: HostFileSnapshot,
        requires: Some("host.files"),
    },
    HostLocalPageUrl => "host/localPage/url" {
        params: HostLocalPageUrlParams,
        result: String,
        requires: Some("host.files"),
    },
    /// The OS trash is the desktop window's (Node's `trashItem` host request).
    HostFilesTrashItem => "host/files/trashItem" {
        params: HostFilesTrashItemParams,
        result: JsonValue,
        requires: Some("host.files"),
    },
    /// Opens (or focuses) the window of a server (`showConnectionWindow`); `opened` is false when the window could not be made.
    HostWindowOpen => "host/window/open" {
        params: HostWindowOpenParams,
        result: HostWindowOpenResult,
        requires: Some("host.windows"),
    },
    /// Closes the window of a server.
    HostWindowClose => "host/window/close" {
        params: HostWindowCloseParams,
        result: crate::v2::feed::EmptyResult,
        requires: Some("host.windows"),
    },
    /// Shows and focuses a window, and with `sessionId` the session in it; `local` is the main window.
    HostWindowFocus => "host/window/focus" {
        params: HostWindowFocusParams,
        result: crate::v2::feed::EmptyResult,
        requires: Some("host.windows"),
    },
    /// A server core's model call executed with this machine's accounts.
    ModelProxyExecute => "model/proxy/execute" {
        params: ModelProxyExecuteParams,
        result: ModelProxyResult,
        requires: Some("modelProxy"),
    },
}
