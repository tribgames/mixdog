// The app's internal "no project" working folder (<userData>/workspace/unclassified,
// created by the session host). The host reports its exact path; this is the
// one comparison every surface uses against it.

const comparableFolder = (value: string): string =>
  value
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();

/** Whether `folder` is the host's task workspace (`taskWorkspace`, its exact
 *  path). Slash style, a trailing slash and letter case do not matter; an
 *  unknown task workspace ('') matches nothing. */
export function isTaskWorkspaceFolder(folder: string, taskWorkspace: string): boolean {
  return Boolean(taskWorkspace) && comparableFolder(folder) === comparableFolder(taskWorkspace);
}
