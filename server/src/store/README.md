Per-account mail store: one SQLite Durable Object (`AccountDO`) per JMAP account.

- `schema.ts` (Drizzle) + `drizzle/do/0001_*.sql` (hand-written FTS5 table and change-log triggers). Migrations run on DO start (`pnpm db:generate:do` to regenerate; keep the SQL file in sync with column changes).
- `types.ts`: `AccountStore` seam, ingest input, `BodyPart`, state/push types.
- `blob.ts`: blob id scheme (`M<hex>` raw message, `<blobId>-<partId>` decoded part) and R2 keys.
- `parse.ts`: postal-mime body parse, run only from the DO alarm (CPU budget).
- `threading.ts`: Message-ID normalization and thread candidates.
- `subscribe.ts`: `subscribeToAccount()` for the SSE/push layer.

CPU: Workers Free allows 10 ms per invocation, DOs included. `ingest()` writes headers only; the body is parsed by `alarm()`, one message per invocation, and large messages may exceed the budget and end up `failed` (headers stay available).
