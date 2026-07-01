import { stdout, stderr } from 'node:process';
import { createStandaloneAgent } from './standalone/agent-tool.mjs';
import * as cfgMod from './runtime/agent/orchestrator/config.mjs';
import * as reg from './runtime/agent/orchestrator/providers/registry.mjs';
import * as mgr from './runtime/agent/orchestrator/session/manager.mjs';

const TERMINAL_STATUS_RE = /^status:\s*(completed|failed|error|cancelled|canceled)\b/im;
const FAILURE_STATUS_RE = /^status:\s*(failed|error|cancelled|canceled)\b/im;

function clean(value) {
  return String(value ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskIdFromOutput(text) {
  return clean(text).match(/agent task:\s*(\S+)/i)?.[1] || null;
}

function makeTag(agent) {
  return `headless-${agent}-${process.pid}-${Date.now()}`
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildHeadlessSpawnArgs({ agent, tag, cwd, message, provider, model } = {}) {
  const spawnArgs = {
    type: 'spawn',
    agent: clean(agent),
    tag,
    cwd,
    prompt: clean(message),
  };
  if (clean(provider)) spawnArgs.provider = clean(provider);
  if (clean(model)) spawnArgs.model = clean(model);
  return spawnArgs;
}

function buildAgentRunner(cwd) {
  return createStandaloneAgent({
    cfgMod: {
      loadConfig: cfgMod.loadConfig,
      resolveRuntimeSpec: cfgMod.resolveRuntimeSpec,
    },
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
  });
}

export async function runHeadlessRole({
  agent,
  message,
  provider,
  model,
  cwd = process.cwd(),
  write = (text) => stdout.write(text),
  writeErr = (text) => stderr.write(text),
} = {}) {
  const cleanAgent = clean(agent);
  const cleanMessage = clean(message);
  if (!cleanAgent) {
    writeErr('mixdog: agent is required\n');
    return 1;
  }
  if (!cleanMessage) {
    writeErr('mixdog: message is required\n');
    return 1;
  }

  const agentRunner = buildAgentRunner(cwd);
  const tag = makeTag(cleanAgent);
  const context = {
    invocationSource: 'headless',
    cwd,
    callerCwd: cwd,
    clientHostPid: process.pid,
  };
  const spawnArgs = buildHeadlessSpawnArgs({
    agent: cleanAgent,
    tag,
    cwd,
    message: cleanMessage,
    provider,
    model,
  });

  let taskId = null;
  let lastOutput = '';
  try {
    const started = await agentRunner.execute(spawnArgs, context);
    lastOutput = clean(started);
    taskId = taskIdFromOutput(started);
    if (!taskId) {
      write(`${lastOutput}\n`);
      return /^Error\b/i.test(lastOutput) ? 1 : 0;
    }

    for (;;) {
      lastOutput = clean(await agentRunner.execute({ type: 'read', task_id: taskId }, context));
      if (TERMINAL_STATUS_RE.test(lastOutput)) break;
      await sleep(500);
    }

    write(`${lastOutput}\n`);
    return FAILURE_STATUS_RE.test(lastOutput) ? 1 : 0;
  } finally {
    try {
      await agentRunner.execute({ type: 'close', tag }, context);
    } catch {
      // Best-effort cleanup only; the command result above is the useful signal.
    }
  }
}
