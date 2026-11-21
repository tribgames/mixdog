export function errorDiagnosticFields(error: unknown): { errorName: string; message: string } {
  return {
    errorName: error instanceof Error ? error.name : 'Error',
    message: String((error as Error)?.message ?? error).slice(0, 300),
  };
}
