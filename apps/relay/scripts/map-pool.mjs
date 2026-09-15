/** Bounded parallel map shared by staging and fingerprint walks. */
export async function mapPool(items, limit, run) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await run(items[index], index);
    }
  });
  await Promise.all(lanes);
}
