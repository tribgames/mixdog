# Core wiring after the audit wave (g95), by the lead: applied and waiting

Applied: g95-fu-validation, g95-fu-takeover-feed (core), g95-fu-computer-observe, g95-fu-computer-bridge, g95-fu-residual-b sections 1 to 3, g95-fu-ssh-link sections 1 and 2,
g95-fu-browser-engine (download reader, file part in the tool output), g95-fu-browser-approval (nothing to apply), every .rows of the wave.

Waiting:
- g95-fu-renderer-direct: SectionEvents::relay_payload_refused must publish ui/relayPayloadRefused {bytes, limit} on the app feed (domain_seams/remote.rs; bind a feed handle
  like bind_pc_access). The row exists; nobody publishes yet, so the toast of a refused relay frame is still missing. Owner: next follow-up.
- g95-fu-residual-b section 4 (login-shell environment read at the start of run()): with the client task x-residual-moves-b-client, which must keep the coverage of the Electron
  main process's own children before the TypeScript read is deleted. The TypeScript read still runs, so nothing is lost meanwhile.
- g95-fu-residual-b section 5 (one Arc<DesktopAttachmentHost> for the three users): tidy-up only.
- g95-fu-ssh-link section 3 (LinkStores.host) and g95-fu-ssh-service section 2 (translate, NotifySink::close, sound rule, NotifyPrefs result, session_ids, ClaimedResources,
  configure failure): they change the connections composition: applied when compose_connections.rs (g9-compose-connections) is merged. The two fragments are kept beside this file.

## After the merge of g9-compose-connections and g9-screen-switch (lead)

Applied: rows of g9-screen-switch and s2b-electron-wiring (remoteHosts/redeemCode answers {host.., ticket}); pub mod compose_screen; host/power fan-out to the connections
service; host/screen/displaysChanged out of SERVICE_PENDING; compose_connections.rs brought to the seams g95-fu-ssh-link and g95-fu-ssh-service changed (LinkStores.host,
NotifySink::close, the sound rule, NotifyPrefs result, sessionIds); desktop: browserEngine DECLARED (host/connection.ts), the pill host, host/notification/close, page reports
resent on claim, the secret value and takeover answer through the core only.

Open, no owner yet (each is a behaviour of today that the tree does not have, or a new refusal):
1. Rust screen viewer: mixdog-remote LiveHost::signal answers SOURCE_NOT_STREAMED for Source::Screen; the Electron screen sources (browser/host.ts createRemoteScreenSources)
   stay until it exists. Also: fill the display list before a granted client's ready; one InputDesktop type.
2. connections: a failed MixdogSshConfig::configure fails the whole core start (TypeScript swallowed it and ssh used the user's files); the icacls run at every start.
3. connections: ConnectionsDeps.translate is the identity (pair-code errors in English); the attachment word of a server toast title is English.
4. connections: ClaimedResources is built but nothing calls resources.set(..) from host/claim, and the desktop does not send claim resources yet (g95-fu-desktop-host.wire
   sections 1b, 2 first bullet, 3: claimResources in host/connection.ts, DesktopHostOptions.resources, main/index.ts).
5. remote: SectionEvents::relay_payload_refused does not publish ui/relayPayloadRefused yet.
6. residual-b: the login-shell environment read at the start of run() (with x-residual-moves-b-client).
7. bridge: BrowserApprovalContext::session_gate answers None (s4-bridge-forward must bind it before the desktop bridge is pointed at browser/bridge/run).
8. mixdog-app-server tests/inventory_rule.rs: the dead arm "host/screen/displays".
