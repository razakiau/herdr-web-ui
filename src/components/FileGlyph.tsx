import { useSyncExternalStore } from "react";

import { ICON_URLS } from "../lib/fileIconUrls.generated.ts";
import { fileIcon, folderIcon } from "../lib/fileIcons.ts";
import "./FileGlyph.css";

export interface FileGlyphProps {
  /** the entry's name, or a path, whose last part names it */
  name: string;
  kind?: "file" | "directory";
  /** a directory drawn open, as a tree shows an expanded folder */
  open?: boolean;
  className?: string;
}

/**
 * The icon a list draws before an entry's name: VS Code's Material Icon Theme icon for it
 * (lib/fileIcons.ts decides which), each its own small SVG the page fetches once and the service
 * worker keeps. Hidden from assistive tech since the name beside it says the same. The row's CSS
 * sizes it; Settings → Appearance → Agent logos → Mono greys it (FileGlyph.css). `data-icon`
 * names the icon for a style or a script that reads it.
 */
export function FileGlyph({ name, kind = "file", open = false, className }: FileGlyphProps) {
  const light = useSyncExternalStore(subscribeTheme, lightTheme, darkOnServer);
  const icon = kind === "directory" ? folderIcon(name, open) : fileIcon(name, light);
  const src = ICON_URLS[icon] ?? ICON_URLS["file"];
  return <img src={src} alt="" aria-hidden="true" draggable={false} decoding="async" className={className === undefined ? "file-glyph" : `file-glyph ${className}`} data-icon={icon} />;
}

// one observer for every glyph on the page, on <html>'s data-theme (Settings keeps it current)
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (observer === null && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => { for (const notify of listeners) notify(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { observer?.disconnect(); observer = null; }
  };
}

function lightTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset["theme"] === "light";
}

function darkOnServer(): boolean {
  return false;
}
