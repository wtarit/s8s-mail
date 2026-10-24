import type { MethodDef } from "../registry";
import { coreMethods } from "./core";
import { emailGetMethods } from "./email-get";
import { emailImportMethods } from "./email-import";
import { emailQueryMethods } from "./email-query";
import { emailSetMethods } from "./email-set";
import { identityMethods } from "./identity";
import { mailboxMethods } from "./mailbox";
import { submissionMethods } from "./submission";
import { threadMethods } from "./thread";

/** Method name -> definition. */
export const methods: Record<string, MethodDef> = {
  ...coreMethods,
  ...mailboxMethods,
  ...threadMethods,
  ...emailGetMethods,
  ...emailQueryMethods,
  ...emailSetMethods,
  ...emailImportMethods,
  ...identityMethods,
  ...submissionMethods,
};
