/**
 * Argument-shape tolerance shared by the desktop bridges (`browser`,
 * `computer`). Providers do serialize a nested object argument as a JSON
 * string, and some flatten its fields onto the argument root instead. Both are
 * transport shape rather than intent, so the bridges absorb them here and keep
 * their own strict field validation untouched.
 */

/** Parse a JSON-object string once. Anything else — including a malformed
 *  string — comes back untouched so the caller's own type check still fails. */
export function parseJsonObjectArg(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/** Split bridge tool arguments into the nested input and the root fields the
 *  tool itself owns. Without an `input` key the remaining root fields are the
 *  input; with one, unowned root fields are reported so the caller can refuse
 *  a half-nested call instead of silently dropping them. */
export function splitBridgeToolArgs(args, rootFields = ['action']) {
  if (Object.hasOwn(args, 'input')) {
    return {
      hasNestedInput: true,
      input: parseJsonObjectArg(args.input),
      strayRootFields: Object.keys(args).filter(
        (name) => name !== 'input' && !rootFields.includes(name),
      ),
    };
  }
  const input = {};
  for (const [name, value] of Object.entries(args)) {
    if (!rootFields.includes(name)) input[name] = value;
  }
  return { hasNestedInput: false, input, strayRootFields: [] };
}
