import { useRef, useState } from 'react';
import { jumpTo } from '../lib/settingsJump.ts';
import { INPUT, useSettingsNav } from './settings/controls.tsx';
import { AppearanceSection } from './settings/appearance.tsx';
import { ChatSection, StatsSection } from './settings/chat.tsx';
import { SafetySection } from './settings/safety.tsx';
import { AbilitiesSection } from './settings/abilities.tsx';
import { ProjectsSection } from './settings/projects.tsx';
import { ComputerSection } from './settings/computer.tsx';

// Settings: the section list, the search, and the sections in order (each in settings/<section>.tsx, 2026-11-15).
export function SettingsView() {
  const content = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const { groups, current, empty } = useSettingsNav(content, query);

  return (
    // Big sections, one under the other; their subsections flow in two columns when there's room (the user's wish, 2026-10-27).
    // On wide windows the section list sits beside them.
    <div className="animate-fade-in mx-auto flex w-full max-w-[1220px] items-start gap-6">
      <nav aria-label="Settings sections" className="sticky top-0 hidden w-44 flex-none flex-col gap-0.5 pt-12 @5xl:flex">
        {groups.map((g) => (
          <button
            key={g}
            type="button"
            aria-current={g === current ? 'true' : undefined}
            onClick={() => jumpTo(g)}
            className={`min-h-8 cursor-pointer rounded-lg px-3 text-left text-xs hover:bg-white/5 ${
              g === current ? 'bg-white/10 text-ink' : 'text-muted'
            }`}
          >
            {g}
          </button>
        ))}
      </nav>
      <div ref={content} className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Find a setting…"
            aria-label="Find a setting"
            className={`${INPUT} max-w-64`}
          />
        </div>
        {/* Narrower panes: the same list as one row of chips (only the search was left to jump with: the full review, R2). */}
        <nav aria-label="Settings sections" className="-mt-1 flex gap-1.5 overflow-x-auto px-1 pb-1 @5xl:hidden">
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              aria-current={g === current ? 'true' : undefined}
              onClick={() => jumpTo(g)}
              className={`min-h-7 flex-none cursor-pointer rounded-full border px-3 text-[11px] whitespace-nowrap hover:bg-white/5 ${
                g === current ? 'border-accent/40 bg-white/10 text-ink' : 'border-[rgb(220_232_245/0.14)] text-muted'
              }`}
            >
              {g}
            </button>
          ))}
        </nav>
        {empty && <p className="m-0 px-1 text-xs text-muted">No setting matches “{query}”.</p>}

        <AppearanceSection />
        <ChatSection />
        <StatsSection />
        <SafetySection />
        <AbilitiesSection />
        <ProjectsSection />
        <ComputerSection />
      </div>
    </div>
  );
}
