/**
 * Fields for a caught error, for one structured `console.*` object (Workers Logs indexes its
 * fields). `JSON.stringify` drops an Error's message and stack, so pull them out explicitly
 * (the stack only when `opts.stack` is set). Non-Error values become `String(err)`.
 */
export function errorFields(
  err: unknown,
  opts?: { stack?: boolean },
): { error: string; stack?: string } {
  if (err instanceof Error) {
    return opts?.stack && err.stack
      ? { error: err.message, stack: err.stack }
      : { error: err.message };
  }
  return { error: String(err) };
}
