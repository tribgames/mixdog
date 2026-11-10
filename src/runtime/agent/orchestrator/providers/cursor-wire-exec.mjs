// Cursor exec/kv message handling: routing native exec requests to local
// tools and sending results back on the bridge.
import crypto from 'node:crypto';
import { BRIDGE_NAME_MAX_CHARS, isBridgeMetaTool } from '../runtime-core/tool-bridge-contract.mjs';
import { releaseCursorNativeCall } from './cursor-native-context.mjs';
import { decodeJsonValue, encodeMessage } from './cursor-wire-protobuf.mjs';
import { capCursorToolResult, storeCursorBlob } from './cursor-wire-guards.mjs';
import { buildCursorExecThrow } from './cursor-wire-interactions.mjs';
import { connectFrame, textDecoder, textEncoder } from './cursor-wire-transport.mjs';
import { buildRequestContext } from './cursor-wire-request.mjs';
import { readSourceWindow } from '../../../shared/read-row-numbers.mjs';
import { splitGrepLineNumberOnlyPrefix, splitGrepCountPrefix } from '../tools/builtin/grep-formatting.mjs';

const nativeWriteDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

function nativeWriteText(args) {
  if (!args.fileBytes?.length) return args.fileText || '';
  try {
    return nativeWriteDecoder.decode(args.fileBytes);
  } catch {
    throw Object.assign(new Error('Native Write fileBytes must be valid UTF-8; no file was written'), {
      code: 'CURSOR_WRITE_ENCODING',
    });
  }
}

export function heartbeatFrame() {
  return connectFrame(encodeMessage('AgentClientMessage', { clientHeartbeat: {} }));
}

export function sendClientMessage(bridge, message) {
  bridge.write(connectFrame(encodeMessage('AgentClientMessage', message)));
}

function sendExecResult(bridge, exec, resultName, value) {
  sendClientMessage(bridge, {
    execClientMessage: {
      id: exec.id,
      execId: exec.execId || '',
      [resultName]: value,
    },
  });
}

export function handleKvMessage(bridge, message, conversation) {
  if (message.getBlobArgs) {
    const key = Buffer.from(message.getBlobArgs.blobId || []).toString('hex');
    sendClientMessage(bridge, {
      kvClientMessage: {
        id: message.id,
        getBlobResult: conversation.blobs.has(key) ? { blobData: conversation.blobs.get(key) } : {},
      },
    });
  } else if (message.setBlobArgs) {
    const { blobId = new Uint8Array(), blobData = new Uint8Array() } = message.setBlobArgs;
    storeCursorBlob(conversation.blobs, Buffer.from(blobId).toString('hex'), blobData);
    sendClientMessage(bridge, { kvClientMessage: { id: message.id, setBlobResult: {} } });
  }
}

function toolByNames(tools, names) {
  return tools.find((tool) => names.includes(tool.name));
}

function argumentName(tool, candidates, fallback) {
  const properties = tool?.inputSchemaObject?.properties || {};
  return candidates.find((name) => Object.hasOwn(properties, name)) || fallback;
}

const shellExecArgs = (_tool, args) => ({
  command: args.command || '',
  ...(args.timeout ? { timeout_ms: args.timeout } : {}),
});

// Cursor native exec cases redirected to a Mixdog tool: [exec key, candidate
// tool names, argument builder, exec result type].
const NATIVE_EXEC_CASES = [
  [
    'readArgs',
    ['read'],
    (tool, args) => ({
      [argumentName(tool, ['file_path', 'filePath', 'path'], 'file_path')]: args.path || '',
      ...(args.offset ? { offset: args.offset } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    }),
    'readResult',
  ],
  [
    'writeArgs',
    // Only the guarded edit tool: it creates missing files and fills empty
    // ones, while its executor rejects overwrites of non-empty files. An
    // explicit write tool would overwrite without any native capability
    // (remote/proxied calls), so it never serves a native Write.
    ['edit'],
    (tool, args) => ({
      [argumentName(tool, ['file_path', 'filePath', 'path'], 'file_path')]: args.path || '',
      old_string: '',
      new_string: nativeWriteText(args),
    }),
    'writeResult',
  ],
  ['fetchArgs', ['web_fetch', 'webfetch', 'fetch'], (_tool, args) => ({ url: args.url || '' }), 'fetchResult'],
  ['shellArgs', ['shell', 'bash'], shellExecArgs, 'shellResult'],
  ['shellStreamArgs', ['shell', 'bash'], shellExecArgs, 'shellStreamResult'],
  ['lsArgs', ['glob'], (_tool, args) => ({ pattern: '*', path: args.path || '' }), 'lsResult'],
  [
    'grepArgs',
    ['grep'],
    (_tool, args) => ({
      pattern: args.pattern || '.',
      ...(args.path ? { path: args.path } : {}),
      ...(args.glob ? { glob: args.glob } : {}),
      mode: args.outputMode === 'files_with_matches' ? 'files' : args.outputMode || 'content',
      context: 0,
      ...(args.headLimit > 0 ? { limit: args.headLimit } : {}),
    }),
    'grepResult',
  ],
];

function redirectNativeExec(exec, tools) {
  for (const [caseName, names, build, resultType] of NATIVE_EXEC_CASES) {
    if (!exec[caseName]) continue;
    const tool = toolByNames(tools, names);
    if (!tool) return null;
    const args = exec[caseName];
    return {
      exec,
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName: tool.name,
      decodedArgs: JSON.stringify(build(tool, args)),
      native: { resultType, args },
    };
  }
  return null;
}

function decodeMcpArgs(args = {}) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      try {
        return [key, decodeJsonValue(value)];
      } catch {
        return [key, textDecoder.decode(value)];
      }
    })
  );
}

const UNAVAILABLE = 'Tool not available in this environment. Use a Mixdog tool instead.';
const rejectedPath = (args) => ({ rejected: { path: args.path || '', reason: UNAVAILABLE } });
const rejectedShell = (args) => ({
  rejected: { command: args.command || '', workingDirectory: args.workingDirectory || '', reason: UNAVAILABLE },
});
const rejectedBackgroundShell = (args) => ({
  rejected: {
    command: args.command || '',
    workingDirectory: args.workingDirectory || '',
    reason:
      'Cursor background shell is not supported. Use the mixdog MCP shell tool with {"command":"..."}; ' +
      'if it returns task_id, use the mixdog task tool with {"action":"wait","task_id":"<returned id>"}. ' +
      'Use load_tool {"names":"task"} if task is not loaded.',
  },
});
const unavailableError = () => ({ error: { error: UNAVAILABLE } });

// Native exec cases with no Mixdog tool behind them: [exec key, exec result
// type, result payload builder]. First matching key wins.
const UNAVAILABLE_EXEC_RESULTS = [
  ['readArgs', 'readResult', rejectedPath],
  ['writeArgs', 'writeResult', rejectedPath],
  ['deleteArgs', 'deleteResult', rejectedPath],
  ['lsArgs', 'lsResult', rejectedPath],
  ['grepArgs', 'grepResult', unavailableError],
  ['fetchArgs', 'fetchResult', (args) => ({ error: { url: args.url || '', error: UNAVAILABLE } })],
  ['shellArgs', 'shellResult', rejectedShell],
  ['shellStreamArgs', 'shellResult', rejectedShell],
  ['backgroundShellSpawnArgs', 'backgroundShellSpawnResult', rejectedBackgroundShell],
  ['writeShellStdinArgs', 'writeShellStdinResult', unavailableError],
  ['diagnosticsArgs', 'diagnosticsResult', () => ({})],
];

// Answers an exec no tool serves with its unavailable result; false when the
// exec shape itself is unsupported.
function rejectUnavailableExec(bridge, exec) {
  for (const [key, resultType, payload] of UNAVAILABLE_EXEC_RESULTS) {
    if (!exec[key]) continue;
    sendExecResult(bridge, exec, resultType, payload(exec[key]));
    return;
  }
  sendClientMessage(bridge, buildCursorExecThrow(exec, 'Unsupported Cursor native exec'));
  return false;
}

function handleMcpExec(bridge, exec, tools, onToolCall) {
  const args = exec.mcpArgs;
  const requestedName = args.toolName || args.name;
  const directTool = toolByNames(tools, [requestedName]);
  // Only the bridge granted in this request can resolve a deferred name.
  // The ordinary runtime still projects the target and enforces its policy.
  let tool =
    directTool ||
    (typeof requestedName === 'string' && requestedName.length > 0 ? toolByNames(tools, ['call_tool']) : null);
  if (!tool) {
    sendExecResult(bridge, exec, 'mcpResult', {
      error: { error: `Tool not available: ${requestedName || 'unknown'}` },
    });
    return;
  }
  let decodedArgs = decodeMcpArgs(args.args);
  if (
    requestedName === 'call_tool' &&
    directTool &&
    Object.keys(decodedArgs).length === 2 &&
    Object.hasOwn(decodedArgs, 'name') &&
    Object.hasOwn(decodedArgs, 'arguments') &&
    typeof decodedArgs.name === 'string' &&
    decodedArgs.name.length > 0 &&
    decodedArgs.name.length <= BRIDGE_NAME_MAX_CHARS &&
    !isBridgeMetaTool(decodedArgs.name) &&
    decodedArgs.arguments !== null &&
    typeof decodedArgs.arguments === 'object' &&
    !Array.isArray(decodedArgs.arguments)
  ) {
    const target = toolByNames(tools, [decodedArgs.name]);
    if (target) {
      tool = target;
      decodedArgs = decodedArgs.arguments;
    }
  }
  onToolCall({
    exec,
    toolCallId: args.toolCallId || crypto.randomUUID(),
    toolName: tool.name,
    decodedArgs: JSON.stringify(directTool ? decodedArgs : { name: requestedName, arguments: decodedArgs }),
  });
}

export function handleExecMessage(bridge, exec, tools, cloudRule, onToolCall) {
  if (exec.requestContextArgs) {
    sendExecResult(bridge, exec, 'requestContextResult', {
      success: {
        requestContext: buildRequestContext(tools, cloudRule),
      },
    });
    return;
  }
  if (exec.mcpArgs) {
    handleMcpExec(bridge, exec, tools, onToolCall);
    return;
  }
  let redirect;
  try {
    redirect = redirectNativeExec(exec, tools);
  } catch (error) {
    if (error.code !== 'CURSOR_WRITE_ENCODING') throw error;
    sendExecResult(bridge, exec, 'writeResult', { error: { path: exec.writeArgs.path || '', error: error.message } });
    return;
  }
  if (redirect) {
    onToolCall(redirect);
    return;
  }
  return rejectUnavailableExec(bridge, exec);
}

function parseListedPaths(text, rootPath) {
  const root = {
    absPath: rootPath || '.',
    childrenDirs: [],
    childrenFiles: [],
    childrenWereProcessed: true,
    fullSubtreeExtensionCounts: {},
    numFiles: 0,
  };
  for (const raw of text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const name = raw.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
    if (!name) continue;
    root.childrenFiles.push({ name });
    root.numFiles += 1;
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      const extension = name.slice(dot + 1);
      root.fullSubtreeExtensionCounts[extension] = (root.fullSubtreeExtensionCounts[extension] || 0) + 1;
    }
  }
  return root;
}

function parseGrepResult(text, args) {
  const mode = args.outputMode || 'content';
  const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith('[total ') && !line.startsWith('... ['));
  if (mode === 'files_with_matches') {
    const files = lines.map((line) => line.trim()).filter((line) => !line.startsWith('(no matches)'));
    return { files: { files, totalFiles: files.length } };
  }
  if (mode === 'count') {
    const counts = [];
    let totalMatches = 0;
    for (const line of lines) {
      const parsed = splitGrepCountPrefix(line);
      if (!parsed && !/^\d+$/.test(line)) continue;
      const count = parsed ? parsed.count : Number(line);
      counts.push({ file: parsed?.path || args.path, count });
      totalMatches += count;
    }
    return { count: { counts, totalFiles: counts.length, totalMatches } };
  }
  const byFile = new Map();
  let currentFile = args.path;
  for (const line of lines) {
    const grouped = /^ {2}(\d+): (.*)$/.exec(line);
    // Native searches request no context: only :N: is a line delimiter.
    // A -N- segment may be part of the filename, not a context-line prefix.
    const match = grouped ? null : /^(.+?):(\d+):/.exec(line);
    const prefix = match ? { path: match[1], lineNo: Number(match[2]), markerEnd: match[0].length } : null;
    const single = grouped || prefix ? null : splitGrepLineNumberOnlyPrefix(line);
    if (!grouped && !prefix && !single) {
      currentFile = line.replace(/ \(\d+ hits\)$/, '');
      continue;
    }
    const file = prefix?.path || currentFile;
    const lineNumber = grouped ? Number(grouped[1]) : (prefix || single).lineNo;
    const content = grouped ? grouped[2] : line.slice((prefix || single).markerEnd);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ lineNumber, content });
  }
  const matches = [...byFile].map(([file, fileMatches]) => ({ file, matches: fileMatches }));
  const matchedLines = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
  return {
    content: {
      matches,
      totalLines: matchedLines,
      totalMatchedLines: matchedLines,
    },
  };
}

function mcpResultPayload(ok, text, media) {
  if (!ok) return { error: { error: text || 'Tool failed' } };
  return {
    success: {
      content: [
        { text: { text } },
        ...media.map((image) => ({ image: { data: image.data, mimeType: image.mimeType } })),
      ],
      isError: false,
    },
  };
}

// A streamed shell result is one start/stdout/exit frame sequence followed by
// the stream close; the exit code carries the outcome.
function sendShellStream(bridge, exec, text, code) {
  sendExecResult(bridge, exec, 'shellStream', { start: {} });
  if (text) sendExecResult(bridge, exec, 'shellStream', { stdout: { data: text } });
  sendExecResult(bridge, exec, 'shellStream', { exit: { code } });
  sendClientMessage(bridge, { execClientControlMessage: { streamClose: { id: exec.id } } });
}

// Native exec failure payloads by result type; an unknown type reports as a
// rejected shell command.
const NATIVE_FAILURE_PAYLOADS = {
  readResult: (args, text) => ({ rejected: { path: args.path || '', reason: text || 'Read failed' } }),
  writeResult: (args, text) => ({ error: { path: args.path || '', error: text || 'Write failed' } }),
  fetchResult: (args, text) => ({ error: { url: args.url || '', error: text || 'Fetch failed' } }),
  lsResult: (args, text) => ({ rejected: { path: args.path || '', reason: text || 'List failed' } }),
  grepResult: (_args, text) => ({ error: { error: text || 'Grep failed' } }),
  shellResult: (args, text) => ({
    rejected: {
      command: args.command || '',
      workingDirectory: args.workingDirectory || '',
      reason: text || 'Command failed',
    },
  }),
};

const NATIVE_SUCCESS_PAYLOADS = {
  readResult: (args, text, pending, result) => {
    const source = readSourceWindow(text);
    // The read executor reports per-line clipping out of band: on the
    // pending call (local) or on the result (remote/proxied).
    if (!source || pending.nativeReadWindow?.lineClipped || result?.readWindow?.lineClipped)
      return {
        rejected: {
          path: args.path || '',
          reason:
            'This read result is not a complete contiguous source window. Use the mixdog MCP read tool with file_path, offset and limit; do not treat display markers as file content.',
        },
      };
    return {
      success: {
        path: args.path || '',
        content: source.content,
        ...(source.totalLines === undefined ? {} : { totalLines: source.totalLines }),
        truncated: source.truncated,
        rangeApplied: Boolean(args.offset || args.limit || (source.startLine != null && source.startLine > 1)),
      },
    };
  },
  writeResult: (args) => {
    const content = nativeWriteText(args);
    return {
      success: {
        path: args.path || '',
        linesCreated: content ? content.split(/\r?\n/).length : 0,
        fileSize: textEncoder.encode(content).length,
      },
    };
  },
  fetchResult: (args, text) => ({
    success: { url: args.url || '', content: text, statusCode: 200, contentType: 'text/markdown' },
  }),
  shellResult: (args, text) => ({
    success: {
      command: args.command || '',
      workingDirectory: args.workingDirectory || '',
      exitCode: 0,
      stdout: text,
    },
  }),
  lsResult: (args, text) => ({ success: { directoryTreeRoot: parseListedPaths(text, args.path) } }),
  grepResult: (args, text) => ({
    success: {
      pattern: args.pattern || '',
      path: args.path || '',
      outputMode: args.outputMode || 'content',
      workspaceResults: { [args.path || '.']: parseGrepResult(text, args) },
    },
  }),
};

export function sendToolResult(bridge, pending, result, ok) {
  releaseCursorNativeCall(pending);
  result = capCursorToolResult(result);
  pending.completedResult = { result, ok };
  const { exec, native } = pending;
  const text = String(result?.content ?? '');
  const media = Array.isArray(result?.media) ? result.media : [];
  if (!native) {
    sendExecResult(bridge, exec, 'mcpResult', mcpResultPayload(ok, text, media));
    return;
  }
  const { args, resultType } = native;
  if (ok && resultType === 'readResult' && pending.nativeReadReply) {
    let reply = pending.nativeReadReply;
    if (pending.nativeUserMessage) {
      reply = {
        rejected: {
          path: args.path || '',
          reason: `Read interrupted by a new user instruction: ${pending.nativeUserMessage}`,
        },
      };
    } else if (pending.nativeSnapshot) {
      pending.nativeSnapshot.delivered = true;
    }
    sendExecResult(bridge, exec, resultType, reply);
    return;
  }
  if (resultType === 'shellStreamResult') {
    sendShellStream(bridge, exec, text, ok ? 0 : 1);
    return;
  }
  if (!ok) {
    const kind = Object.hasOwn(NATIVE_FAILURE_PAYLOADS, resultType) ? resultType : 'shellResult';
    sendExecResult(bridge, exec, kind, NATIVE_FAILURE_PAYLOADS[kind](args, text));
    return;
  }
  if (Object.hasOwn(NATIVE_SUCCESS_PAYLOADS, resultType)) {
    const value = NATIVE_SUCCESS_PAYLOADS[resultType](args, text, pending, result);
    if (resultType === 'writeResult' && Number.isInteger(pending.nativeWrittenBytes)) {
      value.success.fileSize = pending.nativeWrittenBytes;
    }
    sendExecResult(bridge, exec, resultType, value);
  }
}
