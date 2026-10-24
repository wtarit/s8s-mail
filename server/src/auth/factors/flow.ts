/**
 * Per-dispatch scratch state shared between the session-creation database hook and the after
 * hook of the same endpoint call (both see the same `ctx.context` object).
 */
export interface FlowState {
  /** A recovery link verified for a user who still needs a second factor. */
  pendingToken?: string | null;
  recoveryIncomplete?: boolean;
}

const states = new WeakMap<object, FlowState>();

export function flowState(context: object): FlowState {
  let state = states.get(context);
  if (!state) {
    state = {};
    states.set(context, state);
  }
  return state;
}

export const peekFlowState = (context: object) => states.get(context);
