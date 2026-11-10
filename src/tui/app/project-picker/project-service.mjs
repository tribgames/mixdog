/**
 * project-picker/project-service.mjs — the daemon-backed project operations:
 * registering a path in the project list and switching the session cwd.
 * `actions` is the late-bound picker surface (openProjectPicker).
 */
import { createStoreServiceCall } from '../store-service-call.mjs';

export function createProjectService({ store, surface, projectNameFromPath }, actions) {
  const call = createStoreServiceCall(store);

  // Register a project in the picker list without switching this session's cwd.
  const registerProject = async (rawPath) => {
    const path = String(rawPath || '').trim();
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return false;
    }
    // Post-write delegation: the project list reopen must still own the surface
    // (the add can ack long after an Esc).
    const own = surface.claim();
    try {
      const project = await call('addProject', path);
      if (project?.name) store.pushNotice(`project added: ${project.name}`, 'info');
      if (!own.owns()) return true;
      await actions.openProjectPicker();
      return true;
    } catch (e) {
      store.pushNotice(`project add failed: ${e?.message || e}`, 'error');
      return false;
    }
  };

  // Switch the active working directory to a registered/created project path.
  const enterProject = async (rawPath, options = {}) => {
    const path = String(rawPath || '').trim();
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return false;
    }
    surface.claim().close();
    try {
      // Switch cwd first; only persist the project once the runtime accepts it,
      // so an invalid/missing path can never be written to projects.json.
      const resolved = await call('setCwd', path, {
        notice: options?.notice !== false,
        message: `Project set: ${projectNameFromPath(path)}`,
      });
      if (options?.register !== false) await call('addProject', resolved || path);
      return true;
    } catch (e) {
      store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
      return false;
    }
  };

  return { call, registerProject, enterProject };
}
