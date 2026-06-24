import { EventQueue } from "./event-queue.mjs";
import { applyParser, evaluateFilter, applyTemplate } from "./executor.mjs";
class EventPipeline {
  rules;
  queue;
  constructor(config, channelsConfig) {
    const rawRules = config?.rules;
    this.rules = (Array.isArray(rawRules) ? rawRules : [])
      .filter((r) => r && typeof r === "object" && r.enabled !== false);
    this.queue = new EventQueue(config?.queue, channelsConfig);
  }
  getQueue() {
    return this.queue;
  }
  start() {
    this.queue.start();
  }
  stop() {
    this.queue.stop();
  }
  reloadConfig(config, channelsConfig) {
    const rawRules = config?.rules;
    this.rules = (Array.isArray(rawRules) ? rawRules : [])
      .filter((r) => r && typeof r === "object" && r.enabled !== false);
    this.queue.reloadConfig(config?.queue, channelsConfig);
  }
  // ── Source: webhook ───────────────────────────────────────────────
  /** Handle an incoming webhook event */
  handleWebhook(endpointName, body, headers) {
    const rule = this.rules.find((r) => r.source === "webhook" && r.name === endpointName);
    if (!rule) return false;
    const data = applyParser(rule.parser, body, headers);
    if (rule.filter && !evaluateFilter(rule.filter, data)) {
      return true;
    }
    const prompt = applyTemplate(rule.execute, data);
    this.enqueue(rule, prompt);
    return true;
  }
  // ── Direct enqueue (folder-based webhooks) ─────────────────────────
  enqueueDirect(name, prompt, channel, exec = "interactive", instruction) {
    const item = {
      name,
      source: "webhook",
      priority: "normal",
      prompt,
      instruction,
      exec,
      channel,
      timestamp: Date.now()
    };
    this.queue.enqueue(item);
  }
  // ── Common enqueue ────────────────────────────────────────────────
  enqueue(rule, prompt) {
    const item = {
      name: rule.name,
      source: rule.source,
      priority: rule.priority,
      prompt,
      exec: rule.exec,
      channel: rule.channel,
      script: rule.script,
      timestamp: Date.now()
    };
    this.queue.enqueue(item);
  }
  // ── Status ────────────────────────────────────────────────────────
  getRules() {
    return this.rules;
  }
  getStatus() {
    return {
      rules: this.rules.length,
      queue: this.queue.getStatus()
    };
  }
}
export {
  EventPipeline
};
