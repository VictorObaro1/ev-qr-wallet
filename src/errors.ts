export type ErrorCode =
  | 'RIDER_NOT_FOUND'
  | 'RIDER_SUSPENDED'
  | 'QUANTITY_OUT_OF_RANGE'
  | 'ORDER_NOT_FOUND'
  | 'PASS_NOT_FOUND'
  | 'PAYSTACK_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR';

export class StructuredToolError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'StructuredToolError';
    this.code = code;
    this.retryable = retryable;
  }

  public toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
      },
    };
  }
}
