import type { FactorName, MeResponse } from "@s8s/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StepUpDialog } from "@/components/step-up-dialog";
import { fetchMe, useMe } from "@/lib/me";
import {
  pendingFactors,
  reauthRequirement,
  requirementFromMe,
  StepUpCancelledError,
  type StepUpRequirement,
} from "@/lib/step-up";

export interface StepUpRunOptions {
  /** Factors the action itself proves (the password form sends the current password). */
  provides?: readonly FactorName[];
}

export interface StepUp {
  /**
   * Run an account change. Asks (in one dialog) only for the factors that are stale, either up
   * front from `/api/me` or after a 403 REAUTHENTICATION_REQUIRED, refetches `/api/me`, then
   * runs / retries `action`. Rejects with `StepUpCancelledError` when the user backs out.
   */
  run<T>(action: () => Promise<T>, options?: StepUpRunOptions): Promise<T>;
}

const StepUpContext = createContext<StepUp | null>(null);

interface Prompt {
  requirement: StepUpRequirement;
  provides: readonly FactorName[];
  resolve: () => void;
  reject: (error: Error) => void;
}

interface StepUpProviderProps {
  /** Current `/api/me`, when there is one: enables the up-front check. */
  me?: MeResponse;
  /** Refresh the caller's copy of `/api/me` once the prompt is finished. */
  reload?: () => Promise<void>;
  children: ReactNode;
}

export function StepUpProvider({ me, reload, children }: StepUpProviderProps) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const latest = useRef({ me, reload });
  useEffect(() => {
    latest.current = { me, reload };
  });

  const ask = useCallback(
    (requirement: StepUpRequirement, provides: readonly FactorName[]) =>
      new Promise<void>((resolve, reject) => setPrompt({ requirement, provides, resolve, reject })),
    [],
  );

  const value = useMemo<StepUp>(
    () => ({
      async run(action, options) {
        const provides = options?.provides ?? [];
        const known = latest.current.me;
        if (known && pendingFactors(requirementFromMe(known), provides).length > 0) {
          await ask(requirementFromMe(known), provides);
        }
        try {
          return await action();
        } catch (error) {
          const required = reauthRequirement(error);
          if (!required || pendingFactors(required).length === 0) throw error;
          await ask(required, []);
          return action();
        }
      },
    }),
    [ask],
  );

  function close(settle: (p: Prompt) => void) {
    if (!prompt) return;
    setPrompt(null);
    void latest.current.reload?.();
    settle(prompt);
  }

  return (
    <StepUpContext.Provider value={value}>
      {children}
      {prompt ? (
        <StepUpDialog
          requirement={prompt.requirement}
          provides={prompt.provides}
          refresh={async () => requirementFromMe(await fetchMe())}
          onDone={() => close((p) => p.resolve())}
          onCancel={() => close((p) => p.reject(new StepUpCancelledError()))}
        />
      ) : null}
    </StepUpContext.Provider>
  );
}

/** Step-up for the signed-in account area: wired to the shared `/api/me` copy. */
export function MeStepUpProvider({ children }: { children: ReactNode }) {
  const { me, reload } = useMe();
  return (
    <StepUpProvider me={me} reload={reload}>
      {children}
    </StepUpProvider>
  );
}

export function useStepUp(): StepUp {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error("useStepUp must be used inside <StepUpProvider>");
  return ctx;
}
