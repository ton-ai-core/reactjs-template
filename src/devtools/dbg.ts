export const DBG_VARS = Symbol('stackLogger.vars');

export type DebugVarsObject = { [DBG_VARS]: true; vars: Record<string, unknown> };

export function dbg(vars: Record<string, unknown>): DebugVarsObject {
  return { [DBG_VARS]: true, vars } as DebugVarsObject;
}

export function isDebugVars(x: unknown): x is DebugVarsObject {
  return typeof x === 'object' && x !== null && (DBG_VARS in (x));
}

