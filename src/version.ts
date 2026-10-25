// Qué versión está corriendo y si hay una más nueva en GitHub.
// bunx baja la app una vez y después sigue usando esa copia para siempre, sin avisar. Acá se detecta y se dice cómo actualizar.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, realpath } from './util';

const REPO = 'facundoPri/agent-config-manager';
const ROOT = path.join(import.meta.dir, '..');

export type Version = { version: string; commit: string; via: 'bunx' | 'git' | ''; cacheDir: string; latest: string; outdated: boolean; update: string };

const info: Version = { version: readJson(path.join(ROOT, 'package.json'))?.version || '', commit: '', via: '', cacheDir: '', latest: '', outdated: false, update: '' };

// Corriendo con bunx, la app vive en $TMPDIR/bunx-<uid>-agent-config-manager@github@<hash>/node_modules/agent-config-manager
// y el bun.lock de esa carpeta dice qué commit bajó.
export function bunxCache(root: string): { dir: string; commit: string } | null {
  const dir = realpath(root).match(/^(.*[\\/]bunx-[^\\/]*agent-config-manager[^\\/]*)[\\/]/)?.[1];
  if (!dir) return null;
  let lock = '';
  try { lock = fs.readFileSync(path.join(dir, 'bun.lock'), 'utf8'); } catch {}
  return { dir, commit: lock.match(/agent-config-manager#([0-9a-f]{7,40})/)?.[1] || '' };
}

export function updateCommand(cacheDir: string, platform = process.platform) {
  return platform === 'win32'
    ? `Remove-Item -Recurse -Force "${cacheDir}"; bunx github:${REPO}`
    : `rm -rf "${cacheDir}" && bunx github:${REPO}`;
}

const sameCommit = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

export function versionInfo(): Version { return info; }

// Mira el último commit de main en GitHub. Sin red o sin respuesta, no avisa nada.
export async function checkForUpdate() {
  const bunx = bunxCache(ROOT);
  if (bunx) Object.assign(info, { via: 'bunx', commit: bunx.commit, cacheDir: bunx.dir });
  else {
    const r = Bun.spawnSync(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' });
    if (r.exitCode === 0) Object.assign(info, { via: 'git', commit: r.stdout.toString().trim() });
  }
  // Solo la copia de bunx queda vieja sin que nadie se entere; un clon se actualiza con git pull.
  if (info.via !== 'bunx' || !info.commit) return info;
  try {
    info.latest = process.env.ACM_LATEST_COMMIT || (await (await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { accept: 'application/vnd.github.sha' }, signal: AbortSignal.timeout(4000),
    })).text()).trim();
  } catch { return info; }
  if (/^[0-9a-f]{7,40}$/.test(info.latest) && !sameCommit(info.commit, info.latest)) {
    info.outdated = true;
    info.update = updateCommand(info.cacheDir);
  }
  return info;
}
