import type { ReactNode } from "react";

import { fileLineTarget } from "../lib/filePaths.ts";
import { parseInline, type InlineNode } from "../lib/markdown.ts";
import { baseName } from "../lib/toolGroupSummary.ts";

/** A row's text from the host (`Ran \`ls\``): its code spans as code, a file it links as its name. */
export function RowText({ text }: { text: string }) {
  return <>{parseInline(text, false).map((node, index) => <RowNode key={index} node={node} />)}</>;
}

function RowNode({ node }: { node: InlineNode }): ReactNode {
  switch (node.type) {
    case "text": return node.value;
    case "code": return <code>{node.value}</code>;
    case "math": return node.value;
    case "image": return node.alt;
    case "file": return node.children.length > 0 ? <RowText text={inlineText(node.children)} /> : baseName(fileLineTarget(node.path).path);
    default: return <>{node.children.map((child, index) => <RowNode key={index} node={child} />)}</>;
  }
}

function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => node.type === "text" || node.type === "code" || node.type === "math" ? node.value : node.type === "image" ? node.alt : inlineText(node.children)).join("");
}
