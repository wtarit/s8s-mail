import { pendingSignInResponse, type PendingSignInResponse } from "@s8s/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type PendingSignIn = NonNullable<PendingSignInResponse["pending"]>;

/** A half-finished sign-in of a 2FA user (no session yet); null when there is none. */
export async function fetchPendingSignIn(): Promise<PendingSignIn | null> {
  try {
    const { pending } = await api("/api/auth/pending-sign-in", pendingSignInResponse);
    return pending;
  } catch {
    return null;
  }
}

/** Looks for a pending sign-in once `enabled`. `loading` stays true until the answer is in. */
export function usePendingSignIn(enabled: boolean): {
  loading: boolean;
  pending: PendingSignIn | null;
  clear: () => void;
} {
  const [state, setState] = useState<{ done: boolean; pending: PendingSignIn | null }>({
    done: false,
    pending: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchPendingSignIn().then((pending) => {
      if (!cancelled) setState({ done: true, pending });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return {
    loading: enabled && !state.done,
    pending: state.pending,
    clear: () => setState({ done: true, pending: null }),
  };
}
