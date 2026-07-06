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
    notifyRemoteAcquired,
    refreshBridgeOwnership,
    bindPersistedTranscriptIfAny,
    rebindCurrentTranscript,
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
              // Daemon model: this runtime is the unconditional bridge owner
              // (getOwned() is always true), so activate never needs to claim a
              // seat or pre-notify — the not-connected -> connected transition
              // inside startOwnedRuntime fires notifyRemoteAcquired exactly once.
              // refreshBridgeOwnership still re-pins the forwarder binding onto
              // THIS session.
              if (getOwned?.() !== true) {
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
        case "rebind_current_transcript": {
            // Lead-pushed repoint to the transcript it just created/rebound.
            // Best-effort + idempotent: absent channelId or path => no-op; a
            // bind failure is swallowed by the outer try so lead paths never
            // throw. Same binding path as the inbound steal.
            const transcriptPath = typeof args.transcriptPath === "string" ? args.transcriptPath.trim() : "";
            if (transcriptPath) await rebindCurrentTranscript(transcriptPath);
            result = { content: [{ type: "text", text: `transcript rebind ${transcriptPath ? "pushed" : "skipped (no path)"}` }] };
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
    // The transcript rebind op must repoint the forwarder BEFORE any flush;
    // running the pre-flush first would send stale-transcript text ahead of the
    // rebind. Skip the pre-flush for it so rebinding always precedes forwarding.
    if (toolName !== 'rebind_current_transcript' && now - _lastForwardMs >= 250) {
      _lastForwardMs = now;
      await forwarder.forwardNewText();
    }
    if (BACKEND_TOOLS.has(toolName) && !getBridgeRuntimeConnected()) {
      // Remote-owner startup: ensure this owner's backend is connected.
      for (let i = 0; i < 2 && !getBridgeRuntimeConnected(); i++) {
        try {
          // Auto-connect this owner's backend (daemon singleton — no seat claim).
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
