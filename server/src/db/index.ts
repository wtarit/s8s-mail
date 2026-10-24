import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export { schema };
export type Db = DrizzleD1Database<typeof schema>;

/** Drizzle over the D1 directory + Better Auth tables. Cheap to call; holds no connection. */
export function getDb(env: Pick<Env, "DB">): Db {
  return drizzle(env.DB, { schema });
}
