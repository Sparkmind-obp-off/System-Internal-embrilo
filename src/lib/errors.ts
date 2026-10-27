export type Issue = { field: string; issue: string }

/** Errors that are safe to show to the caller. Never put secrets or private content in them. */
export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503,
    public code: string,
    message?: string,
    public details?: Issue[],
    public retryAfter?: number
  ) {
    super(message ?? code)
  }
}

export const notFound = () => new AppError(404, 'not_found', 'Resource not found')
export const forbidden = (msg = 'You do not have permission for this action') =>
  new AppError(403, 'forbidden', msg)
