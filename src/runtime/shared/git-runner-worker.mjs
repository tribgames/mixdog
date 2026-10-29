// Worker-thread body for git-runner.mjs: git children are spawned on this
// thread, never on the host event loop (run-child.mjs). Each request resolves
// to { code, stdout, stderr } or an error with the same codes the in-process
// runner used (ETIMEDOUT, EMAXBUFFER, spawn errors).
import { startGit } from './git-launch.mjs';
import { runChild } from './run-child.mjs';
import { serveWorkerRequests } from './worker-requests.mjs';

serveWorkerRequests((request) => startGit(request.env, (command, env) => runChild({ ...request, command, env })));
