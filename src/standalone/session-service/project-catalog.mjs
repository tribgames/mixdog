// session-service/project-catalog.mjs — Project registry surface of the session
// service, backed by the desktop runtime's project store.
import { sanitizeForWire } from '../session-wire-values.mjs';

export function createProjectCatalog({ desktopRuntime = null } = {}) {
  let projectStorePromise = null;

  async function loadProjectStore() {
    if (typeof desktopRuntime?.loadProjects !== 'function') {
      throw new Error('project service is unavailable');
    }
    projectStorePromise ??= Promise.resolve(desktopRuntime.loadProjects()).catch((error) => {
      projectStorePromise = null;
      throw error;
    });
    return projectStorePromise;
  }

  function requiredProjectPath(path) {
    const value = String(path || '').trim();
    if (!value) throw new TypeError('project path is required');
    return value;
  }

  async function listProjectCatalog() {
    const projects = await loadProjectStore();
    return {
      projects: sanitizeForWire(projects.listProjects?.() || []),
    };
  }

  async function inspectProjectPath({ path } = {}) {
    const projects = await loadProjectStore();
    const resolved = projects.resolveProjectPath?.(requiredProjectPath(path)) || '';
    if (!resolved) throw new TypeError('project path is required');
    return {
      path: resolved,
      exists: projects.pathExists?.(resolved) === true,
      directory: projects.isDirectory?.(resolved) === true,
    };
  }

  async function addProjectEntry({ path } = {}) {
    const projects = await loadProjectStore();
    const project = projects.addProject?.(requiredProjectPath(path)) || null;
    if (!project) throw new Error('project could not be registered');
    return { project: sanitizeForWire(project) };
  }

  async function touchProjectEntry({ path } = {}) {
    const projects = await loadProjectStore();
    return {
      project: sanitizeForWire(projects.touchProjectSelected?.(requiredProjectPath(path)) || null),
    };
  }

  async function renameProjectEntry({ path, name = '' } = {}) {
    const projects = await loadProjectStore();
    const project = projects.renameProject?.(requiredProjectPath(path), String(name || '')) || null;
    if (!project) throw new Error('project is not registered');
    return { project: sanitizeForWire(project) };
  }

  async function removeProjectEntry({ path } = {}) {
    const projects = await loadProjectStore();
    return { removed: projects.removeProject?.(requiredProjectPath(path)) === true };
  }

  async function ensureProjectDirectory({ path } = {}) {
    const projects = await loadProjectStore();
    const resolved = projects.ensureDir?.(requiredProjectPath(path)) || '';
    if (!resolved) throw new Error('project directory could not be created');
    return { path: resolved };
  }

  return Object.freeze({
    loadProjectStore,
    listProjectCatalog,
    inspectProjectPath,
    addProjectEntry,
    touchProjectEntry,
    renameProjectEntry,
    removeProjectEntry,
    ensureProjectDirectory,
  });
}
