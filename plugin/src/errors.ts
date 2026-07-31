export class ClawBitsError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;
  readonly path: string;

  constructor({
    statusCode,
    detail,
    path,
    message,
  }: {
    statusCode: number;
    detail: unknown;
    path: string;
    message?: string;
  }) {
    super(message ?? `Clawbits error ${statusCode} at ${path}`);
    this.name = "ClawBitsError";
    this.statusCode = statusCode;
    this.detail = detail;
    this.path = path;
  }

  toJSON(): { statusCode: number; detail: unknown; path: string } {
    return { statusCode: this.statusCode, detail: this.detail, path: this.path };
  }
}
