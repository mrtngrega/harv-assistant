import { COMPACT_ROWS, WARN_MARKS, type CompactRow } from '@harv/shared';
import { updateSettings, useSettings } from '../../lib/useHarvSocket.ts';
import { Chips, Choice, Group, Note, Sub, Toggle } from './controls.tsx';

export const ROW_NAMES: Record<CompactRow, string> = {
  cpu: 'CPU',
  gpu: 'GPU',
  ram: 'RAM',
  disk: 'Disk',
  net: 'Net',
  session: 'Session',
  weekly: 'Weekly',
};

export function ChatSection() {
  const settings = useSettings();
  return (
    <>
      <Group title="Chat">
        <Sub title="Messages">
          <Toggle on={settings.showTimes} label="Times on chat lines" onChange={(showTimes) => updateSettings({ showTimes })} />
          <Toggle
            on={settings.showTags}
            label="Model tag on replies"
            hint="The [sonnet·medium] after harv ›. Hover or click it to see why AUTO picked it."
            onChange={(showTags) => updateSettings({ showTags })}
          />
          <Choice
            label="Send with"
            value={settings.sendKey}
            options={[
              { value: 'enter', label: 'Enter' },
              { value: 'ctrlEnter', label: 'Ctrl+Enter' },
            ]}
            onChange={(sendKey) => updateSettings({ sendKey })}
          />
          <Note>{settings.sendKey === 'enter' ? 'Shift+Enter makes a new line.' : 'Enter makes a new line.'}</Note>
        </Sub>
        <Sub title="AUTO">
          <Note>A model you pick in the header stays with that chat until you pick AUTO again; new chats start on AUTO.</Note>
          <Toggle
            on={settings.allowFable}
            label="Let AUTO use Fable"
            hint="For the hardest tasks and as the top of a step-up. Fable needs paid usage credits on Pro now (since 17 Nov), so Harv runs those replies on Opus instead; leave this off."
            onChange={(allowFable) => updateSettings({ allowFable })}
          />
        </Sub>
      </Group>
    </>
  );
}

export function StatsSection() {
  const settings = useSettings();
  return (
    <>
      <Group title="Stats & usage">
        <Sub title="Stats panel">
          <Chips
            label="Narrow view"
            values={settings.compactRows}
            options={COMPACT_ROWS.map((r) => ({ value: r, label: ROW_NAMES[r] }))}
            onChange={(compactRows) => updateSettings({ compactRows })}
          />
        </Sub>
        <Sub title="Usage warnings">
          <Toggle
            on={settings.warnSession.length > 0 || settings.warnWeekly.length > 0}
            label="Warn me at 75% and 90%"
            hint="A note pops up when your Claude plan use crosses 75% or 90% of the session or the week."
            onChange={(on) => updateSettings({ warnSession: on ? WARN_MARKS : [], warnWeekly: on ? WARN_MARKS : [] })}
          />
        </Sub>
      </Group>
    </>
  );
}
