export type AnyFunc<TArgs extends unknown[] = unknown[], TRet = unknown> = (...args: TArgs) => TRet;

export function trace<TArgs extends unknown[], TRet>(fn: (...args: TArgs) => TRet, label?: string) {
  const name = label || fn.name || '<anon>';
  return function traced(this: unknown, ...args: TArgs): TRet {
    const t0 = performance.now();
    try {
      const res = fn.apply(this, args);
      if (res && typeof (res as unknown as Promise<unknown>).then === 'function') {
        return (res as unknown as Promise<unknown>).then((val) => {
          const ms = performance.now() - t0;
          console.info('▶ trace', { fn: name, ms: Math.round(ms), args, result: val });
          return val as TRet;
        }) as unknown as TRet;
      }
      const ms = performance.now() - t0;
      console.info('▶ trace', { fn: name, ms: Math.round(ms), args, result: res });
      return res;
    } catch (e) {
      const ms = performance.now() - t0;
      console.error('▶ trace error', { fn: name, ms: Math.round(ms), args, error: e });
      throw e;
    }
  };
}

