import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, errorMessage } from "@/lib/api";

export interface Resource<T> {
  data: T | undefined;
  /** True until the first load settles (skeleton state). */
  loading: boolean;
  error: string | undefined;
  /** HTTP status of a failed load (0 for network errors), when known. */
  errorStatus: number | undefined;
  reload: () => Promise<void>;
}

/** Load data on mount and on `reload()`. Keeps the previous data while reloading. */
export function useResource<T>(loader: () => Promise<T>): Resource<T> {
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const [state, setState] = useState<{ data?: T; loading: boolean; failure?: unknown }>({
    loading: true,
  });
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const data = await loaderRef.current();
      if (alive.current) setState({ data, loading: false });
    } catch (failure) {
      if (alive.current) setState((s) => ({ data: s.data, loading: false, failure }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const failed = state.failure !== undefined;
  return {
    data: state.data,
    loading: state.loading,
    error: failed ? errorMessage(state.failure) : undefined,
    errorStatus: state.failure instanceof ApiRequestError ? state.failure.status : undefined,
    reload,
  };
}
