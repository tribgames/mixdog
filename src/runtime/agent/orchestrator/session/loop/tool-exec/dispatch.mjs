/**
 * dispatch.mjs — hand one policy-cleared tool call to its executor: skills,
 * MCP, code graph, internal tools, shell, apply_patch, built-ins and foreign
 * CLI adapters.
 */
import { executeMcpTool, isMcpTool, isRegisteredMcpTool, mcpToolHasField } from '../../../mcp/client.mjs';
import {
  executeBuiltinTool,
  formatUnknownBuiltinToolMessage,
  isBuiltinTool,
  isExternalAdapterTool,
} from '../../../tools/builtin.mjs';
import { executePatchTool } from '../../../tools/patch.mjs';
import { executeInternalTool, isInternalTool } from '../../../internal-tools.mjs';
import { buildSkillsListResponse, viewSkill } from '../tool-helpers.mjs';
import { isOnDeferredToolSurface } from '../deferred-call-through.mjs';
import { _executeCodeGraphToolLazy } from '../../manager/runtime-loaders.mjs';
import { requiresReadBody } from '../tool-classify.mjs';
import { executeCursorNativeBuiltin } from '../../../tools/builtin/external-tool-adapters.mjs';
import { providerNativePdf, providerReadsImages } from '../../../providers/registry.mjs';
import { getModelMetadataSync } from '../../../../../shared/llm/model-catalog.mjs';

/**
 * How read returns a PDF to this session's model. Native PDF support decides
 * only whether a short PDF may arrive whole as a document block. A scanned
 * page arrives as a page image whenever the model sees images — the provider
 * sends image input (only the text-only local runtime does not) and the
 * catalog does not say the model lacks it — and as OCR text otherwise.
 */
export function pdfReadModes(
  sessionRef,
  { nativePdf = providerNativePdf, readsImages = providerReadsImages, catalogRow = getModelMetadataSync } = {}
) {
  const provider = sessionRef?.provider;
  const model = sessionRef?.model;
  const seesImages =
    readsImages(provider) && (model ? catalogRow(model, provider)?.supportsVision : undefined) !== false;
  return { pdfPageMode: seesImages ? 'image' : 'ocr', pdfNativeDocument: nativePdf(provider) };
}

function dispatchMcp(name, args, { cwd, callerSessionId, sessionRef, executeOpts }) {
  const mcpScopeId = sessionRef?.mcpScopeId || null;
  if (!isOnDeferredToolSurface(sessionRef, name) && !isRegisteredMcpTool(name, mcpScopeId)) {
    return formatUnknownBuiltinToolMessage(name, args, 'tool');
  }
  // 24h trace data shows ~24% of external MCP calls are cwd-sensitive
  // (bash / grep / read / list / glob etc.) but the worker session's
  // cwd was previously dropped here. Inject cwd only when the tool's
  // inputSchema declares the field — schemas without it would reject
  // an unknown argument.
  const needsCwdInjection = cwd && mcpToolHasField(name, 'cwd', mcpScopeId) && (args == null || args.cwd == null);
  const finalArgs = needsCwdInjection ? { ...(args || {}), cwd } : args;
  return executeMcpTool(name, finalArgs, {
    signal: executeOpts.signal || null,
    ownerKey: callerSessionId,
    scopeId: mcpScopeId,
  });
}

function dispatchInternal(
  name,
  args,
  { cwd, callerSessionId, sessionRef, executeOpts, notifyFn, toolApprovalHook, elevationApproved }
) {
  // callerSessionId propagates into server.mjs dispatchTool so that
  // dispatchAiWrapped can detect and reject recursive calls from a
  // hidden-role session (recall/search → self).
  return executeInternalTool(name, args, {
    scopeId: sessionRef?.mcpScopeId || null,
    callerSessionId,
    // The calling session itself: bridge tools answer within its scope.
    callerSession: sessionRef || null,
    callerCwd: cwd,
    setCallerCwd: async (nextCwd) => {
      const applyForCaller = sessionRef?._applyResolvedCwdForCaller;
      if (typeof applyForCaller === 'function') {
        return await applyForCaller(nextCwd);
      }
      if (sessionRef && typeof nextCwd === 'string') sessionRef.cwd = nextCwd;
      return nextCwd;
    },
    clientHostPid: sessionRef?.clientHostPid,
    signal: executeOpts.signal,
    routingSessionId: callerSessionId,
    turnId: Number(sessionRef?.usageMetricsTurnId) || 0,
    notifyFn,
    toolApprovalHook,
    toolCallId: executeOpts.toolCallId || null,
    // Runtime-granted for this call only (terminal run); never from model args.
    elevationApproved: elevationApproved === true,
    invocationSource: 'model-tool',
  });
}

/**
 * @param {{ name: string, args: any }} call
 * @param {object} ctx { cwd, callerSessionId, sessionRef, executeOpts, toolOpts, completionToolOpts, notifyFn, toolApprovalHook }
 */
export function dispatchToolCall({ name, args }, ctx) {
  const { cwd, callerSessionId, sessionRef, executeOpts, toolOpts, completionToolOpts } = ctx;
  if (name === 'Skill' || name === 'skill_view') return viewSkill(cwd, args?.name, sessionRef);
  if (name === 'skills_list') return buildSkillsListResponse(cwd);
  if (isMcpTool(name)) return dispatchMcp(name, args, ctx);
  if (name === 'code_graph') {
    // cwd chain: args.cwd (caller-explicit) → session cwd → undefined (handler throws)
    const graphCwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : cwd;
    return _executeCodeGraphToolLazy(name, args, graphCwd, executeOpts.signal || null, toolOpts);
  }
  if (isInternalTool(name, sessionRef?.mcpScopeId)) return dispatchInternal(name, args, ctx);
  if (name === 'apply_patch') {
    const patchArgs = typeof args === 'string' ? { patch: args } : { ...(args || {}) };
    return executePatchTool(name, patchArgs, cwd, {
      sessionId: callerSessionId,
      toolCallId: executeOpts.toolCallId || null,
    });
  }
  // shell and every other built-in share the completion-aware option bag;
  // clientHostPid is threaded for the per-terminal job scope (see
  // resolveJobOwnerHostPid). Foreign-CLI tool names (StrReplace/Write/bash
  // variants) adapt to a native execution inside executeBuiltinTool's default
  // case; on a shape mismatch it falls back to the redirect guidance message.
  if (name === 'shell' || isBuiltinTool(name) || isExternalAdapterTool(name)) {
    const builtinOpts = {
      ...completionToolOpts,
      ...(executeOpts.suppressReadUnchangedStub || requiresReadBody(name, sessionRef)
        ? { suppressReadUnchangedStub: true }
        : {}),
      // Runtime-granted only; any value inherited from executeOpts is overridden.
      elevationApproved: ctx.elevationApproved === true,
      ...pdfReadModes(sessionRef),
    };
    return executeCursorNativeBuiltin(
      name,
      args,
      cwd,
      {
        ...builtinOpts,
        toolCallId: executeOpts.toolCallId || null,
      },
      executeBuiltinTool
    );
  }
  return formatUnknownBuiltinToolMessage(name, args, 'tool');
}
