import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function writeJson(f: string, data: unknown) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
}

export const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

export const tilde = (home: string, p: string) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

export const hash = (v: unknown) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);

export const realpath = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

// Sigue un camino de claves dentro de un objeto JSON.
export function getAt(obj: any, keys: string[]) {
  let cur = obj;
  for (const k of keys) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}

export function ensureAt(obj: any, keys: string[]) {
  let cur = obj;
  for (const k of keys) { if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; }
  return cur;
}

export function frontmatter(skillDir: string): { name?: string; description?: string } {
  let txt = '';
  try { txt = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'); } catch { return {}; }
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    // description: > o | con el texto en las líneas siguientes
    if (/^[>|][-+]?$/.test(val)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = block.join(' ');
    }
    out[kv[1]] = val.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

export function stampNow() {
  const d = new Date(), z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

export const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
