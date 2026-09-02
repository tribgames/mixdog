// Office session actions, split by lifecycle stage. This facade keeps the public
// surface stable for index.mjs and office-candidate-actions.mjs.
export { applyBatch } from './office-actions-batch.mjs';
export { issues, validate } from './office-actions-inspect.mjs';
export { qa, render } from './office-actions-render.mjs';
export { closeSession, finalize, save } from './office-actions-lifecycle.mjs';
