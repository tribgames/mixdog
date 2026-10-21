/** Rendered size of a pane, or undefined while its element is not mounted. */
export function paneSize(leafId: string): { width: number; height: number } | undefined {
  const paneElement = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).find(
    (element) => element.dataset.paneId === leafId
  );
  const rect = paneElement?.getBoundingClientRect();
  return rect ? { width: rect.width, height: rect.height } : undefined;
}

/** Trimmed project and slash-normalised relative path of a diff target; null when either is empty. */
/** A session with no registered Project (a task, a bot's home thread) runs in
 *  its own folder; the pane's project path is then only the tool-project
 *  fallback, which is some other folder (or a big tree) entirely. */
export function sessionOwnsWorkspace(
  sessions: ReadonlyArray<{ id?: string; projectPath?: string | null } | null | undefined>,
  registeredProjectPath: (path: string) => string,
  sessionId: string
): boolean {
  const row = sessions.find((session) => session?.id === sessionId);
  return Boolean(row) && !registeredProjectPath(String(row?.projectPath || ''));
}

/** The folder a session's Changes read: its own working directory when it owns
 *  one (none yet: no Git read at all), else the pane's project. */
export function sessionChangesCwd(ownsWorkspace: boolean, laneCwd: unknown, projectPath: string): string {
  return ownsWorkspace ? String(laneCwd || '') : projectPath;
}

export function cleanDiffTarget(project: string, rel: string): { project: string; rel: string } | null {
  const cleanProject = String(project || '').trim();
  const cleanRel = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  return cleanProject && cleanRel ? { project: cleanProject, rel: cleanRel } : null;
}
