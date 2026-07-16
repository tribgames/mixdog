import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, RefreshCw, X } from 'lucide-react';

type RuntimeHealth = {
  running?: boolean;
  pid?: number;
};

export function StatusPopover() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [runtime, setRuntime] = useState<RuntimeHealth | null>(null);
  const [engineState, setEngineState] = useState('Checking…');
  const [workflowMode, setWorkflowMode] = useState('Default Mode');
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const invoke = window.mixdogDesktop?.invokeCapability;
    if (typeof invoke !== 'function') {
      setError('Runtime health is unavailable: renderer bridge invokeCapability is missing.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [result, snapshot] = await Promise.all([
        invoke<RuntimeHealth>({ capability: 'getChannelWorkerStatus' }),
        window.mixdogDesktop.getSnapshot(),
      ]);
      setRuntime(result.value && typeof result.value === 'object' ? result.value : {});
      setEngineState(snapshot?.busy || snapshot?.commandBusy ? 'Busy' : 'Ready');
      const workflow = snapshot?.workflow && typeof snapshot.workflow === 'object'
        ? snapshot.workflow as Record<string, unknown>
        : {};
      const name = String(workflow.name || workflow.id || 'Default').trim() || 'Default';
      setWorkflowMode(`${snapshot?.remoteEnabled === true ? 'Remote / ' : ''}${name} Mode`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [load, open]);

  const tone = error ? 'critical' : runtime?.running ? 'healthy' : runtime ? 'idle' : 'pending';
  const bounds = trigger.current?.getBoundingClientRect();
  return <>
    <button ref={trigger} type="button" className="runtime-status-trigger"
      aria-label="Runtime status" aria-haspopup="dialog" aria-expanded={open}
      data-tooltip="Runtime status" onClick={() => setOpen((value) => !value)}>
      <span className="runtime-status-icon"><Activity size={15} /><i data-tone={tone} /></span>
    </button>
    {open && createPortal(<div ref={panel} className="runtime-status-popover" role="dialog"
      aria-label="Runtime health" style={{
        left: Math.max(8, bounds?.left || 8),
        bottom: Math.max(8, window.innerHeight - (bounds?.top || window.innerHeight) + 6),
      }}>
      <header><div><b>Runtime health</b><span data-tone={tone}>{error ? 'Issue detected' : runtime?.running ? 'Running' : loading ? 'Checking…' : 'Stopped'}</span></div>
        <button type="button" aria-label="Close runtime status" onClick={() => setOpen(false)}><X size={14} /></button></header>
      <div className="runtime-status-body">
        <div><span>Desktop bridge</span><b>Connected</b></div>
        <div><span>Engine</span><b>{engineState}</b></div>
        <div><span>Workflow</span><b>{workflowMode}</b></div>
        <div><span>Channel worker</span><b>{runtime?.running ? 'Running' : loading ? 'Checking…' : 'Stopped'}</b></div>
        <div><span>Process ID</span><b>{runtime?.pid || '—'}</b></div>
        {error && <p role="alert">{error}</p>}
      </div>
      <footer><button type="button" disabled={loading} onClick={() => void load()}>
        <RefreshCw className={loading ? 'spin' : ''} size={13} /> Refresh
      </button></footer>
    </div>, document.body)}
  </>;
}
