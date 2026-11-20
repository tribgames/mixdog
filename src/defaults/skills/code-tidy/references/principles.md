# Principles

The ladder, lenses and slop table in `agent-cleanup.md` are procedure. These
are the ideas behind them: use them to judge a case the tables do not name,
and to say why a finding matters. A principle never widens the scope or
overrides a tier.

## Reader load is the measure

Quality is the work a reader does to answer a question about the code. Two
costs, counted separately: the hops between the question and its answer, and
the hidden or mutable state the reader has to keep in mind.

- A wrapper with one caller, an adapter with one implementation, or a layer
  built for a future that did not come adds hops and earns nothing.
- State kept wider than its use (a field for a local, module state for a
  field, a stored copy of something derivable) adds things to remember.
- Line counts and complexity scores are proxies; a short file can still be
  hard to follow.

Test: can a newcomer say where a value comes from and what can change it,
without leaving the unit? A change that lowers neither cost is not a cleanup.

## Subtract before adding

Remove what is not needed, then shape what is left. A smaller base makes the
next change smaller, and often makes the right structure obvious.

- Look for a removal before a rewrite; the deletion ladder is this principle
  as a procedure.
- Speculative guards, parsers and options go before the code they protect is
  polished.
- A file or section with nothing of its own is deleted, not left as a stub.

Test: after the pass, is there less to read for the same behavior?

## The smallest change that works

Producing code costs an agent little, so excess is the default failure.
Borrow the tiredness of the person who maintains it.

- Prefer the flat arrangement; a question that needs more than three files or
  layers to answer is a structural finding.
- One decision lives in one place and is passed on as a plain value, not
  re-derived at each site.
- A new signal threaded through types, schemas and pipelines usually has a
  shorter path: find it before adding the plumbing.
- A new helper or abstraction needs a second real use.

Test: would a maintainer find the result less tiring than what it replaced?

## Guards at the edge, trust inside

Input is checked once, where it enters the system (arguments, files, network,
another process); past that point the types are believed.

- A repeated null check or re-validation deep in a call chain is noise when
  the edge already guarantees the value.
- A check at an edge is never slop, even when it looks redundant from inside.
- Logic that can be a pure function of its inputs is kept apart from the
  framework wiring that calls it.

Test: is this value crossing into the system here? If not, the guard has an
owner elsewhere, or none is needed.

## Types carry the proof

In a typed language the compiler can rule out states, mix-ups and missed
cases. Each thing left to a runtime check is something it was not asked to
prove.

- A set of optional fields that admits contradictory combinations is one
  variant type in disguise.
- A cast or assertion that the compiler cannot verify is a claim to check or
  to remove at its source, not to relocate.
- A branch over a closed set of variants should fail to compile when a
  variant is added.
- A shape another file or schema owns is derived from it, not written again.

Test: if a variant is added next month, does the compiler point at every
place that must change?

## One path, not two

When a replacement is in place and no outside user depends on the old way,
the callers move and the old path is removed in the same change.

- An internal compatibility layer kept only because callers were not moved is
  debt with a growing cost.
- A test that protects only the replaced implementation goes with it; a test
  of behavior that both paths share stays.
- An outside consumer, a staged migration or stored data turns this into a
  contract question: report it.

Test: can a reader tell which of two paths is current without history?

## A repeated edit is a tool

The same change at many sites is made by a script or codemod, not by hand.
The tool is what a reviewer reads and reruns; many hand edits can only be
checked by doing them again.

- Do one site by hand, write the tool, and confirm it reproduces that site.
- The tool is safe to run twice.
- Its output is kept apart from edits that needed judgment, so each can be
  read on its own terms.

Test: could someone else verify the whole change by running one thing?

## A recurring correction becomes a mechanism

A mistake that keeps coming back is not fixed by another comment or
instruction. It is fixed by something that fails without anyone's attention:
a type that cannot hold the bad state, a lint or build check, one canonical
helper.

- Choose the strongest form the situation allows; the surrounding code is
  what the next author copies.
- When the mechanism exists, the prose that asked for the same thing goes.
- Proposing a new check is a finding; adding one to a project is the user's
  decision.

Test: if this were done wrong again tomorrow, what would stop it?

## Equivalence is shown

"Behavior preserved" is a claim with evidence behind it: callers, contracts,
and tests that exercise the touched behavior. It holds for an automated fix
exactly as for a hand edit, and for anything else that depends on a file
(its exact content, its position, its identity), not only for its callers.

- No evidence for a unit means SAFE changes only, and a note that it is
  uncovered.
- A large reshape is compared old against new on the same inputs.

Test: what would have to be true for this change to alter an outcome, and
was that ruled out?
