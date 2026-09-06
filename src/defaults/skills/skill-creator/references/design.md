# Skill design

Use this reference after deciding that the requested outcome belongs in a
skill.

## Start from behavior

Define the behavior before naming files:

- What recurring result should become more reliable?
- Which decisions does the agent currently miss?
- What evidence proves completion?
- Which failures need recovery rather than a hard stop?
- Which adjacent task must remain outside this skill?

A skill earns its context cost by supplying judgement or procedure that changes
results. Generic encouragement and tool documentation do not qualify.

## Pick one owner

Prefer extending an existing skill when it already owns the outcome. Create a
new skill when it has a distinct trigger, workflow, and verification boundary.

Avoid:

- umbrella skills that merely redirect to narrower skills;
- several skills competing for the same user intent;
- one skill that attempts to cover an entire profession or technology family;
- product features represented as prose because implementing code is harder.

## Choose where it lives

| Scope | Use when |
|---|---|
| Machine-global | The user wants the workflow available across Projects |
| Plugin | The workflow depends on and ships with an extension |
| Built-in | The workflow is broadly useful, stable, and inexpensive to expose |

Project-local skill directories are outside Mixdog's discovery chain. If the
workflow is specific to one repository, project documentation may be a better
owner than a machine-global skill.

## Frontmatter

Required:

- `name`: lowercase letters, digits, and hyphens; no edge or repeated hyphen;
  at most 64 characters; identical to the parent directory.
- `description`: one sentence naming the capability.

Recommended:

- `when_to_use`: the trigger line — phrases and situations that should select
  the skill, then the boundary against the nearest neighbour.

Optional portable fields include `license`, `compatibility`, `metadata`, and
`allowed-tools`. A parsed field is not automatically an implemented feature.
Confirm runtime support before assigning it operational meaning.

For Mixdog, `metadata.requires` may list a built-in feature that is mandatory
for the skill. Do not use it for ordinary repository files or generic tools.

## Listing line

The model never sees the body until it calls `Skill()`. Selection happens on
one listing line per skill:

```text
- <name>: <description> — <when_to_use>
```

The runtime cuts that line at 250 characters on a word boundary; text past the
cut never routes the skill. Write both halves for that budget:

| Field | Job | Budget | Write | Avoid |
|---|---|---|---|---|
| `description` | Say what the skill does | ≤ 100 chars | One plain sentence; capability, not implementation | Repeating the name, marketing words, workflow steps, file lists |
| `when_to_use` | Say when to select it | Rest of the 250 | Quoted user phrases in the languages users write, implicit situations, then `not for …` naming the neighbouring owner | Restating the description, listing every feature |

Put the strongest trigger first in `when_to_use`. A boundary is worth writing
only when a neighbouring skill or plain tool could plausibly win the request.

Example:

```yaml
description: Deploy Mixdog to the installed app, VPS, or a live release.
when_to_use: '"배포", "재배포", "deploy", update:dev:fast; not for builds or tests that ship nothing.'
```

## Body

The body loads once, after selection, so it owns everything the listing line
left out. Use only the sections the workflow needs, in this order:

1. **Intro** — two or three sentences: what the skill produces, what it does
   not do, and the key dependency stance.
2. **Boundary or mode selection** — the decision that picks a path or hands
   the request to another owner.
3. **Prerequisites** — exact tools, features, environment, and approvals.
4. **Procedure** — numbered steps; each important step ends with the
   observable result that proves it is done, and an irreversible step names
   the user checkpoint before it.
5. **Pitfalls** — observed failures and their recovery, not generic caution.
6. **Verification** — the check that proves the outcome.
7. **Resource links** — each `references/` or `scripts/` file with the
   condition for reading or running it.

Write in the imperative. Explain why a rule exists when the reason changes
behaviour; drop rules the model already follows without being told.

Size: about 100 lines for a simple workflow, about 200 for a complex one, and
below 500 in every case. Split content because it has a different loading
condition, not simply because the file became long.

## Bundled resources

### References

Put detailed rules or domain material in `references/`. Link each file directly
from `SKILL.md` and state the condition for reading it. Do not create chains in
which one reference points the agent to another.

### Scripts

Use `scripts/` for deterministic repeated work. Every executable should:

- validate inputs before side effects;
- operate on explicit paths;
- bound time, memory, retries, and output;
- return actionable errors and a non-zero failure status;
- avoid hidden network, installation, deletion, or credential behavior;
- work on every claimed platform or declare the limitation;
- have a behavioral test separate from the prose.

Reference executable paths through `${MIXDOG_SKILL_DIR}` so installation
location does not matter.

### Assets

Use `assets/` for templates and static material consumed by outputs. Guidance
belongs in Markdown, not in files that the agent will not load as instructions.

## Portability audit

Inspect prose and scripts for:

- POSIX-only commands or paths on Windows;
- Windows-only shell syntax on other platforms;
- machine-specific absolute paths;
- undeclared external programs and environment variables;
- assumptions about a vendor CLI, model, or authentication state;
- output paths that overwrite user files by default.

Prefer portable implementation first. Restrict compatibility only when the
dependency cannot reasonably be removed.

## Editing discipline

- Preserve identity and public behavior unless change is requested.
- Replace outdated guidance instead of appending exceptions.
- Keep safety and recovery behavior during simplification.
- Do not duplicate a rule across the body, reference, script help, and tool
  schema; choose the component that owns it.
- End with a pass that removes instructions that did not influence outcomes.

## Audit checklist

Apply to every skill when asked to audit, review, or tidy the skill set.

| Check | Failure looks like | Fix |
|---|---|---|
| Listing line | `description` over 100 chars, or `description — when_to_use` over 250; trigger phrases sitting past the cut | Move the capability into one sentence; move phrases and the boundary into `when_to_use`; drop the rest |
| Trigger presence | `when_to_use` empty while a neighbour competes | Add the phrases users actually write and the `not for …` boundary |
| Body order | Sections out of the order above, a `When to use` section in the body, steps without a completion result | Reorder; delete body triggers (they never route); add the observable result |
| Resources | A referenced file missing, a chain of references, a script without an input check | Fix the path, flatten the chain, add validation |
| Duplication | The same rule in the body, a reference, and a script help text | Keep it in the owner; delete the copies |
| Staleness | Paths, tools, or flags that no longer exist | Replace or remove; never leave an instruction that cannot succeed |

Run `scripts/validate-skill.mjs` on each directory; it reports the listing-line
and resource checks mechanically, and the rest is a read of the body against
this reference.

