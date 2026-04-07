import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI } from '@google/genai';
import './index.css';

// Types
type LogKind = 'SYS' | 'RX' | 'TX' | 'ERR';
type Status  = 'idle' | 'connecting' | 'authenticating' | 'live';

interface Log { id: number; ts: string; kind: LogKind; msg: string; meta?: string; }
interface Cfg { url: string; token: string; }
interface Stats { reqs: number; errs: number; latency: number; connAt: number | null; }

// Storage
const KEY = 'gemgate_cfg';
let seq = 0;

function load(): Cfg | null {
  try { const c = JSON.parse(localStorage.getItem(KEY) || ''); return c?.url && c?.token ? c : null; } catch { return null; }
}
function save(c: Cfg) { localStorage.setItem(KEY, JSON.stringify(c)); }
function clear() { localStorage.removeItem(KEY); }

// Signature Cache
// Gemini 3.x models return `thoughtSignature` on function call parts.
// OpenAI format lacks this field, so we cache them keyed by tool_call_id and re-inject them when the client replays the conversation history.
const MAX_SIGS = 500;
const sigs = new Map<string, string>();

function normId(id: string) { return id.replace(/[^a-zA-Z0-9]/g, ''); }
function putSig(id: string, v: string) { sigs.set(normId(id), v); if (sigs.size > MAX_SIGS) sigs.delete(sigs.keys().next().value!); }
function getSig(id: string) { return sigs.get(normId(id)); }

// Protocol: OpenAI → Gemini
function toContents(messages: any[]): any[] {
  if (!Array.isArray(messages)) return [];
  const out: any[] = [];

  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = [];

    if (typeof m.content === 'string' && m.content.length > 0) {
      parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text' && p.text) parts.push({ text: p.text });
        else if (p.type === 'image_url') {
          const u = p.image_url?.url || '';
          if (u.startsWith('data:')) { const x = u.match(/^data:([^;]+);base64,(.+)$/); if (x) parts.push({ inlineData: { mimeType: x[1], data: x[2] } }); }
        }
        else if (p.type === 'input_audio') parts.push({ inlineData: { mimeType: `audio/${p.input_audio?.format || 'wav'}`, data: p.input_audio?.data || '' } });
      }
    }

    if (m.tool_calls) {
      let allHaveSigs = true;
      for (const tc of m.tool_calls) {
        if (!getSig(tc.id)) { allHaveSigs = false; break; }
      }

      if (allHaveSigs) {
        // All signatures cached — use proper functionCall parts
        for (const tc of m.tool_calls) {
          let args: any = {};
          try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); } catch {}
          parts.push({ functionCall: { name: tc.function?.name, args }, thoughtSignature: getSig(tc.id) });
        }
      } else {
        // Missing signatures — fall back to text representation
        // This happens when replaying history from a previous session or external source
        const calls = m.tool_calls.map((tc: any) => `${tc.function?.name}(${tc.function?.arguments || '{}'})`).join(', ');
        parts.push({ text: `[Called: ${calls}]` });
      }
    }

    if (m.role === 'tool') {
      // Check if the corresponding tool call had a signature
      const hasSig = m.tool_call_id && getSig(m.tool_call_id);
      if (hasSig) {
        let data: any;
        try { data = typeof m.content === 'string' ? JSON.parse(m.content) : m.content; } catch { data = { result: m.content }; }
        out.push({ role: 'user', parts: [{ functionResponse: { name: m.name || m.tool_call_id || 'unknown', response: data } }] });
      } else {
        // No signature — convert to text
        out.push({ role: 'user', parts: [{ text: `[Result from ${m.name || 'tool'}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}` }] });
      }
      continue;
    }

    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

function toSystem(messages: any[]): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const t = messages.filter((m: any) => m.role === 'system').map((m: any) => typeof m.content === 'string' ? m.content : '').filter(Boolean);
  return t.length > 0 ? t.join('\n\n') : undefined;
}

const SCHEMA_OK = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'nullable', 'format']);

function cleanSchema(s: any, props = false): any {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map((x: any) => cleanSchema(x));
  const o: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (props) o[k] = cleanSchema(v);
    else if (SCHEMA_OK.has(k)) o[k] = k === 'properties' ? cleanSchema(v, true) : cleanSchema(v);
  }
  return o;
}

function toTools(tools: any[]): any[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const r = tools.filter((t: any) => t.type === 'function' && t.function?.name).map((t: any) => {
    const d: any = { name: t.function.name };
    if (t.function.description) d.description = t.function.description;
    if (t.function.parameters && Object.keys(t.function.parameters).length) d.parameters = cleanSchema(t.function.parameters);
    return d;
  });
  return r.length ? r : undefined;
}

// Protocol: Gemini → OpenAI
function finishReason(r?: string) {
  if (r === 'STOP') return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION') return 'content_filter';
  return 'stop';
}

function extractCalls(parts: any[], rid: string) {
  return parts.filter((p: any) => p.functionCall).map((p: any, i: number) => {
    const id = `call_${rid.slice(4, 16)}_${i}`;
    const sig = p.thoughtSignature || p.thought_signature;
    if (sig) putSig(id, sig);
    return { id, type: 'function' as const, function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } };
  });
}

function toResponse(result: any, model: string, rid: string) {
  const parts = result?.candidates?.[0]?.content?.parts || [];
  const calls = extractCalls(parts, rid);
  const text  = parts.filter((p: any) => p.text != null).map((p: any) => p.text).join('') || null;
  const u     = result?.usageMetadata;
  return {
    id: `chatcmpl-${rid}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: calls.length ? null : text, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : finishReason(result?.candidates?.[0]?.finishReason) }],
    ...(u ? { usage: { prompt_tokens: u.promptTokenCount || 0, completion_tokens: u.candidatesTokenCount || 0, total_tokens: u.totalTokenCount || 0 } } : {}),
  };
}

function toDelta(chunk: any, model: string, rid: string, idx: number) {
  const parts = chunk?.candidates?.[0]?.content?.parts || [];
  const text  = parts.map((p: any) => p.text || '').join('');
  const calls = parts.filter((p: any) => p.functionCall);
  const delta: any = {};
  if (idx === 0) delta.role = 'assistant';
  if (text) delta.content = text;
  if (calls.length) {
    delta.tool_calls = calls.map((p: any, i: number) => {
      const id = `call_${rid.slice(4, 16)}_${i}`;
      const sig = p.thoughtSignature || p.thought_signature;
      if (sig) putSig(id, sig);
      return { index: i, id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } };
    });
  }
  return { id: `chatcmpl-${rid}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: chunk?.candidates?.[0]?.finishReason ? finishReason(chunk.candidates[0].finishReason) : null }] };
}

function toEmbedding(result: any, model: string) {
  const v = result?.embedding?.values || result?.embeddings?.[0]?.values || [];
  return { object: 'list', data: [{ object: 'embedding', index: 0, embedding: v }], model, usage: { prompt_tokens: 0, total_tokens: 0 } };
}

// Processor
function useProcessor(cfg: Cfg | null) {
  const [status, setStatus] = useState<Status>('idle');
  const [logs, setLogs]     = useState<Log[]>([]);
  const [stats, setStats]   = useState<Stats>({ reqs: 0, errs: 0, latency: 0, connAt: null });
  const ws    = useRef<WebSocket | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = useRef(1000);

  const log = useCallback((kind: LogKind, msg: string, meta?: string) => {
    setLogs((prev: Log[]) => [{ id: ++seq, ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), kind, msg, meta }, ...prev].slice(0, 300));
  }, []);

  const process = useCallback(async (socket: WebSocket, m: any) => {
    const { requestId, payload, stream } = m;
    const t0 = performance.now();
    setStats((s: Stats) => ({ ...s, reqs: s.reqs + 1 }));

    const raw   = payload.model || 'gemini-flash-latest';
    const model = raw.replace(/^(google|models|openai)\//i, '');
    log('RX', model, stream ? 'stream' : 'sync');

    try {
      const ai = new GoogleGenAI({ apiKey: 'demo' });

      if (payload._endpoint === 'embeddings') {
        const input = typeof payload.input === 'string' ? payload.input : payload.input?.[0] || '';
        const r = await ai.models.embedContent({ model, contents: [{ role: 'user', parts: [{ text: input }] }] });
        socket.send(JSON.stringify({ type: 'processor_response', requestId, data: toEmbedding(r, model) }));
        log('TX', 'embedding', `${Math.round(performance.now() - t0)}ms`);
        return;
      }

      const sys      = toSystem(payload.messages);
      const contents = toContents(payload.messages);
      const tools    = toTools(payload.tools);
      if (!contents.length) throw { status: 400, message: 'No valid messages' };

      const c: any = {};
      if (sys) c.systemInstruction = sys;
      if (payload.max_tokens) c.maxOutputTokens = payload.max_tokens;
      if (payload.max_completion_tokens) c.maxOutputTokens = payload.max_completion_tokens;
      if (payload.temperature !== undefined) c.temperature = payload.temperature;
      if (payload.top_p !== undefined) c.topP = payload.top_p;
      if (payload.stop) { const s = (Array.isArray(payload.stop) ? payload.stop : [payload.stop]).filter((x: any) => typeof x === 'string' && x); if (s.length) c.stopSequences = s; }
      if (payload.response_format?.type === 'json_object') c.responseMimeType = 'application/json';
      if (payload.response_format?.json_schema) { c.responseMimeType = 'application/json'; c.responseSchema = payload.response_format.json_schema.schema; }
      if (payload.reasoning_effort) { const b: Record<string, number> = { none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576 }; c.thinkingConfig = { thinkingBudget: b[payload.reasoning_effort] ?? 8192 }; }
      if (tools?.length) {
        c.tools = [{ functionDeclarations: tools }];
        const tc = payload.tool_choice;
        if (tc === 'none') c.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        else if (tc === 'auto') c.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        else if (tc === 'required') c.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        else if (typeof tc === 'object' && tc?.function?.name) c.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } };
      }

      if (stream) {
        const r = await ai.models.generateContentStream({ model, contents, config: c });
        let i = 0;
        for await (const chunk of r) { socket.send(JSON.stringify({ type: 'processor_chunk', requestId, chunk: toDelta(chunk, model, requestId, i), isComplete: false })); i++; }
        socket.send(JSON.stringify({ type: 'processor_chunk', requestId, chunk: { id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, isComplete: true }));
        const ms = Math.round(performance.now() - t0);
        setStats((s: Stats) => ({ ...s, latency: s.latency + ms }));
        log('TX', model, `${i} chunks · ${ms}ms`);
      } else {
        const r = await ai.models.generateContent({ model, contents, config: c });
        socket.send(JSON.stringify({ type: 'processor_response', requestId, data: toResponse(r, model, requestId) }));
        const ms = Math.round(performance.now() - t0);
        setStats((s: Stats) => ({ ...s, latency: s.latency + ms }));
        log('TX', model, `${ms}ms`);
      }
    } catch (e: any) {
      setStats((s: Stats) => ({ ...s, errs: s.errs + 1 }));
      log('ERR', `${e.status || e.code || '?'}: ${e.message || 'Failed'}`);
      try { socket.send(JSON.stringify({ type: 'error', requestId, code: String(e.status || e.code || 'UNKNOWN'), message: e.message || 'Failed', httpStatus: typeof e.status === 'number' ? e.status : 500 })); } catch {}
    }
  }, [log]);

  const connect = useCallback(() => {
    if (ws.current || !cfg) return;

    // Validate URL before attempting connection
    let parsed: URL;
    try {
      parsed = new URL(cfg.url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('bad protocol');
    } catch {
      log('ERR', `Invalid WebSocket URL: ${cfg.url}`);
      setStatus('idle');
      return;
    }

    if (!cfg.token) {
      log('ERR', 'Invalid processor token');
      setStatus('idle');
      return;
    }

    setStatus('connecting');
    log('SYS', `Connecting to ${parsed.host}…`);

    let s: WebSocket;
    try {
      s = new WebSocket(cfg.url);
    } catch (e: any) {
      log('ERR', `WebSocket failed: ${e.message}`);
      setStatus('idle');
      return;
    }
    ws.current = s;

    s.onopen = () => { setStatus('authenticating'); log('SYS', 'Authenticating…'); s.send(JSON.stringify({ type: 'register_processor', token: cfg.token })); };
    s.onmessage = async (e: MessageEvent) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') return;
      if (m.type === 'ping') return s.send(JSON.stringify({ type: 'pong' }));
      if (m.type === 'registered') { setLogs([]); setStatus('live'); delay.current = 1000; setStats((prev: Stats) => ({ ...prev, connAt: Date.now() })); log('SYS', 'Connected', `session ${m.sessionKey.slice(0, 8)}`); return; }
      if (m.type === 'process_request') {
        process(s, m).catch((err: any) => {
          log('ERR', err?.message || 'Unhandled');
          try { s.send(JSON.stringify({ type: 'error', requestId: m.requestId, code: 'INTERNAL', message: err?.message || 'Unhandled', httpStatus: 500 })); } catch {}
        });
      }
    };
    s.onclose = (e: CloseEvent) => {
      setStatus('idle'); ws.current = null;
      setStats((prev: Stats) => ({ ...prev, connAt: null }));

      // Don't retry if the server rejected our token
      if (e.reason === 'Bad token' || e.code === 1008) {
        log('ERR', 'Rejected: invalid processor token. Check your credentials.');
        return;
      }

      const d = Math.min(delay.current, 30000);
      log('SYS', `Disconnected: ${e.reason || e.code}`, `retry ${d / 1000}s`);
      retry.current = setTimeout(connect, d);
      delay.current = Math.min(delay.current * 2, 30000);
    };
    s.onerror = () => s.close();
  }, [cfg, log, process]);

  useEffect(() => {
    connect();
    return () => {
      if (retry.current) clearTimeout(retry.current);
      if (ws.current) {
        // Detach handlers before closing to prevent stale onclose from firing a retry
        ws.current.onclose = null;
        ws.current.onerror = null;
        ws.current.close();
        ws.current = null;
      }
    };
  }, [connect]);
  useEffect(() => { const iv = setInterval(() => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'ping' })); }, 25_000); return () => clearInterval(iv); }, []);

  return { status, logs, stats, clear: () => setLogs([]) };
}

// Uptime
function useUptime(at: number | null) {
  const [, tick] = useState(0);
  useEffect(() => { if (!at) return; const iv = setInterval(() => tick((n: number) => n + 1), 1000); return () => clearInterval(iv); }, [at]);
  if (!at) return '—';
  const s = Math.floor((Date.now() - at) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// UI
const DOT: Record<Status, string> = { idle: 'bg-zinc-500', connecting: 'bg-amber-400 animate-pulse', authenticating: 'bg-blue-400 animate-pulse', live: 'bg-emerald-400' };
const TAG: Record<Status, string> = { idle: 'Idle', connecting: 'Connecting', authenticating: 'Authenticating', live: 'Live' };
const BADGE: Record<LogKind, string> = { SYS: 'text-zinc-500', RX: 'text-blue-400', TX: 'text-emerald-400', ERR: 'text-red-400' };

const DEFAULT_URL = 'ws://localhost:3777';

function Setup({ onConnect, status }: { onConnect: (c: Cfg) => void; status?: Status }) {
  const s = load();
  const [url, setUrl]     = useState(s?.url || '');
  const [token, setToken] = useState(s?.token || '');
  const [err, setErr]     = useState('');

  const busy = status === 'connecting' || status === 'authenticating';

  const go = () => {
    if (busy) return;
    const u = (url.trim() || DEFAULT_URL), t = token.trim();
    if (!u.startsWith('ws://') && !u.startsWith('wss://')) return setErr('Must start with ws:// or wss://');
    if (!t) return setErr('Token required');
    setUrl(u);
    save({ url: u, token: t });
    onConnect({ url: u, token: t });
  };

  return (
    <div className="min-h-screen bg-[#1F1F1F] flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <h1 className="text-white text-base font-semibold">Gemgate</h1>
          <p className="text-zinc-500 text-xs mt-1">Connect to your relay server</p>
        </div>

        <div className="bg-[#2A2A2A] rounded-xl p-5 space-y-3 border border-zinc-800/60">
          <Field label="WebSocket URL" value={url} onChange={(v: string) => { setUrl(v); setErr(''); }} onEnter={go} placeholder={DEFAULT_URL} />
          <Field label="Processor Token" value={token} onChange={(v: string) => { setToken(v); setErr(''); }} onEnter={go} placeholder="paste from server console" password />
          {err && <p className="text-red-400 text-xs">{err}</p>}
          {status && status !== 'idle' && (
            <div className="flex items-center gap-2 py-1">
              <span className={`w-1.5 h-1.5 rounded-full ${DOT[status]}`} />
              <span className="text-zinc-400 text-xs">{TAG[status]}…</span>
            </div>
          )}
          <button onClick={go} disabled={busy} className={`w-full py-2 text-white text-sm font-medium rounded-lg transition active:scale-[0.98] ${busy ? 'bg-zinc-700 cursor-wait' : 'bg-[#4285f4] hover:bg-[#5a95f5]'}`}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, onEnter, placeholder, password }: { label: string; value: string; onChange: (v: string) => void; onEnter: () => void; placeholder: string; password?: boolean }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-zinc-200 mb-1">{label}</label>
      <input
        type={password ? 'password' : 'text'} value={value} spellCheck={false}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && onEnter()}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-[#353535] border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono placeholder-zinc-500 focus:outline-none focus:border-[#4285f4] focus:ring-1 focus:ring-[#4285f4]/20 transition"
      />
    </div>
  );
}

function Panel({ cfg, onDisconnect, status, logs, stats, clearLogs }: { cfg: Cfg; onDisconnect: () => void; status: Status; logs: Log[]; stats: Stats; clearLogs: () => void }) {
  const uptime = useUptime(stats.connAt);
  const avg = stats.reqs > 0 ? `${Math.round(stats.latency / stats.reqs)}ms` : '—';

  return (
    <div className="min-h-screen bg-[#1F1F1F] flex flex-col">
      <header className="flex items-center justify-between px-5 py-2 border-b border-zinc-800/60">
        <div className="flex items-center gap-4 text-[11px] text-zinc-500 font-mono">
          <span className="text-zinc-300">{stats.reqs} <span className="text-zinc-400">req</span></span>
          {stats.errs > 0 && <span className="text-red-400">{stats.errs} <span className="text-red-400/50">err</span></span>}
          <span>{avg} <span className="text-zinc-500">avg</span></span>
          <span>{uptime}</span>
        </div>
        <div className="flex items-center gap-2">
          {logs.length > 0 && <button onClick={clearLogs} className="text-[11px] text-zinc-500 hover:text-zinc-400 transition">Clear</button>}
          <button onClick={onDisconnect} className="text-[11px] text-zinc-400 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 rounded px-2.5 py-0.5 transition">Disconnect</button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto font-mono">
        {logs.length > 0 && (
          <div className="p-3 space-y-px">
            {logs.map((l: Log) => (
              <div key={l.id} className="flex items-baseline gap-2.5 py-px text-[11px] leading-5 hover:bg-zinc-800/20 rounded px-1.5 -mx-1.5">
                <span className="text-zinc-500 shrink-0 tabular-nums">{l.ts}</span>
                <span className={`shrink-0 font-medium ${BADGE[l.kind]}`}>{l.kind === 'RX' ? '→' : l.kind === 'TX' ? '←' : l.kind === 'ERR' ? '✗' : '·'}</span>
                <span className="text-zinc-300 truncate">{l.msg}</span>
                {l.meta && <span className="text-zinc-500 ml-auto shrink-0 pl-3">{l.meta}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Error Boundary
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-[#1F1F1F] flex items-center justify-center p-4">
          <div className="text-center space-y-4">
            <p className="text-red-400 text-sm">{this.state.error}</p>
            <button onClick={() => { clear(); location.reload(); }} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-lg transition">
              Reset &amp; Reconnect
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// App
function App() {
  const [cfg, setCfg] = useState<Cfg | null>(load());
  const processor = useProcessor(cfg);

  const disconnect = () => { clear(); setCfg(null); location.reload(); };

  // Show Setup screen when: no config, or config exists but not yet live
  if (!cfg || processor.status !== 'live') {
    return <Setup onConnect={(c: Cfg) => setCfg(c)} status={cfg ? processor.status : undefined} />;
  }

  return <Panel cfg={cfg} onDisconnect={disconnect} status={processor.status} logs={processor.logs} stats={processor.stats} clearLogs={processor.clear} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary><App /></ErrorBoundary>
);
