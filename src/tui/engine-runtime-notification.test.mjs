import test from "node:test";
import assert from "node:assert/strict";
import { resolveTuiRuntimeNotificationDelivery } from "./engine.mjs";
import { toolCompletionMeta } from "../runtime/shared/tool-execution-contract.mjs";

const completedBackgroundTask = [
  "background task",
  "task_id: task_agent_abc123",
  "surface: agent",
  "operation: run",
  "status: completed",
  "",
  "worker finished successfully",
].join("\n");

const runningBackgroundTask = [
  "background task",
  "task_id: task_agent_abc123",
  "surface: agent",
  "operation: run",
  "status: running",
].join("\n");

const statusOnlyCompletedBackgroundTask = [
  "background task",
  "task_id: task_agent_abc123",
  "surface: agent",
  "operation: run",
  "status: completed",
].join("\n");

const agentTaskEnvelopeWithBody = [
  "agent task: task_agent_xyz",
  "status: completed",
  "",
  "done",
].join("\n");

const nestedAgentTaskInBackgroundTask = [
  "background task",
  "task_id: task_agent_abc123",
  "surface: agent",
  "operation: run",
  "status: completed",
  "",
  "agent task: task_agent_nested",
  "status: completed",
  "",
  "nested worker result",
].join("\n");

test("execution completion uses wrapper model content not raw enqueue text", () => {
  const meta = toolCompletionMeta({
    surface: "agent",
    id: "task_agent_abc123",
    status: "completed",
    context: { callerSessionId: "sess_owner" },
  });
  const delivery = resolveTuiRuntimeNotificationDelivery({ meta }, completedBackgroundTask);
  assert.equal(delivery.action, "execution-ui");
  assert.equal(delivery.displayText, completedBackgroundTask);
  assert.ok(delivery.modelContent);
  assert.match(delivery.modelContent, /worker finished successfully/);
  assert.doesNotMatch(delivery.modelContent, /^background task\b/m);
  assert.notEqual(delivery.modelContent, completedBackgroundTask);
});

test("running execution notification is UI-only with empty model content", () => {
  const meta = toolCompletionMeta({
    surface: "agent",
    id: "task_agent_abc123",
    status: "running",
    context: { callerSessionId: "sess_owner" },
  });
  const delivery = resolveTuiRuntimeNotificationDelivery({ meta }, runningBackgroundTask);
  assert.equal(delivery.action, "execution-ui");
  assert.equal(delivery.modelContent, "");
});

test("nested agent task body inside completed background task is not status-only", () => {
  const meta = toolCompletionMeta({
    surface: "agent",
    id: "task_agent_abc123",
    status: "completed",
    context: { callerSessionId: "sess_owner" },
  });
  const delivery = resolveTuiRuntimeNotificationDelivery({ meta }, nestedAgentTaskInBackgroundTask);
  assert.equal(delivery.action, "execution-ui");
  assert.ok(String(delivery.modelContent || "").trim());
  assert.match(delivery.modelContent, /nested worker result/);
});

test("agent task envelope with blank-line body is not status-only", () => {
  const meta = toolCompletionMeta({
    surface: "agent",
    id: "task_agent_xyz",
    status: "completed",
    context: { callerSessionId: "sess_owner" },
  });
  const delivery = resolveTuiRuntimeNotificationDelivery({ meta }, agentTaskEnvelopeWithBody);
  assert.equal(delivery.action, "execution-ui");
  assert.ok(String(delivery.modelContent || "").trim());
});

test("header-only completed background task is status-only", () => {
  const meta = toolCompletionMeta({
    surface: "agent",
    id: "task_agent_abc123",
    status: "completed",
    context: { callerSessionId: "sess_owner" },
  });
  const delivery = resolveTuiRuntimeNotificationDelivery({ meta }, statusOnlyCompletedBackgroundTask);
  assert.equal(delivery.action, "status-only");
  assert.equal(delivery.modelContent, "");
});
