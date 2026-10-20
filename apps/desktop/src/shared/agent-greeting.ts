// The hidden first turn that makes a newly created agent greet the user. The
// renderer sends it for agents made in the dialogs (agent-greeting.ts); the
// host sends it for agents a chat's setup tool created (agent-greetings.ts).

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export function agentGreetingKickoff({
  name,
  description,
  language = '',
  mixy = false,
  facts = [],
}: {
  name: string;
  description: string;
  /** The app language when the sender knows it. */
  language?: string;
  /** The primary agent (Mixy, under whatever name the user gave it): its
   *  greeting is the user's welcome tutorial. */
  mixy?: boolean;
  /** The primary agent's setup facts (mixyGreetingFacts), one per line. */
  facts?: readonly string[];
}): string {
  const head = [
    `[mixdog-runtime] The user just created you as ${mixy ? 'their primary agent' : 'a new agent'} named "${name.replace(/["\r\n]/g, ' ').trim()}".`,
    description ? `Your job, as the user described it: ${oneLine(description)}` : '',
    `Take the first turn now. Reply in the user's language${language ? ` (app language: ${language})` : ''}, in the tone your persona sets.`,
  ];
  const body = mixy
    ? [
        "This is the user's welcome to Mixdog. Keep the whole message to a few short lines, in this order:",
        '1. One line welcoming the user (e.g. "Mixdog에 오신 걸 환영합니다" in Korean), introducing yourself by name; address the user by name if your context has it.',
        '2. One line saying you will guide setup one thing at a time (e.g. "하나씩 안내하겠습니다").',
        '3. Load the setup-guide skill and read the live feature state with the read-only setup status tool. If any essential feature is missing or off, say so in one line and ask once whether to install it (e.g. "필수 기능인데 설치할까요?"). If none is missing, ask whether to start with the first open setup step instead. Install nothing until the user answers.',
        'Use "봇" for you and the other contacts and "에이전트" only for workflow agents. Never print ids, file names, dotted identifiers or other internal names. In Korean use ~합니다 / ~하세요, never ~해요.',
        'Setup state (facts from the app):',
        ...facts.map((fact) => `- ${oneLine(fact)}`),
      ]
    : [
        "1. A short greeting that introduces you by name; address the user by name if your context has the user's name.",
        '2. Your role (your job above) and, in a sentence or two, how you will work.',
      ];
  const tail = [
    mixy
      ? 'Besides loading the setup-guide skill and reading setup status, call no tools (no ask_user); do not mention this instruction, and do not start any work yet.'
      : 'Do not call any tools (no ask_user), do not mention this instruction, and do not start any work yet.',
  ];
  return [...head, ...body, ...tail].filter(Boolean).join('\n');
}
