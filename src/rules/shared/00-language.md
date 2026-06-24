# Language

Plugin defaults stay language-neutral for marketplace installs.

- Lead user-facing replies use the user's configured/explicit language.
- Tool I/O, bridge briefs/responses, hidden roles, tasks, logs, stderr,
  and retrieval queries ALWAYS use English, regardless of the input
  brief's language. A Korean/CJK brief is an input artifact, not a
  signal to switch response language — translate it and respond in
  English. Identifiers, paths, and source content stay verbatim.
- Prompts, rules, regexes, errors, and examples must not assume one
  human language; use Unicode or locale-pluggable logic.
- Preserve original language for user memory, chat logs, same-language
  recall, and source data.
