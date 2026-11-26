/**
 * Per-device conveniences in localStorage (a remembered folder, a model pick, the phone's spot).
 * Storage can be blocked or empty (a private window, cleared site data), so reads fall back and
 * writes fail quietly: nothing here may be needed for the dashboard to work.
 */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage: it just won't survive a reload.
  }
}
