/**
 * A digest's model prose (richText.ts), line by line: each line its own block, a ticket key or a
 * PR ref as an inline mono key, **bold** as strong. `lead` sets the first line apart (a chat
 * summary's lead sentence before its details). Only text is rendered, never the model's HTML.
 */
import "./RichText.css";

import { richLines, richTokens } from "../lib/richText.ts";

export function RichText({ text, lead = false }: { text: string; lead?: boolean }) {
  const lines = richLines(text);
  // a lone line is all lead: set apart only when details follow it
  return <>{lines.map((line, index) => <span key={index} className={`rich-line${lead && index === 0 && lines.length > 1 ? " is-lead" : ""}`}>
    {richTokens(line).map((token, at) => token.kind === "text" ? token.text
      : token.kind === "bold" ? <strong key={at}>{token.text}</strong>
        : <code key={at} className="rich-ref">{token.text}</code>)}
  </span>)}</>;
}
