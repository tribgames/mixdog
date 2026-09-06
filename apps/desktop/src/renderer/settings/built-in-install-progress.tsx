// Progress stays in the control slot, where the installed toggle will appear.
export function SlotProgress({ percent, label }: { percent: number | null; label: string }) {
  return <span className="built-in-feature-slot-progress" role="progressbar"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
    aria-valuetext={label}>
    {percent !== null && <small aria-hidden="true">{percent}%</small>}
    <span className={`built-in-feature-progress-bar${percent === null ? ' is-indeterminate' : ''}`}>
      <span style={percent === null ? undefined : { width: `${percent}%` }} />
    </span>
  </span>;
}
