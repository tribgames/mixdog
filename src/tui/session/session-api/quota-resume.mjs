/**
 * quota-resume.mjs — the session object's quota auto-resume surface: the
 * session-addressed controls (schedule/cancel the resume, retry a failed
 * turn), the daemon scheduler's fire entry, and the global auto-resume
 * setting. The lane behind them is ../quota-resume.mjs.
 */
import { quotaAutoResumeEnabled, setQuotaAutoResumeEnabled } from '../../../runtime/shared/quota-resume-store.mjs';

export function createQuotaResumeApi(bag) {
  return {
    scheduleQuotaResume: (sessionId) => bag.scheduleQuotaResume(sessionId),
    cancelQuotaResume: (sessionId) => bag.cancelQuotaResume(sessionId),
    retryFailedTurn: (sessionId, turnKey) => bag.retryFailedTurn(sessionId, turnKey),
    fireQuotaResume: (options) => bag.fireQuotaResume(options),
    getQuotaAutoResume: () => quotaAutoResumeEnabled(),
    setQuotaAutoResume: (enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('quota auto resume must be boolean');
      return setQuotaAutoResumeEnabled(enabled);
    },
  };
}
