/**
 * A digest's model prose as plain text with a few marked words (ZAC-265, owner: "easier to read,
 * not markdown"). No markdown parser and never the model's HTML: a tiny tokenizer finds ticket keys
 * (ZAC-123, SPK-1616), pull and issue refs (#123, owner/repo#12) and `**bold**`, and leaves every
 * other character as text. A ref is a key (DESIGN.md: --font-mono is for keys); bold is strong.
 */
export type RichToken = { kind: "text"; text: string } | { kind: "ref"; text: string } | { kind: "bold"; text: string };

// one alternation, the longest form first: owner/repo#12 before #12. A key takes 2+ digits, so
// UTF-8, SHA-1 and GPT-5 stay words (ZAC-1 to ZAC-9 do too, the cost of that)
const PATTERN = /\*\*([^*\n]+?)\*\*|(?<![\w/#-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)(?!\w)|(?<![\w&#/])(#\d+)(?!\w)|(?<![\w-])([A-Z][A-Z0-9]{1,9}-\d{2,6})(?![\w-])/g;

export function richTokens(text: string): RichToken[] {
  const tokens: RichToken[] = [];
  let at = 0;
  for (const match of text.matchAll(PATTERN)) {
    const index = match.index;
    if (index > at) tokens.push({ kind: "text", text: text.slice(at, index) });
    if (match[1] !== undefined) tokens.push({ kind: "bold", text: match[1] });
    else tokens.push({ kind: "ref", text: match[0] });
    at = index + match[0].length;
  }
  if (at < text.length) tokens.push({ kind: "text", text: text.slice(at) });
  return tokens;
}

/** The text's lines, each trimmed, the empty ones left out: a direction's sentences, a summary's lead and details. */
export function richLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}
