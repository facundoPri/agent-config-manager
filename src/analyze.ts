// Lee lo que guardó el logger: a qué sesión pertenece cada pedido, qué respondió el modelo,
// y de qué está hecho el contexto (system prompt, herramientas, skills, CLAUDE.md, conversación).
export type Agent = 'claude-code' | 'codex';

// ---------- sesión ----------
export function sessionOf(agent: Agent, headers: Headers, body: any): string {
  let id = '';
  if (agent === 'claude-code') {
    id = headers.get('x-claude-code-session-id') || '';
    const uid = body?.metadata?.user_id;
    if (!id && typeof uid === 'string') {
      try { id = JSON.parse(uid).session_id || ''; } catch {}
      if (!id) id = uid.match(/session_([0-9a-f-]{36})/)?.[1] || '';
    }
  } else {
    id = headers.get('session_id') || headers.get('session-id') || headers.get('conversation_id') || body?.prompt_cache_key || '';
  }
  id = String(id).replace(/[^\w.-]/g, '').slice(0, 80);
  return `${agent}_${id || 'sin-sesion-' + new Date().toISOString().slice(0, 10)}`;
}

// ---------- respuesta ----------
type Block = { type: string; text?: string; name?: string; input?: any; id?: string };
export type ParsedResponse = { usage: Usage | null; stop: string; content: Block[]; error?: string; model?: string };
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };

function sseEvents(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try { out.push(JSON.parse(d)); } catch {}
  }
  return out;
}

export function parseResponse(agent: Agent, text: string): ParsedResponse {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    // Respuesta sin streaming, o un error.
    try {
      const j = JSON.parse(trimmed);
      if (j.error) return { usage: null, stop: 'error', content: [], error: typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error) };
      if (agent === 'claude-code') return { usage: anthropicUsage(j.usage), stop: j.stop_reason || '', content: j.content || [], model: j.model };
      return openaiResponse(j);
    } catch { return { usage: null, stop: '', content: [], error: text.slice(0, 2000) }; }
  }
  const events = sseEvents(text);
  if (agent === 'claude-code') return anthropicStream(events, text);
  const done = events.find((e) => e.type === 'response.completed' || e.type === 'response.failed' || e.type === 'response.incomplete');
  if (done?.response) return openaiResponse(done.response);
  return { usage: null, stop: '', content: [], error: events.length ? undefined : text.slice(0, 2000) };
}

const anthropicUsage = (u: any): Usage | null => u ? {
  input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0,
} : null;

function anthropicStream(events: any[], text: string): ParsedResponse {
  const r: ParsedResponse = { usage: null, stop: '', content: [] };
  const json: Record<number, string> = {};
  for (const e of events) {
    if (e.type === 'message_start') { r.usage = anthropicUsage(e.message?.usage); r.model = e.message?.model; }
    else if (e.type === 'content_block_start') { r.content[e.index] = { ...e.content_block }; if (e.content_block?.type === 'tool_use') json[e.index] = ''; }
    else if (e.type === 'content_block_delta') {
      const b = r.content[e.index] || (r.content[e.index] = { type: 'text', text: '' });
      const d = e.delta || {};
      if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
      else if (d.type === 'thinking_delta') b.text = (b.text || '') + d.thinking;
      else if (d.type === 'input_json_delta') json[e.index] = (json[e.index] || '') + d.partial_json;
    } else if (e.type === 'message_delta') {
      r.stop = e.delta?.stop_reason || r.stop;
      if (e.usage && r.usage) r.usage.output = e.usage.output_tokens ?? r.usage.output;
    } else if (e.type === 'error') r.error = e.error?.message || JSON.stringify(e.error);
  }
  for (const [i, s] of Object.entries(json)) { try { r.content[+i].input = s ? JSON.parse(s) : {}; } catch { r.content[+i].input = s; } }
  r.content = r.content.filter(Boolean).map((b: any) => (b.type === 'thinking' ? { type: 'thinking', text: b.text || b.thinking || '' } : b));
  if (!events.length) r.error = text.slice(0, 2000);
  return r;
}

function openaiResponse(j: any): ParsedResponse {
  const u = j.usage;
  const cached = u?.input_tokens_details?.cached_tokens || 0;
  const content: Block[] = [];
  for (const it of j.output || []) {
    if (it.type === 'message') content.push({ type: 'text', text: (it.content || []).map((c: any) => c.text || '').join('') });
    else if (it.type === 'function_call' || it.type === 'custom_tool_call' || it.type === 'local_shell_call')
      content.push({ type: 'tool_use', name: it.name || it.type, input: tryJson(it.arguments ?? it.input ?? it.action) });
    else if (it.type === 'reasoning') content.push({ type: 'thinking', text: (it.summary || []).map((s: any) => s.text).join('\n') });
  }
  return {
    usage: u ? { input: (u.input_tokens || 0) - cached, cacheRead: cached, cacheWrite: 0, output: u.output_tokens || 0 } : null,
    stop: j.status || '', content, model: j.model, error: j.error?.message,
  };
}
const tryJson = (v: any) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

// ---------- de qué está hecho el contexto ----------
// Cada pedido manda TODO el contexto de nuevo: system prompt, herramientas y la conversación entera.
// Acá se parte en categorías. Los tokens son una estimación (caracteres / 4) ajustada al total real que devolvió la API.
export const CATS: Record<string, string> = {
  system: 'System prompt',
  tools: 'Herramientas propias',
  mcp: 'Herramientas de MCPs',
  skills: 'Skills (lista con descripciones)',
  skillLoaded: 'Skills cargadas completas',
  memory: 'CLAUDE.md / AGENTS.md y memoria',
  harness: 'Instrucciones del harness',
  mcpInstr: 'Instrucciones de MCPs',
  reminders: 'Recordatorios (system-reminder)',
  user: 'Tus mensajes',
  assistant: 'Respuestas del modelo',
  toolCalls: 'Llamadas a herramientas',
  toolResults: 'Resultados de herramientas',
};

type Item = { cat: string; name: string; chars: number; path?: string };
export type SkillSeen = { name: string; chars: number; description: string };

// Una entrada de la lista de skills: "- nombre: descripción" (o "- plugin:skill: descripción"), a veces en varias líneas.
const SKILL_ENTRY = /^- ([^\s]+?)(?::\s(.*)|:?\s*$)/;
// Dónde empieza cada sección dentro de un texto del harness.
const SECTION = /^(?:#{1,2} .+|The following .+|Available agent types.+|Contents of .+|<environment_context>|# AGENTS\.md instructions.*)$/;
const SKILL_LOADED = /Base directory for this skill:\s*(\S+)/;

// Nombres cortos para las secciones conocidas del harness.
const SECTION_NAMES: [RegExp, string][] = [
  [/deferred tools are now available/i, 'Nombres de herramientas diferidas'],
  [/tools just became available/i, 'Herramientas recién agregadas'],
  [/Available agent types/i, 'Tipos de subagentes'],
  [/MCP servers require authentication/i, 'MCPs que piden login'],
  [/<environment_context>/, 'Entorno (carpeta, shell)'],
];

function sectionCat(head: string): string {
  if (/skills are available|^#{1,2} Skills\b/i.test(head)) return 'skills';
  if (/^Contents of |^# AGENTS\.md instructions/.test(head)) return 'memory';
  if (/MCP Server Instructions|MCP servers have provided/i.test(head)) return 'mcpInstr';
  return '';
}

function skillEntries(text: string): SkillSeen[] {
  const out: SkillSeen[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(SKILL_ENTRY);
    if (m) out.push({ name: m[1], chars: line.length + 1, description: (m[2] || '').slice(0, 300) });
    else if (out.length && line.trim()) out[out.length - 1].chars += line.length + 1;
  }
  return out;
}

// Parte un texto del harness (system prompt, mensaje de sistema o un <system-reminder>) en secciones.
function harnessItems(text: string, fallback: string, items: Item[], skills: SkillSeen[]) {
  const lines = text.split('\n');
  let cat = fallback, name = fallback === 'system' ? 'System prompt' : firstLine(text), buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n');
    buf = [];
    if (!t.trim()) return;
    if (cat === 'skills') {
      const entries = skillEntries(t);
      skills.push(...entries);
      for (const e of entries) items.push({ cat: 'skills', name: e.name, chars: e.chars });
      const rest = t.length - entries.reduce((n, e) => n + e.chars, 0);
      if (rest > 0) items.push({ cat: 'skills', name: '(encabezado)', chars: rest });
    } else items.push({ cat, name, chars: t.length + 1 });
  };
  for (const line of lines) {
    if (SECTION.test(line)) {
      // Los títulos de adentro de un CLAUDE.md siguen siendo de ese archivo.
      if (cat === 'memory' && /^#{1,2} /.test(line) && !/^# AGENTS\.md/.test(line)) { buf.push(line); continue; }
      flush();
      // Dentro de las instrucciones de MCPs, cada "## servidor" sigue en esa categoría, con su nombre.
      cat = cat === 'mcpInstr' && line.startsWith('## ') ? cat : sectionCat(line) || fallback;
      name = cat === 'memory' ? line.replace(/^Contents of |^# AGENTS\.md instructions( for )?/, '').replace(/ \(.*\):?$|:$/, '') || 'AGENTS.md'
        : SECTION_NAMES.find(([re]) => re.test(line))?.[1] || line.replace(/^#+ /, '').slice(0, 80);
    }
    buf.push(line);
  }
  flush();
}
const firstLine = (t: string) => (t.trim().split('\n')[0] || '').replace(/^#+ /, '').slice(0, 80);

// Texto de un mensaje del usuario: lo que está en <system-reminder> es del harness, el resto es tuyo.
function userTextItems(text: string, items: Item[], skills: SkillSeen[], loaded: Item[]) {
  const sk = text.match(SKILL_LOADED);
  if (sk) { const it = { cat: 'skillLoaded', name: skillNameFromPath(sk[1]), chars: text.length, path: sk[1] }; items.push(it); loaded.push(it); return; }
  let rest = text;
  for (const m of text.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) {
    harnessItems(m[1].trim(), 'reminders', items, skills);
    rest = rest.replace(m[0], '');
  }
  for (const m of rest.matchAll(/<environment_context>[\s\S]*?<\/environment_context>|# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g)) {
    harnessItems(m[0], 'harness', items, skills);
    rest = rest.replace(m[0], '');
  }
  if (rest.trim()) items.push({ cat: 'user', name: 'Mensajes', chars: rest.length });
}
const skillNameFromPath = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

function toolItem(t: any, items: Item[], deferred: string[]) {
  const def = t?.definition || t;
  const name: string = def?.name || def?.type || '?';
  if (def?.defer_loading) { deferred.push(name); return; }
  const mcp = name.match(/^mcp__(.+?)__/);
  items.push({ cat: mcp ? 'mcp' : 'tools', name: mcp ? mcp[1] : name, chars: JSON.stringify(def).length });
}

// Codex agrupa herramientas en "namespaces"; los de MCP se llaman mcp__<servidor>.
function codexToolItems(t: any, items: Item[], deferred: string[]) {
  if (t?.type !== 'namespace') return toolItem(t, items, deferred);
  const mcp = String(t.name || '').match(/^mcp__(.+)$/);
  for (const sub of t.tools || []) items.push({ cat: mcp ? 'mcp' : 'tools', name: mcp ? mcp[1] : `${t.name}.${sub.name}`, chars: JSON.stringify(sub).length });
  items.push({ cat: mcp ? 'mcp' : 'tools', name: mcp ? mcp[1] : t.name, chars: (t.description || '').length });
}
const codexToolCount = (req: any) => (req.tools || []).length +
  (req.input || []).filter((i: any) => i.type === 'additional_tools').flatMap((i: any) => i.tools || []).reduce((n: number, t: any) => n + (t.type === 'namespace' ? (t.tools || []).length : 1), 0);

const blockText = (c: any): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map(blockText).join('\n') : c?.text ?? (c?.type === 'image' ? '[imagen]' : '');

export function breakdown(rec: any) {
  const req = rec.request || {};
  const items: Item[] = [], skills: SkillSeen[] = [], loaded: Item[] = [], deferred: string[] = [];
  const toolNames: Record<string, string> = {};
  if (rec.agent === 'codex') {
    if (req.instructions) harnessItems(String(req.instructions), 'system', items, skills);
    for (const t of req.tools || []) toolItem(t, items, deferred);
    for (const it of req.input || []) {
      if (it.type === 'additional_tools') for (const t of it.tools || []) codexToolItems(t, items, deferred);
      else if (it.type === 'message') {
        const text = (it.content || []).map((c: any) => c.text || '').join('\n');
        if (it.role === 'user') userTextItems(text, items, skills, loaded);
        else if (it.role === 'assistant') items.push({ cat: 'assistant', name: 'Respuestas', chars: text.length });
        else harnessItems(text, 'harness', items, skills);
      } else if (/_call$/.test(it.type)) {
        toolNames[it.call_id] = it.name || it.type;
        items.push({ cat: 'toolCalls', name: it.name || it.type, chars: JSON.stringify(it.arguments ?? it.input ?? it.action ?? '').length });
      } else if (/_call_output$/.test(it.type)) {
        items.push({ cat: 'toolResults', name: toolNames[it.call_id] || 'herramienta', chars: JSON.stringify(it.output ?? '').length });
      } else if (it.type === 'reasoning') items.push({ cat: 'assistant', name: 'Razonamiento', chars: JSON.stringify(it.summary || it.encrypted_content || '').length });
    }
  } else {
    const sys = typeof req.system === 'string' ? [{ text: req.system }] : req.system || [];
    for (const b of sys) harnessItems(String(b.text || ''), 'system', items, skills);
    for (const t of req.tools || []) toolItem(t, items, deferred);
    for (const m of req.messages || []) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
      for (const b of blocks) {
        if (b.type === 'text') {
          if (m.role === 'user') userTextItems(b.text || '', items, skills, loaded);
          else if (m.role === 'assistant') items.push({ cat: 'assistant', name: 'Respuestas', chars: (b.text || '').length });
          else harnessItems(b.text || '', 'harness', items, skills);
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') items.push({ cat: 'assistant', name: 'Razonamiento', chars: (b.thinking || b.data || '').length });
        else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          toolNames[b.id] = b.name;
          items.push({ cat: 'toolCalls', name: b.name, chars: JSON.stringify(b.input || {}).length });
        } else if (b.type === 'tool_result' || /_tool_result$/.test(b.type)) {
          const text = blockText(b.content);
          const sk = text.match(SKILL_LOADED);
          if (sk) { const it = { cat: 'skillLoaded', name: skillNameFromPath(sk[1]), chars: text.length, path: sk[1] }; items.push(it); loaded.push(it); }
          else items.push({ cat: 'toolResults', name: toolNames[b.tool_use_id] || 'herramienta', chars: text.length });
        } else if (b.type === 'tool_addition') toolItem(b.tool, items, deferred);
        else if (b.type === 'image' || b.type === 'document') items.push({ cat: m.role === 'user' ? 'user' : 'toolResults', name: b.type === 'image' ? 'Imágenes' : 'Documentos', chars: 6000 });
      }
    }
  }
  // Juntar por categoría y nombre, y llevar caracteres a tokens.
  const u: Usage | null = rec.response?.usage || null;
  const real = u ? u.input + u.cacheRead + u.cacheWrite : 0;
  const est = items.reduce((n, i) => n + i.chars, 0) / 4;
  const k = real && est ? real / est : 1;
  const cats = Object.keys(CATS).map((cat) => {
    const by = new Map<string, number>();
    for (const i of items) if (i.cat === cat) by.set(i.name, (by.get(i.name) || 0) + i.chars);
    const list = [...by].map(([name, chars]) => ({ name, tokens: Math.round((chars / 4) * k) })).sort((a, b) => b.tokens - a.tokens);
    return { key: cat, label: CATS[cat], tokens: list.reduce((n, i) => n + i.tokens, 0), items: list };
  }).filter((c) => c.tokens > 0);
  return {
    total: real || Math.round(est), estimated: !real, usage: u, cats, deferred,
    skills: skills.map((s) => ({ name: s.name, description: s.description, tokens: Math.round((s.chars / 4) * k) })),
    loaded: loaded.map((l) => ({ name: l.name, path: l.path, tokens: Math.round((l.chars / 4) * k) })),
  };
}

// ---------- resumen de cada pedido (una línea de index.jsonl) ----------
// Un comando (/skill) llega como <command-name>/x</command-name><command-args>…</command-args>.
const command = (t: string) => {
  const name = t.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
  return name ? `${name} ${t.match(/<command-args>([^<]*)<\/command-args>/)?.[1] || ''}`.trim() : t;
};
const clean = (t: string) => command(t).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
  .replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, '').trim();

// El último texto que escribió una persona (no el harness) en un mensaje.
function humanText(content: any): string {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const t = b.type === 'text' || b.type === 'input_text' ? clean(b.text || '') : '';
    if (t && !SKILL_LOADED.test(t)) return t;
  }
  return '';
}

function messagesOf(rec: any): { role: string; content: any }[] {
  const req = rec.request || {};
  if (rec.agent === 'codex') return (req.input || []).filter((i: any) => i.type === 'message').map((i: any) => ({ role: i.role, content: i.content }));
  return req.messages || [];
}

export const INDEX_VERSION = 3;

export function summarize(rec: any) {
  const req = rec.request || {};
  const msgs = messagesOf(rec);
  const users = msgs.filter((m) => m.role === 'user' && humanText(m.content));
  const bd = breakdown(rec);
  const allText = JSON.stringify(req).slice(0, 400_000);
  const cwd = allText.match(/Primary working directory: ([^\s\\]+)/)?.[1] || allText.match(/<cwd>([^<\\]+)<\/cwd>/)?.[1] || '';
  const ntools = rec.agent === 'codex' ? codexToolCount(req) : (req.tools || []).length;
  // Claude Code marca los subagentes con x-claude-code-agent-id; Codex dice en x-codex-turn-metadata qué agente y qué tipo de pedido es.
  let agentId = rec.headers?.['x-claude-code-agent-id'] || '', auxKind = '';
  if (rec.agent === 'codex') {
    let meta: any = {};
    try { meta = JSON.parse(rec.headers?.['x-codex-turn-metadata'] || '{}'); } catch {}
    if (meta.request_kind && meta.request_kind !== 'turn') auxKind = meta.thread_source || meta.request_kind;
    else if (meta.agent_name && meta.agent_name !== '/root') agentId = meta.agent_name;
  }
  const sys = typeof req.system === 'string' ? req.system : (req.system || []).map((b: any) => b.text || '').filter((t: string) => !t.startsWith('x-anthropic-billing-header')).join('\n');
  const content = rec.response?.content || [];
  return {
    v: INDEX_VERSION, id: rec.id, ts: rec.ts, agent: rec.agent, status: rec.status, ms: rec.ms,
    model: req.model || rec.response?.model || '',
    thread: agentId || (auxKind || (rec.agent !== 'codex' && !ntools) ? 'aux' : 'main'),
    auxLabel: auxKind || (ntools ? '' : firstLine(sys || String(req.instructions || '')).slice(0, 100)),
    firstPrompt: humanText(users[0]?.content).slice(0, 400),
    lastPrompt: humanText(users[users.length - 1]?.content).slice(0, 400),
    nMessages: msgs.length, ntools, cwd,
    usage: rec.response?.usage || null, ctx: bd.total, stop: rec.response?.stop || '', error: rec.response?.error || '',
    toolsCalled: content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.name),
    spawns: content.filter((b: any) => b.type === 'tool_use' && /^(Agent|Task)$/.test(b.name) && b.input?.prompt)
      .map((b: any) => ({ type: b.input.subagent_type || '', description: b.input.description || '', prompt: String(b.input.prompt).slice(0, 300) })),
    reply: content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').slice(0, 300),
    skills: bd.skills.map((s) => [s.name, s.tokens]),
    loaded: bd.loaded.map((s) => [s.name, s.tokens, s.path]),
  };
}
