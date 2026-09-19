// Cursor exec/kv message handling: routing native exec requests to local
// tools and sending results back on the bridge.
import crypto from 'node:crypto';
import { decodeJsonValue, encodeMessage } from './cursor-wire-protobuf.mjs';
import { capCursorToolResult, storeCursorBlob } from './cursor-wire-guards.mjs';
import { buildCursorExecThrow } from './cursor-wire-interactions.mjs';
import { connectFrame, textDecoder, textEncoder } from './cursor-wire-transport.mjs';
import { buildRequestContext } from './cursor-wire-request.mjs';

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
    ['write'],
    (tool, args) => ({
      [argumentName(tool, ['file_path', 'filePath', 'path'], 'file_path')]: args.path || '',
      [argumentName(tool, ['content', 'file_text', 'text'], 'content')]: args.fileBytes?.length
        ? textDecoder.decode(args.fileBytes)
        : args.fileText || '',
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
      mode: args.outputMode || 'content',
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
  ['backgroundShellSpawnArgs', 'backgroundShellSpawnResult', rejectedShell],
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
  const tool = toolByNames(tools, [requestedName]);
  if (!tool) {
    sendExecResult(bridge, exec, 'mcpResult', {
      error: { error: `Tool not available: ${requestedName || 'unknown'}` },
    });
    return;
  }
  onToolCall({
    exec,
    toolCallId: args.toolCallId || crypto.randomUUID(),
    toolName: tool.name,
    decodedArgs: JSON.stringify(decodeMcpArgs(args.args)),
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
  const redirect = redirectNativeExec(exec, tools);
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
  if (mode === 'files_with_matches') {
    const files = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { files: { files, totalFiles: files.length } };
  }
  if (mode === 'count') {
    const counts = [];
    let totalMatches = 0;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^(.*):(\d+)$/);
      if (!match) continue;
      const count = Number(match[2]);
      counts.push({ file: match[1], count });
      totalMatches += count;
    }
    return { count: { counts, totalFiles: counts.length, totalMatches } };
  }
  const byFile = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    if (!byFile.has(match[1])) byFile.set(match[1], []);
    byFile.get(match[1]).push({ lineNumber: Number(match[2]), content: match[3] });
  }
  const matches = [...byFile].map(([file, fileMatches]) => ({ file, matches: fileMatches }));
  return {
    content: {
      matches,
      totalLines: matches.reduce((sum, entry) => sum + entry.matches.length, 0),
      totalMatchedLines: matches.reduce((sum, entry) => sum + entry.matches.length, 0),
    },
  };
}

function mcpResultPayload(ok, text, media) {
  if (!ok) return { error: { error: text || 'Tool failed' } };
  return {
    success: {
      content: [{ text: { text } }, ...media.map((image) => ({ image: { data: image.data, mimeType: image.mimeType } }))],
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
  writeResult: (args, text) => ({ rejected: { path: args.path || '', reason: text || 'Write failed' } }),
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
  readResult: (args, text) => ({
    success: {
      path: args.path || '',
      content: text,
      totalLines: text ? text.split(/\r?\n/).length : 0,
      fileSize: textEncoder.encode(text).length,
    },
  }),
  writeResult: (args) => {
    const content = args.fileBytes?.length ? textDecoder.decode(args.fileBytes) : args.fileText || '';
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
  result = capCursorToolResult(result);
  const { exec, native } = pending;
  const text = String(result?.content ?? '');
  const media = Array.isArray(result?.media) ? result.media : [];
  if (!native) {
    sendExecResult(bridge, exec, 'mcpResult', mcpResultPayload(ok, text, media));
    return;
  }
  const { args, resultType } = native;
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
    sendExecResult(bridge, exec, resultType, NATIVE_SUCCESS_PAYLOADS[resultType](args, text));
  }
}
