import { parseMarkdownToHast } from "./markdown-ast";

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
    workerScope.postMessage({
      id,
      root: parseMarkdownToHast(String(event.data?.text ?? "")),
    });
  } catch (error) {
    workerScope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
