import { parse } from 'error-stack-parser-es/lite';

const base = (p?: string): string => (p ? p.split(/[\\/]/).pop()! : '<anonymous>');

type Opts = {
  prefix?: string;
  skip?: number;
  limit?: number;
  tail?: boolean;
  mapSources?: boolean;
  snippet?: number;
  onlyApp?: boolean;
  preferApp?: boolean;
  appPattern?: RegExp;
  meta?: boolean; // print Config/Frames diagnostics
  ascending?: boolean; // print root -> call-site (last)
};
type LogFn = (...args: unknown[]) => void;
type ParsedFrame = { file?: string; line?: number; col?: number; name?: string };
type MappedFrame = { file?: string; line?: number; col?: number; name?: string };

const srcCache = new Map<string, string[]>();
const stripQuery = (u: string): string => u.split('?')[0];

// Debug variables helper: let users pass structured vars alongside logs
const DBG_VARS = Symbol('stackLogger.vars');
type DebugVarsObject = { [DBG_VARS]: true; vars: Record<string, unknown> };
function isDebugVars(x: unknown): x is DebugVarsObject {
  return typeof x === 'object' && x !== null && (DBG_VARS in (x));
}
export function dbg(vars: Record<string, unknown>): DebugVarsObject {
  return { [DBG_VARS]: true, vars } as DebugVarsObject;
}

async function mapFramesToTS(mapSources: boolean, err: Error): Promise<MappedFrame[]> {
  if (!mapSources) {
    const frames = parse(err) as unknown as ParsedFrame[];
    return frames.map(f => ({ file: f.file, line: f.line, col: f.col, name: f.name }));
  }
  try {
    const mod = await import('stacktrace-js');
    const StackTrace = (mod as unknown as { default: { fromError(e: Error): Promise<unknown[]> } }).default;
    const sframes = await StackTrace.fromError(err);
    return (sframes).map((f: unknown) => {
      const r = f as { fileName?: string; lineNumber?: number; columnNumber?: number; functionName?: string };
      return { file: r.fileName, line: r.lineNumber, col: r.columnNumber, name: r.functionName };
    });
  } catch {
    const frames = parse(err) as unknown as ParsedFrame[];
    return frames.map(f => ({ file: f.file, line: f.line, col: f.col, name: f.name }));
  }
}

async function getSnippet(file?: string, line?: number, contextLines = 1): Promise<string | null> {
  if (!file || !line || contextLines <= 0) return null;
  try {
    const key = stripQuery(file);
    let lines = srcCache.get(key);
    if (!lines) {
      const res = await fetch(file);
      if (!res.ok) return null;
      const text = await res.text();
      lines = text.split(/\r?\n/);
      srcCache.set(key, lines);
    }
    const idx = Math.max(0, line - 1);
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length, idx + contextLines + 1);
    const view = lines.slice(start, end);
    return view
      .map((ln, i) => {
        const no = start + i + 1;
        const mark = no === line ? '>' : ' ';
        return `      ${mark} ${no} ${ln}`;
      })
      .join('\n');
  } catch {
    return null;
  }
}

export function installStackLogger({
  prefix = '📞',
  skip = 2,
  limit = 1,
  tail = false,
  mapSources = true,
  snippet = 0,
  onlyApp = false,
  preferApp = true,
  appPattern = /(?:^|\/)src\//,
  meta = false,
  ascending = true,
}: Opts = {}): void {
  const methods: (keyof Console)[] = ['log', 'info', 'warn', 'error', 'debug'];
  const orig: Partial<Record<keyof Console, LogFn>> = {};
  const E = Error as unknown as { stackTraceLimit?: number };
  E.stackTraceLimit = (limit && limit > 0)
    ? Math.max(E.stackTraceLimit ?? 10, skip + limit + 10)
    : Infinity; // full stack when limit <= 0
  for (const m of methods) {
    orig[m] = console[m] as unknown as LogFn;
    console[m] = (...args: unknown[]): void => {
      const captured = new Error();
      void (async (): Promise<void> => {
        const frames = await mapFramesToTS(mapSources, captured);
        const internalRe = /stack-logger\.browser\.ts|dev-instrumentation\.ts/;
        const filtered = frames.filter(f => f.file && !internalRe.test(String(f.file)));
        // Order root -> call-site so the last is always the call site
        const orderedBase = ascending ? filtered.slice().reverse() : filtered.slice();
        const total = orderedBase.length;
        const effLimit = (limit && limit > 0) ? limit : total;
        const safeSkip = Math.max(0, Math.min(skip, Math.max(0, total - 1)));
        const effectiveEnd = Math.max(1, total - safeSkip); // end is exclusive; last element is call-site
        const start = Math.max(0, effectiveEnd - effLimit);
        const windowSlice = orderedBase.slice(start, effectiveEnd);
        const callSite = windowSlice[windowSlice.length - 1];
        let prior = windowSlice.slice(0, -1);
        // Prefer/limit app frames only among prior frames; always keep call-site last
        if (onlyApp) {
          const only = prior.filter(f => f.file && appPattern.test(String(f.file)));
          if (only.length) prior = only;
        } else if (preferApp) {
          const pref = prior.filter(f => f.file && appPattern.test(String(f.file)));
          if (pref.length) prior = pref;
        }
        const slice = callSite ? [...prior, callSite] : prior;

        const parts: string[] = [];
        const debugVars: Record<string, unknown>[] = [];

        // Extract and remove debug vars wrappers from args to print them nicely later
        const plainArgs = (args).filter(a => {
          if (isDebugVars(a)) {
            debugVars.push((a).vars);
            return false;
          }
          return true;
        });
        for (let i = 0; i < slice.length; i++) {
          const f = slice[i];
          const name = f.name ? ` → ${f.name}` : '';
          const header = `  ${i + 1}. ${base(f.file)}:${f.line}:${f.col}${name}`;
          if (snippet > 0) {
            // Mark internal fetch to avoid network tracer logs
            window.__stackLoggerSilence__ = true;
            const sn = await getSnippet(f.file, f.line, snippet);
            window.__stackLoggerSilence__ = false;
            if (sn) parts.push(`${header}\n${sn}`); else parts.push(header);
          } else {
            parts.push(header);
          }
        }

        let head = `${prefix} CALL STACK\n${parts.join('\n')}`;
        if (meta) {
          const appCount = filtered.filter(f => f.file && appPattern.test(String(f.file))).length;
          const debugCfg = `Config{ limit=${limit}, tail=${tail}, skip=${skip}, mapSources=${mapSources}, snippet=${snippet}, onlyApp=${onlyApp}, preferApp=${preferApp}, ascending=${ascending} }`;
          const debugMeta = `Frames{ total=${filtered.length}, app=${appCount}, used=${slice.length} }`;
          head += `\n\n${debugCfg} ${debugMeta}`;
        }
        if (typeof plainArgs[0] === 'string') {
          const first = `${head}\n\nMessage Log: ${plainArgs[0]}`;
          const rest = (plainArgs).slice(1) as [];
          // Append debug vars after original arg list to keep % tokens mapping
          if (debugVars.length) {
            orig[m]!.call(console, first, ...rest, '\nVars:', ...debugVars as []);
          } else {
            orig[m]!.call(console, first, ...rest);
          }
        } else {
          if (debugVars.length) {
            orig[m]!.call(console, `${head}\n\nMessage Log:`, ...plainArgs as [], '\nVars:', ...debugVars as []);
          } else {
            orig[m]!.call(console, `${head}\n\nMessage Log:`, ...plainArgs as []);
          }
        }
      })();
    };
  }
}

