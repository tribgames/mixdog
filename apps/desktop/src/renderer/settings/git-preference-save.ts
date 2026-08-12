import type { DesktopGitPreferences } from '../../shared/contract';

export type GitPreferenceField = 'preset' | 'auto' | 'custom';

interface GitPreferenceSaveContext {
  recovered: boolean;
  publish: boolean;
  patch: Partial<DesktopGitPreferences>;
}

interface GitPreferenceSaveQueueOptions {
  update(patch: Partial<DesktopGitPreferences>): Promise<DesktopGitPreferences>;
  read(): Promise<DesktopGitPreferences>;
  onBusy(field: GitPreferenceField, busy: boolean): void;
  onResult(
    field: GitPreferenceField,
    preferences: DesktopGitPreferences,
    context: GitPreferenceSaveContext,
  ): void;
  onError(error: unknown): void;
}

/** Serializes independent preference writes without disabling unrelated
 * controls. A final failure re-reads durable state and only reconciles the
 * field whose save failed; stale same-field responses are ignored. */
export function createGitPreferenceSaveQueue(options: GitPreferenceSaveQueueOptions) {
  let tail = Promise.resolve();
  let pending = 0;
  const revisions = new Map<GitPreferenceField, number>();

  return {
    save(field: GitPreferenceField, patch: Partial<DesktopGitPreferences>): Promise<void> {
      const revision = (revisions.get(field) ?? 0) + 1;
      revisions.set(field, revision);
      pending += 1;
      options.onBusy(field, true);
      const run = async () => {
        let preferences: DesktopGitPreferences | null = null;
        let failure: unknown = null;
        try {
          preferences = await options.update(patch);
        } catch (error) {
          failure = error;
          try { preferences = await options.read(); } catch { /* retain the user's draft */ }
        }
        pending -= 1;
        const latest = revisions.get(field) === revision;
        if (latest) {
          options.onBusy(field, false);
          if (preferences) {
            options.onResult(field, preferences, {
              recovered: failure !== null,
              publish: pending === 0,
              patch,
            });
          }
        }
        if (failure !== null) options.onError(failure);
      };
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },
  };
}
