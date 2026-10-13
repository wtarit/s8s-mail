Per-account mail store: one SQLite Durable Object (`AccountDO`) per JMAP account.

- `schema.ts` (Drizzle) + `drizzle/do/0001_*.sql` (hand-written FTS5 table and change-log triggers). Migrations run on DO start (`pnpm db:generate:do` to regenerate; keep the SQL file in sync with column changes).
- `types.ts`: `AccountStore` seam, ingest input, `BodyPart`, state/push types.
- `blob.ts`: blob id scheme (`M<hex>` raw message, `<blobId>-<partId>` decoded part) and R2 keys.
- `parse.ts`: postal-mime body parse, run only from the DO alarm (CPU budget).
- `threading.ts`: Message-ID normalization and thread candidates.
- `subscribe.ts`: `subscribeToAccount()` for the SSE/push layer.

CPU: Workers Free allows 10 ms per invocation, DOs included. `ingest()` writes headers only; the body is parsed by `alarm()`, one message per invocation, and large messages may exceed the budget and end up `failed` (headers stay available).

JMAP layer (see `../jmap/README.md`): `jmap-store.ts` holds the queries and writes behind the `AccountDO` RPC methods (`mailboxGet/Set/Query`, `threadGet`, `emailGet/Query/Create/Update/Destroy/Snippets`, `getChanges`, `getAllStates`, `identitySettings*`, `submission*`), `jmap-filter.ts` compiles Email/query filters and sorts to SQL, `jmap-types.ts` are the plain-data types crossing the RPC boundary. Migration `0002` adds `email_submission` and `identity_setting` (+ `change_log.counts_only`); `0003` adds their triggers and marks count-only Mailbox changes. DO SQL allows 100 bound parameters, so id lists are passed as one JSON parameter and expanded with `json_each(?)`.
