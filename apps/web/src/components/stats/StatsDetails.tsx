import { useState } from 'react';
import type { LhmLaunchResult, MetricsSnapshot } from '@harv/shared';
import { countDuplicates, duration, temperature, gb, ghz, pct, rate, sizePair, watts } from '../../lib/format.ts';
import { useConnection } from '../../lib/useHarvSocket.ts';
import { ActionLog } from './ActionLog.tsx';
import { anyRow, BarList, Card, More, Rows, ThreadBars } from './parts.tsx';

/** "1 volume", "4 volumes". */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Ryzen 7 5800X", "Ryzen 5 PRO 5600U": without the maker, the core count or the built-in graphics. */
const shortCpu = (name: string) =>
  name
    .replace(/^AMD |^Intel\(R\) Core\(TM\) /, '')
    .replace(/ \d+-Core Processor$/, '')
    .replace(/ with Radeon .*$/, '');
const shortGpu = (name: string) => name.replace(/^NVIDIA GeForce |^AMD Radeon /, '');

/** "38% · 377 / 377 rpm", or whichever half is available. */
function gpuFans(fanPct: number | undefined, rpm: number[]): string | undefined {
  const parts = [fanPct !== undefined ? pct(fanPct) : '', rpm.length ? `${rpm.map(Math.round).join(' / ')} rpm` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

const LAUNCH_MESSAGES: Record<LhmLaunchResult, string> = {
  'already-running': 'LibreHardwareMonitor is running; sensors will appear in a moment.',
  started: 'Started. Sensors will appear in a moment.',
  declined: 'The Windows prompt was declined. Click again and choose Yes.',
  'not-installed': 'The sensor program isn’t installed. Ask Harv: “install the hardware sensors”.',
  failed: 'Couldn’t start the sensors. Ask Harv to look at why.',
};

function SensorsOffline() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/sensors/start', { method: 'POST' });
      const { result } = (await res.json()) as { result: LhmLaunchResult };
      setMessage(LAUNCH_MESSAGES[result]);
    } catch {
      setMessage(LAUNCH_MESSAGES.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-black/20 p-3 text-xs leading-relaxed text-muted">
      <p className="m-0">LibreHardwareMonitor isn't running, so temperatures, fans, power and drive health are hidden.</p>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="min-h-9 cursor-pointer self-start rounded-lg border border-line bg-white/5 px-3 text-ink hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? 'Waiting for Windows prompt…' : 'Start sensors'}
      </button>
      {message && <p className="m-0 text-ink">{message}</p>}
    </div>
  );
}

type DriveInfo = MetricsSnapshot['drives'][number];

/**
 * A drive worth a look without asking: hot (60 °C+) or worn (under 50% life left). One already shown
 * stays until it's 3 °C cooler, so a drive near 60 °C doesn't jump in and out (the full review, U5).
 */
const needsLook = (d: DriveInfo, shown = false) => (d.tempC ?? 0) >= (shown ? 57 : 60) || (d.lifePct !== undefined && d.lifePct < 50);

function Drive({ d, deg }: { d: DriveInfo; deg: (n: number | undefined) => string | undefined }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="truncate text-[11px] text-muted">{d.name}</div>
      <Rows
        rows={[
          ['Temp', deg(d.tempC)],
          ['Life', pct(d.lifePct)],
          ['Read', d.readBps !== undefined ? rate(d.readBps) : undefined],
          ['Write', d.writeBps !== undefined ? rate(d.writeBps) : undefined],
        ]}
      />
    </div>
  );
}

export function StatsDetails({ m }: { m: MetricsSnapshot }) {
  // LibreHardwareMonitor is a Windows program; on Linux the sensors come without it.
  const onWindows = useConnection().platform === 'windows';
  const deg = (n: number | undefined) => temperature(n);
  const { cpu, gpu, memory, network, cooling } = m;
  const cpuMore: [string, string | undefined][] = [
    ['Clock', ghz(cpu.clockMhz)],
    ['Peak temp', deg(cpu.peakTempC)],
  ];
  const gpuMore: [string, string | undefined][] = gpu
    ? [
        ['Hotspot', deg(gpu.hotspotC)],
        ['Core clock', ghz(gpu.coreClockMhz)],
        ['Mem clock', ghz(gpu.memClockMhz)],
        ['Fans', gpuFans(gpu.fanPct, gpu.fanRpm)],
      ]
    : [];
  // A fan that has spun keeps its row ("stopped" at 0 rpm): a fan starting and stopping moved the
  // whole panel 22 px (the full review, U5). Headers that never spin stay out.
  const [spun, setSpun] = useState<string[]>([]);
  const newlySpun = (cooling?.fans ?? []).filter((f) => Math.round(f.value) > 0 && !spun.includes(f.name)).map((f) => f.name);
  if (newlySpun.length) setSpun([...spun, ...newlySpun]);
  const spinning = cooling?.fans.filter((f) => spun.includes(f.name) || newlySpun.includes(f.name)) ?? [];
  const [looked, setLooked] = useState<string[]>([]);
  const lookNow = m.drives.filter((d) => needsLook(d, looked.includes(d.name))).map((d) => d.name);
  if (lookNow.join('\n') !== looked.join('\n')) setLooked(lookNow);
  const lookedAt = new Set(lookNow);

  return (
    <>
      {onWindows && !m.sources.lhm && <SensorsOffline />}

      <Card title="CPU" sub={`${shortCpu(cpu.name)} · ${cpu.cores}C/${cpu.threads}T`} value={pct(cpu.load)} load={cpu.load}>
        {cpu.perThread.length > 0 && <ThreadBars loads={cpu.perThread} />}
        <Rows
          rows={[
            ['Temp', deg(cpu.tempC)],
            ['Power', watts(cpu.powerW)],
            // Here, not among the fans: it isn't a cooling value (the full review, R7).
            ['Uptime', duration(m.uptimeSec)],
          ]}
        />
        <BarList title="Top processes" items={cpu.topByCpu.map((p) => ({ name: p.name, value: `${p.cpu.toFixed(1)}%`, share: p.cpu }))} />
        <More has={anyRow(cpuMore)}>
          <Rows rows={cpuMore} />
        </More>
      </Card>

      {gpu && (
        <Card title="GPU" sub={shortGpu(gpu.name)} value={pct(gpu.load)} load={gpu.load}>
          <Rows
            rows={[
              ['Temp', deg(gpu.tempC)],
              [
                'VRAM',
                gpu.vramUsedMb !== undefined && gpu.vramTotalMb !== undefined
                  ? `${(gpu.vramUsedMb / 1024).toFixed(1)} / ${(gpu.vramTotalMb / 1024).toFixed(gpu.vramTotalMb % 1024 ? 1 : 0)} GB`
                  : undefined,
              ],
              ['Power', watts(gpu.powerW)],
            ]}
          />
          <More has={anyRow(gpuMore)}>
            <Rows rows={gpuMore} />
          </More>
        </Card>
      )}

      <Card title="Memory" sub={gb(memory.totalBytes, 0)} value={pct(memory.load)} load={memory.load}>
        <Rows
          rows={[
            ['Used', gb(memory.usedBytes)],
            ['Available', gb(memory.availableBytes)],
          ]}
        />
        <BarList
          title="Top processes"
          items={memory.topByMem.map((p) => ({ name: p.name, value: gb(p.memBytes), share: (p.memBytes / memory.totalBytes) * 100 }))}
        />
        <More has={!!memory.committedBytes || memory.modules.length > 0}>
          <Rows rows={[['Committed', memory.committedBytes ? gb(memory.committedBytes) : undefined]]} />
          {memory.modules.length > 0 && (
            <div className="text-[11px] leading-relaxed text-muted">{countDuplicates(memory.modules).join(' · ')}</div>
          )}
        </More>
      </Card>

      {(m.volumes.length > 0 || m.drives.length > 0) && (
        <Card
          title="Storage"
          sub={[plural(m.volumes.length, 'volume'), m.drives.length ? plural(m.drives.length, 'drive') : ''].filter(Boolean).join(' · ')}
        >
          <BarList
            title="Volumes"
            items={m.volumes.map((v) => ({ name: v.mount, value: sizePair(v.usedBytes, v.totalBytes), share: v.load }))}
          />
          {/* A drive shows by itself only when it's hot or worn; the rest wait behind "more". */}
          {m.drives
            .filter((d) => lookedAt.has(d.name))
            .map((d) => (
              <Drive key={d.name} d={d} deg={deg} />
            ))}
          <More has={m.drives.some((d) => !lookedAt.has(d.name))}>
            {m.drives
              .filter((d) => !lookedAt.has(d.name))
              .map((d) => (
                <Drive key={d.name} d={d} deg={deg} />
              ))}
          </More>
        </Card>
      )}

      {network && (
        <Card
          title="Network"
          sub={network.adapters.map((a) => a.name).join(' · ')}
          value={rate(network.downBps)}
          load={network.utilization}
        >
          <Rows
            rows={[
              ['Down', rate(network.downBps)],
              ['Up', rate(network.upBps)],
            ]}
          />
        </Card>
      )}

      {cooling && (
        <Card title="Cooling" sub="fans & board" value={plural(spinning.filter((f) => Math.round(f.value) > 0).length, 'fan')}>
          {/* Fans that never spun are left out; board sensors wait behind "more". */}
          <Rows
            rows={[...spinning.map((f): [string, string] => [f.name, Math.round(f.value) > 0 ? `${Math.round(f.value)} rpm` : 'stopped'])]}
          />
          <More has={cooling.boardTempsC.length > 0}>
            <Rows rows={cooling.boardTempsC.map((t): [string, string] => [t.name.replace('Temperature', 'Board'), deg(t.value)])} />
          </More>
        </Card>
      )}

      <div className="mt-1 border-t border-line px-1 pt-2.5 text-[11px] tracking-[2px] text-muted">HARV</div>
      <ActionLog />
    </>
  );
}
