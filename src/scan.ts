// Arma el estado completo que muestra la página: skills, plugins, MCPs, hooks, rutas y archivo.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context';
import { skillSources, mcpSources, hookSources, importantPaths, AGENTS } from './context';
import { readJson, exists, frontmatter, tilde, realpath, getAt, hash } from './util';
import { listPlugins, hasClaudeCli } from './plugins';
import { listSnapshots } from './archive';

type Links = { github?: string; skillsSh?: string };

// Lock de npx skills: dice de qué repo vino cada skill.
function lockInfo(c: Ctx, name: string): { source: string; links: Links } | null {
  for (const f of [path.join(c.home, '.agents/.skill-lock.json'), path.join(c.project, 'skills-lock.json')]) {
    const e = readJson(f)?.skills?.[name];
    if (!e) continue;
    const source: string = e.source || e.sourceUrl || 'lock';
    const links: Links = {};
    const repo = String(source).match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
    if (repo) {
      const sub = e.skillPath ? path.dirname(String(e.skillPath)) : '';
      links.github = `https://github.com/${repo}` + (sub && sub !== '.' ? `/tree/HEAD/${sub}` : '');
      links.skillsSh = `https://skills.sh/${repo}/${name}`;
    }
    return { source, links };
  }
  return null;
}

function skills(c: Ctx) {
  const rows: any[] = [];
  for (const s of skillSources(c)) {
    let names: string[] = [];
    try { names = fs.readdirSync(s.dir).sort(); } catch { continue; }
    for (const folder of names) {
      if (folder.startsWith('.')) continue;
      const full = path.join(s.dir, folder);
      let isLink = false, broken = false, isDir = false;
      try { isLink = fs.lstatSync(full).isSymbolicLink(); } catch { continue; }
      try { isDir = fs.statSync(full).isDirectory(); } catch { broken = true; }
      if (!isDir && !broken) continue;
      const fm = frontmatter(full);
      const lock = lockInfo(c, folder);
      rows.push({
        id: 'skill:' + full, path: full, folder, name: fm.name || folder, description: fm.description || '',
        dir: tilde(c.home, s.dir), label: s.label, scope: s.scope, agents: s.agents, enabled: true,
        via: lock ? `npx skills (${lock.source})` : broken ? 'enlace roto' : isLink ? 'enlace a ' + tilde(c.home, realpath(full)) : 'a mano',
        links: lock?.links || {}, real: realpath(full), skillMd: path.join(full, 'SKILL.md'),
      });
    }
  }
  // Si la misma carpeta real aparece en varios lugares (npx skills deja la real en ~/.agents y enlaces en el resto),
  // cada fila muestra todos los agentes que la ven.
  for (const r of rows) {
    const same = rows.filter((o) => o.real === r.real);
    r.seenBy = [...new Set(same.flatMap((o) => o.agents))];
    r.alsoAt = same.filter((o) => o !== r).map((o) => o.dir + '/' + o.folder);
  }
  return rows;
}

function mcps(c: Ctx) {
  const rows: any[] = [];
  for (const s of mcpSources(c)) {
    if (!exists(s.file)) continue;
    let servers: Record<string, any> = {};
    if (s.format === 'json') servers = getAt(readJson(s.file), s.path) || {};
    else { try { servers = (Bun.TOML.parse(fs.readFileSync(s.file, 'utf8')) as any)?.mcp_servers || {}; } catch {} }
    for (const [key, cfg] of Object.entries(servers)) {
      const target = s.format === 'json'
        ? { kind: 'mcp', format: 'json', tool: s.tool, scope: s.scope, file: s.file, path: s.path, key }
        : { kind: 'mcp', format: 'toml', tool: s.tool, scope: s.scope, file: s.file, key };
      rows.push({
        id: 'mcp:' + JSON.stringify([s.file, (s as any).path || null, key]), target, name: key, tool: s.tool, scope: s.scope,
        file: s.file, fileShort: tilde(c.home, s.file), enabled: true,
        detail: cfg?.url || cfg?.httpUrl || cfg?.serverUrl || [cfg?.command, ...(cfg?.args || [])].filter(Boolean).join(' ') || cfg?.type || '',
        transport: cfg?.type || (cfg?.url || cfg?.httpUrl ? 'http' : cfg?.command ? 'stdio' : ''),
        disabledInConfig: cfg?.enabled === false || cfg?.disabled === true,
      });
    }
  }
  return rows;
}

function hooks(c: Ctx) {
  const rows: any[] = [];
  for (const s of hookSources(c)) {
    const h = readJson(s.file)?.hooks;
    if (!h || typeof h !== 'object') continue;
    for (const [event, list] of Object.entries(h)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list as any[]) {
        const hh = hash(entry);
        rows.push({
          id: 'hook:' + JSON.stringify([s.file, event, hh]),
          target: { kind: 'hook', tool: s.tool, scope: s.scope, file: s.file, event, hash: hh },
          event, matcher: entry?.matcher || '', tool: s.tool, scope: s.scope, file: s.file, fileShort: tilde(c.home, s.file),
          commands: (entry?.hooks || []).map((x: any) => x.command || x.prompt || x.url || x.type).filter(Boolean),
          enabled: true,
        });
      }
    }
  }
  return rows;
}

export function state(c: Ctx) {
  const snaps = listSnapshots(c);
  const sk = skills(c);
  const plugins = listPlugins(c);
  const mc = mcps(c);
  const hk = hooks(c);
  const archived = { skills: [] as any[], plugins: [] as any[], mcps: [] as any[], hooks: [] as any[] };
  const sources = skillSources(c);
  for (const sn of snaps) {
    for (const s of sn.skills) {
      const src = sources.find((x) => x.dir === s.dir);
      const fm = frontmatter(s.stored);
      archived.skills.push({
        ref: `${sn.dir}|s|${s.line}`, snapshot: sn.name, path: path.join(s.dir, s.name), folder: s.name,
        name: fm.name || s.name, description: fm.description || '', dir: tilde(c.home, s.dir),
        label: src?.label || 'otra carpeta', scope: src?.scope || '', agents: src?.agents || [], seenBy: src?.agents || [],
        enabled: false, via: 'archivada en ' + tilde(c.home, sn.dir), skillMd: path.join(s.stored, 'SKILL.md'), links: lockInfo(c, s.name)?.links || {},
      });
    }
    for (const it of sn.items) {
      const ref = `${sn.dir}|c|${it.uid}`;
      if (it.kind === 'plugin') archived.plugins.push({ ref, plugin: it.plugin, snapshot: sn.name });
      if (it.kind === 'mcp') archived.mcps.push({ ref, name: it.key, tool: it.tool, scope: it.scope, fileShort: tilde(c.home, it.file), snapshot: sn.name, enabled: false,
        detail: it.format === 'json' ? JSON.stringify(it.value) : it.raw.split('\n').slice(1, 3).join(' ') });
      if (it.kind === 'hook') archived.hooks.push({ ref, event: it.event, matcher: (it.entry as any)?.matcher || '', tool: it.tool, scope: it.scope,
        fileShort: tilde(c.home, it.file), snapshot: sn.name, enabled: false,
        commands: ((it.entry as any)?.hooks || []).map((x: any) => x.command || x.prompt || x.type).filter(Boolean) });
    }
  }
  return {
    home: c.home, project: c.project, archive: tilde(c.home, c.archive), claudeCli: hasClaudeCli(c), editor: c.editor, agents: AGENTS,
    skills: sk.map(({ real, ...r }) => r), plugins, mcps: mc, hooks: hk, archived,
    snapshots: snaps.map((s) => ({ ref: `${s.dir}|all|`, name: s.name, label: s.label, created: s.created, dir: tilde(c.home, s.dir),
      skills: s.skills.length, items: s.items.length, legacy: s.root !== c.archive })),
    paths: importantPaths(c),
  };
}

// Detalle de una skill para su página: el SKILL.md completo y la lista de archivos.
export function skillDetail(c: Ctx, file: string) {
  const dir = path.dirname(file);
  const allowed = [...skillSources(c).map((s) => s.dir), c.archive, ...c.legacyArchives, path.join(c.home, '.claude/plugins')];
  if (path.basename(file) !== 'SKILL.md' || !allowed.some((a) => dir.startsWith(a + '/'))) throw new Error('ruta no permitida');
  let files: string[] = [];
  try { files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => !f.split('/').some((p) => p.startsWith('.'))).sort().slice(0, 200); } catch {}
  return { content: fs.readFileSync(file, 'utf8').slice(0, 200_000), files, dir };
}
