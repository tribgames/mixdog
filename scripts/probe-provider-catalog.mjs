// Prints each named provider's raw listModels() outcome with the real ~/.mixdog data.
import os from 'node:os';
import { createMixdogSessionRuntime } from '../src/session-runtime/runtime-core.mjs';
import { getProvider } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import { listCompatModels } from '../src/runtime/agent/orchestrator/providers/openai-compat-models.mjs';

const names = process.argv.slice(2);
const runtime = await createMixdogSessionRuntime({ provider: 'deepseek', model: 'deepseek-flash', cwd: os.tmpdir() });
await runtime.listProviderModels?.({ force: true }).catch(() => {});
for (const name of names) {
  const provider = getProvider(name);
  if (!provider) {
    console.log(name, 'NOT REGISTERED');
    continue;
  }
  try {
    const models =
      name === 'xai' ? await listCompatModels(provider, { throwOnError: true }) : await provider.listModels();
    console.log(
      name,
      'models',
      models.length,
      models.fallback ? '(fallback)' : '',
      models.slice(0, 5).map((m) => m.id)
    );
  } catch (error) {
    console.log(name, 'ERROR', error?.status || '', String(error?.message || error).slice(0, 300));
  }
}
await runtime.close('probe-provider-catalog');
process.exit(0);
