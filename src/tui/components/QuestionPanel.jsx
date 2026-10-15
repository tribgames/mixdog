/**
 * components/QuestionPanel.jsx — ask_user multiple-choice panel.
 *
 * Same round-border chrome as Picker. Digits/↑↓ choose, Space toggles
 * (multi-select), ←/→ switch questions, Enter confirms the current question
 * (and sends on the last), Esc dismisses. The last row is an inline text
 * input; while typing, every key belongs to the input (no slash commands).
 */
import { useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import { truncatePanelText, padPanelCells } from './panel-cell-text.mjs';
import { isCsiPrivateReply } from './prompt-input/key-signals.mjs';
import {
  CUSTOM_LABEL,
  appendCapped,
  answerFor,
  buildAnswers,
  initialCursor,
  optionLayout,
  planQuestionView,
  questionHelp,
} from './question-panel-model.mjs';

const MAX_TAB_CELLS = 10;

function cleanTyped(value) {
  return String(value ?? '')
    .replace(/\x1b\[[\d;?<]*[A-Za-z~]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

export function QuestionPanel({ questions, columns = 80, rows, onSubmit, onDismiss }) {
  const { isRawModeSupported } = useStdin();
  const [state, setState] = useState(() => ({
    qi: 0,
    cursors: questions.map(initialCursor),
    drafts: questions.map(() => ({ selected: [], text: '' })),
    typing: false,
    buf: '',
  }));
  const ref = useRef(state);
  ref.current = state;
  const commit = (next) => {
    ref.current = next;
    setState(next);
  };
  const last = questions.length - 1;

  const withDraft = (s, qi, patch) => ({
    ...s,
    drafts: s.drafts.map((d, i) => (i === qi ? { ...d, ...patch } : d)),
  });

  // Confirm the current question and advance (or send on the last one).
  const advance = (s) => {
    if (s.qi >= last) {
      onSubmit(buildAnswers(questions, s.drafts));
      return;
    }
    commit({ ...s, qi: s.qi + 1, typing: false, buf: '' });
  };

  const typeInto = (input) => {
    const s = ref.current;
    const text = cleanTyped(input);
    if (text) commit({ ...s, buf: appendCapped(s.buf, text) });
  };

  usePaste((text) => {
    if (ref.current.typing) typeInto(text);
  }, { isActive: isRawModeSupported });

  useInput(
    (input, key) => {
      const s = ref.current;
      const raw = String(input ?? '');
      if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(raw) || isCsiPrivateReply(raw)) return;
      const question = questions[s.qi];
      const n = question.options.length;
      const multi = question.multi_select === true;

      if (s.typing) {
        if (key.escape) return commit({ ...s, typing: false, buf: '' });
        if (key.return) {
          const text = s.buf.trim();
          const draft = s.drafts[s.qi];
          const next = withDraft(s, s.qi, { text, selected: multi ? draft.selected : [] });
          if (text) return advance({ ...next, typing: false, buf: '' });
          return commit({ ...next, typing: false, buf: '' });
        }
        if (key.backspace || key.delete) return commit({ ...s, buf: Array.from(s.buf).slice(0, -1).join('') });
        if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;
        return typeInto(raw);
      }

      if (key.escape) return onDismiss();
      const setCursor = (cursor) => commit({ ...s, cursors: s.cursors.map((c, i) => (i === s.qi ? cursor : c)) });
      const choose = (idx, toggle) => {
        const draft = s.drafts[s.qi];
        let selected;
        if (multi && toggle) {
          selected = draft.selected.includes(idx) ? draft.selected.filter((i) => i !== idx) : [...draft.selected, idx];
        } else {
          selected = multi ? draft.selected : [idx];
        }
        const cursors = s.cursors.map((c, i) => (i === s.qi ? idx : c));
        commit({ ...withDraft(s, s.qi, { selected, text: multi ? draft.text : '' }), cursors });
      };
      const cursor = s.cursors[s.qi];
      if (key.upArrow) return setCursor((cursor - 1 + n + 1) % (n + 1));
      if (key.downArrow) return setCursor((cursor + 1) % (n + 1));
      if (key.leftArrow || key.rightArrow) {
        const qi = Math.max(0, Math.min(last, s.qi + (key.leftArrow ? -1 : 1)));
        return commit({ ...s, qi });
      }
      if (key.return) {
        if (cursor === n) return commit({ ...s, typing: true, buf: s.drafts[s.qi].text });
        const draft = s.drafts[s.qi];
        let next = s;
        if (!multi) next = withDraft(s, s.qi, { selected: [cursor], text: '' });
        else if (draft.selected.length === 0 && !draft.text.trim()) next = withDraft(s, s.qi, { selected: [cursor] });
        return advance(next);
      }
      if (raw === ' ' && !key.ctrl && !key.meta) {
        if (cursor < n) choose(cursor, true);
        return;
      }
      if (/^[1-9]$/.test(raw)) {
        const idx = Number(raw) - 1;
        if (idx < n) choose(idx, true);
        else if (idx === n) setCursor(n);
      }
    },
    { isActive: isRawModeSupported }
  );

  const question = questions[state.qi];
  const multi = question.multi_select === true;
  const layout = optionLayout(question, columns);
  const n = question.options.length;
  const cursor = state.cursors[state.qi];
  const draft = state.drafts[state.qi];
  const avail = layout.avail;

  const title = questions.length > 1 ? `Question ${state.qi + 1}/${questions.length}` : 'Question';
  const tabs =
    questions.length > 1
      ? questions.map((q, i) => ({
          text: truncatePanelText(String(q.header || `Q${i + 1}`), MAX_TAB_CELLS),
          answered: answerFor(q, state.drafts[i]) !== null,
          current: i === state.qi,
        }))
      : [];

  const indexText = (i) => padPanelCells(`${i + 1}.`, layout.indexCells - 1) + ' ';
  const renderLine = (selected, children, key) => {
    const text = selected ? { backgroundColor: theme.selectionBackground, color: theme.selectionText } : {};
    return (
      <Text key={key} {...text} wrap="truncate">
        {children}
      </Text>
    );
  };

  const plan = planQuestionView(question, columns, rows ?? Infinity, cursor);
  const out = [];
  const optionRow = (i) => {
    const row = layout.rows[i];
    const selected = i === cursor;
    const checked = draft.selected.includes(i);
    const lead = `${selected ? '› ' : '  '}${indexText(i)}`;
    const fill = ' '.repeat(Math.max(0, avail - layout.prefixCells - stringWidth(row.label + row.suffix)));
    out.push(
      renderLine(
        selected,
        <>
          {lead}
          {multi ? (
            <Text color={selected ? theme.selectionText : checked ? theme.success : undefined}>
              {checked ? '[x] ' : '[ ] '}
            </Text>
          ) : null}
          {row.label}
          {row.suffix ? <Text color={selected ? theme.selectionText : theme.suggestion}>{row.suffix}</Text> : null}
          {selected ? fill : ''}
        </>,
        `o${i}`
      )
    );
  };

  const customSelected = cursor === n;
  const customLead = `${customSelected ? '› ' : '  '}${indexText(n)}`;
  const markerPad = multi ? '    ' : '';
  let customBody;
  if (state.typing) {
    const room = Math.max(1, avail - stringWidth(customLead) - stringWidth(markerPad) - 1);
    let shown = Array.from(state.buf).slice(-room).join('');
    while (stringWidth(shown) > room) shown = Array.from(shown).slice(1).join('');
    customBody = `${shown}▌`;
  } else if (draft.text) {
    customBody = truncatePanelText(draft.text, Math.max(1, avail - stringWidth(customLead) - stringWidth(markerPad)));
  } else {
    customBody = CUSTOM_LABEL;
  }
  const customColor = customSelected ? theme.selectionText : draft.text && !state.typing ? theme.text : theme.inactive;
  const customRow = () =>
    renderLine(
      customSelected,
      <>
        {customLead}
        {markerPad}
        <Text color={state.typing ? undefined : customColor}>{customBody}</Text>
        {customSelected ? ' '.repeat(Math.max(0, avail - stringWidth(customLead + markerPad + customBody))) : ''}
      </>,
      'custom'
    );

  const moreRow = (key, text) => (
    <Text key={key} color={theme.subtle} wrap="truncate">
      {`    ${text}`}
    </Text>
  );
  if (plan.above > 0) out.push(moreRow('above', `↑ ${plan.above} more`));
  for (const item of plan.items) {
    if (item.index === n) out.push(customRow());
    else optionRow(item.index);
  }
  if (plan.below > 0) out.push(moreRow('below', `↓ ${plan.below} more`));

  const help = questionHelp({ multi, typing: state.typing, last: state.qi >= last, count: n, questionCount: questions.length });

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.promptBorder} paddingX={1} width="100%">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexShrink={1}>
            <Text wrap="truncate">
              <Text color={theme.panelTitle}>{title}</Text>
              {tabs.map((tab, i) => (
                <Text key={i}>
                  {'  '}
                  {tab.current ? (
                    <Text backgroundColor={theme.selectionBackground} color={theme.selectionText}>
                      {` ${tab.answered ? '✓ ' : ''}${tab.text} `}
                    </Text>
                  ) : tab.answered ? (
                    <Text color={theme.success}>{`✓ ${tab.text}`}</Text>
                  ) : (
                    <Text color={theme.subtle}>{tab.text}</Text>
                  )}
                </Text>
              ))}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={2}>
            <Text color={theme.subtle}>{help}</Text>
          </Box>
        </Box>
        <Text> </Text>
        {plan.qLines.map((line, i) => (
          <Text key={i} color={theme.text} wrap="truncate">
            {line}
          </Text>
        ))}
        <Text> </Text>
        {out}
      </Box>
    </Box>
  );
}
