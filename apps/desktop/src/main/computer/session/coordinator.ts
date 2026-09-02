export type ComputerUseActivityPhase =
  | 'active_background'
  | 'active_foreground'
  | 'queued_foreground'
  | 'queued_target'
  | 'awaiting_recapture'
  | 'thinking'
  | 'paused_user_takeover';

export type ComputerUseCursorEffect =
  | 'move'
  | 'click'
  | 'double_click'
  | 'drag'
  | 'scroll'
  | 'type';

export interface ComputerUseActivity {
  sessionId: string;
  action: string;
  target: string;
  mode: 'background' | 'foreground';
  phase: ComputerUseActivityPhase;
  queuePosition?: number;
  startedAt: number;
  updatedAt: number;
}

export interface ComputerUseCursor {
  sessionId: string;
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  action: string;
  effect: ComputerUseCursorEffect;
  direction?: 'up' | 'down' | 'left' | 'right';
  mode: 'background' | 'foreground';
  eventId: number;
  updatedAt: number;
}

export interface ComputerUseAttention {
  sessionId: string;
  detail: string;
  requestedAt: number;
}

export interface ComputerUseSnapshot {
  revision: number;
  userControlActive: boolean;
  takeoverReason?: string;
  attentionRequired?: ComputerUseAttention;
  activities: ComputerUseActivity[];
  cursors: ComputerUseCursor[];
  targetLeases: Array<{
    sessionId: string;
    windowId: string;
    expiresAt: number | null;
  }>;
}

export type TargetLeaseResult =
  | {
    status: 'acquired';
    queued: boolean;
    waitedMs: number;
    windowIds: string[];
  }
  | {
    status: 'timeout' | 'cancelled' | 'user_takeover';
    queued: boolean;
    waitedMs: number;
    queuePosition: number;
    windowIds: string[];
  };

interface TargetLease {
  sessionId: string;
  expiresAt: number;
}

interface PendingTargetLease {
  id: number;
  sessionId: string;
  windowIds: string[];
  enqueuedAt: number;
  queuePosition: number;
  timer: NodeJS.Timeout | null;
  resolve: (result: TargetLeaseResult) => void;
}

export interface ComputerUseCoordinatorOptions {
  now?: () => number;
  targetLeaseGraceMs?: number;
  targetLeaseWaitMs?: number;
}

const DEFAULT_TARGET_LEASE_GRACE_MS = 10_000;
const DEFAULT_TARGET_LEASE_WAIT_MS = 30_000;

function normalizedWindowIds(windowIds: Array<string | undefined>): string[] {
  return [...new Set(windowIds.map((value) => String(value || '').trim()).filter(Boolean))];
}

export function queuedForegroundRequiresRecapture(queuePosition: number): boolean {
  return Number.isFinite(queuePosition) && queuePosition > 0;
}

export function computerResultHasCode(text: string, expectedCode: string): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (record.code === expectedCode) return true;
    return Object.values(record).some(visit);
  };
  try {
    return visit(JSON.parse(String(text || '')));
  } catch {
    return false;
  }
}

export class ComputerUseCoordinator {
  private readonly now: () => number;
  private readonly targetLeaseGraceMs: number;
  private readonly targetLeaseWaitMs: number;
  private readonly listeners = new Set<(snapshot: ComputerUseSnapshot) => void>();
  private readonly activities = new Map<string, ComputerUseActivity>();
  private readonly cursors = new Map<string, ComputerUseCursor>();
  private readonly activeCounts = new Map<string, number>();
  private readonly targetLeases = new Map<string, TargetLease>();
  private readonly pendingTargetLeases: PendingTargetLease[] = [];
  private leaseSequence = 0;
  private cursorSequence = 0;
  private revision = 0;
  private leaseExpiryTimer: NodeJS.Timeout | null = null;
  private userControlActive = false;
  private takeoverReason = '';
  private attentionRequired: ComputerUseAttention | null = null;

  constructor(options: ComputerUseCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.targetLeaseGraceMs = Math.max(0, options.targetLeaseGraceMs ?? DEFAULT_TARGET_LEASE_GRACE_MS);
    this.targetLeaseWaitMs = Math.max(0, options.targetLeaseWaitMs ?? DEFAULT_TARGET_LEASE_WAIT_MS);
  }

  snapshot(): ComputerUseSnapshot {
    this.pruneExpiredLeases();
    return {
      revision: this.revision,
      userControlActive: this.userControlActive,
      ...(this.takeoverReason ? { takeoverReason: this.takeoverReason } : {}),
      ...(this.attentionRequired ? { attentionRequired: { ...this.attentionRequired } } : {}),
      activities: [...this.activities.values()]
        .map((activity) => ({ ...activity }))
        .sort((left, right) => left.startedAt - right.startedAt),
      cursors: [...this.cursors.values()]
        .map((cursor) => ({ ...cursor }))
        .sort((left, right) => left.eventId - right.eventId),
      targetLeases: [...this.targetLeases.entries()].map(([windowId, lease]) => ({
        sessionId: lease.sessionId,
        windowId,
        expiresAt: Number.isFinite(lease.expiresAt) ? lease.expiresAt : null,
      })),
    };
  }

  subscribe(listener: (snapshot: ComputerUseSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  assertAutomationAllowed(): void {
    if (this.userControlActive) {
      throw new Error('computer_user_control_active: Computer Use is paused while the user has control');
    }
  }

  beginCommand(input: {
    sessionId: string;
    action: string;
    target?: string;
    mode: 'background' | 'foreground';
  }): void {
    this.assertAutomationAllowed();
    const now = this.now();
    if (!this.attentionRequired?.sessionId
      || this.attentionRequired.sessionId === input.sessionId) {
      this.attentionRequired = null;
    }
    const existing = this.activities.get(input.sessionId);
    const count = (this.activeCounts.get(input.sessionId) || 0) + 1;
    this.activeCounts.set(input.sessionId, count);
    for (const lease of this.targetLeases.values()) {
      if (lease.sessionId === input.sessionId) lease.expiresAt = Number.POSITIVE_INFINITY;
    }
    this.activities.set(input.sessionId, {
      sessionId: input.sessionId,
      action: input.action,
      target: String(input.target || ''),
      mode: input.mode,
      phase: input.mode === 'foreground' ? 'active_foreground' : 'active_background',
      startedAt: existing?.startedAt || now,
      updatedAt: now,
    });
    this.changed();
  }

  queueForeground(sessionId: string, queuePosition: number): void {
    this.updateActivity(sessionId, {
      phase: 'queued_foreground',
      queuePosition: Math.max(1, queuePosition),
    });
  }

  activateForeground(sessionId: string): void {
    this.updateActivity(sessionId, {
      phase: 'active_foreground',
      queuePosition: undefined,
    });
  }

  setCommandTarget(sessionId: string, target: string): void {
    if (!target) return;
    this.updateActivity(sessionId, { target });
  }

  showCursor(input: {
    sessionId: string;
    x: number;
    y: number;
    toX?: number;
    toY?: number;
    action: string;
    effect: ComputerUseCursorEffect;
    direction?: 'up' | 'down' | 'left' | 'right';
    mode: 'background' | 'foreground';
  }): void {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return;
    const hasDestination = Number.isFinite(input.toX) && Number.isFinite(input.toY);
    const now = this.now();
    this.cursors.set(input.sessionId, {
      sessionId: input.sessionId,
      x: Math.round(input.x),
      y: Math.round(input.y),
      ...(hasDestination ? {
        toX: Math.round(input.toX as number),
        toY: Math.round(input.toY as number),
      } : {}),
      action: input.action,
      effect: input.effect,
      ...(input.direction ? { direction: input.direction } : {}),
      mode: input.mode,
      eventId: ++this.cursorSequence,
      updatedAt: now,
    });
    const existing = this.activities.get(input.sessionId);
    if (existing) {
      this.activities.set(input.sessionId, {
        ...existing,
        action: input.action,
        mode: input.mode,
        phase: input.mode === 'foreground' ? 'active_foreground' : 'active_background',
        queuePosition: undefined,
        updatedAt: now,
      });
    }
    this.changed();
  }

  finishCommand(sessionId: string): void {
    const remaining = Math.max(0, (this.activeCounts.get(sessionId) || 0) - 1);
    if (remaining > 0) this.activeCounts.set(sessionId, remaining);
    else this.activeCounts.delete(sessionId);
    if (remaining === 0) {
      const expiresAt = this.now() + this.targetLeaseGraceMs;
      for (const lease of this.targetLeases.values()) {
        if (lease.sessionId === sessionId) lease.expiresAt = expiresAt;
      }
      if (!this.userControlActive) {
        const existing = this.activities.get(sessionId);
        if (existing) {
          this.activities.set(sessionId, {
            ...existing,
            phase: 'thinking',
            queuePosition: undefined,
            updatedAt: this.now(),
          });
        }
      }
    }
    this.scheduleLeaseExpiry();
    this.changed();
  }

  endExecution(sessionId: string): void {
    this.activeCounts.delete(sessionId);
    this.activities.delete(sessionId);
    this.cursors.delete(sessionId);
    if (this.attentionRequired?.sessionId === sessionId) this.attentionRequired = null;
    if (this.activities.size === 0) {
      this.userControlActive = false;
      this.takeoverReason = '';
    }
    this.changed();
  }

  requestAttention(input: { sessionId?: string; detail?: string }): void {
    const sessionId = String(input.sessionId || '');
    const detail = String(input.detail || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    this.attentionRequired = {
      sessionId,
      detail,
      requestedAt: this.now(),
    };
    if (sessionId) this.cursors.delete(sessionId);
    this.changed();
  }

  clearAttention(sessionId?: string): void {
    if (!this.attentionRequired) return;
    if (sessionId
      && this.attentionRequired.sessionId
      && this.attentionRequired.sessionId !== sessionId) {
      return;
    }
    this.attentionRequired = null;
    this.changed();
  }

  touchTargets(sessionId: string): void {
    this.pruneExpiredLeases();
    const expiresAt = this.activeCounts.has(sessionId)
      ? Number.POSITIVE_INFINITY
      : this.now() + this.targetLeaseGraceMs;
    let touched = false;
    for (const lease of this.targetLeases.values()) {
      if (lease.sessionId !== sessionId) continue;
      lease.expiresAt = expiresAt;
      touched = true;
    }
    if (touched) this.scheduleLeaseExpiry();
  }

  async acquireTargets(
    sessionId: string,
    windowIds: Array<string | undefined>,
    waitMs = this.targetLeaseWaitMs,
  ): Promise<TargetLeaseResult> {
    this.assertAutomationAllowed();
    this.pruneExpiredLeases();
    const exactWindowIds = normalizedWindowIds(windowIds);
    if (exactWindowIds.length === 0) {
      return { status: 'acquired', queued: false, waitedMs: 0, windowIds: [] };
    }
    if (this.targetsAvailableTo(sessionId, exactWindowIds)
      && !this.hasEarlierOverlappingWaiter(exactWindowIds)) {
      this.assignTargets(sessionId, exactWindowIds);
      return { status: 'acquired', queued: false, waitedMs: 0, windowIds: exactWindowIds };
    }

    const queuePosition = this.pendingTargetLeases.length + 1;
    if (waitMs <= 0) {
      return {
        status: 'timeout',
        queued: false,
        waitedMs: 0,
        queuePosition,
        windowIds: exactWindowIds,
      };
    }

    const enqueuedAt = this.now();
    return await new Promise<TargetLeaseResult>((resolve) => {
      const request: PendingTargetLease = {
        id: ++this.leaseSequence,
        sessionId,
        windowIds: exactWindowIds,
        enqueuedAt,
        queuePosition,
        timer: null,
        resolve,
      };
      request.timer = setTimeout(() => {
        if (!this.removePendingRequest(request)) return;
        resolve({
          status: 'timeout',
          queued: true,
          waitedMs: Math.max(0, this.now() - enqueuedAt),
          queuePosition: request.queuePosition,
          windowIds: exactWindowIds,
        });
        this.refreshTargetQueueActivities();
        this.changed();
      }, waitMs);
      request.timer.unref?.();
      this.pendingTargetLeases.push(request);
      this.updateActivity(sessionId, {
        phase: 'queued_target',
        queuePosition,
        target: exactWindowIds[0] || '',
      });
      this.changed();
    });
  }

  releaseTargets(sessionId: string): void {
    let changed = false;
    for (const [windowId, lease] of this.targetLeases) {
      if (lease.sessionId !== sessionId) continue;
      this.targetLeases.delete(windowId);
      changed = true;
    }
    this.cancelPendingRequests(sessionId, 'cancelled');
    if (changed) this.drainTargetQueue();
    this.scheduleLeaseExpiry();
    this.changed();
  }

  cancelSession(sessionId: string): void {
    this.activeCounts.delete(sessionId);
    this.activities.delete(sessionId);
    this.cursors.delete(sessionId);
    if (this.attentionRequired?.sessionId === sessionId) this.attentionRequired = null;
    this.releaseTargets(sessionId);
    if (this.activities.size === 0) {
      this.userControlActive = false;
      this.takeoverReason = '';
    }
  }

  pauseForUser(
    reason = 'user_takeover',
    additionalSessionIds: Iterable<string> = [],
  ): string[] {
    const sessionIds = new Set<string>([
      ...this.activities.keys(),
      ...[...this.targetLeases.values()].map((lease) => lease.sessionId),
      ...this.pendingTargetLeases.map((request) => request.sessionId),
      ...additionalSessionIds,
    ]);
    if (sessionIds.size === 0) return [];
    this.userControlActive = true;
    this.takeoverReason = reason;
    const now = this.now();
    for (const sessionId of sessionIds) {
      const existing = this.activities.get(sessionId);
      this.activities.set(sessionId, {
        sessionId,
        action: existing?.action || 'paused',
        target: existing?.target || '',
        mode: existing?.mode || 'foreground',
        phase: 'paused_user_takeover',
        startedAt: existing?.startedAt || now,
        updatedAt: now,
      });
      this.cursors.delete(sessionId);
    }
    for (const request of this.pendingTargetLeases.splice(0)) {
      if (request.timer) clearTimeout(request.timer);
      request.resolve({
        status: 'user_takeover',
        queued: true,
        waitedMs: Math.max(0, now - request.enqueuedAt),
        queuePosition: request.queuePosition,
        windowIds: request.windowIds,
      });
    }
    this.targetLeases.clear();
    this.scheduleLeaseExpiry();
    this.changed();
    return [...sessionIds];
  }

  resumeAfterUserTakeover(): void {
    this.userControlActive = false;
    this.takeoverReason = '';
    for (const [sessionId, activity] of this.activities) {
      if (activity.phase !== 'paused_user_takeover') continue;
      this.activities.set(sessionId, {
        ...activity,
        phase: 'thinking',
        queuePosition: undefined,
        updatedAt: this.now(),
      });
    }
    this.changed();
  }

  reset(): void {
    for (const request of this.pendingTargetLeases.splice(0)) {
      if (request.timer) clearTimeout(request.timer);
      request.resolve({
        status: 'cancelled',
        queued: true,
        waitedMs: Math.max(0, this.now() - request.enqueuedAt),
        queuePosition: request.queuePosition,
        windowIds: request.windowIds,
      });
    }
    if (this.leaseExpiryTimer) clearTimeout(this.leaseExpiryTimer);
    this.leaseExpiryTimer = null;
    this.activities.clear();
    this.cursors.clear();
    this.activeCounts.clear();
    this.targetLeases.clear();
    this.userControlActive = false;
    this.takeoverReason = '';
    this.attentionRequired = null;
    this.changed();
  }

  private updateActivity(
    sessionId: string,
    patch: Partial<Omit<ComputerUseActivity, 'sessionId' | 'startedAt'>>,
  ): void {
    const existing = this.activities.get(sessionId);
    if (!existing) return;
    this.activities.set(sessionId, {
      ...existing,
      ...patch,
      updatedAt: this.now(),
    });
    this.changed();
  }

  private targetsAvailableTo(sessionId: string, windowIds: string[]): boolean {
    return windowIds.every((windowId) => {
      const lease = this.targetLeases.get(windowId);
      return !lease || lease.sessionId === sessionId;
    });
  }

  private hasEarlierOverlappingWaiter(windowIds: string[]): boolean {
    const targets = new Set(windowIds);
    return this.pendingTargetLeases.some((request) => (
      request.windowIds.some((windowId) => targets.has(windowId))
    ));
  }

  private assignTargets(sessionId: string, windowIds: string[]): void {
    const expiresAt = this.activeCounts.has(sessionId)
      ? Number.POSITIVE_INFINITY
      : this.now() + this.targetLeaseGraceMs;
    for (const windowId of windowIds) this.targetLeases.set(windowId, { sessionId, expiresAt });
    this.setCommandTarget(sessionId, windowIds[0] || '');
    this.scheduleLeaseExpiry();
    this.changed();
  }

  private removePendingRequest(request: PendingTargetLease): boolean {
    const index = this.pendingTargetLeases.findIndex((candidate) => candidate.id === request.id);
    if (index < 0) return false;
    this.pendingTargetLeases.splice(index, 1);
    if (request.timer) clearTimeout(request.timer);
    return true;
  }

  private cancelPendingRequests(
    sessionId: string,
    status: 'cancelled' | 'user_takeover',
  ): void {
    const now = this.now();
    for (const request of [...this.pendingTargetLeases]) {
      if (request.sessionId !== sessionId || !this.removePendingRequest(request)) continue;
      request.resolve({
        status,
        queued: true,
        waitedMs: Math.max(0, now - request.enqueuedAt),
        queuePosition: request.queuePosition,
        windowIds: request.windowIds,
      });
    }
    this.refreshTargetQueueActivities();
  }

  private drainTargetQueue(): void {
    this.pruneExpiredLeases(false);
    let granted = false;
    for (const request of [...this.pendingTargetLeases]) {
      if (!this.targetsAvailableTo(request.sessionId, request.windowIds)) continue;
      if (!this.removePendingRequest(request)) continue;
      this.assignTargets(request.sessionId, request.windowIds);
      this.updateActivity(request.sessionId, {
        phase: 'awaiting_recapture',
        queuePosition: undefined,
      });
      request.resolve({
        status: 'acquired',
        queued: true,
        waitedMs: Math.max(0, this.now() - request.enqueuedAt),
        windowIds: request.windowIds,
      });
      granted = true;
    }
    if (granted) this.refreshTargetQueueActivities();
  }

  private refreshTargetQueueActivities(): void {
    this.pendingTargetLeases.forEach((request, index) => {
      request.queuePosition = index + 1;
      this.updateActivity(request.sessionId, {
        phase: 'queued_target',
        queuePosition: request.queuePosition,
      });
    });
  }

  private pruneExpiredLeases(drain = true): void {
    const now = this.now();
    let expired = false;
    for (const [windowId, lease] of this.targetLeases) {
      if (lease.expiresAt > now) continue;
      this.targetLeases.delete(windowId);
      expired = true;
    }
    if (expired && drain) this.drainTargetQueue();
  }

  private scheduleLeaseExpiry(): void {
    if (this.leaseExpiryTimer) clearTimeout(this.leaseExpiryTimer);
    this.leaseExpiryTimer = null;
    const now = this.now();
    const nextExpiry = Math.min(
      ...[...this.targetLeases.values()]
        .map((lease) => lease.expiresAt)
        .filter(Number.isFinite),
    );
    if (!Number.isFinite(nextExpiry)) return;
    this.leaseExpiryTimer = setTimeout(() => {
      this.leaseExpiryTimer = null;
      this.pruneExpiredLeases();
      this.scheduleLeaseExpiry();
      this.changed();
    }, Math.max(0, nextExpiry - now));
    this.leaseExpiryTimer.unref?.();
  }

  private changed(): void {
    this.revision += 1;
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const computerUseCoordinator = new ComputerUseCoordinator();
