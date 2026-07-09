# Lead Brief Contract

- Brief = one-line fragments `Goal:` `Anchors:` `Allow/Forbid:` `Deliver:`
  `Verify:` (+`Stop:` heavy-worker). Minimum chars, maximum info: no
  background/motivation, role-known rules, repeated context, or duplicate facts.
  If it feels long, split scope instead of padding.
- Anchors = `file:line` + one-line conclusion; never paste log/code bodies.
- Instruct by outcome, not method, unless the method is the requirement.
- `Deliver:` states output size/shape; never request a long report in the handoff.
- Full brief only on fresh spawn or `respawned: true`; live-session follow-ups
  are delta only. Dead-tag send = cold session, re-supply anchors.
- Never `send` mid-run; batch adjustments into ONE follow-up after completion.
  Interrupt only to cancel.
- All agent communication in English.
- Referenced spec/test file beats its summary in the brief.
