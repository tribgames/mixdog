import { runtimeAsyncLocalStorage } from './root-async-context.mjs';

const toolExecutionOwner = runtimeAsyncLocalStorage();

export function runWithToolExecutionOwner(ownerKey, run) {
  const owner =
    String(ownerKey || '')
      .trim()
      .slice(0, 240) || 'anonymous';
  return toolExecutionOwner.run(owner, run);
}

export function currentToolExecutionOwner() {
  return toolExecutionOwner.getStore() || 'anonymous';
}
