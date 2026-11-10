// True for an id in the Gemini wire family ("gemini-4-argon", "models/gemini-3.1-pro",
// "gemini-pro-agent"). It names the family only, never a generation: it separates
// Gemini from the other model families an Antigravity gateway serves (Claude,
// GPT-OSS), which reject Gemini-only request fields outright.
const GEMINI_FAMILY = /(?:^|\/)gemini-/i;

export function isGeminiFamilyModel(model) {
  return GEMINI_FAMILY.test(String(model || ''));
}
