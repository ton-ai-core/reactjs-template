type InstallOpts = {
  network?: boolean;
  messages?: boolean;
};

type Fn<T extends unknown[] = unknown[], R = void> = (...args: T) => R;

const fmtMs = (ms: number): string => `${ms.toFixed(0)}ms`;

function installFetchTracer(): void {
  if (!('fetch' in window)) return;
  const origFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const started = performance.now();
    try {
      if (window.__stackLoggerSilence__) {
        return origFetch(input as RequestInfo, init);
      }
      const url = (input instanceof Request) ? input.url : (typeof input === 'string' || input instanceof URL) ? String(input) : (input as Request).url;
      const method = (input instanceof Request) ? (input.method || 'GET') : ((init && init.method) ? init.method : 'GET');
      let bodySample: string | undefined;
      if (init && typeof init.body === 'string') {
        bodySample = init.body.slice(0, 512);
      }
      const res = await origFetch(input as RequestInfo, init);
      const took = performance.now() - started;
      // Keep objects inspectable by passing as separate args
      console.info('HTTP fetch', { method, url, duration: fmtMs(took), status: res.status, ok: res.ok, bodySample });
      return res;
    } catch (e) {
      const took = performance.now() - started;
      console.error('HTTP fetch failed', { duration: fmtMs(took), error: e });
      throw e;
    }
  }) as typeof window.fetch;
}

function installXHRTracer(): void {
  if (!('XMLHttpRequest' in window)) return;
  const X = XMLHttpRequest.prototype;
  const methodCache = new WeakMap<XMLHttpRequest, string>();
  const urlCache = new WeakMap<XMLHttpRequest, string>();
  const startCache = new WeakMap<XMLHttpRequest, number>();

  X.open = function(this: XMLHttpRequest, method: string, url: string, async?: boolean, user?: string | null, password?: string | null): void {
    methodCache.set(this, method);
    urlCache.set(this, url);
    XMLHttpRequest.prototype.open.call(this, method, url, async ?? true, user ?? null, password ?? null);
  } as typeof X.open;

  X.send = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    startCache.set(this, performance.now());
    this.addEventListener('loadend', () => {
      if (window.__stackLoggerSilence__) return;
      const method = methodCache.get(this) ?? 'GET';
      const url = urlCache.get(this) ?? '';
      const started = startCache.get(this) ?? performance.now();
      const took = performance.now() - started;
      const bodySample = typeof body === 'string' ? body.slice(0, 512) : undefined;
      console.info('HTTP xhr', { method, url, duration: fmtMs(took), status: this.status, ok: this.status >= 200 && this.status < 300, bodySample });
    }, { once: true });
    XMLHttpRequest.prototype.send.call(this, body ?? null);
  } as typeof X.send;
}

function installMessageTracer(): void {
  // Outgoing
  const origPost = window.postMessage.bind(window) as Fn<[unknown, string, Transferable[]?], void>;
  window.postMessage = ((message: unknown, targetOrigin: string, transfer?: Transferable[]): void => {
    console.info('postMessage →', { targetOrigin, message });
    origPost(message, targetOrigin, transfer);
  }) as typeof window.postMessage;

  // Incoming
  window.addEventListener('message', (ev: MessageEvent) => {
    try {
      const origin = ev.origin;
      const data: unknown = ev.data;
      console.info('message ←', { origin, data });
    } catch {
      console.info('message ←');
    }
  });
}

export function installDevInstrumentation(opts: InstallOpts = {}): void {
  const { network = true, messages = true } = opts;
  const w = window as unknown as { __devInstrInstalled__?: boolean };
  if (w.__devInstrInstalled__) return;
  if (network) {
    installFetchTracer();
    installXHRTracer();
  }
  if (messages) installMessageTracer();
  w.__devInstrInstalled__ = true;
}

