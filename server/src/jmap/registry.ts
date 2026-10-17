import type { MethodContext } from "./context";

/** A handler may answer with extra implicit responses (e.g. EmailSubmission/set -> Email/set). */
export class MultiResponse {
  constructor(readonly responses: [string, Record<string, unknown>][]) {}
}

export type Handler = (
  ctx: MethodContext,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown> | MultiResponse>;

export type MethodDef = { capability: string; handler: Handler };
