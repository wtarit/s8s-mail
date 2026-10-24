Inbound mail (`email()` handler) and mail ingest.

## Address routing

`ingest.ts` (`handleEmail`) resolves each recipient in D1 before touching R2 or the DO. Email Routing calls it once per recipient.

- The address to account mapping is the `address` table. An account has one primary address plus aliases, on any served domain. All of them receive; each is a JMAP Identity.
- The recipient is normalized first (`normalizeRecipient` in `headers.ts`): lowercased, angle brackets removed, and a `+tag` dropped from the local part. `Ana+news@Example.com` routes as `ana@example.com`.
- **An exact match wins.**
- Only on a miss is the recipient's domain consulted for a catch-all: `domain.catch_all_address` names an existing address, and the mail goes to the account that owns it. That address can be on any served domain. This is one extra D1 query.
- No exact match and no catch-all: `setReject("5.1.1 Recipient address rejected")`. An unserved domain has no `address` or `domain` rows, so it is always rejected.
- The admin API validates a catch-all against existing addresses, and clears it in the same D1 batch that deletes the address (alias removed in `api/admin-user-routes.ts`, user deleted in `api/users.ts`), so it never dangles.

After routing, the raw message streams into R2 through a `FixedLengthStream` (`message.raw` is single-use), then `AccountDO.ingest()` writes the header-derived row. If the DO call fails, the blob is deleted and the error is rethrown so Email Routing retries or bounces. There is no MIME parsing here: the DO parses bodies later (see `../store/README.md`).
