import { CAP_CORE } from "../types";
import type { MethodDef } from "../registry";

export const coreMethods: Record<string, MethodDef> = {
  "Core/echo": { capability: CAP_CORE, handler: async (_ctx, args) => args },
};
