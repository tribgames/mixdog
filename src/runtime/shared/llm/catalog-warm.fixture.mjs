// Tests that read the catalog from fixture files on disk settle the explicit
// warm first; the interval keeps the loop alive while the background worker
// read is pending.
export async function warmCatalogForTest(catalog) {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await catalog.warmCatalogFromDisk();
  } finally {
    clearInterval(keepAlive);
  }
}
