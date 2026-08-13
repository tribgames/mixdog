const TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?)\b/;
const SESSION_HEADER_RE = /^##\s+session\b/i;

export function textOfResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content.map((part) => (part?.type === 'text' ? part.text || '' : JSON.stringify(part))).join('\n');
  }
  if (result && typeof result === 'object' && typeof result.text === 'string') return result.text;
  if (typeof result === 'string') return result;
  return JSON.stringify(result ?? '');
}

function timestampMs(raw) {
  const value = Date.parse(String(raw || '').replace(' ', 'T'));
  return Number.isFinite(value) ? value : null;
}

export function parseRecallOutput(text) {
  const items = [];
  const headers = [];
  let current = null;
  let group = null;
  let groupLabel = null;
  let groupIndex = -1;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line === '(no results)' || line === '(no valid ids)') continue;
    if (SESSION_HEADER_RE.test(line)) {
      groupIndex += 1;
      group = groupIndex;
      groupLabel = line.replace(/^##\s+session\s+/i, '').split(/\s+\(/, 1)[0].trim();
      current = null;
      headers.push({ text: line, group, label: groupLabel });
      continue;
    }
    const stamp = TIMESTAMP_RE.exec(line);
    if (stamp) {
      current = {
        text: line,
        firstLine: line,
        timestampText: stamp[1],
        timestampMs: timestampMs(stamp[1]),
        group,
        groupLabel,
      };
      items.push(current);
      continue;
    }
    if (line.startsWith('[recall truncated') || line.startsWith('note:')) {
      current = null;
      continue;
    }
    if (/^\[[^\]]+\]$/.test(line)) {
      current = null;
      continue;
    }
    if (current) current.text += `\n${line}`;
  }
  return { items, headers };
}

export function topItems(items, n = 3, maxLen = 140) {
  return items.slice(0, n).map((item) => {
    const line = item.text.replace(/\s+/g, ' ');
    return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
  });
}

export function scoreTopNContains(items, substrings, n) {
  const lower = items.map((item) => item.text.toLowerCase());
  const perSubstring = substrings.map((needle) => {
    const target = String(needle || '').toLowerCase();
    let rank = null;
    for (let i = 0; i < lower.length; i += 1) {
      if (target && lower[i].includes(target)) {
        rank = i + 1;
        break;
      }
    }
    const hit = rank !== null && rank <= n;
    return { needle, rank, hit, rr: hit ? 1 / rank : 0 };
  });
  const total = perSubstring.length || 1;
  return {
    perSubstring,
    hitAtN: perSubstring.reduce((sum, row) => sum + (row.hit ? 1 : 0), 0) / total,
    mrr: perSubstring.reduce((sum, row) => sum + row.rr, 0) / total,
    n,
  };
}

function firstRecencyBreak(items) {
  for (let i = 1; i < items.length; i += 1) {
    const previous = items[i - 1];
    const current = items[i];
    if (current.timestampMs !== null && previous.timestampMs !== null && current.timestampMs > previous.timestampMs) {
      return { prev: previous.timestampText, cur: current.timestampText };
    }
  }
  return null;
}

export function scoreRecencyOrdered(items) {
  const timestamped = items.filter((item) => item.timestampMs !== null);
  const grouped = timestamped.some((item) => item.group !== null);
  if (!grouped) {
    const firstViolation = firstRecencyBreak(timestamped);
    return {
      parsed: timestamped.length,
      groups: 0,
      ordered: firstViolation === null,
      firstViolation,
    };
  }
  const groups = new Map();
  for (const item of timestamped) {
    const key = item.group ?? -1;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  let firstViolation = null;
  for (const rows of groups.values()) {
    const hit = firstRecencyBreak(rows);
    if (hit) {
      firstViolation = { ...hit, scope: 'within-session' };
      break;
    }
  }
  if (!firstViolation) {
    const hit = firstRecencyBreak([...groups.values()].map((rows) => rows[0]));
    if (hit) firstViolation = { ...hit, scope: 'across-sessions' };
  }
  return {
    parsed: timestamped.length,
    groups: groups.size,
    ordered: firstViolation === null,
    firstViolation,
  };
}

function groupHeads(parsed) {
  const heads = [];
  const seen = new Set();
  for (const item of parsed?.items || []) {
    const key = item.groupLabel ?? `group:${item.group ?? -1}`;
    if (seen.has(key) || item.timestampMs === null) continue;
    seen.add(key);
    heads.push(item);
  }
  return heads;
}

export function scorePageAfter(previousParsed, currentParsed) {
  const previousHeads = groupHeads(previousParsed);
  const currentHeads = groupHeads(currentParsed);
  const previousLabels = new Set((previousParsed?.headers || []).map((header) => header.label).filter(Boolean));
  const duplicateGroups = (currentParsed?.headers || [])
    .filter((header) => header.label && previousLabels.has(header.label));
  const previousLast = previousHeads.at(-1) || null;
  const currentFirst = currentHeads[0] || null;
  const inverted = previousLast?.timestampMs != null
    && currentFirst?.timestampMs != null
    && currentFirst.timestampMs > previousLast.timestampMs;
  return {
    ok: duplicateGroups.length === 0 && !inverted,
    duplicateGroups,
    inverted,
    previousLast,
    currentFirst,
  };
}

export function scoreAllContain(items, substrings) {
  const needles = substrings.map((value) => String(value || '').toLowerCase()).filter(Boolean);
  const offenders = items.filter((item) => {
    const text = item.text.toLowerCase();
    return !needles.some((needle) => text.includes(needle));
  });
  return { needles: substrings, offenders, ok: offenders.length === 0 };
}

export function scoreWithinPeriod(items, temporal, toleranceMs = 60_000) {
  const startMs = Number(temporal?.startMs);
  const endMs = Number(temporal?.endMs);
  const hasStart = Number.isFinite(startMs);
  const hasEnd = Number.isFinite(endMs);
  const offenders = items.filter((item) => (
    item.timestampMs !== null
    && ((hasStart && item.timestampMs < startMs - toleranceMs)
      || (hasEnd && item.timestampMs > endMs + toleranceMs))
  ));
  return { checked: items.filter((item) => item.timestampMs !== null).length, offenders, ok: offenders.length === 0 };
}

export function evaluateCase(kase, outcome, quality, recency, allContain, withinPeriod, pageOrder) {
  const warnings = [];
  const expectObj = kase.expect && typeof kase.expect === 'object' ? kase.expect : {};
  const expectKind = expectObj.kind || kase.expect;
  const allowEmpty = expectObj.allowEmpty === true;
  const minResults = Number.isInteger(expectObj.minResults)
    ? Math.max(0, expectObj.minResults)
    : (expectKind === 'empty' || allowEmpty ? 0 : 1);
  const maxResults = Number.isInteger(expectObj.maxResults) ? Math.max(0, expectObj.maxResults) : null;
  if (outcome.isError) warnings.push('error result');
  if (outcome.ms > 3000) warnings.push(`latency ${outcome.ms}ms > 3000ms`);
  if (outcome.count < minResults) warnings.push(`expected at least ${minResults} result(s), got ${outcome.count}`);
  if (maxResults !== null && outcome.count > maxResults) warnings.push(`expected at most ${maxResults} result(s), got ${outcome.count}`);
  if (expectKind === 'empty' && outcome.count > 0) warnings.push(`expected empty but got ${outcome.count} result(s)`);
  if (allContain) {
    for (const item of allContain.offenders) {
      warnings.push(`allContain miss: "${item.firstLine}"`);
    }
  }
  if (quality) {
    for (const row of quality.perSubstring) {
      if (!row.hit) {
        warnings.push(row.rank === null
          ? `topNContains miss: "${row.needle}" not found in results`
          : `topNContains miss: "${row.needle}" found at rank ${row.rank} > topN ${quality.n}`);
      }
    }
  }
  if (recency && !recency.ordered && recency.firstViolation) {
    const violation = recency.firstViolation;
    warnings.push(`recencyOrdered violation (${violation.scope || 'global'}): ${violation.cur} newer than prior ${violation.prev}`);
  }
  if (withinPeriod) {
    for (const item of withinPeriod.offenders) {
      warnings.push(`withinPeriod miss: "${item.firstLine}"`);
    }
  }
  if (pageOrder) {
    for (const header of pageOrder.duplicateGroups) {
      warnings.push(`pageOrder duplicate session: "${header.label}"`);
    }
    if (pageOrder.inverted) {
      warnings.push(`pageOrder inversion: page starts at ${pageOrder.currentFirst?.timestampText} after prior page ended at ${pageOrder.previousLast?.timestampText}`);
    }
  }
  return { status: warnings.length ? 'WARN' : 'PASS', warnings };
}
