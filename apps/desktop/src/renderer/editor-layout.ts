export type EditorLayoutDimension = {
  width: number;
  height: number;
};

export function nextEditorLayoutDimension(
  previous: EditorLayoutDimension | null,
  host: Pick<HTMLElement, "clientWidth" | "clientHeight">,
): EditorLayoutDimension | null {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width <= 0 || height <= 0) return null;
  if (previous?.width === width && previous.height === height) return null;
  return { width, height };
}
