import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { address, mailAccount } from "../db/schema";
import { accountStub } from "../store/subscribe";
import { MethodError } from "./errors";
import type { AccountInfo, AccountStub, AddressRow, Principal } from "./types";

/**
 * Subrequest budget for one HTTP request. Workers Free allows 50 subrequests (fetch, R2,
 * DO RPC, D1 all count); body/header reads from R2 draw from this and degrade gracefully
 * (truncated bodies the client refetches) instead of failing the request.
 */
const R2_READ_BUDGET = 30;

/** Per-HTTP-request state shared by all method calls of one JMAP request. */
export class MethodContext {
  /** creationId -> server id, across method calls (RFC 8620 §5.3). */
  readonly createdIds = new Map<string, string>();
  r2Budget = R2_READ_BUDGET;
  private readonly accountInfos = new Map<string, Promise<AccountInfo | null>>();
  private readonly addresses = new Map<string, Promise<AddressRow[]>>();

  constructor(
    readonly env: Env,
    readonly principal: Principal,
    readonly using: ReadonlySet<string>,
  ) {}

  stub(accountId: string): AccountStub {
    return accountStub(this.env, accountId);
  }

  /** Validates the `accountId` argument against the principal's accounts. */
  account(args: Record<string, unknown>): string {
    const id = args.accountId;
    if (typeof id !== "string") {
      throw new MethodError("invalidArguments", "accountId is required");
    }
    if (!this.principal.accountIds.includes(id)) {
      throw new MethodError("accountNotFound");
    }
    return id;
  }

  accountInfo(accountId: string): Promise<AccountInfo | null> {
    let p = this.accountInfos.get(accountId);
    if (!p) {
      p = drizzle(this.env.DB)
        .select({ id: mailAccount.id, name: mailAccount.name, isPersonal: mailAccount.isPersonal })
        .from(mailAccount)
        .where(eq(mailAccount.id, accountId))
        .get()
        .then((r) => r ?? null);
      this.accountInfos.set(accountId, p);
    }
    return p;
  }

  /** Addresses of the account, primary first. */
  accountAddresses(accountId: string): Promise<AddressRow[]> {
    let p = this.addresses.get(accountId);
    if (!p) {
      p = drizzle(this.env.DB)
        .select({ address: address.address, kind: address.kind })
        .from(address)
        .where(eq(address.accountId, accountId))
        .all()
        .then((rows) =>
          rows.toSorted((a, b) =>
            a.kind === b.kind ? a.address.localeCompare(b.address) : a.kind === "primary" ? -1 : 1,
          ),
        );
      this.addresses.set(accountId, p);
    }
    return p;
  }

  /** Resolves `#creationId` references; other ids pass through. */
  resolveId(id: string): string {
    if (id.startsWith("#")) return this.createdIds.get(id.slice(1)) ?? id;
    return id;
  }
}

/** Account display names and personal flags for the session document. */
export async function loadAccountInfos(env: Env, accountIds: string[]): Promise<AccountInfo[]> {
  if (accountIds.length === 0) return [];
  return drizzle(env.DB)
    .select({ id: mailAccount.id, name: mailAccount.name, isPersonal: mailAccount.isPersonal })
    .from(mailAccount)
    .where(inArray(mailAccount.id, accountIds))
    .all();
}
