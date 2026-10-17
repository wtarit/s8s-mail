/** Message-ID based threading (JMAP Thread, RFC 8621 §3). Pure helpers; SQL lives in the DO. */

/** Max referenced ids considered per message (bounds the lookup and thread_ref growth). */
export const MAX_THREAD_REFS = 20;

/** Normalizes a Message-ID for matching: strip `<>`/whitespace, lowercase. */
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/**
 * Candidate ids ordered by how strongly they indicate the thread: the message's own id
 * (someone may already reference it), In-Reply-To, then References from the newest
 * (closest ancestor) to the oldest. Normalized, de-duplicated, capped.
 */
export function threadCandidates(
  messageId: string | null,
  inReplyTo: string[],
  references: string[],
): string[] {
  const ordered = [...(messageId ? [messageId] : []), ...inReplyTo, ...references.toReversed()];
  const seen = new Set<string>();
  for (const raw of ordered) {
    const id = normalizeMessageId(raw);
    if (id) seen.add(id);
    if (seen.size >= MAX_THREAD_REFS) break;
  }
  return [...seen];
}
