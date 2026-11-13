/** A refusal from GemiesOS, or from waking it, with a stable code. */
export class GemiesOsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GemiesOsError';
  }
}
