import type { DesktopProjectSummary } from '../shared/contract';

export function displayProjectTitle(project: Pick<DesktopProjectSummary, 'path' | 'alias' | 'name'>): string {
  return project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path);
}

export function displayProjectFolder(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || path
  );
}
