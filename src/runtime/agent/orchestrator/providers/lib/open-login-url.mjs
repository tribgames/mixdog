/** Open an OAuth login URL in the browser, best effort: a failure is logged, never thrown. */
export async function openLoginUrl(provider, url) {
  try {
    const { openInBrowser } = await import('../../../../shared/open-url.mjs');
    openInBrowser(url);
  } catch (err) {
    process.stderr.write(`[${provider}] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
  }
}
