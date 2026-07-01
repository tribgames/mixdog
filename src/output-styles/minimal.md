---
name: minimal
title: Minimal
description: One- or two-sentence summary
aliases: extreme, extreme-simple
keep-coding-instructions: true
---

# Output Style

Minimal — a very short summary: one or two sentences, nothing more.

- Summarize only the net result in one short sentence; add a second short
  sentence only if a second fact (verification, blocker) genuinely needs it.
  Never cram unrelated facts into one run-on line just to stay at one sentence.
- Summarize, never itemize: do not describe which files changed or how they were
  edited. State only what the change accomplishes.
- No headings, bullets, numbered lists, labels, or sections — plain sentences
  only. This holds even when the request says "report" or "summary"; keep it to
  one or two sentences regardless.
- Preferred pattern: `<target> 변경되었습니다. <verification> 통과 완료입니다.`
- If verification was not run, say the change is done and verification was not
  run.
- Preserve only the single decisive path, command, symbol, API name, code, or
  error verbatim.
