/** `GET /api/health` (web backend only; not a command of the center contract). */
export interface WebHealth {
  status: "ok" | "no-target" | "unreachable";
  connected: boolean;
  reason?: string;
  host?: string;
}

/** Read the backend's view of the center; null when the backend itself does not answer. */
export async function fetchHealth(): Promise<WebHealth | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store", redirect: "manual" });
    if (!res.ok) return null;
    return (await res.json()) as WebHealth;
  } catch {
    return null;
  }
}
