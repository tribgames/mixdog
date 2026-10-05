/** The directory the test runner hands the fixture through its environment. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
