#!/usr/bin/env bash
# Crea un home y un proyecto falsos con skills, MCPs y hooks para probar sin tocar tu configuración real.
# Uso: test/fake-home.sh /tmp/acm-fake   ->  bun src/server.ts --home /tmp/acm-fake/home --proyecto /tmp/acm-fake/proyecto --sin-cli
set -euo pipefail
ROOT="${1:?carpeta destino}"
# Solo borra una carpeta que haya creado este script antes.
if [[ -e "$ROOT" && ! -f "$ROOT/.acm-fake" ]]; then echo "$ROOT ya existe y no es un home falso; elegí otra carpeta"; exit 1; fi
rm -rf "$ROOT"; mkdir -p "$ROOT"; touch "$ROOT/.acm-fake"; H="$ROOT/home"; P="$ROOT/proyecto"
skill() { mkdir -p "$1/$2"; printf -- '---\nname: %s\ndescription: %s\n---\n\n# %s\n\nInstrucciones de prueba.\n' "$2" "$3" "$2" >"$1/$2/SKILL.md"; }
skill "$H/.claude/skills" mi-skill "Una skill puesta a mano en Claude Code"
skill "$H/.agents/skills" grill-me "Te entrevista hasta entender el plan (instalada con npx skills)"
ln -s "../../.agents/skills/grill-me" "$H/.claude/skills/grill-me"
skill "$H/.agents/skills" tdd "Rojo, verde, refactor"
skill "$H/.codex/skills" solo-codex "Skill que solo ve Codex"
skill "$P/.claude/skills" del-proyecto "Skill del repo"
mkdir -p "$H/.agents"
cat >"$H/.agents/.skill-lock.json" <<'J'
{ "version": 3, "skills": { "grill-me": { "source": "mattpocock/skills", "sourceType": "github", "skillPath": "skills/grill-me/SKILL.md" },
  "tdd": { "source": "mattpocock/skills", "sourceType": "github", "skillPath": "skills/tdd/SKILL.md" } } }
J
cat >"$H/.claude.json" <<J
{ "numStartups": 3, "mcpServers": { "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" } },
  "projects": { "$P": { "mcpServers": { "local-db": { "command": "npx", "args": ["-y", "db-mcp"] } } } } }
J
cat >"$P/.mcp.json" <<'J'
{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }
J
mkdir -p "$H/.codex"
cat >"$H/.codex/config.toml" <<'T'
model = "gpt-5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.context7.env]
KEY = "x"

[mcp_servers."docs server"]
url = "https://example.com/mcp"

[profiles.rapido]
model = "gpt-5-mini"
T
cat >"$H/.claude/settings.json" <<'J'
{ "model": "opus", "hooks": {
  "PostToolUse": [ { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "npx prettier --write \"$FILE\"" } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "say listo" } ] } ] } }
J
# Una skill que vive en un repo git propio, enlazada desde ~/.claude/skills.
skill "$H/repos/mis-skills" en-repo "Skill versionada en un repo git"
git -C "$H/repos/mis-skills" init -q && git -C "$H/repos/mis-skills" remote add origin git@github.com:alguien/mis-skills.git
git -C "$H/repos/mis-skills" -c user.name=t -c user.email=t@t add -A && git -C "$H/repos/mis-skills" -c user.name=t -c user.email=t@t commit -qm init
ln -s "$H/repos/mis-skills/en-repo" "$H/.claude/skills/en-repo"
echo "Listo: $ROOT"
