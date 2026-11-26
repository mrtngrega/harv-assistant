import { MAX_ATTACHMENT_BYTES, type Attachment } from '@harv/shared';

/** Uploads one file into the tab's attachment folder on the Harv server. */
export async function uploadAttachment(tabId: string, file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit`);
  const params = new URLSearchParams({ tab: tabId, name: file.name || 'pasted-image.png' });
  const res = await fetch(`/api/attachments?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `upload failed (${res.status})`);
  }
  return (await res.json()) as Attachment;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
