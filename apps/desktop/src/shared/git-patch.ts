export interface GitPatchHunk {
  header: string;
  patch: string;
}

export function splitGitPatchHunks(patch: string): GitPatchHunk[] {
  const normalized = String(patch || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("@@ ")) starts.push(index);
  }
  if (starts.length === 0) return [];
  const prelude = lines.slice(0, starts[0]).join("\n");
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const body = lines.slice(start, end).join("\n");
    const combined = `${prelude}\n${body}`;
    return {
      header: lines[start],
      patch: combined.endsWith("\n") ? combined : `${combined}\n`,
    };
  });
}
