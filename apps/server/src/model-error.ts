export class ProbeError extends Error {
  constructor(
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}
export function errorCode(error: unknown) {
  return error instanceof ProbeError
    ? error.code
    : error instanceof Error && 'code' in error
      ? String(error.code)
      : 'INTERNAL_ERROR';
}
