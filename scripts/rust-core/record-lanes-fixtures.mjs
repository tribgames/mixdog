#!/usr/bin/env node
// Writes scripts/rust-core/recorded/ from a fresh cargo run (see lanesFixtures in k1-lanes.mjs and recorded/manifest.json).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lanesFixtures } from './k1-lanes.mjs';

for (const [name, content] of Object.entries(await lanesFixtures({ deadlineMs: 3_600_000 }))) {
  writeFileSync(fileURLToPath(new URL(`./recorded/${name}`, import.meta.url)), content);
  console.log(`recorded ${name}`);
}