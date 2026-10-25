import { loginPageUrl } from '../session/human-gate/requests.mjs';

const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MAX_TEXT = 4000;

export const ASK_USER_TOOL_DEFS = Object.freeze([
  {
    name: 'ask_user',
    title: 'Ask User',
    trigger:
      'Ask the user 1–4 multiple-choice questions and wait; when a plan needs the user to pick between clear options, instead of listing them in chat.',
    description:
      'Ask the user multiple-choice questions and wait. Only for a decision only the user can make, with clear options; never for minor choices or approval of requested work, and open questions go in chat. Do not repeat the options in your message.',
    annotations: {
      title: 'Ask User',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      agentHidden: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: ASK_USER_MAX_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'Full question, without the options.' },
              header: { type: 'string', maxLength: 12, description: 'Chip label.' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                description: 'Distinct; free text is added, never "Other".',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', maxLength: 80, description: '1-5 words.' },
                    description: { type: 'string', description: 'One-sentence tradeoff.' },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
              },
              multi_select: { type: 'boolean' },
              recommended: { type: 'integer', minimum: 0, description: 'Recommended option index.' },
            },
            required: ['question', 'header', 'options'],
          },
        },
        handoff: {
          type: 'object',
          description:
            'Instead of questions: secret = the user types a password, sign-in, new password or one-time code into that field of the page (you never see it; result entered/user_skipped/no_field/page_changed/blocked/expired); takeover = the user does a step (sign-in, CAPTCHA, 2FA) and says done.',
          properties: {
            kind: { type: 'string', enum: ['secret', 'takeover'] },
            surface: { type: 'string', enum: ['browser', 'computer'] },
            target: { type: 'string', maxLength: 200, description: 'Site/app and form.' },
            field: { type: 'string', maxLength: 80, description: 'secret: field label.' },
            instructions: { type: 'string', maxLength: 2000, description: 'takeover: what to do.' },
            need: {
              type: 'string',
              enum: ['sign_in', 'action', 'confirmation'],
              description:
                'takeover: sign_in (sign-in, 2FA), action (CAPTCHA, other step), confirmation (identity/payment check). Default action.',
            },
            purpose: {
              type: 'string',
              enum: ['login'],
              description: 'browser takeover: login = sign-in window on url.',
            },
            url: { type: 'string', maxLength: 2048, description: 'login: sign-in page (https).' },
            tab: { type: 'string', maxLength: 64, description: 'browser: page ID from list_tabs.' },
            window_id: { type: 'string', maxLength: 128, description: 'computer: exact window id (secret: required).' },
            ref: { type: 'string', maxLength: 64, description: 'computer secret: field ref (required).' },
            app: { type: 'string', maxLength: 120, description: 'computer takeover: app name.' },
          },
          required: ['kind', 'surface'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
]);

/** The handoff of an ask_user call ({ kind, surface, target, field, instructions }), or null. */
export function validateAskUserHandoff(args) {
  const handoff = args?.handoff;
  if (handoff == null) return null;
  if (args.questions != null) throw new Error('ask_user takes questions or a handoff, not both');
  if (typeof handoff !== 'object' || Array.isArray(handoff)) throw new Error('ask_user handoff must be an object');
  if (handoff.kind !== 'secret' && handoff.kind !== 'takeover') {
    throw new Error('ask_user handoff kind is secret or takeover');
  }
  if (handoff.surface !== 'browser' && handoff.surface !== 'computer') {
    throw new Error('ask_user handoff surface is browser or computer');
  }
  const text = (key, limit) => (typeof handoff[key] === 'string' ? handoff[key].trim().slice(0, limit) : '');
  if (handoff.kind === 'takeover' && !text('instructions', 2000)) {
    throw new Error('ask_user takeover needs instructions');
  }
  const login = handoffLogin(handoff);
  let need = login ? 'sign_in' : 'action';
  if (['sign_in', 'action', 'confirmation'].includes(handoff.need)) need = handoff.need;
  return {
    kind: handoff.kind,
    surface: handoff.surface,
    target: text('target', 200),
    field: text('field', 80),
    instructions: text('instructions', 2000),
    // A secret is bound to its page (browser tab) or window and field (computer).
    identity: handoffIdentity(handoff),
    ...(handoff.kind === 'takeover' ? { need, ...(login ? { login } : {}) } : {}),
  };
}

/** A login takeover's sign-in page ({ url, origin }); null without the
 *  explicit purpose, so every other takeover keeps the side panel. */
function handoffLogin(handoff) {
  if (handoff.purpose == null) return null;
  if (handoff.purpose !== 'login' || handoff.kind !== 'takeover' || handoff.surface !== 'browser') {
    throw new Error('ask_user purpose login is a browser takeover');
  }
  const page = loginPageUrl(handoff.url);
  if (!page) throw new Error('ask_user login needs an https url (http only on localhost)');
  return page;
}

/** The window a takeover is about, validated per surface: a browser page ID
 *  (list_tabs p1, v1 or a page name) or a computer window id and app. Shapes
 *  that are not plain tokens are dropped, never passed on. */
const TOKEN = /^[\w.:#@-]+$/;
function handoffIdentity(handoff) {
  const token = (key, limit) => {
    const value = typeof handoff[key] === 'string' ? handoff[key].trim() : '';
    return value && value.length <= limit && TOKEN.test(value) ? value : '';
  };
  if (handoff.surface === 'browser') {
    const tab = token('tab', 64);
    return tab ? { tab } : {};
  }
  const windowId = token('window_id', 128);
  const app =
    typeof handoff.app === 'string'
      ? handoff.app
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 120)
      : '';
  const ref = handoff.kind === 'secret' ? token('ref', 64) : '';
  return { ...(windowId ? { windowId } : {}), ...(app ? { app } : {}), ...(ref ? { ref } : {}) };
}

/** Throws a clear error when the questions are malformed; returns the list. */
export function validateAskUserQuestions(args) {
  const questions = args?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > ASK_USER_MAX_QUESTIONS) {
    throw new Error(`ask_user requires 1-${ASK_USER_MAX_QUESTIONS} questions`);
  }
  const seenQuestions = new Set();
  questions.forEach((q, i) => {
    const at = `ask_user question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new Error(`${at} must be an object`);
    if (typeof q.question !== 'string' || !q.question.trim()) throw new Error(`${at} needs question text`);
    if (typeof q.header !== 'string' || !q.header.trim() || q.header.length > 12) {
      throw new Error(`${at} needs a header of at most 12 characters`);
    }
    if (seenQuestions.has(q.question)) throw new Error(`${at} duplicates another question text`);
    seenQuestions.add(q.question);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      throw new Error(`${at} needs 2-4 options`);
    }
    const labels = new Set();
    for (const option of q.options) {
      if (!option || typeof option.label !== 'string' || !option.label.trim()) {
        throw new Error(`${at} has an option without a label`);
      }
      if (option.label.length > 80) throw new Error(`${at} has an option label over 80 characters`);
      if (typeof option.description !== 'string' || !option.description.trim()) {
        throw new Error(`${at} option "${option.label}" needs a one-sentence description`);
      }
      if (option.description.length > 200) throw new Error(`${at} has an option description over 200 characters`);
      if (Object.keys(option).some((key) => key !== 'label' && key !== 'description')) {
        throw new Error(`${at}: options take only a label and a description`);
      }
      if (labels.has(option.label)) throw new Error(`${at} has duplicate option label "${option.label}"`);
      labels.add(option.label);
    }
    if (
      q.recommended != null &&
      (!Number.isInteger(q.recommended) || q.recommended < 0 || q.recommended >= q.options.length)
    ) {
      throw new Error(`${at} recommended must be an index below ${q.options.length}`);
    }
  });
  return questions;
}
