//! Who may call the connections methods. In the desktop this was the Electron sender frame (`senderRoute`: only the frame of
//! this PC's main window managed servers); the core knows the caller by its connection: [`CallContext::window`] names the window
//! a socket belongs to and its role, [`CallContext::host_claimant`] says whether it is the desktop's host channel.
//!
//! The callers a method names (its row in the method table):
//! - M: this PC's main window, or the host claimant ([`require_main`]).
//! - S: the server window of the connection the call names ([`require_server`]).
//! - M or S: either ([`require_main_or_server`]).
//! - H: the host claimant only ([`require_host`]).
//!
//! A connection that is neither a window nor the host (a client of this core that is not the desktop) is none of them. Nothing
//! here asks the user for anything: a caller that is refused is refused by what it is.

use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::call::WindowRole;
use mixdog_core_api::call::WindowScope;

fn refused(ctx: &CallContext, method: &str) -> CoreError {
    CoreError::PermissionDenied { method: method.into(), origin: ctx.origin }
}

fn is_main(ctx: &CallContext) -> bool {
    ctx.host_claimant || matches!(&ctx.window, Some(WindowScope { role: WindowRole::Main, .. }))
}

fn own_server(ctx: &CallContext) -> Option<&str> {
    match &ctx.window {
        Some(WindowScope { role: WindowRole::Server { connection_id }, .. }) => Some(connection_id),
        _ => None,
    }
}

/// M: the main window or the host claimant. A server window is refused: it never manages servers.
pub fn require_main(ctx: &CallContext, method: &str) -> Result<(), CoreError> {
    if is_main(ctx) { Ok(()) } else { Err(refused(ctx, method)) }
}

/// H: only the host claimant (the desktop's main process), for what needs the server token or the host's own lists.
pub fn require_host(ctx: &CallContext, method: &str) -> Result<(), CoreError> {
    if ctx.host_claimant { Ok(()) } else { Err(refused(ctx, method)) }
}

/// S: the server window of `connection_id`, and no other (a server window that names another connection's id is refused).
pub fn require_server(ctx: &CallContext, method: &str, connection_id: &str) -> Result<(), CoreError> {
    if own_server(ctx) == Some(connection_id) { Ok(()) } else { Err(refused(ctx, method)) }
}

/// M or S: the main window and the host claimant for any connection, a server window for its own.
pub fn require_main_or_server(ctx: &CallContext, method: &str, connection_id: &str) -> Result<(), CoreError> {
    if is_main(ctx) { Ok(()) } else { require_server(ctx, method, connection_id) }
}

/// `connections/subscribe`: what the caller's subscription may carry. The main window and the host may ask for everything
/// (`None`) or one connection; a server window gets its own connection only, whether it names it or leaves the id out, and
/// another one is refused. The result is the connection the subscription is limited to.
pub fn subscription_scope(ctx: &CallContext, method: &str, requested: Option<&str>) -> Result<Option<String>, CoreError> {
    if is_main(ctx) {
        return Ok(requested.map(str::to_owned));
    }
    match (own_server(ctx), requested) {
        (Some(own), None) => Ok(Some(own.to_owned())),
        (Some(own), Some(asked)) if own == asked => Ok(Some(own.to_owned())),
        _ => Err(refused(ctx, method)),
    }
}

/// Who a method admits (the `Caller:` of its row in the method table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Callers {
    /// M.
    Main,
    /// M or S.
    MainOrServer,
    /// S.
    Server,
    /// H.
    Host,
}

/// The callers of every `connections/*` and `remoteHosts/*` method. `remoteHosts/list` names H or M, and H is part of M.
const TABLE: &[(&str, Callers)] = &[
    ("connections/subscribe", Callers::MainOrServer),
    ("connections/unsubscribe", Callers::MainOrServer),
    ("connections/ssh/list", Callers::Main),
    ("connections/ssh/rename", Callers::Main),
    ("connections/ssh/forget", Callers::Main),
    ("connections/ssh/open", Callers::Main),
    ("connections/ssh/configHosts", Callers::Main),
    ("connections/ssh/inspect", Callers::Main),
    ("connections/ssh/connect", Callers::Main),
    ("connections/ssh/cancel", Callers::Main),
    ("connections/ssh/askpassReply", Callers::Main),
    ("connections/ssh/cleanup", Callers::Main),
    ("connections/ssh/updateSettings", Callers::Main),
    ("connections/ssh/diagnosticsLog", Callers::MainOrServer),
    ("connections/ssh/diagnosticsCopy", Callers::MainOrServer),
    ("connections/ssh/serverLog", Callers::MainOrServer),
    ("connections/ssh/serverLogins", Callers::Main),
    ("connections/ssh/serverLoginBegin", Callers::Main),
    ("connections/ssh/serverLoginStatus", Callers::Main),
    ("connections/ssh/serverLoginComplete", Callers::Main),
    ("connections/ssh/serverLoginCancel", Callers::Main),
    ("connections/ssh/serverLoginSaveKey", Callers::Main),
    ("connections/ssh/serverLoginLogout", Callers::Main),
    ("connections/ssh/serverLoginRemoveCustom", Callers::Main),
    ("connections/ssh/openEphemeral", Callers::Host),
    ("connections/link/get", Callers::MainOrServer),
    ("connections/link/retry", Callers::MainOrServer),
    ("connections/link/retryNow", Callers::MainOrServer),
    ("connections/link/requestSignIn", Callers::Server),
    ("connections/ports/list", Callers::MainOrServer),
    ("connections/ports/forward", Callers::Server),
    ("connections/ports/stop", Callers::Server),
    ("connections/ports/dismiss", Callers::Server),
    ("connections/restore/get", Callers::Main),
    ("connections/restore/set", Callers::Main),
    ("connections/restore/progress", Callers::Main),
    ("connections/endpoint", Callers::Host),
    ("remoteHosts/list", Callers::Main),
    ("remoteHosts/redeemCode", Callers::Host),
    ("remoteHosts/rename", Callers::Host),
    ("remoteHosts/forget", Callers::Host),
    ("remoteHosts/touch", Callers::Host),
    ("remoteHosts/presence", Callers::Host),
];

/// Who `method` admits; `None` for a method that is not one of the connections methods.
pub fn callers(method: &str) -> Option<Callers> {
    TABLE.iter().find(|(name, _)| *name == method).map(|(_, callers)| *callers)
}

/// Every method of the table.
pub fn methods() -> impl Iterator<Item = &'static str> {
    TABLE.iter().map(|(name, _)| *name)
}

/// Whether the caller of `method` is one it admits. `connection_id` is the connection the params name; a server window that
/// names none is taken to mean its own (the server's window gate leaves the id out as it does), one that names another is refused.
pub fn authorize(ctx: &CallContext, method: &str, connection_id: Option<&str>) -> Result<(), CoreError> {
    let Some(callers) = callers(method) else { return Err(refused(ctx, method)) };
    let own = || connection_id.or_else(|| own_server(ctx));
    match callers {
        Callers::Main => require_main(ctx, method),
        Callers::Host => require_host(ctx, method),
        Callers::MainOrServer => match own() {
            Some(id) => require_main_or_server(ctx, method, id),
            None => require_main(ctx, method),
        },
        Callers::Server => match own() {
            Some(id) => require_server(ctx, method, id),
            None => Err(refused(ctx, method)),
        },
    }
}
