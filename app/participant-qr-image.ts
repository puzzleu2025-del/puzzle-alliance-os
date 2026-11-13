// QR encoder is vendored from the locally available MIT-licensed implementation.
import QRCode from "./qr-vendor/index.cjs";

/** Produces only local QR modules. Four light modules around it are required when rendering. */
export function participantQrModules(token: unknown): boolean[][] {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("INVALID_QR_TOKEN");
  const qr = new QRCode(0, 1); // automatic version, error correction L
  qr.addData(token);
  qr.make();
  const count: number = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => Boolean(qr.isDark(row, col))));
}
