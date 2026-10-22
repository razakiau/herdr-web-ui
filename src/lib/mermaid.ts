// Mermaid diagrams drawn by Pele (mermaid 12.1.0 syntax, synchronous, no runtime dependencies),
// one chunk the chat loads with the first diagram it draws (MermaidDiagram in
// components/Markdown.tsx): most replies have none. Measured 2026-10-19 against Mermaid 12.1.0:
// 245 KiB gzip against 1.4 MiB, first render 11-14 ms against 25-192 ms (docs/guide.md).
// Its colours are CSS variables (ChatView.css .markdown-mermaid), so a theme change needs no redraw.
import { render } from "pele";

let serial = 0;

/**
 * Draws `source` as SVG markup; rejects when it is not a valid diagram. Diagram text is escaped,
 * click callbacks dropped and links filtered by Pele; images are off, so a diagram makes no request.
 * `dark` is kept for the caller's effect key: the colours follow the stylesheet.
 */
export async function renderMermaid(source: string, _dark: boolean): Promise<string> {
  const { svg } = render(source, { idPrefix: `mermaid-diagram-${serial++}-`, images: false });
  // Pele caps the svg at 100% inline; the stylesheet sizes it instead (inline and zoomed)
  return svg.replace(/^(<svg[^>]*?\sstyle="[^"]*?)max-width:100%;height:auto;/, "$1");
}
