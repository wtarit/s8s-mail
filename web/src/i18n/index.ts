import { en, type MessageKey, type Messages } from "./en";

export type { MessageKey, Messages };

export type MessageParams = Record<string, string | number>;

const catalog: Messages = en;

/** Look up a message by key and fill `{name}` placeholders. */
export function t(key: MessageKey, params?: MessageParams): string {
  const message = catalog[key];
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Hook form of t(); stable identity, ready for a future locale provider. */
export function useT(): typeof t {
  return t;
}
