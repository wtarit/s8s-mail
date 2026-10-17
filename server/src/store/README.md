Per-account mail store: one SQLite Durable Object (`AccountDO`) per JMAP account.

- `schema.ts` (Drizzle) + `drizzle/do/0001_*.sql` (hand-written FTS5 table and change-log triggers). Keep the hand-written SQL in sync with column changes.
- `types.ts`: `AccountStore` seam, ingest input, `BodyPart`, state/push types.
- `blob.ts`: blob id scheme (`M<hex>` raw message, `<blobId>-<partId>` decoded part) and R2 keys.
- `parse.ts`: postal-mime body parse. `ingest()` writes headers only; `alarm()` parses the body, one message per invocation. Messages too big for the CPU limit end up `failed` (headers stay available).
- `threading.ts`: Message-ID normalization and thread candidates.
- `subscribe.ts`: `subscribeToAccount()` for the SSE/push layer.

JMAP layer (see `../jmap/README.md`): `jmap-store.ts` holds the queries and writes behind the `AccountDO` RPC methods, `jmap-filter.ts` compiles Email/query filters and sorts to SQL, `jmap-types.ts` are the plain-data types crossing the RPC boundary. DO SQL allows 100 bound parameters, so id lists are passed as one JSON parameter and expanded with `json_each(?)`.
