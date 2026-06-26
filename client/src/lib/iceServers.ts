/**
 * Fetches WebRTC ICE server configuration from the server.
 * The server injects TURN credentials from environment variables so they are
 * never bundled into the client build.
 *
 * Result is cached for the lifetime of the page — ICE servers don't change
 * at runtime, so a single fetch is sufficient.
 */

let _cached: RTCIceServer[] | null = null;

const FALLBACK: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
    ],
  },
];

export async function getIceServers(): Promise<RTCIceServer[]> {
  if (_cached) return _cached;
  try {
    const res = await fetch("/api/ice-servers", { credentials: "include" });
    if (res.ok) {
      const data = (await res.json()) as { iceServers: RTCIceServer[] };
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        _cached = data.iceServers;
        return _cached;
      }
    }
  } catch {
    /* network error — use fallback */
  }
  _cached = FALLBACK;
  return _cached;
}
