/** What the phone shows of a tool's output once the row is behind the reader (`REMOTE_HISTORY_OUTPUT_CHARS` of main/remote-transcript.ts):
 *  its first `lines` lines (a command's one more), at most `chars` characters. The phone announces it at initialize (`toolOutput`), and
 *  the core cuts each tool output to it before the frame leaves; the rest is read when the person asks to see it all. */
export const REMOTE_TOOL_OUTPUT_DISPLAY = { chars: 600, lines: 5 } as const;
