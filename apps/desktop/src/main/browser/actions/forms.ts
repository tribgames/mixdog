/**
 * Form controls addressed by ref: text entry, selection, checkboxes, file
 * uploads, and answering the dialog that a submit may have opened.
 */
import { redactBrowserText } from '../redaction';
import { mutateRef } from './ref-mutation';
import { actionRef, adoptResolvedTargets } from './target';
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
    const { guest, command, signal, services } = context;
    const { refActions, state } = services;
    const fields = Array.isArray(command.fields) ? command.fields : [];
    if (!fields.length) {
      const ref = await actionRef(context);
      if (!ref) throw new Error('fill requires ref, target, or fields');
      // One control: text for an input, or a checked state for a checkbox
      // or radio; the schema admits exactly one of the two.
      const hasText = typeof command.text === 'string';
      const hasChecked = typeof command.checked === 'boolean';
      if (hasText === hasChecked) throw new Error('fill requires text or checked');
      await mutateRef(context, ref, async (recovered) => {
        if (hasChecked) await refActions.setCheckedRef(guest, recovered, command.checked as boolean, signal);
        else await refActions.fillRef(guest, recovered, command.text as string, signal);
      });
      return afterEdit(context, Boolean(command.submit));
    }
    if (fields.length > 30) throw new Error('fill requires at most 30 fields');
    // Targets are resolved against ONE fresh observation before any field
    // changes; refs and targets cannot mix because that observation would
    // retire the caller's refs.
    const targeted = fields.filter((field) => field?.target !== undefined && field?.target !== null);
    if (targeted.length && targeted.length !== fields.length) {
      throw new Error('fill.fields must address every item by ref or every item by target, not a mix');
    }
    let fieldRefs = fields.map((field) => String(field?.ref || ''));
    if (targeted.length) {
      const resolved = await services.targets.resolveTargetRefs(
        guest,
        fields.map((field) => field.target),
        signal,
      );
      adoptResolvedTargets(context, resolved);
      fieldRefs = resolved.map((entry) => entry.ref);
    }
    let changed = false;
    try {
      for (const [index, field] of fields.entries()) {
        const fieldRef = fieldRefs[index];
        const hasText = typeof field?.text === 'string';
        const hasValue = typeof field?.value === 'string';
        const hasValues = Array.isArray(field?.values)
          && field.values.length > 0
          && field.values.every((value) => typeof value === 'string');
        const hasChecked = typeof field?.checked === 'boolean';
        const payloadCount = Number(hasText || hasValue) + Number(hasValues) + Number(hasChecked);
        if (!fieldRef || payloadCount !== 1 || (hasText && hasValue)) {
          throw new Error('each fill field requires ref or target and exactly one of text/value, values, or checked');
        }
        const operation: (ref: string) => Promise<unknown> = hasValues
          ? (ref) => refActions.selectRef(guest, ref, field.values as string[], signal)
          : hasChecked
            ? (ref) => refActions.setCheckedRef(guest, ref, field.checked as boolean, signal)
            : (ref) => refActions.fillRef(guest, ref, String(field.text ?? field.value), signal);
        await mutateRef(context, fieldRef, operation);
        changed = true;
      }
    } catch (error) {
      if (changed) state.invalidateInteraction(guest);
      throw error;
    }
    return afterEdit(context, Boolean(command.submit));
  },

  async type(context) {
    const { guest, command, signal, services } = context;
    const ref = await actionRef(context);
    if (!ref) throw new Error('type requires ref (from snapshot) or target');
    if (typeof command.text !== 'string') throw new Error('type requires text');
    await mutateRef(
      context,
      ref,
      (recovered) => services.refActions.typeRef(guest, recovered, command.text as string, signal),
    );
    return afterEdit(context, Boolean(command.submit));
  },

  async select(context) {
    const { guest, command, signal, refRecovery, services } = context;
    const { reply, refActions } = services;
    const ref = await actionRef(context);
    if (!ref) throw new Error('select requires ref (from snapshot) or target');
    const values = Array.isArray(command.values) ? command.values.map(String) : [];
    if (!values.length) {
      // Asking without a value reads the control instead of changing it, so
      // the page is left exactly as it was.
      const options = await reply.withRefRecovery(
        guest,
        refRecovery,
        ref,
        (recovered) => refActions.listSelectOptions(guest, recovered, signal),
        signal,
      );
      return reply.decorateRecovery({
        text: options.length
          ? `Options for ${ref} (${options.length}):\n${options.map((option) => `- ${redactBrowserText(option)}`).join('\n')}`
          : `${ref} has no options.`,
      }, refRecovery);
    }
    await mutateRef(
      context,
      ref,
      (recovered) => refActions.selectRef(guest, recovered, values, signal),
    );
    return afterEdit(context, false);
  },

  async upload(context) {
    const { guest, command, signal, refRecovery, actionSnapshot, services } = context;
    const ref = await actionRef(context);
    if (ref && !refRecovery.source?.refs.has(ref)) {
      throw new Error('upload requires a ref from the latest snapshot; upload refs are never auto-recovered');
    }
    await services.refActions.uploadRef(
      guest,
      ref,
      Array.isArray(command.paths) ? command.paths.map(String) : [],
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
