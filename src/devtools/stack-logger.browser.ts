import { parse } from 'error-stack-parser-es/lite';
import { isDebugVars, dbg as _dbg } from '@/devtools/dbg';
import { __TRACE } from '@/trace-context';

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

// Re-export dbg for convenience (optional import in app code)
export const dbg = _dbg;

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
      // Snapshot data frames synchronously to avoid losing context across awaits
      const dataSnap = __TRACE.stack();
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

        // Merge function-frames (with args) + call-site (real location)
        const dataFrames = dataSnap as unknown as Array<{ file?: string; line?: number; col?: number; fn?: string; args?: Record<string, unknown> }>;
        const dataTailCount = (limit && limit > 0) ? Math.max(0, Math.min(Math.max(0, limit - 1), dataFrames.length)) : dataFrames.length;
        const dataTail = dataFrames.slice(-dataTailCount);

        // Fallback to prior parsed frames if no data frames are available
        let priorFrames: Array<{ file?: string; line?: number; col?: number; fn?: string; name?: string; args?: Record<string, unknown> }>;
        if (dataTail.length > 0) {
          priorFrames = dataTail.map(df => ({ file: df.file, line: df.line, col: df.col, fn: df.fn, args: df.args }));
        } else {
          let prior = windowSlice.slice(0, -1);
          if (onlyApp) {
            const only = prior.filter(f => f.file && appPattern.test(String(f.file)));
            if (only.length) prior = only;
          } else if (preferApp) {
            const pref = prior.filter(f => f.file && appPattern.test(String(f.file)));
            if (pref.length) prior = pref;
          }
          priorFrames = prior;
        }
        const combined = callSite ? [...priorFrames, callSite] : priorFrames;

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
        type CombinedFrame = { file?: string; line?: number; col?: number; fn?: string; name?: string; args?: Record<string, unknown> };
        const toUrl = (file?: string): string | undefined => {
          if (!file) return undefined;
          if (/^https?:\/\//.test(file)) return file;
          if (file.startsWith('/')) return file;
          const baseUrl = import.meta.env.BASE_URL || '/';
          return `${baseUrl}${file}`;
        };

        for (let i = 0; i < combined.length; i++) {
          const f = combined[i] as CombinedFrame;
          const showName = f.fn || f.name;
          const name = showName ? ` → ${showName}` : '';
          const header = `  ${i + 1}. ${base(f.file)}:${f.line}:${f.col}${name}`;
          if (snippet > 0) {
            // Mark internal fetch to avoid network tracer logs
            window.__stackLoggerSilence__ = true;
            const sn = await getSnippet(toUrl(f.file), f.line, snippet);
            window.__stackLoggerSilence__ = false;
            if (sn) parts.push(`${header}\n${sn}`); else parts.push(header);
          } else {
            parts.push(header);
          }
          if (f.args && Object.keys(f.args).length) {
            try { parts.push(`     Vars: ${JSON.stringify(f.args)}`); } catch { /* noop */ }
          }
        }

        let head = `${prefix} CALL STACK\n${parts.join('\n')}`;
        if (meta) {
          const appCount = filtered.filter(f => f.file && appPattern.test(String(f.file))).length;
          const debugCfg = `Config{ limit=${limit}, tail=${tail}, skip=${skip}, mapSources=${mapSources}, snippet=${snippet}, onlyApp=${onlyApp}, preferApp=${preferApp}, ascending=${ascending} }`;
          const debugMeta = `Frames{ total=${filtered.length}, app=${appCount}, used=${combined.length} }`;
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
