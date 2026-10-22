// Copias de seguridad: copian (no mueven) skills, agentes, comandos y archivos de configuración a una carpeta con fecha.
//
// <copias>/<fecha>-<etiqueta>/
//   backup.json                 qué se copió y de dónde
//   dirs/<carpeta original sin la / inicial>/<nombre>   cada skill/agente/comando, con los enlaces tal cual
//   files/<ruta original sin la / inicial>              cada archivo de configuración
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context';
import { skillSources, configFiles } from './context';
import { readJson, writeJson, exists, stampNow, slug, tilde } from './util';

type Entry = { dir: string; name: string };
type Manifest = { label: string; created: string; home: string; project: string; entries: Entry[]; files: string[] };

// Carpetas cuyo contenido se copia entrada por entrada.
const backupDirs = (c: Ctx) => [
  ...skillSources(c).map((s) => s.dir),
  path.join(c.home, '.claude/agents'), path.join(c.home, '.claude/commands'),
  path.join(c.project, '.claude/agents'), path.join(c.project, '.claude/commands'),
].filter((d, i, all) => all.indexOf(d) === i);

export function createBackup(c: Ctx, label = 'copia') {
  const base = `${stampNow()}-${slug(label)}`;
  let name = base, n = 2;
  while (exists(path.join(c.backups, name))) name = `${base}-${n++}`;
  const root = path.join(c.backups, name);
  const m: Manifest = { label, created: new Date().toISOString(), home: c.home, project: c.project, entries: [], files: [] };
  for (const dir of backupDirs(c)) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((x) => !x.startsWith('.')).sort(); } catch { continue; }
    for (const entry of names) {
      const dest = path.join(root, 'dirs', dir.replace(/^\//, ''), entry);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // verbatimSymlinks: un enlace de npx skills se guarda como enlace; la carpeta real se copia desde ~/.agents/skills.
      fs.cpSync(path.join(dir, entry), dest, { recursive: true, verbatimSymlinks: true });
      m.entries.push({ dir, name: entry });
    }
  }
  for (const f of configFiles(c)) {
    const dest = path.join(root, 'files', f.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
    m.files.push(f);
  }
  if (!m.entries.length && !m.files.length) throw new Error('no hay nada para copiar');
  writeJson(path.join(root, 'backup.json'), m);
  return { backup: name, done: [`copia ${name}: ${m.entries.length} skills/agentes/comandos y ${m.files.length} archivos`] };
}

export function listBackups(c: Ctx) {
  let names: string[] = [];
  try { names = fs.readdirSync(c.backups).sort().reverse(); } catch { return []; }
  return names.flatMap((name) => {
    const m: Manifest | null = readJson(path.join(c.backups, name, 'backup.json'));
    if (!m) return [];
    // Qué falta hoy respecto de la copia: eso es lo que devolvería "Restaurar".
    const missing = m.entries.filter((e) => !exists(path.join(e.dir, e.name))).length;
    let bytes = 0;
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) bytes += fs.statSync(f).size; } };
    try { walk(path.join(c.backups, name)); } catch {}
    return [{ name, label: m.label, created: m.created, dir: path.join(c.backups, name), dirShort: tilde(c.home, path.join(c.backups, name)),
      entries: m.entries.length, files: m.files.length, missing, bytes, otherHome: m.home !== c.home,
      skills: m.entries.filter((e) => e.dir.endsWith('/skills')).map((e) => e.name) }];
  });
}

// Restaurar: devuelve las skills/agentes/comandos que faltan (nunca pisa lo que existe).
// Con withFiles también vuelve los archivos de configuración, después de hacer una copia de los actuales.
export function restoreBackup(c: Ctx, name: string, withFiles: boolean) {
  const root = path.join(c.backups, path.basename(name));
  const m: Manifest | null = readJson(path.join(root, 'backup.json'));
  if (!m) throw new Error('no encuentro esa copia');
  if (m.home !== c.home) throw new Error('esa copia es de otro home (' + m.home + ')');
  const done: string[] = [];
  const errors: string[] = [];
  let skipped = 0;
  for (const e of m.entries) {
    const target = path.join(e.dir, e.name);
    if (exists(target)) { skipped++; continue; }
    try {
      fs.mkdirSync(e.dir, { recursive: true });
      fs.cpSync(path.join(root, 'dirs', e.dir.replace(/^\//, ''), e.name), target, { recursive: true, verbatimSymlinks: true });
      done.push(e.name);
    } catch (err: any) { errors.push(`${e.name}: ${err.message}`); }
  }
  if (withFiles && m.files.length) {
    const safety = createBackup(c, 'antes-de-restaurar-' + name.slice(0, 15));
    done.push('copia de lo actual en ' + safety.backup);
    for (const f of m.files) {
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.copyFileSync(path.join(root, 'files', f.replace(/^\//, '')), f);
        done.push(tilde(c.home, f));
      } catch (err: any) { errors.push(`${tilde(c.home, f)}: ${err.message}`); }
    }
  }
  if (skipped) done.push(`${skipped} ya estaban, no las toqué`);
  return { done, errors };
}
