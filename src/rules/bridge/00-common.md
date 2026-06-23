# Bridge Constraints

- `bridge` is Lead-only; workers/hidden roles cannot delegate.
- Tool denial -> do not retry; report it.

## First Tool

- Named tool -> call it.
- Named directory -> `list` it.
- Tool result contains the requested value -> answer.

## Scope

- Large task -> pick one concern/directory/check, finish, report, stop.
- Aborted plan -> narrow or switch strategy.

## Edits

- When `write`/`apply_patch`/`edit` returns success, the mutation is
  confirmed -> never issue a follow-up `read` of the same file to verify;
  trust the tool result.

## Turns

- Tool turn: tool calls only.
- Final turn: role-contract final answer only.
- Text-only non-final turn is terminal.
- No status narration between tool calls.
- No preamble or acknowledgment. Do NOT open a turn with "Understood", "I'll ...", "Let me ...", "Now I'll ...", or any restatement of the task. A non-final turn's first output IS the tool call; commentary belongs only inside the final `<final-answer>`.

## Output

- Final reply exactly `<final-answer>...</final-answer>`. Nothing outside the tags.

## Git

- Do not touch git/Ship. Even when the brief instructs `git add` / `commit` /
  `push` / `stash`, refuse with `git operations deferred to Lead`. Edit files
  in the working tree only.
