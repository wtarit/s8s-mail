type DateInput = Date | string | number;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDate(value: DateInput): string {
  return dateFormat.format(new Date(value));
}

export function formatDateTime(value: DateInput): string {
  return dateTimeFormat.format(new Date(value));
}

/** Minutes until `value` (rounded up), never negative. */
export function minutesUntil(value: DateInput, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(value).getTime() - now) / 60_000));
}
