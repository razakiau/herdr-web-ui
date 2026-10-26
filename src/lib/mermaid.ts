// Mermaid diagrams drawn by Pele (mermaid 12.1.0 syntax, synchronous, no runtime dependencies),
// one chunk the chat loads with the first diagram it draws (MermaidDiagram in
// components/Markdown.tsx): most replies have none. Measured 2026-10-19 against Mermaid 12.1.0:
// 245 KiB gzip against 1.4 MiB, first render 11-14 ms against 25-192 ms (docs/guide.md).
// Its colours are CSS variables (ChatView.css .markdown-mermaid), so a theme change needs no redraw.
import { render } from "pele";

let serial = 0;

/**
 * A sequence diagram with each ";" after a message's or note's ":" written as mermaid's "#59;".
 * Mermaid ends a sequence statement at ";", so agents' prose ("synced; the app gets OK") broke the
 * whole diagram (owner, ZAC-233, 2026-10-26). Used only once the source as written fails to parse,
 * so a diagram that already draws (statements split on one line) is drawn as before.
 */
function semicolonsKept(source: string): string {
  if (!/^\s*sequenceDiagram\b/.test(source)) return source;
  return source.split("\n").map((line) => {
    const colon = line.indexOf(":");
    return colon === -1 ? line : line.slice(0, colon + 1) + line.slice(colon + 1).replaceAll(";", "#59;");
  }).join("\n");
}

/**
 * Draws `source` as SVG markup; rejects when it is not a valid diagram. Diagram text is escaped,
 * click callbacks dropped and links filtered by Pele; images are off, so a diagram makes no request.
 * `dark` is kept for the caller's effect key: the colours follow the stylesheet.
 */
export async function renderMermaid(source: string, _dark: boolean): Promise<string> {
  const draw = (text: string) => render(text, { idPrefix: `mermaid-diagram-${serial++}-`, images: false });
  let svg: string;
  try {
    ({ svg } = draw(source));
  } catch (cause) {
    const kept = semicolonsKept(source);
    if (kept === source) throw cause;
    ({ svg } = draw(kept));
  }
  // Pele caps the svg at 100% inline; the stylesheet sizes it instead (inline and zoomed)
  return svg.replace(/^(<svg[^>]*?\sstyle="[^"]*?)max-width:100%;height:auto;/, "$1");
}
