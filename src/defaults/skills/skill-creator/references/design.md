# Skill design

## One owner

Before writing, name the result the skill makes more reliable, the decisions
the agent misses without it, the evidence that proves completion, the failures
that need recovery, and the nearby request it must leave alone.

Extend an existing skill that owns the outcome; create a new one only for a
distinct trigger, workflow and verification. Avoid skills that redirect to
other skills, several skills competing for one request, one skill covering a
whole technology, and product features written as prose.

System instructions and tool schemas outrank a skill: it explains when and how
to use tools, never redefines their arguments or permissions.

## Frontmatter

- `name`: lowercase letters, digits and hyphens, no leading, trailing or
  repeated hyphen, at most 64 characters, equal to the folder name.
- `description`: one plain capability sentence for the UI, at most 100
  characters. The model never sees it.
- `when_to_use`: the trigger (Listing line below).
- `dependencies.tools`: tools loaded with the skill. `type: tool` takes an
  exact tool name, `type: mcp` a connected server's name. A missing or
  disabled tool is reported, never installed or enabled, and nothing grants
  permissions. Leave optional tools out.

  ```yaml
  dependencies:
    tools:
      - type: tool
        value: office
  ```

- `metadata.requires`: a Mixdog built-in feature the skill cannot work without.

Other fields have no effect in Mixdog.

## Listing line

The model sees one line per skill and loads the body only by calling `Skill`:

```text
- <name>: <when_to_use> [tools: <linked tool names>]
```

The trigger is cut at 100 characters on a word boundary, and shrinks evenly
toward 60 when many skills share the listing; text past the cut never selects
the skill. The tool suffix comes from `dependencies`, never from the trigger.

| Field | Job | Write | Avoid |
|---|---|---|---|
| `when_to_use` | When to load the skill; core in the first 60 characters | The user intents and situations, strongest first, in English for every language, then `not …` naming the nearest other owner | How to do it: steps, rules, commands, tool arguments; translated keyword lists |
| Body | Everything after selection | Capability, prerequisites, procedure, recovery, verification | Relying on the trigger or the UI description for an instruction |

Never summarise the procedure in the trigger: a model that reads a workflow
there may follow it instead of loading the body. Add the `not …` boundary only
when a nearby skill or a plain tool could plausibly win the request.

```yaml
when_to_use: 'Deploy or update the installed app or a live release; not builds or tests alone.'
```

## Body

Only the sections the workflow needs, in this order:

1. **Intro** — two or three sentences: what it produces and what it does not.
2. **Boundary or mode selection** — the decision that picks a path or hands
   the request to another owner.
3. **Prerequisites** — exact tools, environment and approvals.
4. **Procedure** — numbered steps; each important step ends with the
   observable result that proves it, and an irreversible step names the user
   checkpoint before it.
5. **Pitfalls** — observed failures and their recovery, not generic caution.
6. **Verification** — the check that proves the outcome.
7. **Resource links** — each file with the condition for reading or running it.

Write in the imperative; give a reason only when it changes behaviour, and drop
rules the model already follows. About 100 lines for a simple workflow, about
200 for a complex one, never over 500. Split by loading condition, not by
length.

## Resources

- `references/` — detailed rules read only in some cases. Link each directly
  from `SKILL.md` with its read condition; no file points to another.
- `scripts/` — deterministic work that would otherwise be redone each time.
  Validate inputs before side effects, use explicit paths, bound time, output
  and retries, fail with an actionable message and a non-zero status, and do
  no hidden network, installs, deletion or credential access. Give it a
  behavioural test, and call it through `${MIXDOG_SKILL_DIR}`.
- `assets/` — templates and static material the output uses; guidance stays
  in Markdown.

## Audit checklist

| Check | Failure looks like | Fix |
|---|---|---|
| Fields | `description` or `when_to_use` over 100 characters; an instruction found only in metadata | Short UI summary, selection in the trigger, execution in the body |
| Trigger | Empty while a neighbour competes; says how instead of when | The phrases users write plus the `not …` boundary; move the how to the body |
| Body | Out of order, a "when to use" section, steps without a result | Reorder, delete body triggers, add the observable result |
| Resources | A missing file, a chain of references, a script without input checks | Fix the path, flatten, validate inputs |
| Side effects | External programs, network, secrets or irreversible steps (commit, deploy, publish, restart) not visible or not waiting for the user | Name them in prerequisites; checkpoint before the step |
| Duplication | One rule in the body, a reference and a script's help | Keep it in its owner, delete the copies |
| Staleness | Paths, tools or flags that no longer exist | Replace or remove |
| Value | A rule or section that no scenario needed | Delete it |

The validator checks fields, fences and resource paths; the rest is a read
against this table.
