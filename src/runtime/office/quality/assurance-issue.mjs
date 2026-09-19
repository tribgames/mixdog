// Shared issue record shape for the office structure reviews.

export function issue(code, path, message, source = 'format-review', severity = 'warning') {
  return { severity, code, path, message, source };
}
