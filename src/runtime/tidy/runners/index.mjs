// Runner registry: engine id → { check, fix }. An engine in the catalog with no
// entry here is resolved and reported (so `scan` stays honest) but never run.
import biome from './biome.mjs';
import ruff from './ruff.mjs';
import clangFormat from './clang-format.mjs';
import shfmt from './shfmt.mjs';
import shellcheck from './shellcheck.mjs';
import stylua from './stylua.mjs';
import gofumpt from './gofumpt.mjs';
import dprint from './dprint.mjs';
import air from './air.mjs';
import mago from './mago.mjs';
import rustfmt from './rustfmt.mjs';
import gofmt from './gofmt.mjs';
import psscriptanalyzer from './psscriptanalyzer.mjs';
import prettier from './prettier.mjs';
import eslint from './eslint.mjs';

export const RUNNERS = Object.freeze({
  biome,
  ruff,
  'clang-format': clangFormat,
  shfmt,
  shellcheck,
  stylua,
  gofumpt,
  dprint,
  air,
  mago,
  rustfmt,
  gofmt,
  psscriptanalyzer,
  prettier,
  eslint,
});

export const RUNNER_IDS = Object.freeze(Object.keys(RUNNERS));

export function runnerFor(id) {
  return RUNNERS[String(id || '')] || null;
}
