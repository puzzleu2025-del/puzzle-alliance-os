import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { pbkdf2, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "puzzle_admin_session";
export const SESSION_SECONDS = 60 * 60 * 12;
export type MemberSession = { userId: string; username: string; email: string; displayName: string; role: string; via: "password" };
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function tokenHash(token: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))); }
export async function passwordHash(password: string, salt: string) {
  return new Promise<string>((resolve, reject) => pbkdf2(password, salt, 600_000, 32, "sha256", (error, key) => error ? reject(error) : resolve(key.toString("hex"))));
}
export async function verifyPassword(password: string, salt: string, hash: string) {
  const actual = await passwordHash(password, salt);
  return actual.length === hash.length && timingSafeEqual(Buffer.from(actual), Buffer.from(hash));
}
export function csrfError(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "請從本站頁面送出操作" }, { status: 403 });
  return null;
}
export function cookie(token: string, request: Request, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export async function currentToken() {
  const h = await headers();
  return h.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || "";
}
export async function getMember(): Promise<MemberSession | null> {
  if (!env.DB) return null;
  const token = await currentToken();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const member = await env.DB.prepare("SELECT m.user_id AS userId,m.username,m.email,m.display_name AS displayName,m.role FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND m.status='active'").bind(await tokenHash(token), Date.now()).first<Omit<MemberSession, "via">>();
  return member ? { ...member, via: "password" } : null;
}
export async function getAdmin() {
  const member = await getMember();
  return member?.role === "admin" ? member : null;
}
export async function rateLimited(key: string) {
  const now = Date.now(), window = 15 * 60_000;
  const row = await env.DB!.prepare("INSERT INTO auth_attempts (key,attempts,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING attempts").bind(key, now, now-window, now-window).first<{ attempts: number }>();
  return !row || row.attempts > 10;
}
