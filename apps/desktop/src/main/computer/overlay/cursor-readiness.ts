type PrepareSurface = (sessionId: string) => Promise<void>;
let presenter: PrepareSurface | undefined;

/** Bind the live overlay, without making input authorization depend on artwork. */
export function bindCursorPreparation(prepare: PrepareSurface): () => void {
  presenter = prepare;
  return () => { if (presenter === prepare) presenter = undefined; };
}

export async function prepareCursorFeedback(sessionId: string, budgetMs = 750): Promise<'ready' | 'unavailable' | 'timeout'> {
  const prepare = presenter;
  if (!prepare) return 'unavailable';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => prepare(sessionId)).then(() => 'ready' as const, () => 'unavailable' as const),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
