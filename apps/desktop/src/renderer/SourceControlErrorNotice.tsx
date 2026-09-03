import { AlertTriangle } from "lucide-react";

import { t } from "./i18n";

export type SourceControlErrorKind =
  | "authentication"
  | "conflict"
  | "network"
  | "non-fast-forward"
  | "protected-branch"
  | "generic";

export type SourceControlErrorPresentation = {
  kind: SourceControlErrorKind;
  summary: string;
  details: string;
};

const MAX_DETAILS_LENGTH = 12_000;
const IPC_ERROR_PREFIX = /^Error invoking remote method ['"][^'"]+['"]:\s*/i;

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason ?? "");
}

function cleanErrorDetails(reason: unknown): string {
  let details = errorText(reason).replace(/\r\n?/g, "\n").trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const cleaned = details
      .replace(IPC_ERROR_PREFIX, "")
      .replace(/^Error:\s*/i, "")
      .trim();
    if (cleaned === details) break;
    details = cleaned;
  }
  details = details.replace(
    /\b((?:https?|ssh):\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    "$1[credentials]@",
  );
  if (details.length > MAX_DETAILS_LENGTH) {
    return `${details.slice(0, MAX_DETAILS_LENGTH).trimEnd()}\n…`;
  }
  return details;
}

function classifyError(details: string): SourceControlErrorKind {
  if (
    /\bfetch first\b|\bnon-fast-forward\b|remote contains work that you do not have locally|updates were rejected because the remote contains work/i
      .test(details)
  ) return "non-fast-forward";
  if (
    /authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)|not logged into any github hosts|gh auth login/i
      .test(details)
  ) return "authentication";
  if (
    /\bCONFLICT\b|automatic merge failed|resolve all conflicts manually|fix conflicts and then commit/i
      .test(details)
  ) return "conflict";
  if (
    /protected branch|pre-receive hook declined|\bGH006\b|remote rejected/i
      .test(details)
  ) return "protected-branch";
  if (
    /could not resolve host|failed to connect|connection timed out|connection reset|network is unreachable|ssl certificate problem/i
      .test(details)
  ) return "network";
  return "generic";
}

function compactSummary(details: string): string {
  const lines = details.split("\n").map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) =>
    !/^(?:To\s+\S+|hint:|error:\s*failed to push some refs)/i.test(line),
  ) ?? lines[0] ?? "";
  const summary = useful
    .replace(/^(?:fatal|error|remote):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) return "The action could not be completed.";
  return summary.length > 220 ? `${summary.slice(0, 219).trimEnd()}…` : summary;
}

export function describeSourceControlError(reason: unknown): SourceControlErrorPresentation {
  const details = cleanErrorDetails(reason);
  const kind = classifyError(details);
  const summary = compactSummary(details);
  const flattenedDetails = details.replace(/\s+/g, " ").trim();
  const keepDetails = Boolean(details) && (
    kind !== "generic"
    || details.includes("\n")
    || flattenedDetails.length > 220
    || /^(?:fatal|error|remote):/i.test(details)
  );
  return {
    kind,
    summary,
    details: keepDetails ? details : "",
  };
}

function presentationCopy(presentation: SourceControlErrorPresentation): {
  title: string;
  message: string;
} {
  switch (presentation.kind) {
    case "non-fast-forward":
      return {
        title: t("Push blocked"),
        message: t("The remote branch has newer commits. Pull or sync, resolve any conflicts, then push again."),
      };
    case "authentication":
      return {
        title: t("Sign-in required"),
        message: t("Sign in to Git or GitHub, then try the action again."),
      };
    case "conflict":
      return {
        title: t("Resolve conflicts first"),
        message: t("Finish resolving the current Git conflicts, then try again."),
      };
    case "protected-branch":
      return {
        title: t("Push rejected"),
        message: t("The remote repository rules rejected this push. Review the details, then update the branch and try again."),
      };
    case "network":
      return {
        title: t("Connection failed"),
        message: t("Check your network connection and the remote repository address, then try again."),
      };
    default:
      return {
        title: t("Git action failed"),
        message: presentation.summary,
      };
  }
}

export function SourceControlErrorNotice({
  error,
  className = "",
  compact = false,
  onAuthenticationHelp,
  authenticationHelpLabel,
}: {
  error: unknown;
  className?: string;
  compact?: boolean;
  onAuthenticationHelp?: () => void;
  authenticationHelpLabel?: string;
}) {
  const presentation = describeSourceControlError(error);
  const copy = presentationCopy(presentation);
  const classes = ["source-control-error-notice", className].filter(Boolean).join(" ");
  return <section className={classes} role="alert" data-compact={compact || undefined}>
    <AlertTriangle size={16} aria-hidden="true" />
    <div className="source-control-error-copy">
      <strong>{copy.title}</strong>
      <p>{copy.message}</p>
      {presentation.details && <details className="source-control-error-details">
        <summary>{t("Show details")}</summary>
        <pre>{presentation.details}</pre>
      </details>}
      {presentation.kind === "authentication" && onAuthenticationHelp &&
        <button type="button" onClick={onAuthenticationHelp}>
          {authenticationHelpLabel || t("Sign-in help")}
        </button>}
    </div>
  </section>;
}
