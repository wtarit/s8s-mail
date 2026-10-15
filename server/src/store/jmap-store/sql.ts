import type { SqlValue } from "../jmap-filter";
import type { AllStates } from "../jmap-types";

export type Row = Record<string, SqlValue | ArrayBuffer>;

export function json<T>(text: unknown): T | null {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function chunkIds(ids: string[]): string {
  return JSON.stringify(ids);
}

/** Thin typed wrapper over the account DO's SQL storage, shared by every JMAP query module. */
export class StoreSql {
  constructor(private readonly storage: DurableObjectStorage) {}

  all<T extends Row = Row>(query: string, ...binds: SqlValue[]): T[] {
    return this.storage.sql.exec<T>(query, ...binds).toArray();
  }

  first<T extends Row = Row>(query: string, ...binds: SqlValue[]): T | undefined {
    return this.all<T>(query, ...binds)[0];
  }

  run(query: string, ...binds: SqlValue[]): void {
    this.storage.sql.exec(query, ...binds);
  }

  state(type: string): string {
    const row = this.first<{ m: number | null }>(
      "SELECT MAX(seq) AS m FROM change_log WHERE type = ?",
      type,
    );
    return String(row?.m ?? 0);
  }

  states(): AllStates {
    return {
      Email: this.state("Email"),
      Mailbox: this.state("Mailbox"),
      Thread: this.state("Thread"),
      EmailSubmission: this.state("EmailSubmission"),
      Identity: this.state("Identity"),
    };
  }
}
