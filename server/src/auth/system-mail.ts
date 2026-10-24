import type { SystemMail } from "../send/types";

/**
 * Sends a system mail (invite, magic link) through the configured provider. The send module is
 * imported lazily so requests that never send mail do not load the provider code.
 */
export async function sendSystemMailLazy(env: Env, mail: SystemMail): Promise<void> {
  const { sendSystemMail } = await import("../send");
  await sendSystemMail(env, mail);
}
