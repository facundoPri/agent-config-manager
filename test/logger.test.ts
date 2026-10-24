// bun test: el logger reenvía a un servidor falso (en vez de la API de Anthropic), guarda por sesión y separa hilos y contexto.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeCtx } from '../src/context';
import { startLogger, stopLogger, listSessions, sessionDetail, requestDetail } from '../src/logger';

const ROOT = path.join(os.tmpdir(), 'acm-logger-test-' + process.pid);
process.env.AGENT_CONFIG_LOGS = path.join(ROOT, 'logs');
const ctx = makeCtx({ home: path.join(ROOT, 'home'), sinCli: true });
const SESSION = '11111111-2222-3333-4444-555555555555';
const seenUpstream: { path: string; auth: string | null }[] = [];

// Responde como la API de Anthropic en streaming. Si el último mensaje pide un subagente, responde con una llamada a Agent.
function sse(body: any) {
  const wantsAgent = JSON.stringify(body.messages).includes('lanzá un subagente');
  const block = wantsAgent
    ? [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} } },
       { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"Explore","description":"Buscar archivos",' } },
       { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"prompt":"Listá los archivos de la carpeta"}' } }]
    : [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
       { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listo.' } }];
  const events = [
    { type: 'message_start', message: { model: body.model, usage: { input_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 390, output_tokens: 1 } } },
    ...block, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: wantsAgent ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

let upstream: ReturnType<typeof Bun.serve>;
let port = 0;
beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  upstream = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    seenUpstream.push({ path: url.pathname, auth: req.headers.get('x-api-key') });
    if (url.pathname.endsWith('count_tokens')) return Response.json({ input_tokens: 5 });
    return new Response(sse(await req.json()), { headers: { 'content-type': 'text/event-stream' } });
  } });
  process.env.ACM_UPSTREAM_ANTHROPIC = `http://localhost:${upstream.port}`;
  port = startLogger(ctx, 0).port;
});
afterAll(() => { stopLogger(ctx); upstream.stop(true); fs.rmSync(ROOT, { recursive: true, force: true }); });

const SYSTEM_MSG = [
  '# Environment', ' - Primary working directory: /tmp/mi-proyecto', '',
  'The following skills are available for use with the Skill tool:', '',
  '- tdd: Rojo, verde, refactor', '- mi-plugin:revisar: Revisa un PR', '  y sigue en otra línea', '',
].join('\n');

async function send(messages: any[], extraHeaders: Record<string, string> = {}, apiPath = '/v1/messages') {
  const r = await fetch(`http://localhost:${port}/claude-code${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'secreto', 'x-claude-code-session-id': SESSION, ...extraHeaders },
    body: JSON.stringify({ model: 'claude-test', stream: true, system: [{ type: 'text', text: 'Sos Claude Code.' }],
      tools: [{ name: 'Bash', description: 'corre comandos', input_schema: {} }, { name: 'mcp__github__issues', description: 'issues', input_schema: {} },
        { name: 'Lejana', description: 'x', input_schema: {}, defer_loading: true }],
      messages }),
  });
  return r.text();
}
const waitFor = async (fn: () => boolean) => { for (let i = 0; i < 50 && !fn(); i++) await Bun.sleep(20); };

test('reenvía igual, guarda por sesión y separa principal, subagente y contexto', async () => {
  const first = [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nContents of /tmp/mi-proyecto/CLAUDE.md (project instructions):\n\nUsá bun.\n</system-reminder>' }, { type: 'text', text: 'lanzá un subagente que liste archivos' }] },
    { role: 'system', content: [{ type: 'text', text: SYSTEM_MSG }] }];
  const out = await send(first);
  expect(out).toContain('message_stop'); // el agente recibe la respuesta entera
  await send([{ role: 'user', content: 'Listá los archivos de la carpeta' }], { 'x-claude-code-agent-id': 'agente1' });
  await send([{ role: 'user', content: 'cuántos tokens' }], {}, '/v1/messages/count_tokens');
  const dir = path.join(ctx.logs, 'claude-code_' + SESSION);
  await waitFor(() => fs.existsSync(path.join(dir, 'index.jsonl')) && fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').length > 2);

  expect(seenUpstream.map((s) => s.path)).toEqual(['/v1/messages', '/v1/messages', '/v1/messages/count_tokens']);
  expect(seenUpstream[0].auth).toBe('secreto'); // el login llega al servidor real...
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'session.json');
  expect(files.length).toBe(2); // count_tokens no se guarda
  expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).not.toContain('secreto'); // ...pero no al disco

  const [s] = listSessions(ctx) as any[];
  expect(s.title).toBe('lanzá un subagente que liste archivos');
  expect(s.cwd).toBe('/tmp/mi-proyecto');
  expect(s.subagents).toBe(1);

  const d = sessionDetail(ctx, s.session);
  expect(d.threads.map((t: any) => t.kind)).toEqual(['principal', 'subagente']);
  expect(d.threads[1].label).toBe('Explore: Buscar archivos');

  const { context } = requestDetail(ctx, s.session, d.requests[0].id);
  expect(context.total).toBe(1000); // input + caché leída + caché escrita
  expect(context.skills.map((x: any) => x.name)).toEqual(['tdd', 'mi-plugin:revisar']);
  expect(context.deferred).toEqual(['Lejana']);
  const cat = (k: string) => context.cats.find((c: any) => c.key === k);
  expect(cat('mcp').items.map((i: any) => i.name)).toEqual(['github']);
  expect(cat('memory').items.map((i: any) => i.name)).toEqual(['/tmp/mi-proyecto/CLAUDE.md']);
  expect(cat('user').tokens).toBeGreaterThan(0);
  expect(context.cats.reduce((n: number, c: any) => n + c.tokens, 0)).toBeGreaterThan(990);
});

test('rechaza WebSocket con 426 y rutas desconocidas con 404', async () => {
  expect((await fetch(`http://localhost:${port}/codex/responses`, { headers: { upgrade: 'websocket', connection: 'upgrade' } })).status).toBe(426);
  expect((await fetch(`http://localhost:${port}/otra/cosa`)).status).toBe(404);
});
