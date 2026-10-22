#!/usr/bin/env bun
// agent-config-manager: una página local para ver y ordenar skills, plugins, MCPs y hooks de Claude Code, Codex y compañía.
// bun src/server.ts [--puerto 4321] [--proyecto <carpeta>] [--home <home falso>] [--editor code] [--sin-cli] [--no-abrir]
import fs from 'node:fs';
import path from 'node:path';
import { makeCtx, type Ctx } from './context';
import { state, skillDetail } from './scan';
import { archive, restore, type Target } from './archive';
import { createBackup, restoreBackup } from './backup';
import { listPlugins, setPluginEnabled } from './plugins';
import { exists, isInside, tilde } from './util';

function parseArgs(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.ayuda) {
  console.log(fs.readFileSync(import.meta.path, 'utf8').split('\n')[2].replace(/^\/\/ /, ''));
  process.exit(0);
}
const ctx = makeCtx({
  home: args.home as string, proyecto: args.proyecto as string, editor: args.editor as string, sinCli: !!args['sin-cli'],
});
const PORT = Number(args.puerto || process.env.PORT || 4321);
const PUBLIC = path.join(import.meta.dir, '..', 'public');

// Abre un archivo o carpeta en el editor (VS Code por defecto) o en el Finder / explorador.
function openPath(c: Ctx, p: string, reveal: boolean) {
  const target = path.resolve(p);
  const plugins = path.join(c.home, '.claude/plugins');
  if (![c.home, c.project, c.backups].some((root) => isInside(target, root)) && !isInside(target, plugins)) throw new Error('solo abro rutas dentro del home o del proyecto');
  const tries: string[][] = [];
  if (reveal) {
    const where = exists(target) ? target : path.dirname(target);
    if (process.platform === 'darwin') tries.push(['open', '-R', where]);
    else if (process.platform === 'win32') tries.push(['explorer', '/select,', where]);
    else tries.push(['xdg-open', fs.statSync(where).isDirectory() ? where : path.dirname(where)]);
  } else {
    tries.push([...c.editor.split(' '), target]);
    if (process.platform === 'darwin') tries.push(['open', '-a', 'Visual Studio Code', target]);
  }
  for (const cmd of tries) {
    try {
      const r = Bun.spawnSync(cmd, { stdout: 'ignore', stderr: 'pipe' });
      if (r.exitCode === 0) return cmd[0];
    } catch {}
  }
  throw new Error(`no pude abrirlo con "${tries[0][0]}". Instalá el comando "code" (VS Code > Shell Command) o pasá --editor`);
}

// Copia una skill de un plugin a ~/.claude/skills, para poder apagar el plugin y quedarte solo con las que querés.
function copyPluginSkill(c: Ctx, plugin: string, folder: string) {
  const p = listPlugins(c).find((x) => x.plugin === plugin);
  const s = p?.skills.find((x) => x.folder === folder);
  if (!p || !s) throw new Error('no encuentro esa skill en el plugin');
  const dest = path.join(c.home, '.claude/skills', folder);
  if (exists(dest)) throw new Error('ya existe ' + tilde(c.home, dest));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(s.path, dest, { recursive: true });
  return tilde(c.home, dest);
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Solo el navegador local: otra web no puede usar la API (Host y Origin tienen que ser localhost).
  const host = (req.headers.get('host') || '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(host)) return json({ error: 'solo localhost' }, 403);
  const origin = req.headers.get('origin');
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json({ error: 'origen no permitido' }, 403);

  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(Bun.file(path.join(PUBLIC, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/api/state') return json(state(ctx));
    if (url.pathname === '/api/skill') return json(skillDetail(ctx, url.searchParams.get('file') || ''));
    return json({ error: 'no existe' }, 404);
  }
  if (req.method !== 'POST') return json({ error: 'método no permitido' }, 405);
  if (!(req.headers.get('content-type') || '').startsWith('application/json')) return json({ error: 'se espera JSON' }, 415);
  const body: any = await req.json();
  let result: any = {};
  switch (url.pathname) {
    case '/api/archive': result = archive(ctx, (body.targets || []) as Target[], String(body.label || 'ui')); break;
    case '/api/restore': result = restore(ctx, (body.refs || []).map(String)); break;
    case '/api/plugin': setPluginEnabled(ctx, String(body.plugin), !!body.on); result = { done: [(body.on ? 'prendido ' : 'apagado ') + body.plugin] }; break;
    case '/api/copy-skill': result = { done: ['copiada a ' + copyPluginSkill(ctx, String(body.plugin), String(body.folder))] }; break;
    case '/api/backup': result = createBackup(ctx, String(body.label || 'copia')); break;
    case '/api/restore-backup': result = restoreBackup(ctx, String(body.name), !!body.withFiles); break;
    case '/api/open': result = { done: ['abierto con ' + openPath(ctx, String(body.path), !!body.reveal)] }; break;
    default: return json({ error: 'no existe' }, 404);
  }
  return json({ ...result, state: state(ctx) });
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    try { return await handle(req); } catch (e: any) { return json({ error: String(e?.message || e) }, 400); }
  },
});

const link = `http://localhost:${PORT}`;
console.log(`agent-config-manager en ${link}`);
console.log(`  home:     ${ctx.home}`);
console.log(`  proyecto: ${ctx.project}`);
console.log(`  archivo:  ${ctx.archive}`);
if (!args['no-abrir'] && !args.home) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try { Bun.spawn([opener, link], { stdout: 'ignore', stderr: 'ignore' }); } catch {}
}
