import { newId } from "../blob";
import type { MailboxSetParams, StoreError } from "../jmap-types";
import type { StoreSql } from "./sql";

export const MAX_MAILBOX_DEPTH = 10;
export const MAX_MAILBOX_NAME = 255;
const VALID_ROLES = new Set(["archive", "drafts", "important", "inbox", "junk", "sent", "trash"]);

function mailboxDepth(sql: StoreSql, id: string | null): number {
  let depth = 0;
  let cur = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && depth <= MAX_MAILBOX_DEPTH + 1) {
    seen.add(cur);
    depth++;
    cur =
      sql.first<{ parent_id: string | null }>("SELECT parent_id FROM mailbox WHERE id = ?", cur)
        ?.parent_id ?? null;
  }
  return depth;
}

function isDescendant(sql: StoreSql, candidate: string, ancestor: string): boolean {
  let cur: string | null = candidate;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur =
      sql.first<{ parent_id: string | null }>("SELECT parent_id FROM mailbox WHERE id = ?", cur)
        ?.parent_id ?? null;
  }
  return false;
}

function siblingNameTaken(
  sql: StoreSql,
  name: string,
  parentId: string | null,
  exceptId: string | null,
) {
  return !!sql.first(
    "SELECT 1 AS x FROM mailbox WHERE lower(name) = lower(?) AND parent_id IS ? AND id IS NOT ?",
    name,
    parentId,
    exceptId,
  );
}

function validateName(name: string): StoreError | null {
  if (
    name.trim() === "" ||
    name.length > MAX_MAILBOX_NAME ||
    [...name].some((ch) => ch.charCodeAt(0) < 32)
  ) {
    return {
      type: "invalidProperties",
      properties: ["name"],
      description: `Mailbox name must be 1-${MAX_MAILBOX_NAME} characters without control characters`,
    };
  }
  return null;
}

/** Inserts a mailbox; returns its id, or the error. */
export function createMailbox(
  sql: StoreSql,
  c: MailboxSetParams["create"][number],
  parentId: string | null,
) {
  const nameErr = validateName(c.name);
  if (nameErr) return nameErr;
  if (parentId !== null) {
    if (!sql.first("SELECT 1 AS x FROM mailbox WHERE id = ?", parentId)) {
      return {
        type: "invalidProperties",
        properties: ["parentId"],
        description: "Unknown parent",
      };
    }
    if (mailboxDepth(sql, parentId) >= MAX_MAILBOX_DEPTH) {
      return {
        type: "invalidProperties",
        properties: ["parentId"],
        description: `Mailboxes can be nested at most ${MAX_MAILBOX_DEPTH} deep`,
      };
    }
  }
  if (siblingNameTaken(sql, c.name, parentId, null)) {
    return {
      type: "invalidProperties",
      properties: ["name"],
      description: "A sibling mailbox with this name exists",
    };
  }
  if (c.role !== null) {
    if (!VALID_ROLES.has(c.role)) {
      return { type: "invalidProperties", properties: ["role"], description: "Unsupported role" };
    }
    if (sql.first("SELECT 1 AS x FROM mailbox WHERE role = ?", c.role)) {
      return {
        type: "invalidProperties",
        properties: ["role"],
        description: "Another mailbox already has this role",
      };
    }
  }
  const id = newId("b");
  sql.run(
    "INSERT INTO mailbox (id, name, parent_id, role, sort_order, is_subscribed) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    c.name,
    parentId,
    c.role,
    c.sortOrder,
    c.isSubscribed ? 1 : 0,
  );
  return id;
}

export function updateMailbox(
  sql: StoreSql,
  u: MailboxSetParams["update"][number],
): StoreError | null {
  const cur = sql.first<{
    id: string;
    name: string;
    parent_id: string | null;
    role: string | null;
  }>("SELECT id, name, parent_id, role FROM mailbox WHERE id = ?", u.id);
  if (!cur) return { type: "notFound" };
  const name = u.name ?? cur.name;
  const parentId = u.parentId !== undefined ? u.parentId : cur.parent_id;
  if (u.name !== undefined) {
    const err = validateName(u.name);
    if (err) return err;
  }
  if (u.parentId !== undefined && u.parentId !== null) {
    if (!sql.first("SELECT 1 AS x FROM mailbox WHERE id = ?", u.parentId)) {
      return {
        type: "invalidProperties",
        properties: ["parentId"],
        description: "Unknown parent",
      };
    }
    if (isDescendant(sql, u.parentId, u.id)) {
      return {
        type: "invalidProperties",
        properties: ["parentId"],
        description: "A mailbox cannot be moved under itself",
      };
    }
    if (mailboxDepth(sql, u.parentId) >= MAX_MAILBOX_DEPTH) {
      return {
        type: "invalidProperties",
        properties: ["parentId"],
        description: `Mailboxes can be nested at most ${MAX_MAILBOX_DEPTH} deep`,
      };
    }
  }
  if (
    (u.name !== undefined || u.parentId !== undefined) &&
    siblingNameTaken(sql, name, parentId, u.id)
  ) {
    return {
      type: "invalidProperties",
      properties: ["name"],
      description: "A sibling mailbox with this name exists",
    };
  }
  if (u.role !== undefined && u.role !== cur.role) {
    if (cur.role !== null) {
      return { type: "forbidden", description: "The role of a mailbox cannot be changed" };
    }
    if (u.role !== null) {
      if (!VALID_ROLES.has(u.role)) {
        return {
          type: "invalidProperties",
          properties: ["role"],
          description: "Unsupported role",
        };
      }
      if (sql.first("SELECT 1 AS x FROM mailbox WHERE role = ?", u.role)) {
        return {
          type: "invalidProperties",
          properties: ["role"],
          description: "Another mailbox already has this role",
        };
      }
    }
  }
  sql.run(
    `UPDATE mailbox SET name = ?, parent_id = ?, role = ?, sort_order = COALESCE(?, sort_order),
       is_subscribed = COALESCE(?, is_subscribed) WHERE id = ?`,
    name,
    parentId,
    u.role !== undefined ? u.role : cur.role,
    u.sortOrder ?? null,
    u.isSubscribed === undefined ? null : u.isSubscribed ? 1 : 0,
    u.id,
  );
  return null;
}
