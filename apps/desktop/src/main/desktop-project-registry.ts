// Desktop project registry: the shared core projects.json store plus the
// desktop-only preferences sidecar (aliases, pins, legacy hidden tombstones).
import { isAbsolute, resolve } from 'node:path';

import type { DesktopProjectSummary } from '../shared/contract';
import { readProjectPreferences, writeProjectPreferences } from './project-preferences-file';
import type {
  DesktopProjectPreferences,
  MixdogProject,
  MixdogProjectsModule,
} from './backend-support';
import {
  matchingProjectPath,
  normalizedProjectKey,
  projectAlias,
  withoutMatchingProject,
} from './backend-support';

/** Recent-project list length shown in the snapshot. */
const RECENT_PROJECT_LIMIT = 12;

export class DesktopProjectRegistry {
  private readonly loadProjectsModule: () => Promise<MixdogProjectsModule>;
  private readonly userDataRoot: () => string;
  private preferences: DesktopProjectPreferences | null = null;

  constructor(options: {
    loadProjectsModule: () => Promise<MixdogProjectsModule>;
    userDataRoot: () => string;
  }) {
    this.loadProjectsModule = options.loadProjectsModule;
    this.userDataRoot = options.userDataRoot;
  }

  /** Enter a project: register it, mark it most-recently selected, and undo any
   *  legacy hidden tombstone. Returns the refreshed recent-project list. */
  async enter(canonicalPath: string): Promise<string[]> {
    const store = await this.loadProjectsModule();
    const registered = this.addTo(store, canonicalPath);
    store.touchProjectSelected(registered.path);
    await this.unhide(store, registered.path);
    return this.recentsOf(store);
  }

  /** Register a folder WITHOUT entering it (the Projects page adds in place). */
  async register(canonicalPath: string): Promise<string[]> {
    const store = await this.loadProjectsModule();
    const registered = this.addTo(store, canonicalPath);
    await this.unhide(store, registered.path);
    return this.recentsOf(store);
  }

  /** The registered path for a requested one, or a rejection when unknown. */
  async knownPath(projectPath: string): Promise<string> {
    const store = await this.loadProjectsModule();
    return this.known(store, projectPath).path;
  }

  /** Mark an already-registered project as most-recently selected. */
  async touchSelected(registeredPath: string): Promise<string[]> {
    const store = await this.loadProjectsModule();
    store.touchProjectSelected(registeredPath);
    return this.recentsOf(store);
  }

  async list(): Promise<{ projects: DesktopProjectSummary[]; recents: string[] }> {
    const store = await this.loadProjectsModule();
    const registered = this.registered(store);
    const preferences = await this.loadPreferences();
    // The core store already orders by most-recent use; the desktop keeps
    // that order (pin ordering retired with the popup switcher).
    return {
      projects: registered.map((project) => ({
        name: project.name,
        path: project.path,
        alias: projectAlias(preferences.aliases, project.path),
      })),
      recents: registered.map((project) => project.path).slice(0, RECENT_PROJECT_LIMIT),
    };
  }

  async rename(projectPath: string, displayAlias: string): Promise<void> {
    const store = await this.loadProjectsModule();
    const known = this.known(store, projectPath).path;
    if (!store.renameProject(known, displayAlias)) throw new Error('Project is not available.');
    const preferences = await this.loadPreferences();
    for (const candidate of Object.keys(preferences.aliases)) {
      if (normalizedProjectKey(candidate) === normalizedProjectKey(known)) {
        delete preferences.aliases[candidate];
      }
    }
    if (displayAlias) preferences.aliases[known] = displayAlias;
    await this.savePreferences(store);
  }

  async remove(projectPath: string): Promise<string[]> {
    const store = await this.loadProjectsModule();
    const known = this.known(store, projectPath).path;
    if (store.removeProject(known) !== true) throw new Error('Project is not available.');
    const preferences = await this.loadPreferences();
    preferences.hidden = [known, ...withoutMatchingProject(preferences.hidden, known)];
    await this.savePreferences(store);
    return this.recentsOf(store);
  }

  private addTo(store: MixdogProjectsModule, canonicalPath: string): MixdogProject {
    const registered = store.addProject(canonicalPath);
    if (!registered) throw new Error('Unable to register the selected project.');
    return registered;
  }

  private async unhide(store: MixdogProjectsModule, path: string): Promise<void> {
    const preferences = await this.loadPreferences();
    preferences.hidden = withoutMatchingProject(preferences.hidden, path);
    await this.savePreferences(store);
  }

  private recentsOf(store: MixdogProjectsModule): string[] {
    return this.registered(store).map((project) => project.path).slice(0, RECENT_PROJECT_LIMIT);
  }

  private async loadPreferences(): Promise<DesktopProjectPreferences> {
    this.preferences ??= await readProjectPreferences(this.userDataRoot());
    return this.preferences;
  }

  private async savePreferences(store?: MixdogProjectsModule): Promise<void> {
    if (!this.preferences) return;
    if (store) {
      const registeredPaths = this.registered(store).map((project) => project.path);
      // `hidden` is retained only as a legacy desktop tombstone. A path the
      // shared core store currently registers must always be visible.
      this.preferences.hidden = this.preferences.hidden.filter((candidate) =>
        matchingProjectPath(registeredPaths, candidate) === null);
    }
    await writeProjectPreferences(this.userDataRoot(), this.preferences);
  }

  /** Registered projects, skipping malformed or relative store entries. */
  private registered(store: MixdogProjectsModule): MixdogProject[] {
    const listed = store.listProjects();
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((entry): MixdogProject[] => {
      if (!entry || typeof entry !== 'object') return [];
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      if (!path || !isAbsolute(path)) return [];
      const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path;
      return [{
        name,
        path,
        addedAt: Number(entry.addedAt) || 0,
        ...(Number(entry.lastSelectedAt) > 0 ? { lastSelectedAt: Number(entry.lastSelectedAt) } : {}),
      }];
    });
  }

  private known(store: MixdogProjectsModule, projectPath: string): MixdogProject {
    const requested = projectPath.trim();
    if (!requested) throw new Error('Project is not available.');
    const resolved = store.resolveProjectPath?.(requested) || resolve(requested);
    const key = normalizedProjectKey(resolved);
    const project = this.registered(store).find((entry) => normalizedProjectKey(entry.path) === key);
    if (!project) throw new Error('Project is not available.');
    return project;
  }
}
