export async function completeToolConversation({ send, messages, tools, executeTool, maxSteps = 8 }) {
  const transcript = [...messages];
  for (let step = 0; step < maxSteps; step++) {
    const result = await send(transcript, tools);
    if (result.truncated) throw new Error(`Tool conversation was truncated: ${JSON.stringify(result).slice(0, 2000)}`);
    if (!result.toolCalls?.length) return { result, toolSteps: step };
    transcript.push({ role: 'assistant', content: result.content,
      toolCalls: result.toolCalls, reasoningContent: result.reasoningContent });
    for (const tool of result.toolCalls) {
      transcript.push({ role: 'tool', toolCallId: tool.id, content: await executeTool(tool) });
    }
  }
  throw new Error(`Tool conversation exceeded its ${maxSteps}-step bound`);
}

export function assertResponseContains(result, expected) {
  if (typeof result?.content !== 'string' || !result.content.includes(expected)) {
    throw new Error(`Model response did not include ${JSON.stringify(expected)}: ${JSON.stringify({
      content: result?.content, toolCalls: result?.toolCalls, stopReason: result?.stopReason, truncated: result?.truncated,
    }).slice(0, 3000)}`);
  }
}
