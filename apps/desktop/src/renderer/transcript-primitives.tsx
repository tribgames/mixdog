import { useEffect, useRef, useState, type CSSProperties } from "react";
import { type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { MxIcon } from "./MxIcon";
import { copyTextToClipboard } from "./text-format";

export const TERMINAL_AGENT_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

const compactTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

export function formatTokenCount(value: number): string {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1000) return compactTokenFormatter.format(tokens).toUpperCase();
  return String(Math.round(tokens));
}

export function timeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatWorkElapsed(value: unknown): string {
  const elapsed = Math.max(0, Number(value) || 0);
  if (!Number.isFinite(elapsed) || elapsed < 1_000) return "";
  const days = Math.floor(elapsed / 86_400_000);
  const hours = Math.floor((elapsed % 86_400_000) / 3_600_000);
  const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1_000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// CSS measures the shimmer in terminal cells, where CJK characters are wide.
const WIDE_CELL = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function shimmerCells(text: string): number {
  let cells = 0;
  for (const character of text) cells += WIDE_CELL.test(character) ? 2 : 1;
  return cells || 1;
}

export function TextShimmer({ text, active = true }: { text: string; active?: boolean }) {
  return <span data-component="text-shimmer" data-active={active ? "true" : "false"} aria-label={text}
    style={{ "--text-shimmer-cells": shimmerCells(text) } as CSSProperties}>
    <span key={text} data-slot="text-shimmer-char" data-run={active ? "true" : "false"}
      aria-hidden="true">{text}</span>
  </span>;
}

export function CopyControl({ value, label, className, tooltipSide = "top" }: {
  value: string;
  label: string;
  className: string;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}) {
  const copiedTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const copy = async () => {
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className={className} onClick={() => void copy()}
    aria-label={copied ? t("Copied") : t(label)} data-copied={copied || undefined}
    data-tooltip={copied ? t("Copied") : t("Copy")} data-tooltip-side={tooltipSide}>
    {copied ? <MxIcon name="check" size={14} /> : <MxIcon name="copy" size={14} />}
  </button>;
}

export function completionTone(item: TranscriptItem): "complete" | "failed" | "interrupted" | "compaction" {
  const label = String(item.label || item.status || "").trim();
  const status = String(item.status || "").toLowerCase();
  if (status === "failed" || item.tone === "error" || /failed|error/i.test(label)) return "failed";
  if (/^(?:cancelled|canceled|aborted|interrupted)$/.test(status)
    || /cancelled|canceled|aborted|interrupted/i.test(label)) return "interrupted";
  if (item.kind === "statusdone" && /compact/i.test(label)) return "compaction";
  return "complete";
}
