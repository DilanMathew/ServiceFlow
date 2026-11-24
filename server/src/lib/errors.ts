export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'CONFLICT', msg, details);
export const unprocessable = (msg: string, details?: unknown) => new AppError(422, 'BUSINESS_RULE', msg, details);
export const paymentRequired = (msg: string) => new AppError(402, 'SUBSCRIPTION_REQUIRED', msg);
export const tooMany = (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg);
