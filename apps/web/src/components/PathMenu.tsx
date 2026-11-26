import { useEffect, useState } from 'react';
import type { PathSuggestion } from '@harv/shared';
import { formatSize } from '../lib/attachments.ts';
import { SuggestionList } from './SuggestionList.tsx';

/**
 * The `@path` being typed at the end of the command line (like Claude Code's): what follows the
 * last `@` that starts a word, up to the end. Spaces are allowed (`@C:\My files\Co`), new lines
 * aren't. Null when there's none.
 */
export function atToken(draft: string): { start: number; query: string } | null {
  const m = /(^|\s)@([^\n@]*)$/.exec(draft);
  if (!m || m[2]!.length > 260) return null;
  return { start: m.index + m[1]!.length, query: m[2]! };
}

/** A folder's path ready to type inside it (`C:\Users\me` → `C:\Users\me\`, `/home/me` → `/home/me/`). */
export function insideFolder(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  return path.endsWith(sep) ? path : path + sep;
}

/** The draft with the `@path` taken out (it becomes a chip instead). */
export const withoutToken = (draft: string, start: number) => draft.slice(0, start).replace(/[ \t]+$/, start > 0 ? ' ' : '');

/** Suggestions for what's typed after `@`, from the server's disk (GET /api/paths), a moment after typing stops. */
export function usePathSuggestions(query: string | null): PathSuggestion[] {
  // Each answer is kept with the query it answers, so an older one never shows for newer typing.
  const [answer, setAnswer] = useState<{ query: string; items: PathSuggestion[] }>({ query: '', items: [] });
  useEffect(() => {
    if (query === null) return;
    let live = true;
    const timer = setTimeout(() => {
      fetch(`/api/paths?q=${encodeURIComponent(query)}`)
        .then((r) => (r.ok ? (r.json() as Promise<PathSuggestion[]>) : []))
        .then((items) => live && setAnswer({ query, items }))
        .catch(() => live && setAnswer({ query, items: [] }));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  return query !== null && answer.query === query ? answer.items : [];
}

/** The list above the command line while an `@path` is typed: Enter attaches, Tab walks into a folder. */
export function PathMenu({ items, index, onPick }: { items: PathSuggestion[]; index: number; onPick: (s: PathSuggestion) => void }) {
  return (
    <SuggestionList
      label="Files and folders"
      items={items}
      index={index}
      onPick={onPick}
      keyOf={(s) => s.path}
      titleOf={(s) => s.path}
      row={(s) => (
        <>
          <span aria-hidden="true" className="w-3 flex-none text-accent">
            {s.folder ? '▸' : '·'}
          </span>
          <span className="min-w-0 truncate text-ink">
            {s.name}
            {s.folder && s.name !== s.path ? '/' : ''}
          </span>
          <span className="ml-auto flex-none text-faint">{s.folder ? 'folder' : formatSize(s.size)}</span>
        </>
      )}
      footer={
        <li aria-hidden="true" className="px-3 pt-1 text-[11px] text-faint">
          Enter attaches it by path (nothing is copied) · Tab opens a folder · Esc closes
        </li>
      }
    />
  );
}
