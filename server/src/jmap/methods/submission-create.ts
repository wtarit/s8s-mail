import { z } from "zod";
import { normalizeRecipient } from "../../mail/headers";
import { envelopeFromEmail, removeBccHeader } from "../../mime";
import { SendError } from "../../send";
import type { SendProvider } from "../../send";
import { blobKey } from "../../store/blob";
import type { DeliveryStatus } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import { attachmentLimit } from "../session";
import type { SetError } from "../types";
import type { loadIdentities } from "./identity";
import { submissionObject } from "./submission-read";

const createSchema = z.object({
  emailId: z.string(),
  identityId: z.string(),
  envelope: z
    .object({
      mailFrom: z.object({ email: z.string(), parameters: z.unknown().optional() }),
      rcptTo: z.array(z.object({ email: z.string(), parameters: z.unknown().optional() })),
    })
    .nullish(),
  undoStatus: z.string().optional(),
});

const ADDR_RE = /^[^\s@<>]+@[^\s@<>]+$/;

/** Maps a provider failure to a SetError. Retries/queueing are out of scope (see README). */
export function sendErrorToSetError(err: SendError, provider: SendProvider): SetError {
  const code = err.code ?? "";
  if (err.retryable) {
    return { type: "serverFail", description: `The provider is unavailable: ${err.message}` };
  }
  if (code === "tooLarge" || code.endsWith("_413")) {
    return { type: "tooLarge", description: err.message, maxSize: provider.maxMessageBytes };
  }
  if (code === "tooManyRecipients") {
    return {
      type: "tooManyRecipients",
      description: err.message,
      maxRecipients: provider.maxRecipients,
    };
  }
  if (code === "noRecipients") return { type: "noRecipients", description: err.message };
  if (code.endsWith("_400") || code.endsWith("_422")) {
    return { type: "invalidEmail", description: err.message };
  }
  if (code === "notConfigured") return { type: "serverFail", description: err.message };
  return { type: "forbiddenToSend", description: err.message };
}

type Created = { object: Record<string, unknown>; emailId: string };

export async function createSubmission(
  ctx: MethodContext,
  accountId: string,
  obj: Record<string, unknown>,
  provider: SendProvider,
  identities: Awaited<ReturnType<typeof loadIdentities>>["list"],
  accountAddresses: Set<string>,
): Promise<{ ok: Created } | { error: SetError }> {
  const parsed = createSchema.safeParse(obj);
  if (!parsed.success) {
    return {
      error: {
        type: "invalidProperties",
        properties: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))],
      },
    };
  }
  const c = parsed.data;
  const emailId = ctx.resolveId(c.emailId);
  const identity = identities.find((i) => i.id === ctx.resolveId(c.identityId));
  if (!identity) {
    return {
      error: {
        type: "invalidProperties",
        properties: ["identityId"],
        description: "Unknown identity",
      },
    };
  }
  const stub = ctx.stub(accountId);
  const email = await stub.emailForSubmission(emailId);
  if (!email) {
    return {
      error: { type: "invalidProperties", properties: ["emailId"], description: "Unknown email" },
    };
  }

  // The From address(es) must be the chosen identity's address (plus-tags ignored).
  if (
    email.from.length === 0 ||
    email.from.some((f) => normalizeRecipient(f.email) !== identity.email)
  ) {
    return {
      error: {
        type: "forbiddenFrom",
        description: `The From address does not match the identity ${identity.email}`,
      },
    };
  }

  let mailFrom: string;
  let rcptTo: string[];
  try {
    if (c.envelope) {
      mailFrom = c.envelope.mailFrom.email.trim();
      rcptTo = [...new Set(c.envelope.rcptTo.map((r) => r.email.trim()))];
    } else {
      ({ mailFrom, rcptTo } = envelopeFromEmail(email));
    }
  } catch (err) {
    return {
      error: {
        type: "invalidEmail",
        description: err instanceof Error ? err.message : "Invalid email",
      },
    };
  }
  if (!ADDR_RE.test(mailFrom) || rcptTo.some((r) => !ADDR_RE.test(r))) {
    return {
      error: {
        type: "invalidProperties",
        properties: ["envelope"],
        description: "Invalid address in envelope",
      },
    };
  }
  if (!accountAddresses.has(normalizeRecipient(mailFrom))) {
    return {
      error: {
        type: "forbiddenMailFrom",
        description: "The envelope MAIL FROM must be one of your addresses",
      },
    };
  }
  if (rcptTo.length === 0) return { error: { type: "noRecipients" } };
  if (rcptTo.length > provider.maxRecipients) {
    return {
      error: {
        type: "tooManyRecipients",
        description: `At most ${provider.maxRecipients} recipients`,
        maxRecipients: provider.maxRecipients,
      },
    };
  }
  const limit = attachmentLimit(ctx.env);
  if (email.size > provider.maxMessageBytes || (email.attachmentBytes ?? 0) > limit) {
    return {
      error: {
        type: "tooLarge",
        description: `The message exceeds the sending limit (attachments up to ${limit} bytes)`,
        maxSize: provider.maxMessageBytes,
      },
    };
  }

  const obj2 = await ctx.env.BLOBS.get(blobKey(accountId, email.blobId));
  if (!obj2)
    return { error: { type: "serverFail", description: "The message content is missing" } };
  const raw = removeBccHeader(new Uint8Array(await obj2.arrayBuffer()));

  let providerMessageId: string | null = null;
  try {
    const sent = await provider.send({ mailFrom, rcptTo, raw });
    providerMessageId = sent.providerMessageId ?? null;
  } catch (err) {
    if (err instanceof SendError) return { error: sendErrorToSetError(err, provider) };
    throw err;
  }

  const deliveryStatus: Record<string, DeliveryStatus> = Object.fromEntries(
    rcptTo.map((r) => [
      r,
      {
        smtpReply: "250 2.0.0 Accepted by the sending provider",
        delivered: "queued",
        displayed: "unknown",
      },
    ]),
  );
  const row = await stub.submissionCreate({
    accountId,
    identityId: identity.id,
    emailId,
    threadId: email.threadId,
    envelopeMailFrom: mailFrom,
    envelopeRcptTo: rcptTo,
    sendAt: Date.now(),
    undoStatus: "final",
    deliveryStatus,
    providerMessageId,
  });
  const o = submissionObject(row);
  return {
    ok: {
      emailId,
      object: {
        id: o.id,
        threadId: o.threadId,
        sendAt: o.sendAt,
        undoStatus: o.undoStatus,
        deliveryStatus: o.deliveryStatus,
        dsnBlobIds: [],
        mdnBlobIds: [],
        ...(c.envelope ? {} : { envelope: o.envelope }),
      },
    },
  };
}
