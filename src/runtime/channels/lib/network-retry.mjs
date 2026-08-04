// Network-error detection + retry helper extracted from channels/index.mjs
// (behavior-preserving).
const NETWORK_ERR_RE = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout|aborted|TimeoutError/i;
function isNetworkError(err) {
  const s = `${err?.code ?? ""} ${err?.name ?? ""} ${err?.message ?? err ?? ""}`;
  return NETWORK_ERR_RE.test(s);
}
async function retryOnNetwork(fn, { attempts = 3, baseDelayMs = 300, label = "op" } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isNetworkError(err)) throw err;
      const delay = baseDelayMs * (i + 1);
      process.stderr.write(`mixdog: ${label} network failure (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${err?.message || err}\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
export { isNetworkError, retryOnNetwork };
