// What a call gave its caller, whole: a thrown Error as its name, message and every own field (`code`, ...), anything else as it came.
// The stack is the one thing left out: it names the machine's paths and the line the error was made on, which no caller reads.
export function wholeOutcome(value) {
  if (!(value instanceof Error)) return { value };
  const fields = {};
  for (const key of Object.keys(value)) fields[key] = value[key];
  return { error: { name: value.name, message: value.message, fields } };
}