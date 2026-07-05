import { OutputForwarder } from "./output-forwarder.mjs";

// Worker/HTTP tool-call dispatch + bridge auto-connect retry wrapper.
// Extracted verbatim from channels/index.mjs (behavior-preserving). The
// `handleToolCall` switch is entangled with ~8 runtime-lifecycle functions
// (claim/refresh ownership, stop owned runtime, transcript rebind, config
// reload) plus mutable owner state (channelBridgeActive, bridgeRuntimeConnected)
// and the forwarder. Those are threaded in as a `lifecycle` bag of lazy
// getters/functions so the module reads the live file-level references at
// call time — matching the original in-file closure semantics.
function createToolDispatch({
  getForwarder,
  BACKEND_TOOLS,
  isChannelsDegraded,
  dispatchReply,
  dispatchFetch,
  lifecycle,
}) {
  const {
    getBridgeRuntimeConnected,
    getChannelBridgeActive,
    getOwned,
    setChannelBridgeActive,
    writeBridgeState,
    stopServerTyping,
    claimBridgeOwnership,
    notifyRemoteAcquired,
    refreshBridgeOwnership,
    bindPersistedTranscriptIfAny,
    stopOwnedRuntime,
    reloadRuntimeConfig,
  } = lifecycle;

  async function handleToolCall(name, args, _signal) {
    if (isChannelsDegraded()) {
      return { content: [{ type: 'text', text: `[channels degraded] ${name} unavailable — restart MCP to recover` }], isError: true }
    }
    let result;
    try {
      switch (name) {
        case "reply":
          result = await dispatchReply(args);
          break;
        case "fetch":
          result = await dispatchFetch(args);
          break;
        case "activate_channel_bridge": {
            const active = args.active === true;
            const wasActive = getChannelBridgeActive();
            setChannelBridgeActive(active);
            writeBridgeState(active);
            if (active) {
              // Claim the seat only when we are NOT already the owner — a
              // genuine /remote takeover or re-occupy after being superseded.
              // When this session already owns the seat (e.g. the boot-time
              // activate that fires right after start() claimed after READY),
              // skip the redundant claim so boot performs ONE claim, not a
              // remote-start + re-activate double claim (the latter forced a
              // double reconnect). refreshBridgeOwnership below still re-pins
              // the forwarder binding onto THIS session either way.
              if (getOwned?.() !== true) {
                claimBridgeOwnership(wasActive ? "re-activate takeover" : "bridge activated");
                // Genuine acquire transition (we were NOT the owner) — tell the
                // parent to flip remote ON. Not fired when we already own the
                // seat, so an idempotent re-activate never re-notifies.
                notifyRemoteAcquired?.();
              }
              try {
                await refreshBridgeOwnership({ restoreBinding: true });
                // An already-connected owner returns early from
                // startOwnedRuntime(), so rebind explicitly to follow the
                // current (parent-chain) session transcript.
                if (getBridgeRuntimeConnected()) await bindPersistedTranscriptIfAny();
              } catch (e) {
                process.stderr.write(`mixdog: bridge activate refresh failed (non-fatal): ${e?.message || e}\n`);
              }
            }
            if (!active && wasActive) {
              stopServerTyping();
              // Tear down the owner-side runtime so Discord/scheduler/webhook/
              // event-pipeline don't keep running on a deactivated bridge.
              try { await stopOwnedRuntime("bridge deactivated"); } catch (e) {
                process.stderr.write(`mixdog: stopOwnedRuntime on deactivate failed: ${e?.message || e}\n`);
              }
            }
            result = { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
            break;
          }
        case "reload_config": {
            await reloadRuntimeConfig();
            // Extend reload to the agent module so providers/presets/maintenance
            // hot-reload on the same call (dynamic import: agent/index.mjs does not
            // import channels, so this stays acyclic and tolerant of load order).
            let agentReloadMsg = "";
            if (process.env.MIXDOG_STANDALONE !== '1') {
              try {
                const { reloadAgentConfig } = await import("../../agent/index.mjs");
                await reloadAgentConfig("reload_config tool");
                agentReloadMsg = ", agent providers/presets/maintenance";
              } catch (err) {
                process.stderr.write(`[reload_config] agent reload failed: ${err?.message || String(err)}\n`);
              }
            }
            result = { content: [{ type: "text", text: `config reloaded — schedules, webhooks, events${agentReloadMsg} re-registered` }] };
            break;
          }
        // memory — handled by memory-service.mjs MCP
        default:
            result = {
              content: [{ type: "text", text: `unknown tool: ${name}` }],
              isError: true
            };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        content: [{ type: "text", text: `${name} failed: ${msg}` }],
        isError: true
      };
    }
    return result;
  }

  // Bridge auto-connect retry + forwarder-aware tool dispatch wrapper. Used by
  // both the HTTP MCP path (createHttpMcpServer's CallTool handler can call this)
  // and the worker IPC handler at the bottom of index.mjs.
  // Last timestamp a forwardNewText() call was dispatched (debounce for item 4).
  let _lastForwardMs = 0;

  async function handleToolCallWithBridgeRetry(toolName, args, signal) {
    const forwarder = getForwarder();
    // Debounce: only forward when ≥250 ms have elapsed since the last forward,
    // to avoid one HTTP roundtrip per tool call on rapid-fire sequences.
    const now = Date.now();
    if (now - _lastForwardMs >= 250) {
      _lastForwardMs = now;
      await forwarder.forwardNewText();
    }
    if (BACKEND_TOOLS.has(toolName) && !getBridgeRuntimeConnected()) {
      // Remote-owner startup: ensure this owner's backend is connected.
      for (let i = 0; i < 2 && !getBridgeRuntimeConnected(); i++) {
        try {
          await refreshBridgeOwnership();
        } catch {
        }
        if (!getBridgeRuntimeConnected()) await new Promise((r) => setTimeout(r, 300));
      }
      if (!getBridgeRuntimeConnected()) {
        return {
          content: [{ type: "text", text: `Discord auto-connect failed after retries. Check token and network.` }],
          isError: true
        };
      }
    }
    const result = await handleToolCall(toolName, args, signal);
    const toolLine = OutputForwarder.buildToolLine(toolName, args);
    if (toolLine) {
      // Distinct from the dispatch-log ok line (server-main.mjs): this forwards
      // a human-readable tool summary to Discord for the user, not operator stdout.
      void forwarder.forwardToolLog(toolLine, toolName, args);
    }
    return result;
  }

  return { handleToolCall, handleToolCallWithBridgeRetry };
}

export { createToolDispatch };
