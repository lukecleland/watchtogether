import { WORDS } from "./wordList";

/**
 * Generates a cryptographically random room code by picking a word from the
 * dictionary using `crypto.getRandomValues`. The word is uppercased for display
 * but lowercased when used as a PeerJS peer ID (peer IDs are case-sensitive;
 * lowercasing ensures host and guest always match regardless of how the code
 * was typed or copied).
 */
export function generateCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return WORDS[array[0] % WORDS.length].toUpperCase();
}

/** Reads the `?room=` URL query parameter. Returns null if not present. */
export function getCodeFromURL(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("room");
}

/** Writes `code` into the `?room=` query parameter using pushState (no page reload). */
export function setCodeInURL(code: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  window.history.replaceState(null, "", url.toString());
}
