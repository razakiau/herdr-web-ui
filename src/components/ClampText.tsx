/**
 * A block of model prose held to four lines (ZAC-265, owner: "a wall of text"): a chat's summary
 * in the group tree and the digest's Direction read at one even height, each with its own quiet
 * "Show more" / "Show less" (the subagent brief's fold, SubagentAsked). The toggle shows only
 * when the text is really cut, measured, so a short summary carries no dead control.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import "./ClampText.css";

import { useT } from "../lib/i18n.ts";

export function ClampText({ className, children }: { className: string; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = body.current;
    if (open || node === null || typeof node.scrollHeight !== "number") return;
    const measure = (): void => setCut(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, children]);
  return <div className={`clamp-text ${className}`}>
    <div ref={body} className={`clamp-text-body${open ? "" : " is-clamped"}`}>{children}</div>
    {(open || cut) && <button type="button" className="clamp-text-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? t("Show less") : t("Show more")}
    </button>}
  </div>;
}
