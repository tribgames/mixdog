// Adapters from what the Rust runners emit to evidence records and expectations (docs/testing.md, "Release coverage"). Nothing here
// invents a start, a pass or a skip from a list: a record exists only for a terminal testcase a runner reported in its own report,
// an ignored one included (nextest's `<skipped>` element); a listing only routes.
import { readFileSync } from 'node:fs';

import { readPackages } from './inventory-rust.mjs';

/** Packages by name from the tracked sources: { manifest, dir, targets }. A name two manifests share is an error. */
export function packagesByName(tracked, read) {
  const { packages, errors } = readPackages(tracked, read);
  const byName = new Map();
  for (const pkg of packages) {
    if (byName.has(pkg.name))
      errors.push({
        code: 'duplicate-package',
        path: pkg.manifest,
        line: 0,
        message: `package ${pkg.name} is declared by two manifests`,
      });
    byName.set(pkg.name, pkg);
  }
  return { byName, errors };
}

/** nextest binary id → target: `pkg` is the lib, `pkg::bin/x` a binary, `pkg::x` an integration test. Anything else is unsupported. */
export function targetOfBinaryId(binaryId, byName) {
  const [name, rest] = binaryId.includes('::')
    ? [binaryId.slice(0, binaryId.indexOf('::')), binaryId.slice(binaryId.indexOf('::') + 2)]
    : [binaryId, null];
  const pkg = byName.get(name);
  if (!pkg) throw new Error(`binary ${binaryId} names no tracked package`);
  if (rest === null) {
    const lib = pkg.targets.find((target) => target.kind === 'lib');
    if (!lib) throw new Error(`binary ${binaryId}: ${name} has no lib target`);
    return { manifest: pkg.manifest, kind: 'lib', name: lib.name, root: lib.root };
  }
  if (/^(?:example|bench)\//.test(rest)) throw new Error(`binary ${binaryId} is an example or bench no run executes`);
  const kind = rest.startsWith('bin/') ? 'bin' : 'test';
  const targetName = kind === 'bin' ? rest.slice(4) : rest;
  return {
    manifest: pkg.manifest,
    kind,
    name: targetName,
    root: pkg.targets.find((target) => target.kind === kind && target.name === targetName)?.root,
  };
}

const decode = (text) =>
  text.replace(
    /&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (_, entity) =>
      ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[entity] ??
      String.fromCodePoint(entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
  );

function attributes(text) {
  const out = {};
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[match[1]] = decode(match[2] ?? match[3]);
  return out;
}

/**
 * Terminal testcases of a nextest JUnit report. A retry element is a result the release mode forbids (retries are 0).
 * @returns {{ binaryId: string, name: string, status: 'pass'|'fail'|'ignored'|'retried', text: string }[]}
 */
export function parseJunit(xml) {
  const cleaned = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  let suite = null;
  let current = null;
  for (const tag of cleaned.matchAll(/<(\/?)([A-Za-z][\w-]*)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrText, selfClosing] = tag;
    if (name === 'testsuite') {
      suite = closing ? null : attributes(attrText).name;
    } else if (name === 'testcase') {
      if (closing) {
        current = null;
        continue;
      }
      const attrs = attributes(attrText);
      current = { binaryId: attrs.classname || suite, name: attrs.name, status: 'pass', text: '' };
      out.push(current);
      if (selfClosing) current = null;
    } else if (current) {
      const attrs = attributes(attrText);
      if (name === 'failure' || name === 'error') current.status = 'fail';
      else if (name === 'skipped') current.status = current.status === 'pass' ? 'ignored' : current.status;
      else if (/^(?:flaky|rerun)/.test(name)) current.status = 'retried';
      current.text = attrs.message ?? attrs.type ?? current.text;
    }
  }
  for (const found of out)
    if (!found.binaryId || found.name === undefined) throw new Error('a JUnit testcase has no binary identity');
  return out;
}

export function junitRecords(xml, byName) {
  return parseJunit(xml).map((found) => {
    const target = targetOfBinaryId(found.binaryId, byName);
    const id = ['rust', target.manifest, target.kind, target.name, found.name];
    if (found.status === 'ignored')
      return { kind: 'case', id, status: 'ignored', reasonCode: 'nextest-ignored', reasonText: found.text };
    if (found.status === 'retried')
      return {
        kind: 'case',
        id,
        status: 'fail',
        reasonCode: 'retried',
        reasonText: 'a retry is a result the release mode does not allow',
      };
    return { kind: 'case', id, status: found.status };
  });
}

/** The binaries of a nextest listing, each with its target and its tests; a listing without `rust-suites`, or a suite without `testcases`, is not one. */
function suitesOf(list, byName) {
  if (!list || typeof list['rust-suites'] !== 'object') throw new Error('not a nextest list: no "rust-suites"');
  return Object.keys(list['rust-suites'])
    .sort()
    .map((binaryId) => {
      const suite = list['rust-suites'][binaryId];
      if (!suite || typeof suite.testcases !== 'object')
        throw new Error(`the listing of ${binaryId} has no "testcases"`);
      return { binaryId, target: targetOfBinaryId(suite['binary-id'] ?? binaryId, byName), tests: suite.testcases };
    });
}

/** A nextest listing reduced to its binaries and the names of their tests (a receipt keeps this, never the whole listing). */
export function suiteNames(list) {
  if (!list || typeof list['rust-suites'] !== 'object') throw new Error('not a nextest list: no "rust-suites"');
  return {
    'rust-suites': Object.fromEntries(
      Object.entries(list['rust-suites']).map(([id, suite]) => {
        if (typeof suite?.testcases !== 'object') throw new Error(`the listing of ${id} has no "testcases"`);
        return [
          id,
          {
            'binary-id': suite['binary-id'] ?? id,
            testcases: Object.fromEntries(Object.keys(suite.testcases).map((name) => [name, {}])),
          },
        ];
      })
    ),
  };
}

/** Tests of a nextest listing: [{ id, root, ignored, binaryId, name, matches }] in nextest's own order (binary id, then name). */
export function listedTests(list, byName) {
  return suitesOf(list, byName).flatMap(({ binaryId, target, tests }) =>
    Object.keys(tests)
      .sort()
      .map((name) => ({
        id: ['rust', target.manifest, target.kind, target.name, name],
        root: target.root,
        binaryId,
        name,
        ignored: tests[name].ignored === true,
        matches: tests[name]['filter-match']?.status === 'matches',
      }))
  );
}

/** The test targets an unfiltered listing shows, with how many tests each holds: [{ id: ['rust', manifest, kind, name], root, count }]. A listing that shows no binary at all is an error. */
export function listedSuites(list, byName) {
  const suites = suitesOf(list, byName);
  if (suites.length === 0) throw new Error('the listing shows no test binary');
  return suites.map(({ target, tests }) => ({
    id: ['rust', target.manifest, target.kind, target.name],
    root: target.root,
    count: Object.keys(tests).length,
  }));
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
