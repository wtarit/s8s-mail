import type { SendProvider, SystemMail } from "./types";

export * from "./types";

/**
 * Returns the deployment's configured provider (env.MAIL_PROVIDER).
 * TODO(send): implemented by the sending module (Mailgun + Cloudflare).
 */
export function getSendProvider(_env: Env): SendProvider {
  throw new Error("getSendProvider: not implemented yet");
}

/**
 * Builds a simple MIME message from `mail` (From = env.SYSTEM_MAIL_FROM) and
 * sends it through the configured provider.
 * TODO(send): implemented by the sending module.
 */
export async function sendSystemMail(_env: Env, _mail: SystemMail): Promise<void> {
  throw new Error("sendSystemMail: not implemented yet");
}

/**
 * The largest total attachment size to advertise as JMAP
 * `maxSizeAttachmentsPerEmail`, derived from the provider's raw limit
 * minus MIME/base64 overhead.
 * TODO(send): implemented by the sending module.
 */
export function maxAttachmentBytes(provider: SendProvider): number {
  return Math.floor((provider.maxMessageBytes - 64 * 1024) * 0.73);
}
