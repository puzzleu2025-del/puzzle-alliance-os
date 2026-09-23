export async function previewPasswordHash(password: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function previewPasswordMatches(stored: string | undefined, password: string) {
  if (!stored) return false;
  const supplied = await previewPasswordHash(password);
  return stored === supplied || stored === password;
}
