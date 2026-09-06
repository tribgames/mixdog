import { parseMarkdownToHast } from "./markdown-ast";
import { MARKDOWN_AST_CACHE_MAX_CHARACTERS } from "./markdown-ast-weight";
import { estimateRetainedChars } from "./renderer-value-weight";

interface MarkdownWorkerRequest {
  id: number;
  text: string;
}

interface MarkdownWorkerScope {
  onmessage: ((event: MessageEvent<MarkdownWorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as MarkdownWorkerScope;

workerScope.onmessage = (event) => {
  const id = Number(event.data?.id);
  try {
    const root = parseMarkdownToHast(String(event.data?.text ?? ""));
    workerScope.postMessage({
      id,
      root,
      retainedChars: estimateRetainedChars(root, MARKDOWN_AST_CACHE_MAX_CHARACTERS),
    });
  } catch (error) {
    workerScope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
