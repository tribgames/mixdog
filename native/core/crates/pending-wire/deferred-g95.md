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
