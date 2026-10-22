#!/usr/bin/env bash
# Versión en bash de agent-config-manager, para cuando no hay Bun: archiva y restaura skills para "arrancar limpio".
# No borra nada: mueve cada carpeta de skill a ~/.agent-config-archive/<fecha>/ y guarda un manifest.
# Usa el mismo archivo que la página web, así que se pueden mezclar.
#
# Uso:
#   ./skills-toggle.sh listar                 # skills, plugins, MCPs y hooks que hay y dónde
#   ./skills-toggle.sh archivar               # simulación: dice qué movería
#   ./skills-toggle.sh archivar --si          # mueve las skills al archivo
#   ./skills-toggle.sh restaurar [FECHA] --si # devuelve el último archivo con skills (o FECHA) a su lugar
#   ./skills-toggle.sh archivos               # lista los archivos guardados
#   ./skills-toggle.sh web                    # abre la página (necesita Bun)
#
# Extra: SKILL_DIRS="dir1:dir2" para cambiar las carpetas que se revisan.
# MCPs, hooks y plugins se archivan desde la página web; acá solo se listan.
set -euo pipefail

ARCHIVE_ROOT="${AGENT_CONFIG_ARCHIVE:-${SKILLS_ARCHIVE:-$HOME/.agent-config-archive}}"
REPO="github:facundoPri/agent-config-manager"
DEFAULT_DIRS=(
  "$HOME/.claude/skills"          # Claude Code, skills personales
  "$PWD/.claude/skills"           # Claude Code, skills del proyecto actual
  "$HOME/.agents/skills"          # npx skills / Codex / OpenCode / Gemini CLI
  "$PWD/.agents/skills"
  "$HOME/.codex/skills"           # Codex (carpeta vieja)
  "$HOME/.cursor/skills"          # Cursor
  "$PWD/.cursor/skills"
  "$HOME/.copilot/skills"         # GitHub Copilot
  "$PWD/.github/skills"
  "$HOME/.gemini/skills"          # Gemini CLI
  "$HOME/.config/opencode/skills" # OpenCode
)
if [[ -n "${SKILL_DIRS:-}" ]]; then IFS=':' read -r -a DIRS <<<"$SKILL_DIRS"; else DIRS=("${DEFAULT_DIRS[@]}"); fi
# Sin repetidos (si estás parado en el home, $PWD/.claude/skills es lo mismo que ~/.claude/skills).
# (sin arrays asociativos: macOS trae bash 3.2)
uniq=(); joined=":"
for d in "${DIRS[@]}"; do [[ "$joined" == *":$d:"* ]] || { uniq+=("$d"); joined="$joined$d:"; }; done
DIRS=("${uniq[@]}")

cmd="${1:-listar}"; shift || true
confirm=false; target=""
for a in "$@"; do
  case "$a" in
    --si|--yes|-y) confirm=true ;;
    *) target="$a" ;;
  esac
done

skills_in() { find "$1" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) ! -name '.*' 2>/dev/null | sort; }

listar() {
  local total=0
  echo "SKILLS"
  for d in "${DIRS[@]}"; do
    [[ -d "$d" ]] || continue
    local items; items=$(skills_in "$d")
    [[ -n "$items" ]] || continue
    echo "== $d"
    while read -r s; do echo "   - $(basename "$s")$([[ -L "$s" ]] && echo "  -> $(readlink "$s")")"; total=$((total+1)); done <<<"$items"
  done
  echo "Total: $total skills sueltas."
  echo
  echo "PLUGINS de Claude Code (se apagan con 'claude plugin disable <plugin>')"
  if command -v claude >/dev/null 2>&1; then claude plugin list 2>/dev/null || echo "   (no se pudo listar)"; else echo "   (no está la CLI de claude)"; fi
  echo
  echo "MCPs"
  if command -v jq >/dev/null 2>&1; then
    [[ -f "$HOME/.claude.json" ]] && jq -r '(.mcpServers // {}) | keys[] | "   - \(.)  (Claude Code, usuario)"' "$HOME/.claude.json"
    [[ -f "$HOME/.claude.json" ]] && jq -r --arg p "$PWD" '(.projects[$p].mcpServers // {}) | keys[] | "   - \(.)  (Claude Code, local)"' "$HOME/.claude.json"
    [[ -f "$PWD/.mcp.json" ]] && jq -r '(.mcpServers // {}) | keys[] | "   - \(.)  (Claude Code, .mcp.json)"' "$PWD/.mcp.json"
  else
    echo "   (instalá jq para ver los MCPs de Claude Code)"
  fi
  [[ -f "$HOME/.codex/config.toml" ]] && grep -oE '^\[mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)\]' "$HOME/.codex/config.toml" | sed 's/^\[mcp_servers\./   - /; s/\]$/  (Codex)/'
  echo
  echo "HOOKS"
  for f in "$HOME/.claude/settings.json" "$PWD/.claude/settings.json" "$PWD/.claude/settings.local.json" "$HOME/.codex/hooks.json"; do
    [[ -f "$f" ]] || continue
    if command -v jq >/dev/null 2>&1; then jq -r --arg f "$f" '(.hooks // {}) | to_entries[] | "   - \(.key) x\(.value|length)  (\($f))"' "$f"
    else grep -q '"hooks"' "$f" && echo "   - hay hooks en $f"; fi
  done
  true
}

archivar() {
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)-bash"
  local dest="$ARCHIVE_ROOT/$stamp" n=0
  for d in "${DIRS[@]}"; do
    [[ -d "$d" ]] || continue
    while read -r s; do
      [[ -n "$s" ]] || continue
      n=$((n+1))
      if $confirm; then
        local rel="${d#/}"; mkdir -p "$dest/$rel"
        mv "$s" "$dest/$rel/"
        printf '%s\t%s\n' "$d" "$(basename "$s")" >>"$dest/manifest.tsv"
      else
        echo "movería: $s"
      fi
    done < <(skills_in "$d")
  done
  if $confirm; then
    if ((n == 0)); then echo "No había skills para archivar."; rmdir "$dest" 2>/dev/null || true
    else echo "Archivadas $n skills en $dest"; echo "Para volver atrás: $0 restaurar $stamp --si"; fi
  else
    echo "Simulación: $n skills. Repetí con --si para moverlas a $ARCHIVE_ROOT/<fecha>/."
  fi
}

# El archivo más nuevo que tenga skills (los de MCPs/hooks solos se restauran desde la web).
ultimo() { for d in $(ls -1 "$ARCHIVE_ROOT" 2>/dev/null | sort -r); do [[ -s "$ARCHIVE_ROOT/$d/manifest.tsv" ]] && { echo "$d"; return; }; done; }

restaurar() {
  local stamp="$target"
  [[ -n "$stamp" ]] || stamp=$(ultimo)
  local src="$ARCHIVE_ROOT/$stamp"
  [[ -n "$stamp" && -f "$src/manifest.tsv" ]] || { echo "No encuentro un archivo con skills en $ARCHIVE_ROOT"; exit 1; }
  local left="" nleft=0
  while IFS=$'\t' read -r dir name; do
    [[ -n "$dir" ]] || continue
    local from="$src/${dir#/}/$name"
    if [[ ! -e "$from" && ! -L "$from" ]]; then continue; fi
    if [[ -e "$dir/$name" || -L "$dir/$name" ]]; then echo "ya existe, lo salteo: $dir/$name"; left+="$dir"$'\t'"$name"$'\n'; nleft=$((nleft+1)); continue; fi
    if $confirm; then mkdir -p "$dir"; mv "$from" "$dir/"; echo "restaurada: $dir/$name"
    else echo "restauraría: $dir/$name"; fi
  done <"$src/manifest.tsv"
  if $confirm; then
    if ((nleft)); then printf '%s' "$left" >"$src/manifest.tsv"; else rm -f "$src/manifest.tsv"; fi
    [[ -f "$src/config.json" ]] && grep -q '"uid"' "$src/config.json" && echo "Este archivo también tiene plugins/MCPs/hooks: restauralos desde la web ($0 web)."
    find "$src" -depth -type d -empty -delete 2>/dev/null || true
  else
    echo "Simulación. Repetí con --si para restaurar $stamp."
  fi
}

web() {
  command -v bun >/dev/null 2>&1 || { echo "Necesitás Bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "$here/src/server.ts" ]]; then exec bun "$here/src/server.ts" "$@"; else exec bunx "$REPO" "$@"; fi
}

case "$cmd" in
  listar) listar ;;
  archivar) archivar ;;
  restaurar) restaurar ;;
  archivos) ls -1 "$ARCHIVE_ROOT" 2>/dev/null | grep -v '^\.' || echo "Sin archivos todavía." ;;
  web) web ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
