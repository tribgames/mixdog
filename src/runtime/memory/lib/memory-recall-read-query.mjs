// Recall read path: bounded query time via SET LOCAL (requires a transaction).
export async function recallReadQuery(db, sql, params) {
  return db.transaction(async (tx) => {
    await tx.query(`SET LOCAL statement_timeout = '30s'`)
    return tx.query(sql, params)
  })
}