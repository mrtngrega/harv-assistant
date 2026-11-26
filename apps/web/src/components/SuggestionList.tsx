import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The list that opens above the command line while something is typed (a /command, an @path),
 * like Claude Code's. The highlighted row stays in view; a row is picked on mousedown, so the
 * textarea keeps its focus.
 */
export function SuggestionList<T>({
  label,
  items,
  index,
  onPick,
  keyOf,
  titleOf,
  rowClass,
  row,
  footer,
}: {
  label: string;
  items: T[];
  index: number;
  onPick: (item: T) => void;
  keyOf: (item: T) => string;
  titleOf?: (item: T) => string;
  /** Extra classes for a row (a divider after a group). */
  rowClass?: (item: T, i: number) => string;
  row: (item: T) => ReactNode;
  footer?: ReactNode;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // By hand: scrollIntoView could scroll the page.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.children[index] as HTMLElement | undefined;
    if (!list || !el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }, [index]);

  // A solid panel, not glass: a backdrop blur inside the glass chat panel shows nothing behind it.
  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label={label}
      className="absolute right-3 bottom-full left-3 z-30 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[rgb(220_232_245/0.18)] bg-[rgb(16_24_34/0.96)] py-1 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)]"
    >
      {items.map((item, i) => (
        <li
          key={keyOf(item)}
          role="option"
          aria-selected={i === index}
          title={titleOf?.(item)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          className={`flex min-w-0 cursor-pointer items-baseline gap-3 px-3 py-1.5 ${i === index ? 'bg-white/10' : 'hover:bg-white/5'} ${rowClass?.(item, i) ?? ''}`}
        >
          {row(item)}
        </li>
      ))}
      {footer}
    </ul>
  );
}
