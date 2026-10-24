import type { EmailDestroyResult, EmailUpdateInput, EmailUpdateResult, SetOp } from "../jmap-types";
import { chunkIds, type StoreSql } from "./sql";

export function applySetOp(sql: StoreSql, current: string[], op: SetOp): string[] {
  const next = op.set ? new Set(op.set) : new Set(current);
  for (const a of op.add ?? []) next.add(a);
  for (const r of op.remove ?? []) next.delete(r);
  return [...next];
}

export function emailUpdate(sql: StoreSql, updates: EmailUpdateInput[]): EmailUpdateResult {
  const oldState = sql.state("Email");
  const results: EmailUpdateResult["results"] = {};
  const mailboxIds = new Set(sql.all<{ id: string }>("SELECT id FROM mailbox").map((m) => m.id));
  for (const u of updates) {
    if (!sql.first("SELECT 1 AS x FROM email WHERE id = ?", u.id)) {
      results[u.id] = { ok: false, error: { type: "notFound" } };
      continue;
    }
    let nextBoxes: string[] | null = null;
    let curBoxes: string[] = [];
    if (u.mailboxIds) {
      curBoxes = sql
        .all<{ mailbox_id: string }>(
          "SELECT mailbox_id FROM email_mailbox WHERE email_id = ?",
          u.id,
        )
        .map((r) => r.mailbox_id);
      nextBoxes = applySetOp(sql, curBoxes, u.mailboxIds);
      if (nextBoxes.length === 0) {
        results[u.id] = {
          ok: false,
          error: {
            type: "invalidProperties",
            properties: ["mailboxIds"],
            description: "An email must be in at least one mailbox",
          },
        };
        continue;
      }
      const unknown = nextBoxes.find((b) => !mailboxIds.has(b));
      if (unknown !== undefined) {
        results[u.id] = {
          ok: false,
          error: {
            type: "invalidProperties",
            properties: ["mailboxIds"],
            description: `Unknown mailbox ${unknown}`,
          },
        };
        continue;
      }
    }
    if (nextBoxes) {
      const before = new Set(curBoxes);
      const after = new Set(nextBoxes);
      for (const b of after) {
        if (!before.has(b)) {
          sql.run("INSERT INTO email_mailbox (email_id, mailbox_id) VALUES (?, ?)", u.id, b);
        }
      }
      for (const b of before) {
        if (!after.has(b)) {
          sql.run("DELETE FROM email_mailbox WHERE email_id = ? AND mailbox_id = ?", u.id, b);
        }
      }
    }
    if (u.keywords) {
      const cur = sql
        .all<{ keyword: string }>("SELECT keyword FROM email_keyword WHERE email_id = ?", u.id)
        .map((r) => r.keyword);
      const after = new Set(applySetOp(sql, cur, u.keywords));
      const before = new Set(cur);
      for (const k of after) {
        if (!before.has(k)) {
          sql.run("INSERT INTO email_keyword (email_id, keyword) VALUES (?, ?)", u.id, k);
        }
      }
      for (const k of before) {
        if (!after.has(k)) {
          sql.run("DELETE FROM email_keyword WHERE email_id = ? AND keyword = ?", u.id, k);
        }
      }
    }
    results[u.id] = { ok: true };
  }
  return { oldState, newState: sql.state("Email"), results };
}

/** Deletes emails (rows, membership, keywords); returns the R2 blob ids to remove. */
export function deleteEmails(
  sql: StoreSql,
  ids: string[],
): { destroyed: string[]; blobIds: string[] } {
  if (ids.length === 0) return { destroyed: [], blobIds: [] };
  const idJson = chunkIds(ids);
  const rows = sql.all<{ id: string; blob_id: string }>(
    "SELECT id, blob_id FROM email WHERE id IN (SELECT value FROM json_each(?))",
    idJson,
  );
  const parts = sql
    .all<{ v: string }>(
      `SELECT DISTINCT j.value AS v FROM email e, json_tree(e.body_structure) j
      WHERE e.id IN (SELECT value FROM json_each(?)) AND j.key = 'blobId' AND j.type = 'text'`,
      idJson,
    )
    .map((r) => r.v);
  sql.run("DELETE FROM email_mailbox WHERE email_id IN (SELECT value FROM json_each(?))", idJson);
  sql.run("DELETE FROM email_keyword WHERE email_id IN (SELECT value FROM json_each(?))", idJson);
  sql.run("DELETE FROM email WHERE id IN (SELECT value FROM json_each(?))", idJson);
  return {
    destroyed: rows.map((r) => r.id),
    blobIds: [...new Set([...rows.map((r) => r.blob_id), ...parts])],
  };
}

export function emailDestroy(sql: StoreSql, ids: string[]): EmailDestroyResult {
  const oldState = sql.state("Email");
  const { destroyed, blobIds } = deleteEmails(sql, ids);
  const done = new Set(destroyed);
  return {
    oldState,
    newState: sql.state("Email"),
    destroyed,
    notFound: ids.filter((i) => !done.has(i)),
    blobIds,
  };
}
