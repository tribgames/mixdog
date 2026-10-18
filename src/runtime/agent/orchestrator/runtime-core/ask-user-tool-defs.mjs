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
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
]);

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
