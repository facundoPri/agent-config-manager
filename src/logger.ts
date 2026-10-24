// Logger: un proxy local entre el agente y la API del modelo. Reenvía cada pedido tal cual (con su login),
// devuelve la respuesta en streaming sin tocarla y guarda una copia por sesión para verla en la página.
// La idea sale del request-logger del AI Coding Crash Course.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Ctx } from './context';
import { sessionOf, summarize, parseResponse, breakdown, INDEX_VERSION, type Agent } from './analyze';
import { readJson, writeJson } from './util';

// Cada agente entra por su propio prefijo, así un solo puerto sirve para todos.
type Route = { agent: Agent; prefix: string; upstream: (h: Headers) => string };
const ROUTES: Route[] = [
  { agent: 'claude-code', prefix: '/claude-code', upstream: () => process.env.ACM_UPSTREAM_ANTHROPIC || 'https://api.anthropic.com' },
  // Codex con login de ChatGPT manda chatgpt-account-id y va a chatgpt.com; con API key va a api.openai.com.
  { agent: 'codex', prefix: '/codex', upstream: (h) => process.env.ACM_UPSTREAM_OPENAI ||
      (h.get('chatgpt-account-id') ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com/v1') },
];

let server: ReturnType<typeof Bun.serve> | null = null;
let startedAt = '';
let lastError = '';
let seen = 0;

export function commands(port: number) {
  const base = `http://localhost:${port}`;
  return [
    { agent: 'claude-code', label: 'Claude Code', command: `ANTHROPIC_BASE_URL=${base}/claude-code ENABLE_TOOL_SEARCH=true claude`,
      note: 'Funciona con la suscripción o con API key. ENABLE_TOOL_SEARCH=true hace que Claude Code se comporte igual que sin el proxy (si no, manda todas las herramientas completas y el contexto se ve más grande de lo que es).' },
    { agent: 'codex', label: 'Codex', command: `codex -c 'openai_base_url="${base}/codex"'`, beta: true,
      note: 'Con login de ChatGPT o con API key. Todavía en prueba: los logs se guardan, el análisis está pensado para Claude Code.' },
  ];
}

export function loggerStatus(c: Ctx) {
  const port = server?.port ?? 0;
  return { running: !!server, port: port || defaultPort(), startedAt, lastError, seen, logs: c.logs, commands: commands(port || defaultPort()) };
}
export const defaultPort = () => Number(process.env.ACM_LOGGER_PORT || 4322);

export function startLogger(c: Ctx, port = defaultPort()) {
  if (server) return loggerStatus(c);
  try {
    server = Bun.serve({ port, hostname: '127.0.0.1', idleTimeout: 0, fetch: (req) => proxy(c, req) });
  } catch (e: any) {
    throw new Error(`no pude escuchar en el puerto ${port}: ${e?.message || e}. Probá otro puerto.`);
  }
  startedAt = new Date().toISOString();
  lastError = '';
  return loggerStatus(c);
}

export function stopLogger(c: Ctx) {
  server?.stop(true);
  server = null;
  return loggerStatus(c);
}

// Cabeceras que no se guardan nunca (el login va al servidor real, no al disco).
const SECRET = /^(authorization|x-api-key|api-key|cookie|chatgpt-account-id)$/i;

async function proxy(c: Ctx, req: Request): Promise<Response> {
  // Codex prueba primero un WebSocket; un 426 lo hace volver a HTTP enseguida en vez de quedarse colgado.
  if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') return new Response(null, { status: 426 });
  const url = new URL(req.url);
  const route = ROUTES.find((r) => url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/'));
  if (!route) return Response.json({ error: `agent-config-manager logger: ruta desconocida ${url.pathname}. Usá ${ROUTES.map((r) => r.prefix).join(' o ')}` }, { status: 404 });

  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
  const headers = new Headers(req.headers);
  for (const h of ['host', 'connection', 'accept-encoding', 'content-length', 'transfer-encoding']) headers.delete(h);
  const target = route.upstream(req.headers) + url.pathname.slice(route.prefix.length) + url.search;
  const t0 = Date.now();
  let up: Response;
  try {
    up = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  } catch (e: any) {
    lastError = `${route.agent}: ${e?.message || e}`;
    return Response.json({ error: `agent-config-manager logger: no pude llegar a ${target}: ${e?.message || e}` }, { status: 502 });
  }
  // fetch ya descomprimió la respuesta, así que esas cabeceras dejan de ser ciertas.
  const out = new Headers(up.headers);
  for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);

  if (!shouldLog(req.method, url.pathname) || !up.body) return new Response(up.body, { status: up.status, headers: out });
  const [toAgent, toLog] = up.body.tee();
  new Response(toLog).text().then((text) => {
    try { save(c, route.agent, req, url.pathname.slice(route.prefix.length), body, up.status, Date.now() - t0, text); }
    catch (e: any) { lastError = 'no pude guardar el log: ' + (e?.message || e); }
  }, () => {});
  return new Response(toAgent, { status: up.status, headers: out });
}

// Solo pedidos al modelo. count_tokens es de mantenimiento (Claude Code lo usa para la barra de contexto).
export const shouldLog = (method: string, p: string) => method === 'POST' && /\/(messages|responses|chat\/completions)$/.test(p);

export function decodeBody(body: Uint8Array | undefined, encoding: string | null): string {
  if (!body) return '';
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(body).toString('utf8');
    if (enc === 'br') return zlib.brotliDecompressSync(body).toString('utf8');
    if (enc === 'deflate') return zlib.inflateSync(body).toString('utf8');
    if (enc === 'zstd') return Buffer.from(Bun.zstdDecompressSync(body)).toString('utf8');
  } catch {}
  return Buffer.from(body).toString('utf8');
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');

function save(c: Ctx, agent: Agent, req: Request, apiPath: string, body: Uint8Array | undefined, status: number, ms: number, responseText: string) {
  const raw = decodeBody(body, req.headers.get('content-encoding'));
  let request: any;
  try { request = JSON.parse(raw); } catch { request = { raw }; }
  const reqHeaders: Record<string, string> = {};
  req.headers.forEach((v, k) => { if (!SECRET.test(k)) reqHeaders[k] = v; });
  const session = sessionOf(agent, req.headers, request);
  const dir = path.join(c.logs, session);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${stamp()}-${String(++seen).padStart(4, '0')}`;
  const record = {
    id, ts: new Date().toISOString(), agent, session, method: req.method, path: apiPath, status, ms,
    headers: reqHeaders, request, response: parseResponse(agent, responseText),
  };
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(record));
  fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify(summarize(record)) + '\n');
  const metaFile = path.join(dir, 'session.json');
  const meta = readJson(metaFile) || { session, agent, firstSeen: record.ts };
  writeJson(metaFile, { ...meta, lastSeen: record.ts });
}

// ---------- leer lo guardado ----------
// index.jsonl tiene una línea corta por pedido. Si la guardó una versión vieja del análisis, se rehace desde los .json.
function readIndex(dir: string): any[] {
  let idx: any[] = [];
  try { idx = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  if (idx.length && idx.every((r) => r.v === INDEX_VERSION)) return idx;
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'session.json').sort(); } catch { return idx; }
  if (!files.length) return idx;
  idx = files.map((f) => { try { return summarize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { return null; } }).filter(Boolean);
  fs.writeFileSync(path.join(dir, 'index.jsonl'), idx.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return idx;
}
const safeName = (s: string) => { if (!/^[\w.-]+$/.test(s)) throw new Error('nombre inválido'); return s; };
const ctxOf = (u: any) => (u ? u.input + u.cacheRead + u.cacheWrite : 0);

export function listSessions(c: Ctx) {
  let names: string[] = [];
  try { names = fs.readdirSync(c.logs).filter((n) => !n.startsWith('.')); } catch {}
  return names.map((name) => {
    const dir = path.join(c.logs, name);
    const meta = readJson(path.join(dir, 'session.json')) || {};
    const idx = readIndex(dir);
    if (!idx.length) return null;
    const main = idx.filter((r) => r.thread === 'main');
    const last = main[main.length - 1] || idx[idx.length - 1];
    return {
      session: name, agent: meta.agent || idx[0].agent, firstSeen: meta.firstSeen || idx[0].ts, lastSeen: meta.lastSeen || last.ts,
      title: (main[0] || idx[0]).firstPrompt || '(sin mensaje)', cwd: idx.find((r) => r.cwd)?.cwd || '',
      requests: idx.length, subagents: new Set(idx.filter((r) => !['main', 'aux'].includes(r.thread)).map((r) => r.thread)).size,
      models: [...new Set(idx.map((r) => r.model).filter(Boolean))], ctx: last.ctx || ctxOf(last.usage),
      output: idx.reduce((n, r) => n + (r.usage?.output || 0), 0), errors: idx.filter((r) => r.status >= 400 || r.error).length,
    };
  }).filter(Boolean).sort((a: any, b: any) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 200);
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

// Una sesión, partida en hilos: el principal, cada subagente (con el pedido que lo lanzó) y las llamadas auxiliares.
export function sessionDetail(c: Ctx, session: string) {
  const dir = path.join(c.logs, safeName(session));
  const idx = readIndex(dir);
  if (!idx.length) throw new Error('no hay logs de esa sesión');
  const spawns = idx.flatMap((r) => (r.spawns || []).map((s: any) => ({ ...s, from: r.thread, at: r.id })));
  const byThread = new Map<string, any[]>();
  for (const r of idx) byThread.set(r.thread, [...(byThread.get(r.thread) || []), r]);
  const threads = [...byThread].map(([id, reqs]) => {
    const first = reqs[0];
    let kind = id === 'main' ? 'principal' : id === 'aux' ? 'auxiliar' : 'subagente';
    let label = kind === 'principal' ? 'Hilo principal' : kind === 'auxiliar' ? 'Llamadas auxiliares (títulos, resúmenes, chequeos)' : 'Subagente';
    let spawn: any = null;
    if (kind === 'subagente') {
      const p = norm(first.firstPrompt || '');
      spawn = spawns.find((s) => p && (p.startsWith(norm(s.prompt).slice(0, 120)) || norm(s.prompt).startsWith(p.slice(0, 120)))) || null;
      if (spawn) label = [spawn.type, spawn.description].filter(Boolean).join(': ');
    }
    const last = reqs[reqs.length - 1];
    return {
      id, kind, label, spawn, requests: reqs.length, firstTs: first.ts, lastTs: last.ts, models: [...new Set(reqs.map((r) => r.model))],
      ctx: last.ctx || ctxOf(last.usage), output: reqs.reduce((n, r) => n + (r.usage?.output || 0), 0),
    };
  }).sort((a, b) => (a.kind === 'principal' ? -1 : b.kind === 'principal' ? 1 : a.kind === 'auxiliar' ? 1 : b.kind === 'auxiliar' ? -1 : a.firstTs.localeCompare(b.firstTs)));
  const lastMain = [...idx].reverse().find((r) => r.thread === 'main');
  return { session, meta: readJson(path.join(dir, 'session.json')) || {}, dir, threads, requests: idx, lastMain: lastMain?.id || idx[idx.length - 1].id };
}

export function requestDetail(c: Ctx, session: string, id: string) {
  const rec = JSON.parse(fs.readFileSync(path.join(c.logs, safeName(session), safeName(id) + '.json'), 'utf8'));
  return { record: rec, context: breakdown(rec) };
}

// Las skills que vio el modelo en el último pedido del hilo principal de la sesión más reciente (para la pestaña Skills).
export function latestContextSkills(c: Ctx) {
  const s = listSessions(c).find((x: any) => x.agent === 'claude-code') as any;
  if (!s) return null;
  const idx = readIndex(path.join(c.logs, s.session));
  const last = [...idx].reverse().find((r) => r.thread === 'main' && r.skills?.length) || [...idx].reverse().find((r) => r.skills?.length);
  if (!last) return null;
  const loaded = idx.filter((r) => r.thread === 'main').flatMap((r) => r.loaded || []);
  return { session: s.session, title: s.title, ts: last.ts, ctx: last.ctx, skills: Object.fromEntries(last.skills), loaded: [...new Set(loaded.map((l: any) => l[0]))] };
}
