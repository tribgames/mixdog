/**
 * The core's half of the human-only approval lock (human-only-approval.ts): the core sends the agent's
 * Computer Use input to its own helper, so every human-only dialog also holds it there
 * (`host/humanOnly/begin`, answered once the core's running operations ended) until the dialog closes
 * (`host/humanOnly/end`). The core ends a hold with the connection that declared it, so a dialog still
 * open then is declared again on the next connection (`redeclare`, at each claim).
 */
import type {
  HostHumanOnlyBeginParams,
  HostHumanOnlyBeginResult,
  HostHumanOnlyEndParams,
} from '../../../../../packages/protocol/src/index.ts';
import { setCoreHumanOnlyHolds } from '../human-only-approval';
import { HOST_METHOD, type HostConnection } from './connection';

/** One open dialog's hold. */
interface OpenHold {
  label: string;
  /** The core's id for it on the current connection; null while none is declared there. */
  coreId: string | null;
  /** A declaration is on its way. */
  declaring: boolean;
}

export function registerHumanOnlyHolds(connection: HostConnection) {
  /** The holds of the dialogs open now, by the id `begin` answered. */
  const open = new Map<string, OpenHold>();
  let last = 0;
  const declare = async (hold: OpenHold): Promise<string> => {
    hold.declaring = true;
    try {
      const begun = await connection.request(HOST_METHOD.humanOnlyBegin, { label: hold.label } satisfies HostHumanOnlyBeginParams);
      return (begun as HostHumanOnlyBeginResult).holdId;
    } finally {
      hold.declaring = false;
    }
  };
  const endOnCore = (coreId: string): void =>
    void connection.request(HOST_METHOD.humanOnlyEnd, { holdId: coreId } satisfies HostHumanOnlyEndParams).catch(() => undefined);
  // The core ended every hold of the connection that closed.
  connection.onClose(() => {
    for (const hold of open.values()) hold.coreId = null;
  });
  setCoreHumanOnlyHolds({
    begin: async (label) => {
      const id = String(++last);
      const hold: OpenHold = { label, coreId: null, declaring: false };
      open.set(id, hold);
      try {
        hold.coreId = await declare(hold);
      } catch (error) {
        open.delete(id);
        throw error;
      }
      return id;
    },
    end: (id) => {
      const hold = open.get(id);
      open.delete(id);
      // A hold whose connection closed is already over; one being declared again ends once it is.
      if (hold?.coreId) endOnCore(hold.coreId);
    },
  });
  return {
    /** Declares again each open dialog's hold that ended with its connection. */
    redeclare(): void {
      for (const [id, hold] of open) {
        if (hold.coreId !== null || hold.declaring) continue;
        void declare(hold).then(
          (coreId) => {
            if (open.get(id) === hold) hold.coreId = coreId;
            else endOnCore(coreId);
          },
          // Still undeclared: the next claim tries again.
          () => undefined
        );
      }
    },
  };
}
