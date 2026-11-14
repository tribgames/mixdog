//! What a window-scoped connection may not call: the host-role methods listed in one table (`window_methods.json`), parsed once.
//! Every other method is open to a window, as it was through the desktop main process.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::v1::InitializeParams;

/// The table's version; a change of the table's meaning raises it.
pub const WINDOW_SCOPE_VERSION: u32 = 2;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Table<'a> {
    version: u32,
    #[serde(borrow)]
    methods: BTreeSet<&'a str>,
}

/// A method a window-scoped connection may not call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowDenial {
    pub method: String,
}

fn table() -> &'static Table<'static> {
    static TABLE: OnceLock<Table<'static>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table: Table<'static> = serde_json::from_str(include_str!("window_methods.json")).expect("window_methods.json is the table");
        assert_eq!(table.version, WINDOW_SCOPE_VERSION, "window_methods.json is version {WINDOW_SCOPE_VERSION}");
        table
    })
}

/// Whether a window-scoped connection may call `method`: every method except the host-role ones the table lists.
pub fn allows(method: &str) -> Result<(), WindowDenial> {
    if table().methods.contains(method) { Err(WindowDenial { method: method.to_owned() }) } else { Ok(()) }
}

/// Whether a window may send these `initialize` params: a window is never the host and never executes model proxy calls,
/// so params that claim either capability are refused.
pub fn allows_initialize(params: &InitializeParams) -> Result<(), WindowDenial> {
    let claims_host_role = params.capabilities.as_ref().is_some_and(|c| c.host.is_some() || c.model_proxy == Some(true));
    if claims_host_role { Err(WindowDenial { method: "initialize".to_owned() }) } else { Ok(()) }
}

/// A server-role window is held to its own server connection: a call that names another `connectionId` is refused.
/// A call that names none is the window's own.
pub fn server_window_allows(own_connection_id: &str, requested: Option<&str>) -> Result<(), WindowDenial> {
    match requested {
        Some(id) if id != own_connection_id => Err(WindowDenial { method: format!("connectionId {id}") }),
        _ => Ok(()),
    }
}

/// Every method the table names.
#[cfg(test)]
pub(super) fn table_methods() -> impl Iterator<Item = &'static str> {
    table().methods.iter().copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::methods::CLIENT_METHODS;

    fn params(json: &str) -> InitializeParams {
        serde_json::from_str(json).expect("initialize params")
    }

    #[test]
    fn host_role_refused() {
        for method in table_methods() {
            assert!(allows(method).is_err(), "{method} is host-role");
            assert!(method.starts_with("host/") || ["modelProxy/run", "process/kill", "process/resizePty", "process/spawn", "process/writeStdin",
                "connections/endpoint", "projectFs/localPage/revokeOwner", "test/browserEngine/run", "migrate/profile/adopt", "dev/computer/run",
                "connections/ssh/openEphemeral", "computer/userControl", "desktop/workflowConfig/read", "migrate/profile/status",
                "projectFs/localPage/virtual", "computer/bridge/run", "computer/bridge/abort", "desktop/launchVersion/record",
                "desktop/modelBootstrap/read", "desktop/nativeToolCache/gc",
                "browser/bridge/run", "browser/bridge/turn", "browser/bridge/abort", "remoteHosts/touch", "transfer/serverDownload/begin", "transfer/serverDownload/step",
                "transfer/serverDownload/finish", "transfer/serverDownload/abort", "transfer/serverDownload/check"].contains(&method), "{method} is not a host-role method");
        }
        assert!(allows_initialize(&params(r#"{"clientInfo":{"name":"w","version":"1","kind":"desktop"},"capabilities":{"host":{}}}"#)).is_err());
        assert!(allows_initialize(&params(r#"{"clientInfo":{"name":"w","version":"1","kind":"desktop"},"capabilities":{"modelProxy":true}}"#)).is_err());
        assert!(allows_initialize(&params(r#"{"clientInfo":{"name":"w","version":"1","kind":"desktop"},"capabilities":{"approvalsInbox":true}}"#)).is_ok());
        assert!(allows_initialize(&params(r#"{"clientInfo":{"name":"w","version":"1","kind":"desktop"}}"#)).is_ok());
    }

    /// Every method a renderer lane reached through main (sessions, files, scm, settings, pcAccess, remoteHosts, approvals,
    /// terminal, connections other than the endpoint) passes: the whole table minus the host-role list is open.
    #[test]
    fn every_direct_key_allowed() {
        for spec in CLIENT_METHODS {
            if !table().methods.contains(spec.method) {
                assert!(allows(spec.method).is_ok(), "{} is not host-role", spec.method);
            }
        }
        for method in ["projectFs/listDir", "projectFs/readText", "projectFs/writeText", "projectFs/localPageUrl", "projectFs/localPage/origin",
            "projectFs/localPage/assetType", "connections/ssh/connect", "connections/subscribe", "initialize", "app/subscribe", "blob/read",
            // The renderer reaches these through main today (Connection settings, the PC access row, the remote host list,
            // the takeover card and the link, attachment and font lanes): a window keeps them.
            "connections/ssh/open", "connections/link/get", "connections/ports/forward", "remoteHosts/list", "remoteHosts/redeemCode",
            "remoteHosts/rename", "remoteHosts/forget", "remoteHosts/presence", "pcAccess/readiness", "pcAccess/approve", "takeover/ready", "takeover/state",
            "desktop/link/resolve", "desktop/attachment/resolve", "desktop/attachment/stage", "desktop/fonts/list", "projectFs/grant/describe",
            "projectFs/grant/redeem",
            // x-residual-moves-b: the link, thumbnail, attachment, save-as, what's-new and Linux input-access lanes reach these through main.
            "desktop/localLink/open", "desktop/attachment/thumbnail", "desktop/attachment/write", "desktop/userFile/write",
            "desktop/launchVersion/acknowledge", "desktop/computer/inputAccess/request"] {
            assert!(allows(method).is_ok(), "{method}");
        }
    }

    #[test]
    fn server_window_own_connection_only() {
        assert!(server_window_allows("conn-1", Some("conn-1")).is_ok());
        assert!(server_window_allows("conn-1", None).is_ok());
        assert!(server_window_allows("conn-1", Some("conn-2")).is_err());
    }

    #[test]
    fn unlisted_method_allowed_for_main_window() {
        assert!(allows("thread/list").is_ok());
        assert!(allows("pcAccess/anything").is_ok());
        assert!(allows("remoteHosts/anything").is_ok());
        assert!(allows("a/method/that/does/not/exist").is_ok());
    }
}
