// Session listing and project routes: one daemon call, one field of the result.
import { randomUUID } from 'node:crypto';

export function createProjectRoutes({ binding, sendCall }) {
  const projectCall = async (route, payload, pick) => pick(await sendCall(route, payload, randomUUID()));
  return {
    async listSessions(listOptions = {}) {
      const result = await binding.attachment.client.list(listOptions, { callId: randomUUID() });
      return Array.isArray(result?.sessions) ? result.sessions : [];
    },
    async listProjects() {
      const result = await sendCall('project.list', {}, randomUUID());
      return Array.isArray(result?.projects) ? result.projects : [];
    },
    inspectProjectPath: (projectPath) => sendCall('project.inspect', { path: projectPath }, randomUUID()),
    addProject: (projectPath) => projectCall('project.add', { path: projectPath }, (r) => r?.project ?? null),
    touchProjectSelected: (projectPath) =>
      projectCall('project.touch', { path: projectPath }, (r) => r?.project ?? null),
    renameProject: (projectPath, name) =>
      projectCall('project.rename', { path: projectPath, name }, (r) => r?.project ?? null),
    removeProject: (projectPath) => projectCall('project.remove', { path: projectPath }, (r) => r?.removed === true),
    ensureProjectDirectory: (projectPath) =>
      projectCall('project.ensureDirectory', { path: projectPath }, (r) => String(r?.path || '')),
  };
}
