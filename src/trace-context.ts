// Optional: if global Zone is present (e.g., via 'zone.js'), we will use it for async propagation.
// We intentionally do not import 'zone.js' here to avoid side effects unless project opts in.

export type Frame = { fn: string; file: string; line: number; col: number; args: Record<string, unknown> };

// Use Zone if available; otherwise, fall back to a local stack (no async propagation)
type ZoneGlobal = { Zone?: { current?: object } };
const localStack: Frame[] = [];
const zoneStacks = new WeakMap<object, Frame[]>();

function getCurrentZone(): object | undefined {
  // Access via globalThis to avoid ReferenceError if Zone is not declared
  const Z = (globalThis as unknown as ZoneGlobal).Zone;
  if (Z && typeof Z === 'object' && 'current' in Z) {
    const cur = (Z as { current?: object }).current;
    return cur;
  }
  return undefined;
}

function stackOfCurrent(): Frame[] {
  const z = getCurrentZone();
  if (!z) return localStack;
  let s = zoneStacks.get(z);
  if (!s) { s = []; zoneStacks.set(z, s); }
  return s;
}

export const __TRACE = {
  enter(frame: Frame): Frame {
    try { stackOfCurrent().push(frame); } catch { /* noop */ }
    return frame;
  },
  leave(_frame: Frame): void {
    try {
      const s = stackOfCurrent();
      if (s.length) s.pop();
    } catch { /* noop */ }
  },
  stack(): Frame[] {
    try { return stackOfCurrent().slice(); } catch { return []; }
  },
};
