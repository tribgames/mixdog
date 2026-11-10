import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The exact-term leg is a case-insensitive literal substring match on
// content/element/summary: no LIKE wildcards, NULL columns never match.
test('the exact-term recall leg matches literal substrings case-insensitively', async (t) => {
  // Private PGDATA and runtime metadata; never the user's memory service.
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-exact-leg-'));
  process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
  process.env.MIXDOG_DATA_DIR = directory;
  const { openDatabase, closeDatabase } = await import('../memory.mjs');
  const { stopPgForShutdown } = await import('../pg/supervisor.mjs');
  const { buildHybridQuery } = await import('./hybrid-sql.mjs');
  const { recallPlan } = await import('./plan.mjs');
  const { buildExactTerms } = await import('../recall-scoring.mjs');
  let passed = false;
  t.after(async () => {
    await closeDatabase(directory);
    await stopPgForShutdown();
    if (passed) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else t.diagnostic(`Retained isolated PostgreSQL artifacts: ${directory}`);
  });
  const db = await openDatabase(directory, 384, { model: 'isolated-exact-test', dimensions: 384 });

  let seq = 0;
  const insert = async (content, element = null, summary = null) => {
    seq += 1;
    const { rows } = await db.query(
      `INSERT INTO entries(ts,role,content,source_ref,session_id,project_id,is_root,element,summary,category,status,last_seen_at)
       VALUES ($1,'assistant',$2,$3,'s','p',1,$4,$5,'fact','active',$1) RETURNING id`,
      [seq * 1000, content, `exact:${seq}`, element, summary]
    );
    return Number(rows[0].id);
  };
  const exactIds = async (query, literal) => {
    assert.ok(buildExactTerms(query).includes(literal), `exact terms of ${query} include ${literal}`);
    const { sql, params } = buildHybridQuery(recallPlan(query));
    const { rows } = await db.query(sql, params);
    return new Set(rows.filter((row) => row.exact_rank != null).map((row) => Number(row.id)));
  };
  const assertMatches = async (query, literal, expected, rejected) => {
    const ids = await exactIds(query, literal);
    for (const id of expected) assert.ok(ids.has(id), `${query} matches #${id}`);
    for (const id of rejected) assert.ok(!ids.has(id), `${query} does not match #${id}`);
  };

  // Mixed Korean/product-name casing, in the query and in each column.
  const koContent = await insert('어제 CLAUDE코드 설정을 바꿨다');
  const koElement = await insert('무관한 본문', 'Claude코드 정리');
  const koSummary = await insert('무관한 본문', null, '요약: claude코드 비교');
  const koOther = await insert('claude 코드 띄어 씀');
  await assertMatches('cLaUdE코드', 'claude코드', [koContent, koElement, koSummary], [koOther]);

  // A non-ASCII case pair. Folding follows the database ctype exactly like
  // ILIKE did (the bundled cluster uses C ctype, which folds ASCII only), so
  // pin parity with ILIKE plus the same-case match.
  const umlautUpper = await insert('DER ÄRGER WAR GROSS');
  const umlautLower = await insert('der ärger war gross');
  const umlautOther = await insert('der arger war gross');
  const { rows: fold } = await db.query(`SELECT 'DER ÄRGER' ILIKE '%ärger%' AS folds`);
  await assertMatches(
    'Ärger',
    'ärger',
    fold[0].folds ? [umlautUpper, umlautLower] : [umlautLower],
    fold[0].folds ? [umlautOther] : [umlautUpper, umlautOther]
  );

  // NULL columns never match on their own; another matching column can.
  const nullOnly = await insert('nothing here', null, null);
  const nullWithSummary = await insert('nothing here', null, 'the nullterm lives in the summary');
  await assertMatches('nullterm', 'nullterm', [nullWithSummary], [nullOnly]);

  // %, _ and backslash are literal characters, never wildcards or escapes.
  const underscore = await insert('set my_var=1');
  const underscoreWild = await insert('set myXvar=1');
  await assertMatches('my_var', 'my_var', [underscore], [underscoreWild]);
  // Single-term queries, so another term cannot produce the match.
  const percent = await insert('ratio a%b here');
  const percentWild = await insert('ratio aXYZb here');
  await assertMatches('a%b', 'a%b', [percent], [percentWild]);
  // As a LIKE escape, x\y would match plain "xy".
  const backslash = await insert('path x\\y here');
  const backslashOther = await insert('path xy here');
  await assertMatches('x\\y', 'x\\y', [backslash], [backslashOther]);
  passed = true;
});
