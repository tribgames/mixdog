import { executeOfficeTool } from '../index.mjs';

export function resultValue(result) {
  const text = result?.content?.[0]?.text || '';
  if (result?.isError) throw new Error(text);
  return JSON.parse(text);
}

export function toolValue(result, label) {
  const text = result?.content?.find((entry) => entry.type === 'text')?.text || '';
  if (result?.isError) throw new Error(`${label}: ${text}`);
  return JSON.parse(text);
}

export async function office(args, cwd, label = args.action) {
  const raw = await executeOfficeTool(args, { cwd });
  return { raw, value: toolValue(raw, label) };
}
