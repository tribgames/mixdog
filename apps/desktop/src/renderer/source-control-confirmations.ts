import { t } from "./i18n";

/** Keep paths, commit IDs and Git mode tokens outside translated prose. */
export function partialStagingWarning(files: readonly { path: string }[]): string {
  return [
    t("{{count}} files have staged changes that differ from the working tree:", { count: files.length }),
    files.slice(0, 5).map(({ path }) => path).join("\n") + (files.length > 5 ? "\n…" : ""),
    t("Committing replaces that staged content with the full working-tree version. Continue?"),
  ].join("\n\n");
}

export function resetModePrompt(hash: string): string {
  return [
    t("Reset to {{hash}} — type the reset mode:", { hash }),
    [
      `soft   ${t("Move HEAD; keep the index and the working tree.")}`,
      `mixed  ${t("Move HEAD and reset the index; keep the working tree.")}`,
      `hard   ${t("Move HEAD and DISCARD every change made after this commit.")}`,
    ].join("\n"),
  ].join("\n\n");
}
