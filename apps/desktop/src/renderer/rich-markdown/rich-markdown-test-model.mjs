// Test double for the slice of a Monaco ITextModel the rich editor uses:
// 1-based line/column positions (CRLF counted as one line break), single-range
// edits recorded for inspection, content-change listeners, and Monaco's undo
// history (edits between two stack elements undo as one step; an edit after
// an undo clears the redo stack; setValue starts a fresh history).
export function createTestModel(initial) {
  let value = initial;
  let disposed = false;
  const listeners = new Set();
  const edits = [];
  const stackElements = { count: 0 };
  /** Undo steps, each the list of { before, after } values of its edits. */
  let undoStack = [];
  let redoStack = [];
  let stepOpen = false;
  const restore = (step, field) => {
    value = field === 'before' ? step[0].before : step.at(-1).after;
    stepOpen = false;
    emit();
  };
  const lineStarts = () => {
    const starts = [0];
    for (let index = 0; index < value.length; index++) if (value[index] === '\n') starts.push(index + 1);
    return starts;
  };
  const offsetAt = (lineNumber, column) => lineStarts()[lineNumber - 1] + column - 1;
  const emit = () => {
    for (const listener of [...listeners]) listener({});
  };
  return {
    edits,
    stackElements,
    getValue: () => value,
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
    },
    getPositionAt(offset) {
      const starts = lineStarts();
      let line = starts.length - 1;
      while (starts[line] > offset) line--;
      return { lineNumber: line + 1, column: offset - starts[line] + 1 };
    },
    pushStackElement() {
      stackElements.count++;
      stepOpen = false;
    },
    pushEditOperations(_selections, operations) {
      const before = value;
      for (const { range, text } of operations) {
        const start = offsetAt(range.startLineNumber, range.startColumn);
        const end = offsetAt(range.endLineNumber, range.endColumn);
        edits.push({ start, end, text });
        value = value.slice(0, start) + text + value.slice(end);
      }
      if (!stepOpen || !undoStack.length) undoStack.push([]);
      undoStack.at(-1).push({ before, after: value });
      stepOpen = true;
      redoStack = [];
      emit();
      return null;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undo() {
      const step = undoStack.pop();
      if (!step) return;
      redoStack.push(step);
      restore(step, 'before');
    },
    redo() {
      const step = redoStack.pop();
      if (!step) return;
      undoStack.push(step);
      restore(step, 'after');
    },
    onDidChangeContent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    /** An edit made elsewhere (Source mode, reload, revert). */
    setValue(next) {
      value = next;
      undoStack = [];
      redoStack = [];
      stepOpen = false;
      emit();
    },
  };
}
