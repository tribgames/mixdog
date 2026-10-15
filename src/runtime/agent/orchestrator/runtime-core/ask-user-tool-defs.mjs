export const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MAX_TEXT = 4000;
export const ASK_USER_MAX_LABEL = 80;

export const ASK_USER_TOOL_DEFS = Object.freeze([
  {
    name: 'ask_user',
    title: 'Ask User',
    trigger: 'Ask the user 1–4 multiple-choice questions and wait; only for decisions the user must make.',
    description: [
      'Ask the user multiple-choice questions while you work and wait for the answers. Use it to:',
      '1. Gather preferences or requirements',
      '2. Clarify ambiguous instructions',
      '3. Get decisions on approaches with real tradeoffs',
      '4. Offer a choice of direction',
      '',
      'Usage notes:',
      '- Users can always type their own answer; never add an "Other" option',
      '- Only ask what the user must decide; settle what code, docs or conventions answer, and make minor choices yourself',
      '- Not for "Should I proceed?" or plan approval; ask in chat',
      '- Batch independent questions in one call',
      '- Options are short labels; put any tradeoff the user needs in your message before asking',
      '- Do not repeat the options in your message',
    ].join('\n'),
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
          description: 'Questions to ask the user (1-4).',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The complete question, ending with a question mark, e.g. "Which auth method should we use?"',
              },
              header: {
                type: 'string',
                maxLength: 12,
                description: 'Very short chip label, e.g. "Auth method", "Library".',
              },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                description: 'Distinct choices. No "Other" option; free text is added automatically.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', maxLength: 80, description: 'The choice, summarized in 1-5 words.' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multi_select: { type: 'boolean', description: 'Allow several answers when choices are not mutually exclusive.' },
              recommended: { type: 'integer', minimum: 0, description: 'Index of the option you recommend.' },
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
      if (Object.keys(option).some((key) => key !== 'label')) {
        throw new Error(`${at}: options take only a label; put explanations in your message before asking`);
      }
      if (labels.has(option.label)) throw new Error(`${at} has duplicate option label "${option.label}"`);
      labels.add(option.label);
    }
    if (q.recommended != null && (!Number.isInteger(q.recommended) || q.recommended < 0 || q.recommended >= q.options.length)) {
      throw new Error(`${at} recommended must be an index below ${q.options.length}`);
    }
  });
  return questions;
}
