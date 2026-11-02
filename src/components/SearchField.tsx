/**
 * The app's one search field (ZAC-265 round 13): the filter pill's family (PillMenu.tsx). It is the
 * pill's height (--pill-h) with round ends, the pill's raised ground and hairline, and a leading
 * magnifier, then the words, then a clear (×) only while there are words. Focus outlines it in amber
 * on its hairline, as the pill is while its menu is open: no thicker ring. Beside a pill the two
 * share their top and bottom edges. The input reaches a finger's --touch-target past the drawn
 * edge, as the pill's own expander does.
 *
 * `onDismiss` is the sidebar's: its search has no other way out on a touch screen, so the cross stays
 * on an empty field there, as Close search.
 */
import "./SearchField.css";

import type { InputHTMLAttributes, MouseEvent as ReactMouseEvent, Ref } from "react";
import { Search, X } from "lucide-react";

import { useT } from "../lib/i18n.ts";

type Native = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "className" | "aria-label">;

export interface SearchFieldProps extends Native {
  value: string;
  onValue(value: string): void;
  /** the field's accessible name */
  label: string;
  inputRef?: Ref<HTMLInputElement>;
  /** the shell's own classes (its place in a row) */
  className?: string;
  /** the input's own classes (a hook a parent's rules or listeners look for) */
  inputClassName?: string;
  /** the cross's own classes (a hook a parent's checks look for) */
  clearClassName?: string;
  /** the cross's words while there are words; "Clear search" when not given */
  clearLabel?: string;
  /** false: no cross of its own (a bar whose Close sits beside it: the find bars, the palette) */
  clearable?: boolean;
  /** an empty field's cross: closes what the field belongs to (the sidebar's search) */
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function SearchField({ value, onValue, label, inputRef, className = "", inputClassName = "", clearClassName = "", clearLabel, clearable = true, onDismiss, dismissLabel, ...native }: SearchFieldProps) {
  const t = useT();
  const empty = value === "";
  const cross = clearable && (!empty || onDismiss !== undefined);
  const crossLabel = empty ? dismissLabel ?? t("Close search") : clearLabel ?? t("Clear search");
  // a press anywhere on the drawn pill (its magnifier, its padding) puts the caret in the field
  const focusInput = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest("input, button")) return;
    event.preventDefault();
    event.currentTarget.querySelector("input")?.focus();
  };
  return <div onMouseDown={focusInput} className={`search-field${cross ? " has-clear" : ""}${native.disabled ? " is-disabled" : ""} ${className}`.trim()}>
    <Search className="search-field-icon" aria-hidden="true" />
    <input ref={inputRef} type="search" className={`search-field-input ${inputClassName}`.trim()} value={value} aria-label={label}
      onChange={(event) => onValue(event.target.value)} {...native} />
    {cross && <button type="button" className={`search-field-clear ${clearClassName}`.trim()} aria-label={crossLabel} title={crossLabel} disabled={native.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (empty) { onDismiss?.(); return; }
        onValue("");
        (event.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null)?.focus();
      }}><X aria-hidden="true" /></button>}
  </div>;
}
