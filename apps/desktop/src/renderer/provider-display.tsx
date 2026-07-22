import React, { type SVGProps } from "react";

import type { DesktopModelOption } from "../shared/contract";

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic API",
  "anthropic-api": "Anthropic API",
  "anthropic-oauth": "Anthropic OAuth",
  deepseek: "DeepSeek API",
  "deepseek-api": "DeepSeek API",
  default: "Default",
  gemini: "Gemini API",
  "gemini-api": "Gemini API",
  "grok-oauth": "Grok OAuth",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  openai: "OpenAI API",
  "openai-api": "OpenAI API",
  "openai-oauth": "OpenAI OAuth",
  "opencode-go": "OpenCode Go API",
  xai: "xAI API",
  "xai-api": "xAI API",
};

const PROVIDER_RANKS: Readonly<Record<string, number>> = {
  default: 0,
  "openai-oauth": 10,
  "anthropic-oauth": 20,
  "grok-oauth": 30,
  "opencode-go": 35,
  openai: 40,
  "openai-api": 40,
  anthropic: 50,
  "anthropic-api": 50,
  gemini: 60,
  "gemini-api": 60,
  xai: 70,
  "xai-api": 70,
  deepseek: 90,
  "deepseek-api": 90,
  ollama: 100,
  lmstudio: 110,
};

export function providerDisplayName(provider: string | null | undefined) {
  const id = String(provider || "").trim();
  if (!id) return "Unknown provider";
  const normalized = id.toLowerCase();
  const known = PROVIDER_LABELS[normalized];
  if (known) return known;
  return id;
}

export function providerDisplayRank(provider: string | null | undefined) {
  return PROVIDER_RANKS[String(provider || "").trim().toLowerCase()] ?? 900;
}

function parsedModelVersion(id: string | null | undefined): number[] {
  const text = String(id || "").toLowerCase();
  const claude = text.match(/^claude-[a-z]+-(\d+)(?:[-.](\d+))?/);
  if (claude) return [Number(claude[1]) || 0, Number(claude[2]) || 0];
  const compact = text.match(/(?:^|[-_])(?:o|gpt|grok|qwen|llama|mistral|gemma|phi|glm)(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
  if (compact) return compact.slice(1).filter((value): value is string => value != null).map((value) => Number(value) || 0);
  const generic = text.match(/(?:^|[-_v])(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
  return generic
    ? generic.slice(1).filter((value): value is string => value != null).map((value) => Number(value) || 0)
    : [];
}

function releaseTime(model: DesktopModelOption): number {
  if (model.releaseDate) {
    const value = Date.parse(model.releaseDate);
    if (Number.isFinite(value)) return value;
  }
  const created = Number(model.created);
  if (Number.isFinite(created) && created > 0) return created < 1_000_000_000_000 ? created * 1000 : created;
  const dated = model.model.match(/(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)/);
  return dated ? Date.parse(`${dated[1]}-${dated[2]}-${dated[3]}`) || 0 : 0;
}

function isClaudeModel(model: DesktopModelOption): boolean {
  return model.provider.toLowerCase().includes("anthropic") && /^claude-[a-z]+-/.test(model.model.toLowerCase());
}

function modelVersion(model: DesktopModelOption): number[] {
  const fromId = parsedModelVersion(model.model);
  return fromId.length ? fromId : parsedModelVersion(model.display);
}

function compareModelVersion(left: DesktopModelOption, right: DesktopModelOption): number {
  const leftVersion = modelVersion(left);
  const rightVersion = modelVersion(right);
  if (!leftVersion.length && !rightVersion.length) return 0;
  if (!leftVersion.length) return 1;
  if (!rightVersion.length) return -1;
  for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
    const delta = (rightVersion[index] || 0) - (leftVersion[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

export function compareModelRecency(left: DesktopModelOption, right: DesktopModelOption): number {
  if (isClaudeModel(left) && isClaudeModel(right)) {
    if (Boolean(left.latest) !== Boolean(right.latest)) return left.latest ? -1 : 1;
    const versionDelta = compareModelVersion(left, right);
    if (versionDelta) return versionDelta;
    const leftTime = releaseTime(left);
    const rightTime = releaseTime(right);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return (left.display || left.model).localeCompare(right.display || right.model);
  }

  const leftTime = releaseTime(left);
  const rightTime = releaseTime(right);
  const versionDelta = compareModelVersion(left, right);
  if (leftTime > 0 && rightTime > 0 && leftTime !== rightTime) return rightTime - leftTime;
  if (versionDelta) return versionDelta;
  if (Boolean(left.latest) !== Boolean(right.latest)) return left.latest ? -1 : 1;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return (left.display || left.model).localeCompare(right.display || right.model);
}

function modelFamily(model: DesktopModelOption): string {
  const text = String(model.model || model.display || "").toLowerCase();
  const claude = text.match(/^claude-([a-z]+)/);
  if (claude) return claude[1];
  if (model.family) return model.family.toLowerCase();
  return text.match(/^[a-z]+(?:-[a-z]+)?/)?.[0] || "model";
}

function modelFamilyLimit(provider: string, family: string): number {
  if (!provider.toLowerCase().includes("anthropic")) return 8;
  return family === "opus" ? 3 : 1;
}

/** Mirrors the model set and ordering presented by the TUI /model picker. */
export function normalizeModelOptions(models: readonly DesktopModelOption[]): DesktopModelOption[] {
  const providers = new Map<string, Map<string, DesktopModelOption[]>>();
  for (const model of models) {
    if (!model?.provider || !model?.model) continue;
    const families = providers.get(model.provider) || new Map<string, DesktopModelOption[]>();
    const family = modelFamily(model);
    const familyModels = families.get(family) || [];
    familyModels.push(model);
    families.set(family, familyModels);
    providers.set(model.provider, families);
  }

  const normalized: DesktopModelOption[] = [];
  for (const [provider, families] of providers) {
    const providerModels: DesktopModelOption[] = [];
    for (const [family, familyModels] of families) {
      providerModels.push(...familyModels.slice().sort(compareModelRecency).slice(0, modelFamilyLimit(provider, family)));
    }
    normalized.push(...providerModels.sort(compareModelRecency));
  }
  return normalized;
}

export function modelContextWindow(model: DesktopModelOption): number {
  const value = Number(model.contextWindow);
  const explicit = Number.isFinite(value) && value > 0 ? value : 0;
  // Provider metadata is authoritative when it is present.  The Claude
  // fallback below only exists for older catalog entries that did not expose
  // a context window at all; inflating an explicit 200k entry to 1M makes the
  // desktop picker disagree with the TUI and with the provider response.
  if (explicit > 0) return explicit;
  const provider = model.provider.toLowerCase();
  const id = model.model.toLowerCase();
  const version = parsedModelVersion(id);
  if (provider.includes("anthropic") && /^claude-[a-z]+-/.test(id)) {
    if ((version[0] || 0) >= 5) return 1_000_000;
    if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/.test(id)) return 1_000_000;
  }
  return 0;
}

export function formatContextWindow(tokens: number): string {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return "";
  const unit = value >= 1024 && (value & (value - 1)) === 0 ? 1024 : 1000;
  const mega = unit * unit;
  if (value >= mega) {
    const millions = value / mega;
    const label = Number.isInteger(millions)
      ? millions.toFixed(0)
      : millions.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return `${label}M Context`;
  }
  return `${Math.round(value / unit)}k Context`;
}

export function modelOptionDescription(model: DesktopModelOption): string {
  return [formatContextWindow(modelContextWindow(model)) || "-", model.fastCapable ? "Fast Available" : ""]
    .filter(Boolean).join(" · ");
}

export function modelDetailTooltip(model: DesktopModelOption): string {
  const effort = Array.isArray(model.effortOptions)
    ? model.effortOptions.map((option) => option.label || option.value).filter(Boolean)
    : [];
  return [
    providerDisplayName(model.provider),
    model.model,
    formatContextWindow(modelContextWindow(model)),
    effort.length > 0 ? `Reasoning ${effort.join("/")}` : "",
    model.fastCapable ? "Fast available" : "",
    model.latest ? "Latest" : "",
    model.releaseDate ? `Released ${model.releaseDate}` : "",
  ].filter(Boolean).join(" · ");
}

function titleModelPart(part: string) {
  const text = String(part || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "gpt") return "GPT";
  if (lower === "api") return "API";
  if (lower === "v4") return "V4";
  return `${lower[0]?.toUpperCase() || ""}${lower.slice(1)}`;
}

function canonicalModelDisplay(model: string) {
  const raw = String(model || "").trim()
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  if (!raw) return "";

  const gpt = raw.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (gpt) {
    const suffix = gpt[2] ? `-${gpt[2].split("-").map(titleModelPart).filter(Boolean).join("-")}` : "";
    return `GPT-${gpt[1]}${suffix}`;
  }
  if (/^gpt-/i.test(raw)) {
    return raw.split("-").map((part, index) => index === 0 ? part.toUpperCase() : titleModelPart(part))
      .filter(Boolean).join("-");
  }
  const openaiO = raw.match(/^o(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (openaiO) {
    const tail = openaiO[2] ? ` ${openaiO[2].split("-").map(titleModelPart).filter(Boolean).join(" ")}` : "";
    return `O${openaiO[1]}${tail}`;
  }
  const codex = raw.match(/^codex-(.+)$/i);
  if (codex) return `Codex ${codex[1].split("-").map(titleModelPart).filter(Boolean).join(" ")}`;
  const deepseek = raw.match(/^deepseek-(.+)$/i);
  if (deepseek) return `DeepSeek ${deepseek[1].split("-").map(titleModelPart).filter(Boolean).join(" ")}`;
  const grok = raw.match(/^grok-(.+)$/i);
  if (grok) return `Grok ${grok[1].split("-").map(titleModelPart).filter(Boolean).join(" ")}`;
  const claudeLegacy = raw.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku|fable)(?:-|$)/i);
  if (claudeLegacy) {
    const version = `${claudeLegacy[1]}${claudeLegacy[2] ? `.${claudeLegacy[2]}` : ""}`;
    return `Claude ${titleModelPart(claudeLegacy[3])} ${version}`;
  }
  const claude = raw.match(/^claude-(opus|sonnet|haiku|fable)-(.+)$/i);
  if (claude) return `Claude ${titleModelPart(claude[1])} ${claude[2].replace(/-/g, ".")}`;
  const gemini = raw.match(/^gemini-(\d+(?:\.\d+)?)-(.+)$/i);
  if (gemini) return `Gemini ${gemini[1]} ${gemini[2].split("-").map(titleModelPart).filter(Boolean).join(" ")}`;
  const geminiLoose = raw.match(/^gemini-(.+)$/i);
  if (geminiLoose) return `Gemini ${geminiLoose[1].split("-").map(titleModelPart).filter(Boolean).join(" ")}`;
  return raw;
}

export function modelDisplayName(model: string | null | undefined, provider = "", displayHint = "") {
  void provider;
  const raw = String(model || "").trim();
  const id = raw.includes("/") ? raw.split("/").filter(Boolean).at(-1) || raw : raw;
  const hint = String(displayHint || "").trim();
  if (id) {
    const canonical = canonicalModelDisplay(id);
    if (canonical && canonical !== id) return canonical;
  }
  if (hint) return hint;
  return id ? canonicalModelDisplay(id) || id : "";
}

export function modelOptionLabel(model: { provider: string; model: string; display: string }) {
  const display = modelDisplayName(model.model, model.provider, model.display) || "Unnamed model";
  return `${display} · ${providerDisplayName(model.provider)}`;
}

type ProviderIconKind = "openai" | "anthropic" | "xai" | "google" | "synthetic";

function providerIconKind(provider: string): ProviderIconKind {
  const normalized = provider.toLowerCase();
  if (normalized.includes("openai") || normalized.includes("codex")) return "openai";
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  if (normalized.includes("xai") || normalized.includes("grok")) return "xai";
  if (normalized.includes("google") || normalized.includes("gemini")) return "google";
  return "synthetic";
}

function ProviderIcon({ provider, ...props }: SVGProps<SVGSVGElement> & { provider: string }) {
  const kind = providerIconKind(provider);
  return (
    <svg {...props} viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false"
      data-provider-icon={kind}>
      {kind === "openai" && <path fill="currentColor" d="M32.84 17.28a8 8 0 0 0-8.72-9.75A8 8 0 0 0 11.28 10.16a8 8 0 0 0-4.13 12.56 8 8 0 0 0 8.72 9.75 8 8 0 0 0 12.84-2.63 8 8 0 0 0 4.13-12.56Zm-11.25 15.75a5.58 5.58 0 0 1-3.66-1.31l6.19-3.57a.8.8 0 0 0 .47-.84v-8.44l2.53 1.5v6.94a5.53 5.53 0 0 1-5.53 5.72ZM9.5 27.87a5.58 5.58 0 0 1-.66-3.75l6.19 3.57c.29.14.63.14.94 0l7.31-4.22v2.91l-6.09 3.56a5.53 5.53 0 0 1-7.69-2.07ZM7.9 14.84a5.58 5.58 0 0 1 2.91-2.44v7.13c0 .37.1.66.47.84l7.31 4.22-2.53 1.5-6-3.47a5.53 5.53 0 0 1-2.16-7.78Zm20.72 4.78-7.31-4.22 2.53-1.5 6 3.47a5.53 5.53 0 0 1-.84 10.13v-7.13c0-.37-.1-.66-.38-.75Zm2.53-3.75-6.19-3.56a.95.95 0 0 0-.94 0l-7.31 4.22v-2.91l6.09-3.56a5.53 5.53 0 0 1 8.35 5.81ZM15.4 21.12l-2.53-1.5v-7.03a5.53 5.53 0 0 1 9.19-4.31l-6.19 3.56a.95.95 0 0 0-.47.84v8.44Zm1.31-3 3.28-1.87 3.28 1.87v3.75l-3.28 1.88-3.28-1.88v-3.75Z" />}
      {kind === "anthropic" && <path fill="currentColor" d="M26.96 9.88h-4.83l8.65 21.9h4.71l-8.53-21.9Zm-13.93 0L4.49 31.78h4.83l1.91-4.6h8.99l1.79 4.49h4.83L18.08 9.88h-5.05Zm-.45 13.26 2.92-7.75 3.03 7.75h-5.95Z" />}
      {kind === "xai" && <path fill="currentColor" d="m12.46 15.6 13.69 19.4h-6.08L6.37 15.6h6.09Zm-.01 10.78 3.05 4.31L12.46 35H6.36l6.09-8.62ZM33.64 7.16V35h-4.99V14.22l4.99-7.06Zm0-2.16L20.07 24.22l-3.05-4.31L27.55 5h6.09Z" />}
      {kind === "google" && <path fill="currentColor" d="M37 20.03C27.88 20.58 20.58 27.88 20.03 37h-.06C19.42 27.88 12.12 20.58 3 20.03v-.06C12.12 19.42 19.42 12.12 19.97 3h.06C20.58 12.12 27.88 19.42 37 19.97v.06Z" />}
      {kind === "synthetic" && <path fill="currentColor" d="m20 4 2.24 7.76L30 14l-7.76 2.24L20 24l-2.24-7.76L10 14l7.76-2.24L20 4Zm10 18 1.12 3.88L35 27l-3.88 1.12L30 32l-1.12-3.88L25 27l3.88-1.12L30 22ZM11 24l1.4 4.6L17 30l-4.6 1.4L11 36l-1.4-4.6L5 30l4.6-1.4L11 24Z" />}
    </svg>
  );
}
