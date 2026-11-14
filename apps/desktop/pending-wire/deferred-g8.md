# Desktop wiring after wave 8 (lead): what was applied and what waits

Applied: g75-fu-screen-displays (display-change reports, display label), s1-dl-wire (server downloads through this PC's core), g75-fu-engine-live items 2 and 3 (the sign-in port).

NOT applied: g75-fu-engine-live item 1, host/connection.ts HOST_CAPABILITIES beside `windows: true`:

      // `host/browser/*` engine methods (host/browser-engine/index.ts). A core that does not compose the engine ignores it.
      browserEngine: { version: 1, features: ['inputBatch', 'snapshot', 'lease', 'blob'] },

Reason: review-g75-fu-engine-live.json still lists behaviour of today that the engine path does not have (an aborted or cancelled turn does not close
its disposable pages, sign-in hooks after a blocking dialog, unload forgetting turnFinishedAt). Unblocked by g85-fu-engine; the lead applies the line when that task is merged.
