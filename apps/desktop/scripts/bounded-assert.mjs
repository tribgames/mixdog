// Bounded assertion failures for the DOM test suites.
//
// node:assert renders a failed comparison with
// util.inspect(value, { customInspect: false, depth: 1000, maxArrayLength: Infinity })
// inside the AssertionError constructor, and node:test inspects
// `error.actual` / `error.expected` again for its report. With a JSDOM node as
// an operand both walks reach the document, its window and every attached React
// fiber, so one failed `assert.equal(element, null)` allocates hundreds of
// megabytes synchronously.
//
// Design: when both operands are small enough for node to render safely, the
// call is delegated to node itself, so class, code, operator, generatedMessage
// and message text are node's own, byte for byte. Only when an operand cannot
// be rendered within a fixed budget does this wrapper build the failure, and
// then every own object/function field of the error is replaced by a bounded
// summary before it is thrown, so no DOM/window reference escapes.
//
// Wrapped: exactly the comparisons the DOM suites use — equal, notEqual,
// deepEqual, match, doesNotMatch and their strict aliases. `ok` and the
// callable `assert(value)` form are not wrapped: a failing `ok` only inspects a
// falsy value, which is always a primitive.
import strictAssert, { AssertionError } from "node:assert/strict";
import { inspect, isDeepStrictEqual } from "node:util";

const MAX_SUMMARY_CHARS = 512;
// node appends its own diff of the (already summarised) operands to whatever
// message it is handed, so the message cap sits above the sum of two summaries.
const MAX_MESSAGE_CHARS = 1200;
const MAX_STACK_CHARS = 4000;
// Whole-graph budget for the renderability walk below. node renders operands at
// depth 1000 with no array limit, so a *sampled* render is not a safe proxy.
const MAX_GRAPH_NODES = 100;

const isObjectLike = (value) => value !== null
  && (typeof value === "object" || typeof value === "function");

const truncate = (text, limit) => (text.length > limit
  ? `${text.slice(0, limit)}… (${text.length} chars truncated)`
  : text);

/** Frames of the current throw site, captured fresh — the source error's own
 *  stack is an accessor and is never invoked. Materialised to a string right
 *  away so the copy holds no frame objects. */
function callsite() {
  const carrier = {};
  if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(carrier, inertError);
  else carrier.stack = new Error("callsite").stack;
  return String(carrier.stack ?? "").split("\n").slice(1).join("\n");
}

export function summarise(value) {
  let rendered;
  try {
    rendered = inspect(value, {
      depth: 2, breakLength: 120, maxArrayLength: 20, maxStringLength: 512, getters: false,
    });
  } catch {
    rendered = "[unrenderable value]";
  }
  if (typeof rendered !== "string") rendered = "[unrenderable value]";
  return truncate(rendered, MAX_SUMMARY_CHARS);
}

/** True when node can render this operand in full without walking a large
 *  graph: a bounded traversal of everything node's own inspect would reach. */
function isRenderable(value) {
  if (typeof value === "string") return value.length <= MAX_SUMMARY_CHARS;
  if (!isObjectLike(value)) return true;
  const seen = new Set();
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!isObjectLike(current) || seen.has(current)) continue;
    seen.add(current);
    if (seen.size > MAX_GRAPH_NODES) return false;
    try {
      const keys = Reflect.ownKeys(current);
      if (keys.length > MAX_GRAPH_NODES) return false;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        // Accessors are rendered as [Getter]; node never invokes them here.
        if (descriptor && "value" in descriptor) stack.push(descriptor.value);
      }
      if (current instanceof Map || current instanceof Set) {
        if (current.size > MAX_GRAPH_NODES) return false;
        // Map iteration yields [key, value] pairs, so both sides are walked.
        for (const entry of current) stack.push(entry);
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Returns a fresh inert error instead of editing one in place: the original is
 *  never touched, so a non-configurable or frozen field cannot defeat this.
 *  The copy is built from own property *descriptors* only — the source is never
 *  property-read, so no accessor (own or inherited: message, stack, name, code,
 *  operator, generatedMessage, or any symbol key) is ever evaluated. Accessor
 *  descriptors are dropped; own data properties are copied as scalars, with
 *  object/function values replaced by a bounded summary, so an ordinary node
 *  AssertionError keeps its class, name, code, operator, generatedMessage,
 *  capped message and — when node stored it as data — its stack. */
export function inertError(error) {
  if (!isObjectLike(error)) return error;
  const descriptors = Object.getOwnPropertyDescriptors(error);
  const inert = Object.create(Object.getPrototypeOf(error));
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) continue;
    const { value } = descriptor;
    let copied = isObjectLike(value) ? summarise(value) : value;
    if (key === "message" && typeof copied === "string") copied = truncate(copied, MAX_MESSAGE_CHARS);
    define(inert, key, copied, descriptor.enumerable);
  }
  // Fallbacks, composed only from descriptors already copied above. V8 stores
  // `stack` as a lazy accessor, so a dropped stack is the normal case: the copy
  // gets a freshly captured callsite instead, never the source's.
  if (!Object.hasOwn(inert, "message")) define(inert, "message", "", false);
  if (!Object.hasOwn(inert, "stack")) {
    const name = typeof descriptors.name?.value === "string" ? descriptors.name.value : "Error";
    define(inert, "stack", truncate(`${name}: ${inert.message}\n${callsite()}`, MAX_STACK_CHARS), false);
  }
  return inert;
}

/** Runs the native comparison and guarantees the thrown error is inert. An
 *  Error handed in as the `message` argument is rethrown by node as-is: it
 *  belongs to the caller and is never copied or modified. */
function delegate(native, base, args) {
  try {
    return Reflect.apply(native, base, args);
  } catch (error) {
    throw error === args[2] ? error : inertError(error);
  }
}

// node compares with the primordial RegExp exec, so an overridden `test`/`exec`
// on the instance or on RegExp.prototype changes neither the verdict nor
// `lastIndex`. Captured at import for the same reason, and called exactly once.
const intrinsicExec = RegExp.prototype.exec;
const matchesOnce = (string, regexp) => Reflect.apply(intrinsicExec, regexp, [string]) !== null;

// One spec per wrapped comparison: when it passes, and the message node would
// have generated — rendered from bounded summaries instead of live operands.
const SPECS = {
  strictEqual: {
    passes: (actual, expected) => Object.is(actual, expected),
    message: (actual, expected) =>
      `Expected values to be strictly equal:\n\n${summarise(actual)} !== ${summarise(expected)}\n`,
  },
  notStrictEqual: {
    passes: (actual, expected) => !Object.is(actual, expected),
    message: (actual, expected) =>
      `Expected "actual" to be strictly unequal to:\n\n${summarise(expected)}\n`,
  },
  deepStrictEqual: {
    passes: isDeepStrictEqual,
    message: (actual, expected) => "Expected values to be strictly deep-equal:\n"
      + `+ actual - expected\n\n+ ${summarise(actual)}\n- ${summarise(expected)}\n`,
  },
  match: {
    // Invalid operands keep node's own error class/code/message; only the
    // fields node attaches to the error are sanitised.
    valid: (string, regexp) => typeof string === "string" && regexp instanceof RegExp,
    passes: matchesOnce,
    message: (string, regexp) =>
      `The input did not match the regular expression ${regexp}. Input:\n\n${summarise(string)}\n`,
  },
  doesNotMatch: {
    valid: (string, regexp) => typeof string === "string" && regexp instanceof RegExp,
    passes: (string, regexp) => !matchesOnce(string, regexp),
    message: (string, regexp) => "The input was expected to not match the regular expression "
      + `${regexp}. Input:\n\n${summarise(string)}\n`,
  },
};

function createComparisons(base) {
  const comparisons = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    const native = base[name];
    if (typeof native !== "function") continue;
    const bounded = function boundedComparison(actual, expected, message) {
      // Operands node can render in full — and operands node must reject
      // itself — are handed over whole, so the comparison runs exactly once
      // with node's own semantics, `lastIndex` on a /g or /y regexp included.
      if ((spec.valid && !spec.valid(actual, expected))
        || (isRenderable(actual) && isRenderable(expected))) {
        return delegate(native, base, [actual, expected, message]);
      }
      // Oversized operand: the comparison is evaluated here, exactly once.
      if (spec.passes(actual, expected)) return undefined;
      // A caller-owned Error is thrown exactly as node throws it: unchanged.
      if (message instanceof Error) throw message;
      const error = new AssertionError({
        message: message ?? spec.message(actual, expected),
        actual: summarise(actual),
        expected: summarise(expected),
        operator: name,
        stackStartFn: bounded,
      });
      error.generatedMessage = message == null;
      throw inertError(error);
    };
    comparisons[name] = bounded;
  }
  // `node:assert/strict` aliases the loose names onto the strict comparisons.
  return {
    ...comparisons,
    equal: comparisons.strictEqual,
    notEqual: comparisons.notStrictEqual,
    deepEqual: comparisons.deepStrictEqual,
  };
}

const define = (target, name, value, enumerable = true) => Object.defineProperty(target, name, {
  value, writable: true, enumerable, configurable: true,
});

// Installing twice would capture the wrappers as "natives" and recurse.
const INSTALLED = Symbol.for("mixdog.bounded-assert.installed");

/** Replace the comparison helpers on a `node:assert/strict` namespace object in
 *  place. The DOM harness installs this, so every DOM suite is covered by the
 *  import it already makes and no preload ordering can drop it. */
export function installBoundedAssertions(target = strictAssert) {
  if (target[INSTALLED]) return target;
  for (const [name, implementation] of Object.entries(createComparisons(target))) {
    if (typeof target[name] !== "function" || typeof implementation !== "function") continue;
    define(target, name, implementation);
  }
  Object.defineProperty(target, INSTALLED, { value: true, configurable: true });
  return target;
}

/** An isolated bounded façade: inherits everything else (ok, throws, rejects,
 *  AssertionError, …) from `base` without mutating it. */
export function createBoundedAssert(base = strictAssert) {
  const facade = Object.create(base);
  for (const [name, implementation] of Object.entries(createComparisons(base))) {
    if (typeof implementation === "function") define(facade, name, implementation);
  }
  return facade;
}
