import type { ChangesResult } from "../jmap-types";
import type { StoreSql } from "./sql";

const COUNT_PROPERTIES = ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"];

/**
 * Foo/changes (RFC 8620 §5.2). Entries of an object inside (since, newState] collapse as:
 * last = destroyed -> destroyed (nothing if its first entry is "created"); else first =
 * created -> created; else updated. With more than `maxChanges` objects, `newState` is
 * the seq of the maxChanges-th object's first entry, and only entries up to it count.
 */
export function changes(
  sql: StoreSql,
  type: string,
  sinceState: string,
  maxChanges: number,
): ChangesResult {
  if (!/^\d{1,15}$/.test(sinceState)) {
    return { ok: false, error: { type: "cannotCalculateChanges" } };
  }
  const since = Number(sinceState);
  const current = Number(sql.state(type));
  if (since > current) return { ok: false, error: { type: "cannotCalculateChanges" } };
  const firsts = sql.all<{ object_id: string; first_seq: number }>(
    "SELECT object_id, MIN(seq) AS first_seq FROM change_log WHERE type = ? AND seq > ? GROUP BY object_id ORDER BY first_seq LIMIT ?",
    type,
    since,
    maxChanges + 1,
  );
  let upTo = current;
  let hasMore = false;
  if (firsts.length > maxChanges) {
    upTo = firsts[maxChanges - 1]!.first_seq;
    hasMore = true;
  }
  const entries = sql.all<{ object_id: string; kind: string; counts_only: number }>(
    "SELECT object_id, kind, counts_only FROM change_log WHERE type = ? AND seq > ? AND seq <= ? ORDER BY seq",
    type,
    since,
    upTo,
  );
  const byObject = new Map<string, { kind: string; counts_only: number }[]>();
  for (const e of entries) {
    const list = byObject.get(e.object_id) ?? [];
    list.push(e);
    byObject.set(e.object_id, list);
  }
  const created: string[] = [];
  const updated: string[] = [];
  const destroyed: string[] = [];
  let allCountsOnly = true;
  for (const [id, list] of byObject) {
    const firstKind = list[0]!.kind;
    const lastKind = list[list.length - 1]!.kind;
    if (lastKind === "destroyed") {
      if (firstKind !== "created") destroyed.push(id);
    } else if (firstKind === "created") {
      created.push(id);
    } else {
      updated.push(id);
      if (!list.every((e) => e.counts_only === 1)) allCountsOnly = false;
    }
  }
  return {
    ok: true,
    oldState: sinceState,
    newState: String(upTo),
    hasMoreChanges: hasMore,
    created,
    updated,
    destroyed,
    updatedProperties:
      type === "Mailbox" && updated.length > 0 && allCountsOnly ? COUNT_PROPERTIES : null,
  };
}
