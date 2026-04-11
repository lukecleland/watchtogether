const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCode(): string {
  let code = "";
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  for (const byte of array) {
    code += CHARS[byte % CHARS.length];
  }
  return code;
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
