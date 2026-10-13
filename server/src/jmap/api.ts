import { z } from "zod";
import type { Context } from "hono";
import { MethodContext } from "./context";
import { MethodError, REQUEST_ERRORS, RequestError } from "./errors";
import { resolveResultReferences } from "./references";
import { methods } from "./methods/index";
import { MultiResponse } from "./registry";
import {
  LIMITS,
  SUPPORTED_CAPABILITIES,
  type Invocation,
  type JmapEnv,
  type Principal,
} from "./types";
import { sessionState } from "./session";

const requestSchema = z.object({
  using: z.array(z.string()),
  methodCalls: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()])),
  createdIds: z.record(z.string(), z.string()).optional(),
});

/** Parses and validates the request envelope; throws RequestError (HTTP 400). */
async function readEnvelope(req: Request): Promise<z.infer<typeof requestSchema>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > LIMITS.maxSizeRequest) {
    throw new RequestError(REQUEST_ERRORS.limit, 413, "Request is too large", {
      limit: "maxSizeRequest",
    });
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new RequestError(REQUEST_ERRORS.notJSON, 400, "Content-Type must be application/json");
  }
  const text = await req.text();
  if (text.length > LIMITS.maxSizeRequest) {
    throw new RequestError(REQUEST_ERRORS.limit, 413, "Request is too large", {
      limit: "maxSizeRequest",
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RequestError(REQUEST_ERRORS.notJSON, 400, "The request body is not valid JSON");
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RequestError(
      REQUEST_ERRORS.notRequest,
      400,
      `Not a JMAP request: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"}`,
    );
  }
  return parsed.data;
}

function describeZod(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`)
    .join("; ");
}

/** Runs one method call; never throws. */
async function runCall(
  ctx: MethodContext,
  call: Invocation,
  responses: Invocation[],
): Promise<Invocation[]> {
  const [name, rawArgs, callId] = call;
  const fail = (e: MethodError): Invocation[] => [["error", e.toJSON(), callId]];
  const def = Object.hasOwn(methods, name) ? methods[name] : undefined;
  if (!def || !ctx.using.has(def.capability)) {
    return fail(new MethodError("unknownMethod", `Unknown method "${name}"`));
  }
  try {
    const args = resolveResultReferences(rawArgs, responses);
    const out = await def.handler(ctx, args);
    if (out instanceof MultiResponse) {
      return out.responses.map(([n, a]) => [n, a, callId] as Invocation);
    }
    return [[name, out, callId]];
  } catch (err) {
    if (err instanceof MethodError) return fail(err);
    if (err instanceof z.ZodError) {
      return fail(new MethodError("invalidArguments", describeZod(err)));
    }
    console.error(`JMAP ${name} failed`, err);
    return fail(new MethodError("serverFail", "An internal error occurred"));
  }
}

/** `POST /jmap/api` (RFC 8620 §3). */
export async function handleApi(c: Context<JmapEnv>): Promise<Response> {
  const principal: Principal = c.get("principal");
  let envelope: z.infer<typeof requestSchema>;
  try {
    envelope = await readEnvelope(c.req.raw);
    const unknown = envelope.using.filter(
      (u) => !(SUPPORTED_CAPABILITIES as readonly string[]).includes(u),
    );
    if (unknown.length > 0) {
      throw new RequestError(
        REQUEST_ERRORS.unknownCapability,
        400,
        `Unknown capability: ${unknown.join(", ")}`,
      );
    }
    if (envelope.methodCalls.length > LIMITS.maxCallsInRequest) {
      throw new RequestError(
        REQUEST_ERRORS.limit,
        400,
        `At most ${LIMITS.maxCallsInRequest} method calls per request`,
        { limit: "maxCallsInRequest" },
      );
    }
  } catch (err) {
    if (err instanceof RequestError) return err.toResponse();
    throw err;
  }

  const ctx = new MethodContext(c.env, principal, new Set(envelope.using));
  for (const [k, v] of Object.entries(envelope.createdIds ?? {})) ctx.createdIds.set(k, v);

  const responses: Invocation[] = [];
  for (const call of envelope.methodCalls) {
    responses.push(...(await runCall(ctx, call, responses)));
  }
  return c.json({
    methodResponses: responses,
    ...(envelope.createdIds ? { createdIds: Object.fromEntries(ctx.createdIds) } : {}),
    sessionState: await sessionState(c.env, principal),
  });
}
