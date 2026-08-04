// Self-contained: installs nothing globally and needs no preload or loader, so
// it behaves identically under any command that can run it, e.g.
//   node --test scripts/bounded-assert.test.mjs
// Parity is measured against the untouched node:assert comparisons; the subject
// is an isolated bounded façade.
import pristine, { AssertionError } from "node:assert";
import { test } from "node:test";
import { inspect } from "node:util";

import { createBoundedAssert, inertError } from "./bounded-assert.mjs";

const bounded = createBoundedAssert();

const capture = (run) => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

const isLive = (value) => value !== null && (typeof value === "object" || typeof value === "function");

/** Everything node:test can reach when it reports a failure. */
const serializedSize = (error) => inspect(
  { message: error.message, actual: error.actual, expected: error.expected, stack: error.stack, ...error },
  { depth: 10, maxStringLength: Infinity, maxArrayLength: Infinity },
).length;

const assertInert = (error, context) => {
  pristine.ok(error, `${context}: the comparison must still fail`);
  for (const [key, value] of Object.entries(error)) {
    pristine.ok(
      value === null || (typeof value !== "object" && typeof value !== "function"),
      `${context}: own property ${key} must not carry a live object`,
    );
  }
  const size = serializedSize(error);
  pristine.ok(size < 8000, `${context}: serialized error must stay bounded, received ${size} chars`);
};

// Wide, deep, cyclic and cross-linked, with window/document-shaped back
// references — the shape that makes node:assert's depth-1000 inspect explode.
function buildHugeGraph() {
  const fakeWindow = { name: "fake-window", document: null, listeners: [] };
  const nodes = [];
  for (let i = 0; i < 5000; i += 1) {
    nodes.push({ index: i, payload: "x".repeat(64), children: [], ownerWindow: fakeWindow });
  }
  for (let i = 1; i < nodes.length; i += 1) {
    nodes[i].parent = nodes[i - 1];
    nodes[i].root = nodes[0];
    nodes[i - 1].children.push(nodes[i]);
  }
  fakeWindow.document = nodes[0];
  fakeWindow.listeners.push(nodes[1]);
  return nodes[0];
}

const comparePair = (label, boundedRun, nativeRun) => {
  const boundedError = capture(boundedRun);
  const nativeError = capture(nativeRun);
  pristine.strictEqual(Boolean(boundedError), Boolean(nativeError), `${label}: throw parity`);
  if (!boundedError || !nativeError) return;
  pristine.strictEqual(boundedError.constructor, nativeError.constructor, `${label}: error class`);
  pristine.strictEqual(boundedError.code, nativeError.code, `${label}: code`);
  pristine.strictEqual(boundedError.operator, nativeError.operator, `${label}: operator`);
  pristine.strictEqual(boundedError.generatedMessage, nativeError.generatedMessage,
    `${label}: generatedMessage`);
  pristine.strictEqual(boundedError.message, nativeError.message, `${label}: message`);
};

test("small operands keep node's own failure verbatim", () => {
  for (const [actual, expected] of [[1, 1], [1, 2], ["a", "b"], [Number.NaN, Number.NaN], [{ a: 1 }, { a: 1 }]]) {
    const label = `${inspect(actual)} / ${inspect(expected)}`;
    comparePair(`equal ${label}`,
      () => bounded.equal(actual, expected),
      () => pristine.strictEqual(actual, expected));
    comparePair(`notEqual ${label}`,
      () => bounded.notEqual(actual, expected),
      () => pristine.notStrictEqual(actual, expected));
  }
  for (const [actual, expected] of [
    [{ a: [1, 2] }, { a: [1, 2] }],
    [{ a: [1, 2] }, { a: [1, 3] }],
    [new Map([["k", 1]]), new Map([["k", 2]])],
  ]) {
    comparePair(`deepEqual ${inspect(actual)} / ${inspect(expected)}`,
      () => bounded.deepEqual(actual, expected),
      () => pristine.deepStrictEqual(actual, expected));
  }
  for (const [input, pattern] of [["abc", /b/], ["abc", /z/]]) {
    comparePair(`match ${input} ${pattern}`,
      () => bounded.match(input, pattern),
      () => pristine.match(input, pattern));
    comparePair(`doesNotMatch ${input} ${pattern}`,
      () => bounded.doesNotMatch(input, pattern),
      () => pristine.doesNotMatch(input, pattern));
  }
  // Invalid operands: node's own class/code/message survive untouched.
  comparePair("match(123, /b/)", () => bounded.match(123, /b/), () => pristine.match(123, /b/));
  // Custom messages are node's, not a format of our own.
  comparePair("custom message",
    () => bounded.equal(1, 2, "custom failure text"),
    () => pristine.strictEqual(1, 2, "custom failure text"));
});

// A stateful regexp advances (or resets) lastIndex on every `test()`, so a
// wrapper that probes the operand before delegating would both change the
// observable state and risk a different verdict on the second run.
test("a stateful regexp is executed exactly once, like node", () => {
  const small = "ab";
  // Longer than the render budget, so the bounded path handles it.
  const large = `a${"b".repeat(600)}`;
  for (const input of [small, large]) {
    const size = input === small ? "small" : "large";

    const boundedGlobal = /a/g;
    const nativeGlobal = /a/g;
    bounded.match(input, boundedGlobal);
    pristine.match(input, nativeGlobal);
    pristine.strictEqual(boundedGlobal.lastIndex, nativeGlobal.lastIndex, `${size}: /g after match`);
    pristine.strictEqual(boundedGlobal.lastIndex, 1, `${size}: /g advanced exactly one match`);

    // Sticky: a second execution would start at lastIndex 1 and fail.
    const boundedSticky = /a/y;
    const nativeSticky = /a/y;
    bounded.match(input, boundedSticky);
    pristine.match(input, nativeSticky);
    pristine.strictEqual(boundedSticky.lastIndex, nativeSticky.lastIndex, `${size}: /y after match`);
    pristine.strictEqual(boundedSticky.lastIndex, 1, `${size}: /y matched at index 0 only once`);

    // doesNotMatch fails on this input, again after exactly one execution.
    const boundedFail = /a/g;
    const nativeFail = /a/g;
    const boundedError = capture(() => bounded.doesNotMatch(input, boundedFail));
    const nativeError = capture(() => pristine.doesNotMatch(input, nativeFail));
    pristine.ok(boundedError && nativeError, `${size}: doesNotMatch must fail`);
    pristine.strictEqual(boundedError.code, nativeError.code, `${size}: doesNotMatch code`);
    pristine.strictEqual(boundedError.operator, nativeError.operator, `${size}: doesNotMatch operator`);
    pristine.strictEqual(boundedFail.lastIndex, nativeFail.lastIndex, `${size}: /g after doesNotMatch`);
    pristine.ok(boundedError.message.length < 2000, `${size}: doesNotMatch message stays bounded`);

    // A failed match resets lastIndex — once, not twice.
    const boundedMiss = /zz/y;
    const nativeMiss = /zz/y;
    pristine.ok(capture(() => bounded.match(input, boundedMiss)), `${size}: a missing match fails`);
    pristine.ok(capture(() => pristine.match(input, nativeMiss)));
    pristine.strictEqual(boundedMiss.lastIndex, nativeMiss.lastIndex, `${size}: /y after a failed match`);

    // Sticky doesNotMatch that passes: one execution, no throw.
    const boundedPass = /zz/y;
    const nativePass = /zz/y;
    bounded.doesNotMatch(input, boundedPass);
    pristine.doesNotMatch(input, nativePass);
    pristine.strictEqual(boundedPass.lastIndex, nativePass.lastIndex,
      `${size}: /y after a passing doesNotMatch`);
  }
});

// A wrapper that called `regexp.test(...)` would run user code; node compares
// with the primordial exec, so an override must change nothing.
test("an overridden test/exec cannot change an oversized-operand verdict", () => {
  const large = `a${"b".repeat(600)}`;
  const overridePrototype = (run) => {
    const nativeTest = RegExp.prototype.test;
    const nativeExec = RegExp.prototype.exec;
    RegExp.prototype.test = () => false;
    RegExp.prototype.exec = () => null;
    try {
      run();
    } finally {
      RegExp.prototype.test = nativeTest;
      RegExp.prototype.exec = nativeExec;
    }
  };
  for (const scope of ["instance", "prototype"]) {
    const boundedRe = /a/g;
    const nativeRe = /a/g;
    const boundedNot = /a/y;
    const nativeNot = /a/y;
    if (scope === "instance") {
      for (const regexp of [boundedRe, nativeRe, boundedNot, nativeNot]) {
        regexp.test = () => false;
        regexp.exec = () => null;
      }
    }
    const run = () => {
      // A lying override would turn this passing match into a failure…
      pristine.strictEqual(capture(() => bounded.match(large, boundedRe)), null, `${scope}: match passes`);
      pristine.strictEqual(capture(() => pristine.match(large, nativeRe)), null, `${scope}: node agrees`);
      // …and this real failure into a pass.
      pristine.ok(capture(() => bounded.doesNotMatch(large, boundedNot)), `${scope}: doesNotMatch fails`);
      pristine.ok(capture(() => pristine.doesNotMatch(large, nativeNot)), `${scope}: node agrees`);
    };
    if (scope === "prototype") overridePrototype(run);
    else run();
    pristine.strictEqual(boundedRe.lastIndex, nativeRe.lastIndex, `${scope}: /g lastIndex parity`);
    pristine.strictEqual(boundedRe.lastIndex, 1, `${scope}: exactly one intrinsic execution`);
    pristine.strictEqual(boundedNot.lastIndex, nativeNot.lastIndex, `${scope}: /y lastIndex parity`);
  }
});

// Reportable fields can be accessors (V8 stores `stack` as one) or frozen live
// values: none may be read, none may escape.
test("inertError copies data descriptors only, never reading the source", () => {
  const live = buildHugeGraph();
  const metadata = Symbol("mixdog.metadata");
  let reads = 0;
  const getter = (value) => ({ get() { reads += 1; return value; }, configurable: true, enumerable: true });
  class Inherited extends Error {}
  Object.defineProperty(Inherited.prototype, "message", getter("inherited"));
  Object.defineProperty(Inherited.prototype, "stack", getter("inherited"));
  const accessors = Object.defineProperties(new Inherited(), {
    name: getter("Exploding"), code: getter("ERR"), [metadata]: getter(live),
    operator: { value: "strictEqual", enumerable: true, configurable: true },
  });
  const frozen = Object.freeze(Object.defineProperties(
    new AssertionError({ message: "boom", actual: 1, expected: 2, operator: "strictEqual" }),
    { cause: { value: live }, [metadata]: { value: { window: live }, enumerable: true } },
  ));

  for (const [label, source, absent, kept] of [
    ["accessors", accessors, ["name", "code", metadata], ["operator"]],
    ["frozen live fields", frozen, [], ["name", "code", "operator", "message", "generatedMessage"]],
  ]) {
    const inert = inertError(source);
    pristine.strictEqual(reads, 0, `${label}: no own or inherited getter may run`);
    pristine.notStrictEqual(inert, source, `${label}: the source is never mutated`);
    for (const key of absent) pristine.strictEqual(Object.hasOwn(inert, key), false, `${label}: ${String(key)} dropped`);
    for (const key of kept) pristine.strictEqual(inert[key], source[key], `${label}: ${key} parity`);
    for (const key of Reflect.ownKeys(inert)) {
      pristine.ok(!isLive(inert[key]), `${label}: ${String(key)} must be a scalar`);
    }
    pristine.match(inert.stack, /bounded-assert\.test\.mjs/, `${label}: a fresh callsite frame`);
    pristine.ok(inert.stack.length < 4000 && serializedSize(inert) < 8000, `${label}: bounded`);
  }
});

test("a caller-supplied Error is thrown untouched on both paths", () => {
  const live = buildHugeGraph();
  for (const [actual, expected] of [[1, 2], [buildHugeGraph(), null]]) {
    const caller = new Error("caller supplied", { cause: live });
    const thrown = capture(() => bounded.equal(actual, expected, caller));
    pristine.strictEqual(thrown, caller, "node throws the caller's own error");
    pristine.strictEqual(thrown.message, "caller supplied");
    pristine.strictEqual(thrown.cause, live, "a caller-owned error is never sanitised in place");
  }
});

test("a huge cyclic graph fails with a fully bounded, inert error", () => {
  const graph = buildHugeGraph();
  const error = capture(() => bounded.equal(graph, null));
  pristine.ok(error instanceof AssertionError, "the comparison must still fail");
  pristine.strictEqual(error.operator, "strictEqual");
  pristine.strictEqual(error.code, "ERR_ASSERTION");
  pristine.strictEqual(error.generatedMessage, true);
  pristine.ok(error.message.length < 2000,
    `message must stay bounded, received ${error.message.length} characters`);
  assertInert(error, "huge graph equality");
  assertInert(capture(() => bounded.deepEqual(graph, { index: -1 })), "huge graph deep equality");
  assertInert(capture(() => bounded.match(graph, /anything/)), "huge graph invalid match operand");
});

test("the same comparison is unbounded without the wrapper", () => {
  // Guards the regression itself: if node ever stops expanding operands this
  // test fails loudly and the wrapper can be reconsidered.
  const native = capture(() => pristine.strictEqual(buildHugeGraph(), null));
  pristine.ok(native instanceof AssertionError);
  pristine.ok(native.message.length > 100_000,
    `native rendering was expected to be huge, received ${native.message.length} characters`);
});
