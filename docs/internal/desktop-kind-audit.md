# ConnectionKind::Desktop audit

A renderer window connects with `clientInfo.kind` "desktop" and a window scope (the transport's window record, `CallContext.window`). The desktop's own connection (the Electron main process) is kind "desktop" with no window. Rule: a Desktop connection with a window is a view of the desktop; it takes part in subscriptions and approvals like any client, but it neither registers with the boot coordinator nor counts as "the desktop is on". There is one registration and one "desktop ready" per desktop, whatever the number of windows.

Read: every non-test line of `crates/` naming `ConnectionKind::Desktop`, `LocalKind::Desktop` or `is_desktop_on` (grep, inferred from reading each site).

| Site | Verdict |
| --- | --- |
| app-server `connection.rs` `Session.view`, `is_desktop_on` | Changed: a view never votes. Window sockets coming and going leave `desktop_attached` unchanged. |
| app-server `server.rs` `open` | Changed: sets `Session.view` from the window record; `client_registered` is not called for a view. |
| app-server `server.rs` `subscribe` (`desktop_ready` after the app feed attach) | Unchanged line; it is guarded by `is_desktop_on`, so a window's `app/subscribe` no longer fires it. |
| app-server `outgoing.rs` `desktop_attached_on`, `DesktopPresence` | Unchanged lines; correct through `is_desktop_on`. `is_eligible` (approvals) does not look at the kind: every window that shows the thread or surface, or declares `approvalsInbox`, is asked, and a window closing leaves the request open for the others. |
| daemon `boot_coordinator.rs` `BootHook::registered` | Unchanged: a Desktop kind only warms the keychain in Node, so it schedules nothing; background work starts on `desktop_ready`, which is the desktop's own connection only. |
| daemon `late_lifecycle.rs` `client_kind` (Desktop to Session) | Keep: a window socket is a live session client and must hold the daemon up. Not owned here. |
| daemon `domain_seams/remote.rs` `register_local` (Desktop to `LocalKind::Desktop`) | Keep: windows appear as local desktop devices for approvals' device naming. Follow-up row if the device list should fold windows into one entry. Not owned here. |
| daemon `held_requests.rs` default kind of an answer without one | Keep: an answer arriving over the app feed is the desktop's. Not owned here. |
| core-base `approvals/devices.rs` mapping `LocalKind::Desktop` to `ConnectionKind::Desktop` | Keep: a pure mapping. |
| agent `tools.rs`, core-base `approvals/mod.rs`, core-session `testing.rs`, tools `ask_user.rs`, `handoff.rs` | Test fixtures only; nothing to change. |

Follow-up rows: none required. The two "Keep, not owned here" rows are noted for the owner of those files only if a device list per window is wanted.
