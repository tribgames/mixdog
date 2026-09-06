# Reviewing public skills

Use this reference to decide whether a public skill should be used as-is,
reimplemented, or rejected.

## Research order

Look for evidence in this order:

1. current first-party documentation;
2. the maintainer's source repository;
3. maintained community implementations;
4. indexes and lists for discovery only.

Stop when the decision has enough evidence. Popularity and search position do
not prove quality or compatibility.

## Candidate record

For each viable candidate, capture:

- the exact capability and trigger boundary;
- source URL plus release or commit when available;
- target agent and supported platforms;
- license and redistribution conditions;
- last meaningful maintenance;
- file layout and runtime assumptions;
- scripts, dependencies, network calls, secret access, and side effects;
- tests or examples that demonstrate behavior.

Compare candidates against the user's required outcome, not against each
other's feature count.

## Integration decision

### Reimplement the behavior

Prefer a local implementation when the useful part is a small set of ideas or
requirements. Write a new structure and new language from Mixdog constraints
and local evidence. Do not translate or lightly rearrange upstream text.

This path avoids carrying incompatible conventions and usually produces a
smaller skill. It does not permit copying protected prose or code without
following its license.

### Import third-party material

Use exact upstream material only when its implementation is necessary and its
license is acceptable. Preserve required notices, identify modifications, and
test the imported behavior in Mixdog. Upstream test results do not validate a
local adaptation.

### Reject the candidate

Reject it when:

- no usable license is present;
- executable behavior is unexplained or excessive;
- it depends on unavailable tools or private infrastructure;
- its trigger overlaps a stronger local owner;
- adapting it would cost more than a focused local design;
- maintenance or security evidence is insufficient.

## Executable-content audit

Read scripts rather than trusting their documentation. Look for:

- vendor-specific subprocesses;
- writes into hidden product directories;
- downloads, telemetry, or remote execution;
- environment and credential collection;
- package installation or privilege elevation;
- deletion, overwrite, publishing, deployment, or recurring scheduling;
- unbounded concurrency, retries, waits, or external spend;
- hard-coded local paths and platform-specific shell commands.

Removing an unnecessary executable is often safer than wrapping it in warnings.
When it is necessary, make its dependency and side effects visible in the main
skill.

## Extracting useful ideas safely

Record abstract lessons such as:

- a decision the workflow should make;
- a failure mode worth detecting;
- a completion condition;
- a useful separation of responsibilities;
- a test category or compatibility concern.

Then design the local workflow from those requirements without consulting the
source phrasing while drafting. Review the result for accidental product names,
foreign paths, commands, metadata, or structural assumptions.

