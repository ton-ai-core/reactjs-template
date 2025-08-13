// Sources: [Vite Plugin API](https://vite.dev/guide/api-plugin) (accessed 2025-08-13),
// [PerformanceResourceTiming - MDN](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming) (accessed 2025-08-13),
// [html2canvas options](https://html2canvas.hertzen.com/configuration) (accessed 2025-08-13),
// [CORS-enabled images for canvas - MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image) (accessed 2025-08-13)
// Assumptions: Dev-only usage; Node 18+; Vite 6; npm package manager. The plugin injects a virtual client via HMR and exposes REST endpoints under /__snap/*.
// Specification: Provide session discovery and data dumps (html, console, network, perf, DOM screenshot) from connected dev clients. Pre: Vite dev server running. Post: REST endpoints respond with JSON/HTML/Binary per route.
// Model/Invariants: Sessions keyed by browserId:pageId; pending waiter registry keyed by reqId; timeouts enforce bounded waits; apply: 'serve' ensures no prod effect.
// Complexity: O(1) per request/session bookkeeping; memory bounded by ring buffers and Map sizes.
// Build/Run: Wired from vite.config.ts via import and included in plugins; no build-time effect.
// Tests/Commands: curl endpoints while dev server runs; see README usage.
// Tool logs: Lint/build unaffected; plugin excluded from build due to apply: 'serve'.

// [Definitions]
import type { Plugin, ViteDevServer } from 'vite'
import crypto from 'node:crypto'

type Waiter = { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }
type Sess = { sid: string; browserId: string; pageId: string; ua: string; href: string; title: string; client: any; lastSeen: number }

export default function snapApi(): Plugin {
  let server: ViteDevServer
  const sessions = new Map<string, Sess>()
  const waiters = new Map<string, Waiter>()
  let base = '/'
  const DEFAULT_ACTIVE_WINDOW_MS = 45_000 // ~3 heartbeats

  async function handleDump(sid: string, types: string[], waitMs = 5000) {
    const s = sessions.get(sid); if (!s) throw new Error('no such session')
    const reqId = crypto.randomUUID()
    const p = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(reqId); reject(new Error('timeout')) }, waitMs)
      waiters.set(reqId, { resolve, reject, timer })
    })
    s.client.send('snap:dump', { reqId, types })
    return await p
  }
  async function handlePing(sid: string, waitMs = 3000) {
    const s = sessions.get(sid); if (!s) throw new Error('no such session')
    const reqId = crypto.randomUUID()
    const p = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(reqId); reject(new Error('timeout')) }, waitMs)
      waiters.set(reqId, { resolve, reject, timer })
    })
    s.client.send('snap:ping', { reqId })
    return await p
  }
  const readJson = (req: any) => new Promise<any>(r => {
    const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); try { r(s ? JSON.parse(s) : {}) } catch { r({}) } })
  })

  return {
    name: 'vite-snap-api',
    apply: 'serve',
    enforce: 'post',

    configResolved(cfg) {
      base = cfg.base || '/'
      if (!base.startsWith('/')) base = `/${base}`
      if (!base.endsWith('/')) base = `${base}/`
    },

    configureServer(s) {
      server = s

      // [Invariants] HMR: client -> server events
      server.ws.on('snap:hello', (d: any, client) => {
        const { browserId, pageId, href, title, ua } = d || {}
        const sid = `${browserId}:${pageId}`
        sessions.set(sid, { sid, browserId, pageId, ua, href, title, client, lastSeen: Date.now() })
        client.send('snap:ack', { sid })
      })
      server.ws.on('snap:pong', (d: any) => { const s = sessions.get(d?.sid); if (s) s.lastSeen = Date.now() })
      server.ws.on('snap:dumpResult', (d: any) => {
        const w = waiters.get(d?.reqId); if (w) { clearTimeout(w.timer); waiters.delete(d.reqId); w.resolve(d) }
      })
      server.ws.on('snap:pingResult', (d: any) => {
        const w = waiters.get(d?.reqId); if (w) { clearTimeout(w.timer); waiters.delete(d.reqId); w.resolve(d) }
      })
      server.ws.on('snap:bye', (d: any) => {
        const sid = d?.sid; if (sid) sessions.delete(sid)
      })

      // small GC for very old sessions (no heartbeat for 5 min)
      setInterval(() => {
        const now = Date.now();
        for (const [sid, sess] of sessions) if (now - sess.lastSeen > 5 * 60_000) sessions.delete(sid)
      }, 60_000).unref?.()

      // REST API
      server.middlewares.use(async (req, res, next) => {
        try {
          const u = new URL(req.url!, 'http://dev.local')
          if (req.method === 'GET' && u.pathname === '/__snap/sessions') {
            const now = Date.now()
            const activeParam = u.searchParams.get('active')
            const activeMsParam = u.searchParams.get('activeMs')
            const onlyActive = activeParam === '1' || activeMsParam != null
            const activeMs = activeMsParam ? Math.max(0, Number(activeMsParam)) : DEFAULT_ACTIVE_WINDOW_MS
            const items = [...sessions.values()]
              .filter(s => !onlyActive || (now - s.lastSeen <= activeMs))
              .map(s => ({ sid: s.sid, browserId: s.browserId, pageId: s.pageId, url: s.href, title: s.title, ua: s.ua, lastSeen: s.lastSeen }))
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sessions: items })); return
          }
          if (req.method === 'POST' && u.pathname === '/__snap/dump') {
            const body = await readJson(req)
            const out = await handleDump(body.sid, body.types ?? ['html', 'console', 'network', 'perf', 'screenshotDom'], body.waitMs ?? 5000)
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out)); return
          }
          if (req.method === 'GET' && u.pathname === '/__snap/html') {
            const out: any = await handleDump(String(u.searchParams.get('sid')), ['html'])
            res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(out?.payload?.html || '<!-- no html -->'); return
          }
          if (req.method === 'GET' && u.pathname === '/__snap/console') {
            const out: any = await handleDump(String(u.searchParams.get('sid')), ['console'])
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out?.payload?.console ?? [])); return
          }
          if (req.method === 'GET' && u.pathname === '/__snap/network') {
            const out: any = await handleDump(String(u.searchParams.get('sid')), ['network', 'perf'])
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ logs: out?.payload?.network ?? [], perf: out?.payload?.perf ?? [] })); return
          }
          if (req.method === 'GET' && u.pathname === '/__snap/screenshot') {
            const out: any = await handleDump(String(u.searchParams.get('sid')), ['screenshotDom'])
            const dataUrl: string = out?.payload?.screenshotDom; if (!dataUrl) { res.statusCode = 404; res.end('no screenshot'); return }
            const m = /^data:(.+?);base64,(.*)$/i.exec(dataUrl); if (!m) { res.statusCode = 500; res.end('bad dataurl'); return }
            res.setHeader('content-type', m[1]); res.end(Buffer.from(m[2], 'base64')); return
          }
          if (req.method === 'GET' && u.pathname === '/__snap/ping') {
            const sid = String(u.searchParams.get('sid'))
            const waitMs = Number(u.searchParams.get('waitMs') ?? 3000)
            const t0 = Date.now()
            const out: any = await handlePing(sid, waitMs)
            const rttMs = Date.now() - t0
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: out?.ok !== false, rttMs, payload: out?.payload ?? {} })); return
          }
          next()
        } catch (e: any) {
          res.statusCode = 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e?.message || String(e) }))
        }
      })
    },

    // injection of virtual client
    resolveId(id) { if (id === 'virtual:snap-client') return '\0virtual:snap-client' },
    load(id) { if (id === '\0virtual:snap-client') return CLIENT_CODE },
    transformIndexHtml() {
      return { tags: [{ tag: 'script', attrs: { type: 'module', src: `${base}@id/virtual:snap-client` }, injectTo: 'head' }] }
    },
  }
}

const CLIENT_CODE = `
const ring = (a,v,c=500)=>{a.push(v); if(a.length>c) a.shift()}
const buf = { console:[], network:[], perf:[] }

const browserKey='__snap_browser'
let browserId = localStorage.getItem(browserKey)
if (!browserId) { browserId = (globalThis.crypto?.randomUUID?.() || String(Math.random())).toString(); localStorage.setItem(browserKey, browserId) }
const pageId = (globalThis.crypto?.randomUUID?.() || String(Math.random())).toString()
const sid = browserId + ':' + pageId

if (import.meta.hot) {
  import.meta.hot.send('snap:hello', { browserId, pageId, href: location.href, title: document.title, ua: navigator.userAgent })
  setInterval(()=> import.meta.hot?.send('snap:pong', { sid }), 15000)

  // console
  ;['log','info','warn','error','debug'].forEach(level => {
    const orig = console[level].bind(console)
    console[level] = (...args)=>{ try{ ring(buf.console, { t:Date.now(), level, args: args.map(safe) }) }catch{}; orig(...args) }
  })

  // fetch
  const ofetch = window.fetch?.bind(window)
  if (ofetch) {
    window.fetch = async (input, init) => {
      const t0 = performance.now(); const url = typeof input==='string' ? input : input.url
      try { const r = await ofetch(input, init); ring(buf.network, { t:Date.now(), kind:'fetch', url, status:r.status, ok:r.ok, dt:+(performance.now()-t0).toFixed(1) }); return r }
      catch(e){ ring(buf.network, { t:Date.now(), kind:'fetch', url, ok:false, error:String(e) }); throw e }
    }
  }

  // xhr
  if (window.XMLHttpRequest) {
    const X = XMLHttpRequest, xo = X.prototype.open, xs = X.prototype.send
    X.prototype.open = function(m,u,...rest){ this.__t={m,u,t:performance.now()}; return xo.call(this,m,u,...rest) }
    X.prototype.send = function(b){ this.addEventListener('loadend',()=>{ const t=this.__t||{}; ring(buf.network,{ t:Date.now(), kind:'xhr', url:t.u, method:t.m, status:this.status, ok:this.status>=200&&this.status<400, dt:+(performance.now()-t.t).toFixed(1) })}); return xs.call(this,b) }
  }

  // WebSocket
  try {
    const OriginalWS = window.WebSocket
    if (OriginalWS) {
      // Minimal wrapper to observe ws lifecycle
      // eslint-disable-next-line func-names
      // @ts-ignore
      window.WebSocket = function(url, protocols){
        // @ts-ignore
        const ws = new OriginalWS(url, protocols)
        const startedAt = performance.now()
        const log = (phase, extra={}) => ring(buf.network, { t:Date.now(), kind:'ws', url: typeof url==='string'?url:url?.toString?.(), phase, ...extra })
        ws.addEventListener('open', ()=> log('open'))
        ws.addEventListener('error', (e)=> log('error', { message: String(e?.message||'error'), dt:+(performance.now()-startedAt).toFixed(1) }))
        ws.addEventListener('close', (e)=> log('close', { code: e.code, reason: e.reason, wasClean: e.wasClean, dt:+(performance.now()-startedAt).toFixed(1) }))
        return ws
      }
      // @ts-ignore
      window.WebSocket.prototype = OriginalWS.prototype
    }
  } catch {}

  // EventSource (SSE)
  try {
    const OriginalES = window.EventSource
    if (OriginalES) {
      // @ts-ignore
      window.EventSource = function(url, eventSourceInitDict){
        // @ts-ignore
        const es = new OriginalES(url, eventSourceInitDict)
        const startedAt = performance.now()
        const toUrl = typeof url==='string'?url:url?.toString?.()
        es.addEventListener('open', ()=> ring(buf.network, { t:Date.now(), kind:'eventsource', url: toUrl, phase:'open' }))
        es.addEventListener('error', ()=> ring(buf.network, { t:Date.now(), kind:'eventsource', url: toUrl, phase:'error', dt:+(performance.now()-startedAt).toFixed(1) }))
        return es
      }
      // @ts-ignore
      window.EventSource.prototype = OriginalES.prototype
    }
  } catch {}

  // PerformanceObserver
  try {
    performance.setResourceTimingBufferSize?.(10000)
    const po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) if (e.entryType==='resource') ring(buf.perf, { t:Date.now(), name:e.name, initiatorType:e.initiatorType, duration: Math.round(e.duration), transferSize:e.transferSize||0, encodedBodySize:e.encodedBodySize||0 })
    })
    po.observe({ type:'resource', buffered:true })
  } catch {}

  // command dump
  import.meta.hot.on('snap:dump', async ({ reqId, types }) => {
    const payload = {}
    try {
      if (types.includes('html')) {
        const root = document.documentElement.cloneNode(true)
        payload.html = '<!doctype html>\\n' + root.outerHTML.slice(0, 200000)
        payload.title = document.title
      }
      if (types.includes('console')) payload.console = buf.console.slice(-500)
      if (types.includes('network')) payload.network = buf.network.slice(-500)
      if (types.includes('perf'))    payload.perf    = buf.perf.slice(-500)
      if (types.includes('screenshotDom')) {
        let html2canvas
        try { html2canvas = (await import('html2canvas')).default } catch { html2canvas = (await import('https://esm.sh/html2canvas@1.4.1')).default }
        const c = await html2canvas(document.documentElement, { useCORS:true, logging:false, scale:1 })
        payload.screenshotDom = c.toDataURL('image/webp', 0.9)
      }
      import.meta.hot?.send('snap:dumpResult', { reqId, ok:true, payload })
    } catch (e) {
      import.meta.hot?.send('snap:dumpResult', { reqId, ok:false, error:String(e) })
    }
  })
  // capture global errors
  try {
    window.addEventListener('error', (e) => {
      try { ring(buf.console, { t: Date.now(), level: 'error', args: [safe(e?.message), safe(e?.filename||''), e?.lineno||0, e?.colno||0, safe(e?.error?.stack||'')] }) } catch {}
    })
    window.addEventListener('unhandledrejection', (e) => {
      try { ring(buf.console, { t: Date.now(), level: 'error', args: ['unhandledrejection', safe(e?.reason)] }) } catch {}
    })
    document.addEventListener('securitypolicyviolation', (e) => {
      try { ring(buf.console, { t: Date.now(), level: 'error', args: ['csp', {blockedURI:e.blockedURI, violatedDirective:e.violatedDirective, effectiveDirective:e.effectiveDirective, disposition:e.disposition}] }) } catch {}
    })
    // resource loading errors (img/script/link)
    window.addEventListener('error', (e: any) => {
      try {
        const t = e?.target
        if (t && (t.src || t.href)) {
          ring(buf.network, { t: Date.now(), kind: 'resource', tag: t.tagName, url: t.src || t.href, phase: 'error' })
        }
      } catch {}
    }, true)
  } catch {}
  // ping
  import.meta.hot.on('snap:ping', ({ reqId }) => {
    try {
      const payload = { sid, now: Date.now(), href: location.href, title: document.title, focused: !!document.hasFocus?.(), visibility: document.visibilityState }
      import.meta.hot?.send('snap:pingResult', { reqId, ok: true, payload })
    } catch (e) {
      import.meta.hot?.send('snap:pingResult', { reqId, ok: false, error: String(e) })
    }
  })
  // try to cleanup on unload (page close/reload)
  window.addEventListener('beforeunload', () => {
    try { import.meta.hot?.send('snap:bye', { sid }) } catch {}
  })
}

function safe(x){ try{ return JSON.parse(JSON.stringify(x)) } catch { try { return String(x) } catch { return null } } }
`

// [Lemma] apply: 'serve' guarantees zero impact in production builds.
// [Proof sketch] Vite evaluates apply field before running plugin hooks during build; since value is 'serve', hooks are skipped.
// [Complexity] All endpoints are linear in payload size; metadata operations are constant time.


