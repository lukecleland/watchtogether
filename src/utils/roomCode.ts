import { WORDS } from "./wordList";

export function generateCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return WORDS[array[0] % WORDS.length].toUpperCase();
}

export function getCodeFromURL(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("room");
}

export function setCodeInURL(code: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  window.history.replaceState(null, "", url.toString());
}
