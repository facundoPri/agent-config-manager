// Carpetas y archivos que mira la app. Todo sale de HOME y del proyecto, así se puede probar con un home falso.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export type Ctx = {
  home: string;
  project: string;
  archive: string; // donde se guardan las cosas archivadas
  backups: string; // copias de seguridad (copian, no mueven)
  legacyArchives: string[]; // archivos viejos de skills-toggle.sh / skills-ui, solo para restaurar
  editor: string;
  useClaudeCli: boolean;
};

export function makeCtx(opts: { home?: string; proyecto?: string; editor?: string; sinCli?: boolean } = {}): Ctx {
  const home = path.resolve(opts.home || process.env.HOME || os.homedir());
  const archive = process.env.AGENT_CONFIG_ARCHIVE || path.join(home, '.agent-config-archive');
  const legacy = path.join(home, '.skills-archive');
  return {
    home,
    project: path.resolve(opts.proyecto || process.cwd()),
    archive,
    backups: process.env.AGENT_CONFIG_BACKUPS || path.join(home, '.agent-config-backups'),
    legacyArchives: legacy !== archive && fs.existsSync(legacy) ? [legacy] : [],
    editor: opts.editor || process.env.AGENT_CONFIG_EDITOR || 'code',
    useClaudeCli: !opts.sinCli,
  };
}

export const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Gemini CLI', 'OpenCode'] as const;

export type SkillSource = { dir: string; agents: string[]; scope: 'personal' | 'proyecto'; label: string };

// Carpetas de skills sueltas y qué agentes las cargan.
export function skillSources(c: Ctx): SkillSource[] {
  const H = (p: string) => path.join(c.home, p);
  const P = (p: string) => path.join(c.project, p);
  const universal = ['Codex', 'OpenCode', 'Gemini CLI'];
  const list: SkillSource[] = [
    { dir: H('.claude/skills'), agents: ['Claude Code', 'OpenCode'], scope: 'personal', label: 'Claude Code' },
    { dir: P('.claude/skills'), agents: ['Claude Code', 'OpenCode'], scope: 'proyecto', label: 'Claude Code' },
    { dir: H('.agents/skills'), agents: universal, scope: 'personal', label: 'npx skills (.agents)' },
    { dir: P('.agents/skills'), agents: universal, scope: 'proyecto', label: 'npx skills (.agents)' },
    { dir: H('.codex/skills'), agents: ['Codex'], scope: 'personal', label: 'Codex' },
    { dir: H('.cursor/skills'), agents: ['Cursor'], scope: 'personal', label: 'Cursor' },
    { dir: P('.cursor/skills'), agents: ['Cursor'], scope: 'proyecto', label: 'Cursor' },
    { dir: H('.copilot/skills'), agents: ['GitHub Copilot'], scope: 'personal', label: 'GitHub Copilot' },
    { dir: P('.github/skills'), agents: ['GitHub Copilot'], scope: 'proyecto', label: 'GitHub Copilot' },
    { dir: H('.gemini/skills'), agents: ['Gemini CLI'], scope: 'personal', label: 'Gemini CLI' },
    { dir: H('.config/opencode/skills'), agents: ['OpenCode'], scope: 'personal', label: 'OpenCode' },
  ];
  // Si el proyecto es el home, las de "proyecto" repetirían las personales.
  return list.filter((s, i) => list.findIndex((o) => o.dir === s.dir) === i);
}

// Dónde vive cada lista de MCPs. path = claves para llegar al objeto { nombre: config }.
export type McpSource =
  | { format: 'json'; tool: string; scope: string; file: string; path: string[] }
  | { format: 'toml'; tool: string; scope: string; file: string };

export function mcpSources(c: Ctx): McpSource[] {
  const H = (p: string) => path.join(c.home, p);
  const P = (p: string) => path.join(c.project, p);
  return [
    { format: 'json', tool: 'Claude Code', scope: 'usuario', file: H('.claude.json'), path: ['mcpServers'] },
    { format: 'json', tool: 'Claude Code', scope: 'local (este proyecto)', file: H('.claude.json'), path: ['projects', c.project, 'mcpServers'] },
    { format: 'json', tool: 'Claude Code', scope: 'proyecto (.mcp.json)', file: P('.mcp.json'), path: ['mcpServers'] },
    { format: 'toml', tool: 'Codex', scope: 'usuario', file: H('.codex/config.toml') },
    { format: 'toml', tool: 'Codex', scope: 'proyecto', file: P('.codex/config.toml') },
    { format: 'json', tool: 'Cursor', scope: 'usuario', file: H('.cursor/mcp.json'), path: ['mcpServers'] },
    { format: 'json', tool: 'Cursor', scope: 'proyecto', file: P('.cursor/mcp.json'), path: ['mcpServers'] },
    { format: 'json', tool: 'Gemini CLI', scope: 'usuario', file: H('.gemini/settings.json'), path: ['mcpServers'] },
    { format: 'json', tool: 'OpenCode', scope: 'usuario', file: H('.config/opencode/opencode.json'), path: ['mcp'] },
  ].filter((s, i, all) => all.findIndex((o) => o.file === s.file && JSON.stringify((o as any).path) === JSON.stringify((s as any).path)) === i) as McpSource[];
}

// Archivos con "hooks": { Evento: [ { matcher, hooks: [...] } ] } (formato de Claude Code; Codex y Gemini usan el mismo).
export type HookSource = { tool: string; scope: string; file: string };

export function hookSources(c: Ctx): HookSource[] {
  const H = (p: string) => path.join(c.home, p);
  const P = (p: string) => path.join(c.project, p);
  const list = [
    { tool: 'Claude Code', scope: 'usuario', file: H('.claude/settings.json') },
    { tool: 'Claude Code', scope: 'proyecto', file: P('.claude/settings.json') },
    { tool: 'Claude Code', scope: 'local', file: P('.claude/settings.local.json') },
    { tool: 'Codex', scope: 'usuario', file: H('.codex/hooks.json') },
    { tool: 'Gemini CLI', scope: 'usuario', file: H('.gemini/settings.json') },
  ];
  return list.filter((s, i) => list.findIndex((o) => o.file === s.file) === i);
}

// Rutas importantes de cada herramienta, para abrirlas en el editor.
export function importantPaths(c: Ctx) {
  const H = (p: string) => path.join(c.home, p);
  const P = (p: string) => path.join(c.project, p);
  const groups: { tool: string; items: { label: string; path: string }[] }[] = [
    { tool: 'Claude Code', items: [
      { label: 'Carpeta de configuración', path: H('.claude') },
      { label: 'Settings de usuario (hooks, permisos, plugins)', path: H('.claude/settings.json') },
      { label: 'Estado global y MCPs de usuario', path: H('.claude.json') },
      { label: 'Memoria personal', path: H('.claude/CLAUDE.md') },
      { label: 'Skills personales', path: H('.claude/skills') },
      { label: 'Agentes personales', path: H('.claude/agents') },
      { label: 'Comandos personales', path: H('.claude/commands') },
      { label: 'Plugins instalados', path: H('.claude/plugins') },
      { label: 'Proyecto: .claude', path: P('.claude') },
      { label: 'Proyecto: settings', path: P('.claude/settings.json') },
      { label: 'Proyecto: settings locales', path: P('.claude/settings.local.json') },
      { label: 'Proyecto: MCPs (.mcp.json)', path: P('.mcp.json') },
      { label: 'Proyecto: CLAUDE.md', path: P('CLAUDE.md') },
    ] },
    { tool: 'Codex', items: [
      { label: 'Carpeta de configuración', path: H('.codex') },
      { label: 'config.toml (modelo, MCPs)', path: H('.codex/config.toml') },
      { label: 'Instrucciones globales', path: H('.codex/AGENTS.md') },
      { label: 'Hooks', path: H('.codex/hooks.json') },
      { label: 'Skills (las que instala npx skills)', path: H('.agents/skills') },
      { label: 'Proyecto: AGENTS.md', path: P('AGENTS.md') },
      { label: 'Proyecto: .codex/config.toml', path: P('.codex/config.toml') },
    ] },
    { tool: 'Cursor', items: [
      { label: 'Carpeta de configuración', path: H('.cursor') },
      { label: 'MCPs', path: H('.cursor/mcp.json') },
      { label: 'Proyecto: reglas', path: P('.cursor/rules') },
    ] },
    { tool: 'Gemini CLI', items: [
      { label: 'Settings (MCPs, hooks)', path: H('.gemini/settings.json') },
      { label: 'Instrucciones globales', path: H('.gemini/GEMINI.md') },
    ] },
    { tool: 'OpenCode', items: [
      { label: 'Configuración', path: H('.config/opencode/opencode.json') },
      { label: 'Skills', path: H('.config/opencode/skills') },
    ] },
    { tool: 'GitHub Copilot', items: [
      { label: 'Skills personales', path: H('.copilot/skills') },
      { label: 'Proyecto: instrucciones', path: P('.github/copilot-instructions.md') },
    ] },
    { tool: 'npx skills', items: [
      { label: 'Lock global', path: H('.agents/.skill-lock.json') },
      { label: 'Lock del proyecto', path: P('skills-lock.json') },
    ] },
    { tool: 'Esta app', items: [
      { label: 'Archivo (lo apagado vive acá)', path: c.archive },
      { label: 'Copias de seguridad', path: c.backups },
      ...c.legacyArchives.map((p) => ({ label: 'Archivo viejo de skills-toggle.sh', path: p })),
    ] },
  ];
  return groups.map((g) => ({
    tool: g.tool,
    items: g.items.map((i) => {
      let kind: 'file' | 'dir' | null = null;
      try { kind = fs.statSync(i.path).isDirectory() ? 'dir' : 'file'; } catch {}
      return { ...i, exists: kind !== null, kind };
    }),
  }));
}

// Archivos de configuración que entran en una copia de seguridad (los que existan).
export function configFiles(c: Ctx): string[] {
  const H = (p: string) => path.join(c.home, p);
  const P = (p: string) => path.join(c.project, p);
  const files = [
    ...mcpSources(c).map((s) => s.file), ...hookSources(c).map((s) => s.file),
    H('.claude/CLAUDE.md'), H('.claude/plugins/installed_plugins.json'), H('.claude/plugins/known_marketplaces.json'),
    H('.codex/AGENTS.md'), H('.agents/.skill-lock.json'), P('skills-lock.json'), P('CLAUDE.md'), P('AGENTS.md'),
  ];
  return [...new Set(files)].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}
