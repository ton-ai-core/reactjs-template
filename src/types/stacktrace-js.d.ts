declare module 'stacktrace-js' {
  export type StackFrame = {
    fileName?: string;
    lineNumber?: number;
    columnNumber?: number;
    functionName?: string;
  };
  const StackTrace: {
    fromError(error: Error, opts?: unknown): Promise<StackFrame[]>;
    get(opts?: unknown): Promise<StackFrame[]>;
  };
  export default StackTrace;
}

