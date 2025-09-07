export {};

declare global {
  interface Window {
    __stackLoggerSilence__?: boolean;
  }
}

