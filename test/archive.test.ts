// bun test: archiva y restaura todo sobre un home falso y compara que quede igual que antes.
import { test, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeCtx } from '../src/context';
import { state } from '../src/scan';
import { archive, restore } from '../src/archive';

const ROOT = path.join(os.tmpdir(), 'acm-test-' + process.pid);
const H = path.join(ROOT, 'home'), P = path.join(ROOT, 'proyecto');
const ctx = () => makeCtx({ home: H, proyecto: P, sinCli: true });
const read = (f: string) => fs.readFileSync(f, 'utf8');

beforeEach(() => {
  Bun.spawnSync(['bash', path.join(import.meta.dir, 'fake-home.sh'), ROOT]);
});

test('lista skills con origen y agentes', () => {
  const s = state(ctx());
  const grill = s.skills.find((x: any) => x.dir === '~/.agents/skills' && x.folder === 'grill-me');
  expect(grill.seenBy).toContain('Claude Code');
  expect(grill.seenBy).toContain('Codex');
  expect(grill.via).toContain('mattpocock/skills');
  expect(grill.links.skillsSh).toBe('https://skills.sh/mattpocock/skills/grill-me');
  expect(s.skills.find((x: any) => x.folder === 'solo-codex').seenBy).toEqual(['Codex']);
  expect(s.skills.find((x: any) => x.folder === 'del-proyecto').scope).toBe('proyecto');
  expect(s.mcps.map((m: any) => m.name).sort()).toEqual(['context7', 'docs server', 'github', 'local-db', 'playwright']);
  expect(s.hooks.map((h: any) => h.event).sort()).toEqual(['PostToolUse', 'Stop']);
});

test('archivar todo y restaurar todo deja los archivos como estaban', () => {
  const c = ctx();
  const files = [path.join(H, '.claude.json'), path.join(H, '.codex/config.toml'), path.join(H, '.claude/settings.json'), path.join(P, '.mcp.json')];
  const parse = (f: string) => (f.endsWith('.toml') ? Bun.TOML.parse(read(f)) : JSON.parse(read(f)));
  const before = files.map(parse);
  const s = state(c);
  const targets = [
    ...s.skills.map((x: any) => ({ kind: 'skill', path: x.path })),
    ...s.mcps.map((m: any) => m.target),
    ...s.hooks.map((h: any) => h.target),
  ];
  const r = archive(c, targets as any, 'arrancar-limpio');
  expect(r.errors).toEqual([]);
  const mid = state(c);
  expect(mid.skills.length).toBe(0);
  expect(mid.mcps.length).toBe(0);
  expect(mid.hooks.length).toBe(0);
  expect(mid.archived.skills.length).toBe(s.skills.length);
  // el resto de config.toml sigue ahí
  expect(read(path.join(H, '.codex/config.toml'))).toContain('[profiles.rapido]');
  expect(JSON.parse(read(path.join(H, '.claude.json'))).numStartups).toBe(3);
  // copia de respaldo
  expect(fs.existsSync(path.join(c.archive, '.backups'))).toBe(true);

  const rr = restore(c, mid.snapshots.map((x: any) => x.ref));
  expect(rr.errors).toEqual([]);
  expect(files.map(parse)).toEqual(before); // mismo contenido (el orden de las claves puede cambiar)
  const end = state(c);
  expect(end.skills.length).toBe(s.skills.length);
  expect(end.snapshots.length).toBe(0);
  // el enlace de npx skills vuelve como enlace
  expect(fs.lstatSync(path.join(H, '.claude/skills/grill-me')).isSymbolicLink()).toBe(true);
});

test('una por una: apagar y prender una skill y un MCP', () => {
  const c = ctx();
  const s = state(c);
  const sk = s.skills.find((x: any) => x.folder === 'mi-skill');
  archive(c, [{ kind: 'skill', path: sk.path }], 'skill-mi-skill');
  const m = s.mcps.find((x: any) => x.name === 'context7');
  archive(c, [m.target], 'mcp-context7');
  const mid = state(c);
  expect(mid.archived.skills.map((x: any) => x.folder)).toEqual(['mi-skill']);
  expect(mid.mcps.find((x: any) => x.name === 'context7')).toBeUndefined();
  expect(mid.snapshots.length).toBe(2);
  restore(c, [mid.archived.skills[0].ref, mid.archived.mcps[0].ref]);
  const end = state(c);
  expect(end.skills.find((x: any) => x.folder === 'mi-skill')).toBeTruthy();
  expect(end.mcps.find((x: any) => x.name === 'context7').detail).toContain('context7-mcp');
  expect(end.snapshots.length).toBe(0);
});

test('restaurar no pisa algo que ya existe', () => {
  const c = ctx();
  const sk = state(c).skills.find((x: any) => x.folder === 'mi-skill');
  archive(c, [{ kind: 'skill', path: sk.path }], 'x');
  fs.mkdirSync(sk.path);
  const r = restore(c, [state(c).archived.skills[0].ref]);
  expect(r.errors[0]).toContain('no lo piso');
  expect(state(c).archived.skills.length).toBe(1);
});

test('plugins sin CLI: lee installed_plugins.json y apaga con enabledPlugins', () => {
  const c = ctx();
  const inst = path.join(H, '.claude/plugins/cache/demo');
  fs.mkdirSync(path.join(inst, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(inst, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'demo', description: 'Plugin de prueba' }));
  fs.mkdirSync(path.join(inst, 'skills/hola'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'skills/hola/SKILL.md'), '---\nname: hola\ndescription: saluda\n---\n');
  fs.writeFileSync(path.join(inst, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'x' } } }));
  fs.writeFileSync(path.join(H, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'demo@local': [{ scope: 'user', installPath: inst, version: '1.0.0' }] } }));
  const settings = JSON.parse(read(path.join(H, '.claude/settings.json')));
  settings.enabledPlugins = { 'demo@local': true };
  fs.writeFileSync(path.join(H, '.claude/settings.json'), JSON.stringify(settings));
  const p = state(c).plugins[0];
  expect(p.enabled).toBe(true);
  expect(p.skills[0].name).toBe('demo:hola');
  expect(p.mcp).toEqual(['demo']);
  archive(c, [{ kind: 'plugin', plugin: 'demo@local' }], 'plugins');
  expect(state(c).plugins[0].enabled).toBe(false);
  restore(c, [state(c).archived.plugins[0].ref]);
  expect(state(c).plugins[0].enabled).toBe(true);
});
