/** Added/removed counts; a zero half is left out. */
export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats">
      {additions > 0 && <i>+{additions}</i>}
      {deletions > 0 && (
        <em>
          {'\u2212'}
          {deletions}
        </em>
      )}
    </span>
  );
}
