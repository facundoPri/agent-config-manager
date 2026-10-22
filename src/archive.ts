// Archivar y restaurar. Nada se borra: cada cosa apagada queda en una carpeta del archivo y se puede devolver.
//
// <archivo>/<fecha>-<etiqueta>/
//   manifest.tsv   skills: "<carpeta original>\t<nombre>" (mismo formato que bash/skills-toggle.sh)
//   <carpeta original sin la / inicial>/<nombre>   la skill movida tal cual
//   config.json    plugins apagados, MCPs y hooks sacados de su archivo de configuración
// <archivo>/.backups/<fecha>/   copia de cada archivo de configuración antes de modificarlo
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Ctx } from './context';
import { skillSources } from './context';
import { readJson, writeJson, exists, getAt, ensureAt, hash, stampNow, slug, tilde } from './util';
import { cutTomlServer, appendToml } from './toml';
import { setPluginEnabled } from './plugins';

export type ConfigItem =
  | { uid: string; kind: 'plugin'; plugin: string }
  | { uid: string; kind: 'mcp'; format: 'json'; tool: string; scope: string; file: string; path: string[]; key: string; value: unknown }
  | { uid: string; kind: 'mcp'; format: 'toml'; tool: string; scope: string; file: string; key: string; raw: string }
  | { uid: string; kind: 'hook'; tool: string; scope: string; file: string; event: string; entry: unknown };

export type SkillLine = { dir: string; name: string; stored: string; line: string };

export type Snapshot = { root: string; name: string; dir: string; label: string; created: string; skills: SkillLine[]; items: ConfigItem[] };

const roots = (c: Ctx) => [c.archive, ...c.legacyArchives];

export function listSnapshots(c: Ctx): Snapshot[] {
  const out: Snapshot[] = [];
  for (const root of roots(c)) {
    let names: string[] = [];
    try { names = fs.readdirSync(root).filter((n) => !n.startsWith('.')).sort(); } catch { continue; }
    for (const name of names) {
      const dir = path.join(root, name);
      const skills: SkillLine[] = [];
      const mf = path.join(dir, 'manifest.tsv');
      if (exists(mf)) {
        for (const line of fs.readFileSync(mf, 'utf8').split('\n').filter(Boolean)) {
          const [d, n] = line.split('\t');
          const stored = path.join(dir, d.replace(/^\//, ''), n);
          if (exists(stored)) skills.push({ dir: d, name: n, stored, line });
        }
      }
      const cfg = readJson(path.join(dir, 'config.json'));
      const items: ConfigItem[] = cfg?.items || [];
      if (!skills.length && !items.length) continue;
      let created = cfg?.created;
      if (!created) { try { created = fs.statSync(dir).mtime.toISOString(); } catch { created = ''; } }
      out.push({ root, name, dir, label: cfg?.label || name, created, skills, items });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function newSnapshot(c: Ctx, label: string) {
  const base = `${stampNow()}-${slug(label)}`;
  let name = base, n = 2;
  while (exists(path.join(c.archive, name))) name = `${base}-${n++}`;
  const dir = path.join(c.archive, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, name, label };
}

function backup(c: Ctx, file: string, stamp: string) {
  if (!exists(file)) return;
  const dest = path.join(c.archive, '.backups', stamp, file.replace(/^\//, ''));
  if (exists(dest)) return; // la primera copia es la original de esta operación
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

const uid = () => crypto.randomBytes(6).toString('hex');

// Qué se puede archivar. Los ids son los mismos que muestra el estado.
export type Target =
  | { kind: 'skill'; path: string }
  | { kind: 'plugin'; plugin: string }
  | { kind: 'mcp'; format: 'json'; tool: string; scope: string; file: string; path: string[]; key: string }
  | { kind: 'mcp'; format: 'toml'; tool: string; scope: string; file: string; key: string }
  | { kind: 'hook'; tool: string; scope: string; file: string; event: string; hash: string };

export function archive(c: Ctx, targets: Target[], label: string) {
  if (!targets.length) throw new Error('no hay nada para archivar');
  const snap = newSnapshot(c, label);
  const stamp = snap.name;
  const items: ConfigItem[] = [];
  const done: string[] = [];
  const errors: string[] = [];
  const sources = skillSources(c).map((s) => s.dir);
  for (const t of targets) {
    try {
      if (t.kind === 'skill') {
        const dir = path.dirname(t.path), name = path.basename(t.path);
        if (!sources.includes(dir)) throw new Error('carpeta de skills desconocida: ' + dir);
        fs.lstatSync(t.path);
        const rel = dir.replace(/^\//, '');
        fs.mkdirSync(path.join(snap.dir, rel), { recursive: true });
        fs.renameSync(t.path, path.join(snap.dir, rel, name));
        fs.appendFileSync(path.join(snap.dir, 'manifest.tsv'), `${dir}\t${name}\n`);
        done.push('skill ' + name);
      } else if (t.kind === 'plugin') {
        setPluginEnabled(c, t.plugin, false);
        items.push({ uid: uid(), kind: 'plugin', plugin: t.plugin });
        done.push('plugin ' + t.plugin);
      } else if (t.kind === 'mcp' && t.format === 'json') {
        backup(c, t.file, stamp);
        const data = readJson(t.file);
        const obj = getAt(data, t.path);
        if (!obj || !(t.key in obj)) throw new Error(`no encuentro el MCP ${t.key} en ${tilde(c.home, t.file)}`);
        items.push({ uid: uid(), kind: 'mcp', format: 'json', tool: t.tool, scope: t.scope, file: t.file, path: t.path, key: t.key, value: obj[t.key] });
        delete obj[t.key];
        writeJson(t.file, data);
        done.push('MCP ' + t.key);
      } else if (t.kind === 'mcp' && t.format === 'toml') {
        backup(c, t.file, stamp);
        const res = cutTomlServer(fs.readFileSync(t.file, 'utf8'), t.key);
        if (!res) throw new Error(`no encuentro [mcp_servers.${t.key}] en ${tilde(c.home, t.file)}`);
        items.push({ uid: uid(), kind: 'mcp', format: 'toml', tool: t.tool, scope: t.scope, file: t.file, key: t.key, raw: res.raw });
        fs.writeFileSync(t.file, res.rest);
        done.push('MCP ' + t.key);
      } else if (t.kind === 'hook') {
        backup(c, t.file, stamp);
        const data = readJson(t.file);
        const list = data?.hooks?.[t.event];
        const i = Array.isArray(list) ? list.findIndex((e: unknown) => hash(e) === t.hash) : -1;
        if (i < 0) throw new Error(`no encuentro ese hook de ${t.event} en ${tilde(c.home, t.file)}`);
        items.push({ uid: uid(), kind: 'hook', tool: t.tool, scope: t.scope, file: t.file, event: t.event, entry: list[i] });
        list.splice(i, 1);
        if (!list.length) delete data.hooks[t.event];
        if (!Object.keys(data.hooks).length) delete data.hooks;
        writeJson(t.file, data);
        done.push('hook ' + t.event);
      }
    } catch (e: any) {
      errors.push(String(e.message || e));
    }
  }
  if (done.length) writeJson(path.join(snap.dir, 'config.json'), { label, created: new Date().toISOString(), items });
  prune(snap.dir);
  return { snapshot: done.length ? snap.name : null, done, errors };
}

// Ref de algo archivado: "<carpeta del snapshot>|s|<línea del manifest>" o "<carpeta>|c|<uid>"
export function restore(c: Ctx, refs: string[]) {
  const done: string[] = [];
  const errors: string[] = [];
  const snaps = listSnapshots(c);
  for (const ref of refs) {
    const [dir, type, ...rest] = ref.split('|');
    const key = rest.join('|');
    const snap = snaps.find((s) => s.dir === dir);
    try {
      if (!snap) throw new Error('no encuentro ese archivo');
      if (type === 's') {
        const s = snap.skills.find((x) => x.line === key);
        if (!s) throw new Error('esa skill ya no está en el archivo');
        restoreSkill(c, snap, s);
        done.push('skill ' + s.name);
      } else if (type === 'c') {
        const it = snap.items.find((x) => x.uid === key);
        if (!it) throw new Error('eso ya no está en el archivo');
        restoreItem(c, snap, it);
        done.push(describe(it));
      } else if (type === 'all') {
        for (const s of [...snap.skills]) { try { restoreSkill(c, snap, s); done.push('skill ' + s.name); } catch (e: any) { errors.push(e.message); } }
        for (const it of [...snap.items]) { try { restoreItem(c, snap, it); done.push(describe(it)); } catch (e: any) { errors.push(e.message); } }
      } else throw new Error('ref inválida');
    } catch (e: any) {
      errors.push(String(e.message || e));
    }
  }
  return { done, errors };
}

const describe = (it: ConfigItem) => it.kind === 'plugin' ? 'plugin ' + it.plugin : it.kind === 'mcp' ? 'MCP ' + it.key : 'hook ' + it.event;

function restoreSkill(c: Ctx, snap: Snapshot, s: SkillLine) {
  const target = path.join(s.dir, s.name);
  if (exists(target)) throw new Error('ya existe algo en ' + tilde(c.home, target) + ', no lo piso');
  fs.mkdirSync(s.dir, { recursive: true });
  fs.renameSync(s.stored, target);
  const mf = path.join(snap.dir, 'manifest.tsv');
  const left = fs.readFileSync(mf, 'utf8').split('\n').filter((l) => l && l !== s.line);
  if (left.length) fs.writeFileSync(mf, left.join('\n') + '\n'); else fs.unlinkSync(mf);
  snap.skills = snap.skills.filter((x) => x !== s);
  if (!snap.skills.length && !snap.items.length && exists(path.join(snap.dir, 'config.json'))) fs.unlinkSync(path.join(snap.dir, 'config.json'));
  prune(snap.dir);
}

function restoreItem(c: Ctx, snap: Snapshot, it: ConfigItem) {
  const stamp = 'restaurar-' + stampNow();
  if (it.kind === 'plugin') {
    setPluginEnabled(c, it.plugin, true);
  } else if (it.kind === 'mcp' && it.format === 'json') {
    backup(c, it.file, stamp);
    const data = readJson(it.file) || {};
    const obj = ensureAt(data, it.path);
    if (it.key in obj) throw new Error(`ya hay un MCP ${it.key} en ${tilde(c.home, it.file)}, no lo piso`);
    obj[it.key] = it.value;
    writeJson(it.file, data);
  } else if (it.kind === 'mcp' && it.format === 'toml') {
    backup(c, it.file, stamp);
    const text = exists(it.file) ? fs.readFileSync(it.file, 'utf8') : '';
    if (cutTomlServer(text, it.key)) throw new Error(`ya hay un [mcp_servers.${it.key}] en ${tilde(c.home, it.file)}, no lo piso`);
    fs.mkdirSync(path.dirname(it.file), { recursive: true });
    fs.writeFileSync(it.file, appendToml(text, it.raw));
  } else if (it.kind === 'hook') {
    backup(c, it.file, stamp);
    const data = readJson(it.file) || {};
    data.hooks ||= {};
    data.hooks[it.event] ||= [];
    if (!data.hooks[it.event].some((e: unknown) => hash(e) === hash(it.entry))) data.hooks[it.event].push(it.entry);
    writeJson(it.file, data);
  }
  const f = path.join(snap.dir, 'config.json');
  const cfg = readJson(f);
  cfg.items = cfg.items.filter((x: ConfigItem) => x.uid !== it.uid);
  if (cfg.items.length || exists(path.join(snap.dir, 'manifest.tsv'))) writeJson(f, cfg); else fs.unlinkSync(f);
  snap.items = snap.items.filter((x) => x.uid !== it.uid);
  prune(snap.dir);
}

// Borra solo carpetas vacías (lo que queda de un snapshot ya restaurado).
function prune(d: string) {
  let entries: string[] = [];
  try { entries = fs.readdirSync(d); } catch { return; }
  for (const e of entries) {
    const f = path.join(d, e);
    try { if (fs.lstatSync(f).isDirectory()) prune(f); } catch {}
  }
  try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch {}
}
