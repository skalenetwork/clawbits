export class ClawBitsError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;
  readonly path: string;

  constructor({
    statusCode,
    detail,
    path,
    message,
    cause,
  }: {
    statusCode: number;
    detail: unknown;
    path: string;
    message?: string;
    cause?: unknown;
  }) {
    super(message ?? `Clawbits error ${statusCode} at ${path}`, cause === undefined ? undefined : { cause });
    this.name = "ClawBitsError";
    this.statusCode = statusCode;
    this.detail = detail;
    this.path = path;
  }

  toJSON(): { statusCode: number; detail: unknown; path: string } {
    return { statusCode: this.statusCode, detail: this.detail, path: this.path };
  }
}
