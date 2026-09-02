/**
 * Form controls addressed by ref: text entry, selection, checkboxes, file
 * uploads, and answering the dialog that a submit may have opened.
 */
import { redactBrowserText } from '../host-policy';
import { type BrowserActionContext, defineBrowserActions } from './types';

/** After the control changed: forget the old refs, optionally submit, and
 *  reply with the settled snapshot plus any recovery notes. */
async function afterEdit(
  { guest, signal, refRecovery, actionSnapshot, services }: BrowserActionContext,
  submit: boolean,
) {
  services.state.invalidateInteraction(guest);
  if (submit) await services.input.pressKey(guest, 'enter', signal);
  return services.reply.decorateRecovery(await actionSnapshot(), refRecovery);
}

export const formActions = defineBrowserActions({
  async fill(context) {
    const { guest, command, signal, refRecovery, services } = context;
    const { reply, refActions, state } = services;
    const fields = Array.isArray(command.fields) ? command.fields : [];
    if (!fields.length) {
      if (!command.ref) throw new Error('fill requires ref or fields');
      if (typeof command.text !== 'string') throw new Error('fill requires text');
      await reply.withRefRecovery(
        guest,
        refRecovery,
        command.ref,
        (ref) => refActions.fillRef(guest, ref, command.text as string, signal),
        signal,
      );
      return afterEdit(context, Boolean(command.submit));
    }
    if (fields.length > 30) throw new Error('fill requires at most 30 fields');
    let changed = false;
    try {
      for (const field of fields) {
        const hasText = typeof field?.text === 'string';
        const hasValue = typeof field?.value === 'string';
        const hasValues = Array.isArray(field?.values)
          && field.values.length > 0
          && field.values.every((value) => typeof value === 'string');
        const hasChecked = typeof field?.checked === 'boolean';
        const payloadCount = Number(hasText || hasValue) + Number(hasValues) + Number(hasChecked);
        if (!field?.ref || payloadCount !== 1 || (hasText && hasValue)) {
          throw new Error('each fill field requires ref and exactly one of text/value, values, or checked');
        }
        const operation: (ref: string) => Promise<unknown> = hasValues
          ? (ref) => refActions.selectRef(guest, ref, field.values as string[], signal)
          : hasChecked
            ? (ref) => refActions.setCheckedRef(guest, ref, field.checked as boolean, signal)
            : (ref) => refActions.fillRef(guest, ref, String(field.text ?? field.value), signal);
        await reply.withRefRecovery(guest, refRecovery, field.ref, operation, signal);
        changed = true;
      }
    } catch (error) {
      if (changed) state.invalidateInteraction(guest);
      throw error;
    }
    return afterEdit(context, Boolean(command.submit));
  },

  async type(context) {
    const { guest, command, signal, refRecovery, services } = context;
    if (!command.ref) throw new Error('type requires ref (from snapshot)');
    if (typeof command.text !== 'string') throw new Error('type requires text');
    await services.reply.withRefRecovery(
      guest,
      refRecovery,
      command.ref,
      (ref) => services.refActions.typeRef(guest, ref, command.text as string, signal),
      signal,
    );
    return afterEdit(context, Boolean(command.submit));
  },

  async select(context) {
    const { guest, command, signal, refRecovery, services } = context;
    const { reply, refActions } = services;
    if (!command.ref) throw new Error('select requires ref (from snapshot)');
    const values = Array.isArray(command.values) ? command.values.map(String) : [];
    if (!values.length) {
      // Asking without a value reads the control instead of changing it, so
      // the page is left exactly as it was.
      const options = await reply.withRefRecovery(
        guest,
        refRecovery,
        command.ref,
        (ref) => refActions.listSelectOptions(guest, ref, signal),
        signal,
      );
      return reply.decorateRecovery({
        text: options.length
          ? `Options for ${command.ref} (${options.length}):\n${options.map((option) => `- ${redactBrowserText(option)}`).join('\n')}`
          : `${command.ref} has no options.`,
      }, refRecovery);
    }
    await reply.withRefRecovery(
      guest,
      refRecovery,
      command.ref,
      (ref) => refActions.selectRef(guest, ref, values, signal),
      signal,
    );
    return afterEdit(context, false);
  },

  async check(context) {
    const { guest, command, signal, refRecovery, services } = context;
    if (!command.ref) throw new Error('check requires ref (from snapshot)');
    await services.reply.withRefRecovery(
      guest,
      refRecovery,
      command.ref,
      (ref) => services.refActions.setCheckedRef(guest, ref, command.checked !== false, signal),
      signal,
    );
    return afterEdit(context, false);
  },

  async upload({ guest, command, signal, refRecovery, actionSnapshot, services }) {
    const ref = command.ref ? String(command.ref) : undefined;
    if (ref && !refRecovery.source?.refs.has(ref)) {
      throw new Error('upload requires a ref from the latest snapshot; upload refs are never auto-recovered');
    }
    await services.refActions.uploadRef(
      guest,
      ref,
      Array.isArray(command.paths) ? command.paths.map(String) : [],
      command.confirm === true,
      signal,
    );
    services.state.invalidateInteraction(guest);
    return actionSnapshot();
  },

  async handle_dialog({ guest, command, signal, actionSnapshot, services }) {
    await services.dialogs.handleDialog(guest, command.accept === true, command.promptText || '', signal);
    services.state.invalidateInteraction(guest);
    return actionSnapshot();
  },
});
