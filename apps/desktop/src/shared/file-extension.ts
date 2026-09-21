export function fileExtension(path: string): string {
  const name =
    String(path || '')
      .split(/[\\/]/)
      .at(-1) || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLocaleLowerCase();
}
