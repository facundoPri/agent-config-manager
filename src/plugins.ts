// Plugins de Claude Code: cuáles hay, qué traen (skills, comandos, agentes, hooks, MCPs) y prenderlos/apagarlos.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Ctx } from './context';
import { readJson, writeJson, frontmatter, exists } from './util';

let cliCache: { key: string; ok: boolean } | null = null;
export function hasClaudeCli(c: Ctx) {
  if (!c.useClaudeCli) return false;
  if (cliCache?.key === c.home) return cliCache.ok;
  let ok = false;
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', env: { ...process.env, HOME: c.home }, timeout: 15000 }); ok = true; } catch {}
  cliCache = { key: c.home, ok };
  return ok;
}

const claudeRun = (c: Ctx, args: string[]) =>
  execFileSync('claude', args, { cwd: c.project, env: { ...process.env, HOME: c.home }, encoding: 'utf8', timeout: 60000 });

type RawPlugin = { id: string; version?: string; scope?: string; installPath?: string; enabled: boolean };

function settingsEnabled(c: Ctx) {
  return Object.assign({},
    readJson(path.join(c.home, '.claude/settings.json'))?.enabledPlugins,
    readJson(path.join(c.project, '.claude/settings.json'))?.enabledPlugins,
    readJson(path.join(c.project, '.claude/settings.local.json'))?.enabledPlugins);
}

function rawPlugins(c: Ctx): RawPlugin[] {
  if (hasClaudeCli(c)) {
    try {
      const list = JSON.parse(claudeRun(c, ['plugin', 'list', '--json']));
      if (Array.isArray(list)) return list.map((p: any) => ({ id: p.id, version: p.version, scope: p.scope, installPath: p.installPath, enabled: !!p.enabled }));
    } catch {}
  }
  const inst = readJson(path.join(c.home, '.claude/plugins/installed_plugins.json'))?.plugins || {};
  const enabled = settingsEnabled(c);
  return Object.entries(inst).map(([id, v]: [string, any]) => {
    const e = Array.isArray(v) ? v[0] : v;
    return { id, version: e?.version, scope: e?.scope, installPath: e?.installPath, enabled: enabled[id] === true };
  });
}

const mdNames = (dir: string) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(); } catch { return []; } };

function marketplaceUrl(c: Ctx, market: string): string | undefined {
  const m = readJson(path.join(c.home, '.claude/plugins/known_marketplaces.json'))?.[market];
  const src = m?.source;
  if (src?.source === 'github' && src.repo) return `https://github.com/${src.repo}`;
  if (src?.url && /^https?:/.test(src.url)) return String(src.url).replace(/\.git$/, '');
  return undefined;
}

export type PluginInfo = ReturnType<typeof listPlugins>[number];

export function listPlugins(c: Ctx) {
  return rawPlugins(c).map((p) => {
    const [name, market] = p.id.split('@');
    const base = p.installPath || '';
    const manifest = readJson(path.join(base, '.claude-plugin/plugin.json')) || {};
    const skillsDir = path.join(base, 'skills');
    let skillNames: string[] = [];
    try { skillNames = fs.readdirSync(skillsDir).filter((n) => exists(path.join(skillsDir, n, 'SKILL.md'))).sort(); } catch {}
    const skills = skillNames.map((n) => {
      const fm = frontmatter(path.join(skillsDir, n));
      return { name: `${name}:${fm.name || n}`, folder: n, description: fm.description || '', path: path.join(skillsDir, n) };
    });
    const mcpFile = readJson(path.join(base, '.mcp.json'));
    const mcp = Object.keys(mcpFile?.mcpServers || mcpFile || {}).concat(
      typeof manifest.mcpServers === 'object' && manifest.mcpServers ? Object.keys(manifest.mcpServers) : []);
    const hooksFile = readJson(path.join(base, 'hooks/hooks.json'));
    const hooks = Object.keys(hooksFile?.hooks || {});
    const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    return {
      id: 'plugin:' + p.id, plugin: p.id, name, marketplace: market || '', version: p.version || manifest.version || '',
      scope: p.scope || '', enabled: p.enabled, installPath: base, description: manifest.description || '',
      url: manifest.homepage || repo || (market ? marketplaceUrl(c, market) : undefined),
      skills, commands: mdNames(path.join(base, 'commands')), agents: mdNames(path.join(base, 'agents')),
      mcp: [...new Set(mcp)], hooks,
    };
  });
}

export function setPluginEnabled(c: Ctx, plugin: string, on: boolean) {
  if (hasClaudeCli(c)) { claudeRun(c, ['plugin', on ? 'enable' : 'disable', plugin]); return; }
  // Sin CLI: escribir enabledPlugins en ~/.claude/settings.json.
  const f = path.join(c.home, '.claude/settings.json');
  const s = readJson(f) || {};
  s.enabledPlugins = { ...s.enabledPlugins, [plugin]: on };
  writeJson(f, s);
}
