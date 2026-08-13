function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function compareRecallNewestFirst(a, b) {
  const tsA = finite(a?.ts) ?? 0
  const tsB = finite(b?.ts) ?? 0
  if (tsA !== tsB) return tsB - tsA

  const sessionA = String(a?.session_id ?? a?.sessionId ?? '')
  const sessionB = String(b?.session_id ?? b?.sessionId ?? '')
  if (sessionA && sessionA === sessionB) {
    const turnA = finite(a?.source_turn ?? a?.sourceTurn)
    const turnB = finite(b?.source_turn ?? b?.sourceTurn)
    if (turnA !== null && turnB !== null && turnA !== turnB) return turnB - turnA
  }

  return (finite(b?.id) ?? 0) - (finite(a?.id) ?? 0)
}
