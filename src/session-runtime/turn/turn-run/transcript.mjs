function transcriptText(text) {
  if (typeof text === 'string') return text;
  return text != null ? String(text) : '';
}

// Main-session conversation persistence is independent of Remote: Desktop and
// local TUI turns feed the same JSONL memory watcher. Writer failures are
// reported, never thrown into the turn.
export function createTurnTranscript({ getTranscriptWriter, getLastAppendedAssistant, setLastAppendedAssistant }) {
  function append(method, text, failure) {
    const writer = getTranscriptWriter();
    if (!writer) return;
    try {
      writer[method](text);
    } catch (error) {
      process.stderr.write(`mixdog: transcript-writer: ${failure}: ${error?.message || error}\n`);
    }
  }

  function appendUser(prompt) {
    setLastAppendedAssistant('');
    append('appendUser', prompt, 'appendUser failed');
  }

  function appendAssistantText(text) {
    if (!getTranscriptWriter()) return;
    const value = transcriptText(text);
    if (!value.trim()) return;
    append('appendAssistant', value, 'onAssistantText failed');
    setLastAppendedAssistant(value);
  }

  // historyContent is the terminal segment alone; content may be the aggregate
  // of already-appended continuation parts plus that segment, which would
  // re-write the parts into the transcript.
  function appendFinalAssistant(result) {
    if (!getTranscriptWriter()) return;
    const finalSource = result?.historyContent ?? result?.content;
    const finalText = finalSource != null ? String(finalSource) : '';
    if (finalText.trim() && finalText !== getLastAppendedAssistant()) {
      append('appendAssistant', finalText, 'final append failed');
      setLastAppendedAssistant(finalText);
    }
  }

  return { appendUser, appendAssistantText, appendFinalAssistant };
}
