// Lo mínimo de TOML para sacar y devolver un [mcp_servers.<nombre>] de Codex sin tocar el resto del archivo.

// Convierte el texto de un encabezado de tabla en sus claves: mcp_servers."mi server".env -> ['mcp_servers', 'mi server', 'env']
function headerKeys(h: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < h.length) {
    while (h[i] === ' ' || h[i] === '\t' || h[i] === '.') i++;
    if (i >= h.length) break;
    const q = h[i];
    if (q === '"' || q === "'") {
      const end = h.indexOf(q, i + 1);
      keys.push(h.slice(i + 1, end < 0 ? h.length : end));
      i = end < 0 ? h.length : end + 1;
    } else {
      let j = i;
      while (j < h.length && h[j] !== '.' && h[j] !== ' ' && h[j] !== '\t') j++;
      keys.push(h.slice(i, j));
      i = j;
    }
  }
  return keys;
}

const HEADER = /^\s*\[\[?([^\[\]]+)\]\]?\s*(#.*)?$/;

// Devuelve el texto de la tabla [mcp_servers.name] y sus subtablas, y el archivo sin ellas.
export function cutTomlServer(text: string, name: string): { raw: string; rest: string } | null {
  const lines = text.split('\n');
  const keep: string[] = [];
  const cut: string[] = [];
  let inside = false;
  for (const line of lines) {
    const m = line.match(HEADER);
    if (m) {
      const k = headerKeys(m[1]);
      inside = k[0] === 'mcp_servers' && k[1] === name;
    }
    (inside ? cut : keep).push(line);
  }
  if (!cut.length) return null;
  while (cut.length && cut[cut.length - 1].trim() === '') cut.pop();
  return { raw: cut.join('\n') + '\n', rest: keep.join('\n') };
}

export function appendToml(text: string, raw: string) {
  const base = text.replace(/\s*$/, '');
  return (base ? base + '\n\n' : '') + raw;
}
