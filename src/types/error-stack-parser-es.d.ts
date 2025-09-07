declare module 'error-stack-parser-es/lite' {
  export type ParsedFrame = {
    file?: string;
    line?: number;
    col?: number;
    name?: string;
  };
  export function parse(err: unknown): ParsedFrame[];
}
