import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { handleEmail } from "../../src/mail/ingest";
import { accountStub } from "../../src/store/subscribe";
import { ctx, fakeMessage } from "./mail";

export type EmailRow = {
  id: string;
  blob_id: string;
  thread_id: string;
  subject: string | null;
  preview: string;
  has_attachment: number;
  parse_state: string;
  parse_attempts: number;
  parse_error: string | null;
  size: number;
  body_structure: string | null;
};

export async function emails(accountId: string): Promise<EmailRow[]> {
  return runInDurableObject(accountStub(env, accountId), (_i, state) =>
    state.storage.sql.exec<EmailRow>("SELECT * FROM email ORDER BY received_at, rowid").toArray(),
  );
}

export async function deliver(to: string, raw: string) {
  const { message, setReject } = fakeMessage(to, raw);
  await handleEmail(message, env, ctx);
  return { setReject };
}

export async function r2Keys(accountId: string): Promise<string[]> {
  return (await env.BLOBS.list({ prefix: `${accountId}/` })).objects.map((o) => o.key);
}

export async function setCatchAll(domainName: string, address: string | null) {
  await env.DB.prepare("UPDATE domain SET catch_all_address = ? WHERE name = ?")
    .bind(address, domainName)
    .run();
}
