/**
 * Equality indexes keep PostgreSQL's full-value collision recheck. No stored
 * identifier is shortened, and no row/retention/vector setting is changed.
 * Build replacements concurrently; take only a bounded metadata lock to swap.
 */
export const SESSION_INDEXES = [
  // Memory's ordered session paging needs its composite btree. A hash-only
  // replacement preserved rows but regressed the largest session in replay.
  { schema: 'trace', table: 'trace_events', name: 'idx_trace_session' },
  { schema: 'trace', table: 'agent_calls', name: 'idx_ac_session' },
  { schema: 'trace', table: 'agent_llm', name: 'idx_al_session' },
];
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const qualified = (schema, name) => `${quote(schema)}.${quote(name)}`;

export function sessionIndexSql(name) {
  const target = SESSION_INDEXES.find((entry) => entry.name === name);
  if (!target) throw new Error(`Unknown session index: ${name}`);
  return `CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${qualified(target.schema, target.table)}
        USING hash (session_id)${target.predicate ? ` WHERE ${target.predicate}` : ''}`;
}

async function describe(client, schema, name) {
  return (
    await client.query(
      `
        SELECT i.oid::text AS oid,t.relkind,am.amname AS method,x.indisvalid,x.indisunique,
            pg_get_indexdef(i.oid) AS definition,n.nspname AS schema,t.relname AS table,
            pg_relation_size(i.oid)::text AS bytes
        FROM pg_class i JOIN pg_namespace n ON n.oid=i.relnamespace
        JOIN pg_index x ON x.indexrelid=i.oid JOIN pg_class t ON t.oid=x.indrelid
        JOIN pg_am am ON am.oid=i.relam WHERE n.nspname=$1 AND i.relname=$2
    `,
      [schema, name]
    )
  ).rows[0];
}

export async function prepareSessionIndexes(client) {
  const prepared = [];
  await client.query("SET lock_timeout='5s'; SET statement_timeout='5min'");
  for (const target of SESSION_INDEXES) {
    const old = await describe(client, target.schema, target.name);
    if (!old || old.table !== target.table || old.indisunique || !old.indisvalid) {
      throw new Error(`Unexpected original index: ${target.schema}.${target.name}`);
    }
    if (old.method === 'hash') continue;
    const temporary = `${target.name}_diet_v1`;
    if (await describe(client, target.schema, temporary)) {
      throw new Error(`Unresolved prior index build: ${target.schema}.${temporary}`);
    }
    const table = qualified(target.schema, target.table);
    const predicate = target.predicate ? ` WHERE ${target.predicate}` : '';
    if (old.relkind === 'p') {
      await client.query(`CREATE INDEX ${quote(temporary)} ON ONLY ${table} USING hash(session_id)${predicate}`);
      const children = (
        await client.query(
          `
                SELECT n.nspname AS schema,c.relname AS name,c.oid::text AS oid
                FROM pg_inherits h JOIN pg_class c ON c.oid=h.inhrelid
                JOIN pg_namespace n ON n.oid=c.relnamespace WHERE h.inhparent=$1::regclass
            `,
          [`${target.schema}.${target.table}`]
        )
      ).rows;
      for (const child of children) {
        const name = `mixdog_diet_${old.oid}_${child.oid}`;
        await client.query(`CREATE INDEX CONCURRENTLY ${quote(name)}
                    ON ${qualified(child.schema, child.name)} USING hash(session_id)${predicate}`);
        await client.query(`ALTER INDEX ${qualified(target.schema, temporary)}
                    ATTACH PARTITION ${qualified(child.schema, name)}`);
      }
    } else {
      await client.query(
        `CREATE INDEX CONCURRENTLY ${quote(temporary)} ON ${table} USING hash(session_id)${predicate}`
      );
    }
    const next = await describe(client, target.schema, temporary);
    if (!next?.indisvalid || next.method !== 'hash') throw new Error(`Invalid replacement index: ${temporary}`);
    prepared.push({ ...target, temporary, original: old });
  }
  return prepared;
}

export async function commitSessionIndexes(client, prepared) {
  for (const target of prepared) {
    // Revalidate identity immediately before dropping the old index.
    const old = await describe(client, target.schema, target.name);
    const next = await describe(client, target.schema, target.temporary);
    if (
      old?.oid !== target.original.oid ||
      old?.definition !== target.original.definition ||
      !next?.indisvalid ||
      next.method !== 'hash' ||
      next.table !== target.table
    ) {
      throw new Error(`Index changed during validation: ${target.name}`);
    }
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query(`DROP INDEX ${qualified(target.schema, target.name)}`);
      await client.query(`ALTER INDEX ${qualified(target.schema, target.temporary)} RENAME TO ${quote(target.name)}`);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw error;
    }
  }
}
