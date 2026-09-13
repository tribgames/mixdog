// Only for WHERE/ON filtering. Keep the indexed column bare while retaining
// COALESCE(column,'') behavior for NULLs and patterns that match empty text.
// column and term are internal SQL expressions; user text stays in bind values.
export function recallSubstringPredicate(column, term) {
    const pattern = `'%' || ${term} || '%'`;
    return `(${column} ILIKE ${pattern} OR (${column} IS NULL AND '' ILIKE ${pattern}))`;
}
