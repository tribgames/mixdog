/**
 * llm-worker-host.mjs — LLM worker host using direct spawn (no fork).
 *
 * Replaces fork-based approach that broke in bundled environments
 * where the separate worker .mjs file cannot be resolved.
 * Each task spawns a child process directly and communicates via stdio.
 */

export function startLlmWorker() {
}

export async function stopLlmWorker() {
}
