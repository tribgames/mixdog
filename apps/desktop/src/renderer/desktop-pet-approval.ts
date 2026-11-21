// A pending approval as the pet's speech bubble shows it. It is built from the
// approval card's own model and rows (ApprovalCard.tsx), so the bubble offers
// exactly the decisions the card does and never one of its own.
import {
  DESKTOP_PET_APPROVAL_ROWS_MAX,
  DESKTOP_PET_APPROVAL_TEXT_MAX,
  type DesktopPetApproval,
} from '../shared/desktop-pet';
import { approvalAllowIsPointerOnly } from '../shared/approval-enter-rule';
import { actionQuestion, approvalCardModel, approvalCardRows } from './ApprovalCard';
import type { Approval } from './desktop-types';
import { t } from './i18n';

/** Request kinds whose card takes more than a click: a value typed, a step done by hand. */
const HANDS_ON_KINDS = ['takeover', 'secret', 'question'];

/** Plain text for the wire: line breaks kept, other control characters
 *  dropped, bounded. */
function petText(value: string): string {
  const text = value
    .replace(/\t/g, '  ')
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the wire allows no control characters
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
  return text.length > DESKTOP_PET_APPROVAL_TEXT_MAX ? `${text.slice(0, DESKTOP_PET_APPROVAL_TEXT_MAX - 1)}…` : text;
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? '';

type CardModel = ReturnType<typeof approvalCardModel>;
type CardRows = ReturnType<typeof approvalCardRows>;

/** Whether the bubble offers the card's own decisions inline, and which rows are its allow and deny. */
function inlineDecisions(approval: Approval, model: CardModel, rows: CardRows) {
  const decisions = rows.map((row) => row.decision);
  const plain = rows.every(
    (row) =>
      typeof row.decision === 'object' &&
      // The edited text only rides an outbound request that has some to edit.
      !(row.edits && model.editable.length > 0)
  );
  const primary = decisions.findIndex((decision) => typeof decision === 'object' && decision.approved);
  // The card's own deny: the plain "no" (or a secret's plain skip).
  const deny = decisions.findIndex(
    (decision) =>
      typeof decision === 'object' &&
      !decision.approved &&
      (!decision.response || (decision.response === 'skip' && !decision.reason))
  );
  const inline =
    plain &&
    primary >= 0 &&
    deny >= 0 &&
    rows.length <= DESKTOP_PET_APPROVAL_ROWS_MAX &&
    !HANDS_ON_KINDS.includes(model.kind) &&
    // An Office transaction's review and a payment, permanent delete or
    // connector widening are decided on the card, where their details show.
    !model.office &&
    !approvalAllowIsPointerOnly(approval);
  return { decisions, inline, primary, deny };
}

function fullText(model: CardModel): string {
  if (model.kind === 'outbound') {
    return [
      model.target,
      model.account,
      model.payload,
      ...Object.entries(model.details).map(([key, value]) => `${key}: ${value}`),
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [model.detail, model.requestAccount && `${t('Account')}: ${model.requestAccount}`].filter(Boolean).join('\n');
}

/** The request as the bubble shows it. `requester` names who asks and
 *  `agentName` is the card's own name for it (the "always allow" scope). */
export function petApproval(
  approval: Approval,
  { requester, agentName }: { requester: string; agentName: string }
): DesktopPetApproval {
  const model = approvalCardModel(approval);
  const rows = approvalCardRows(model, { agentName, officeLabel: '' });
  const { decisions, inline, primary, deny } = inlineDecisions(approval, model, rows);
  const full = fullText(model);
  return {
    id: String(approval.id ?? ''),
    title: petText(model.kind === 'outbound' ? actionQuestion(model.action) : model.title),
    requester: petText(requester),
    detail: petText(firstLine(full)),
    full: petText(full),
    note: petText(model.text),
    inline,
    rows: inline
      ? rows.map((row, index) => ({
          label: petText(row.label),
          ...(row.desc ? { desc: petText(row.desc) } : {}),
          decision: decisions[index] as Extract<(typeof decisions)[number], object>,
        }))
      : [],
    primary: inline ? primary : -1,
    deny: inline ? deny : -1,
  };
}
