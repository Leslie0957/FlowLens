export class ProbeError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}
export function asCode(error: unknown): string {
  return error instanceof ProbeError ? error.code : 'INTERNAL_ERROR';
}
