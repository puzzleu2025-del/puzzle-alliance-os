"use client";

import { useState } from "react";
import { REGISTRATION_IMAGE_BYTES, registrationImageBytes } from "./registration-types";

export function RegistrationImage({ value, alt }: { value?: string; alt: string }) {
  if (registrationImageBytes(value) === null) return null;
  // Raster uploads are embedded locally rather than sent to an image proxy.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={value} alt={alt} style={{ display: "block", maxWidth: "100%", maxHeight: 420, height: "auto", objectFit: "contain", borderRadius: 10 }} />;
}

async function compressImage(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("請選擇 PNG、JPEG 或 WebP 圖片");
  if (file.size > 10 * 1024 * 1024) throw new Error("原始圖片不得超過 10 MB");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("無法讀取圖片，請選擇有效圖片")); image.src = url; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error("圖片尺寸過大，請先縮小圖片");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("此裝置無法處理圖片");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png");
    if (registrationImageBytes(png) !== null) return png;
    // JPEG fallback uses white for transparent pixels and reduces dimensions as needed.
    for (let attempt = 0; attempt < 6; attempt++) {
      context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL("image/jpeg", Math.max(.45, .85 - attempt * .08));
      if (registrationImageBytes(result) !== null) return result;
      canvas.width = Math.max(1, Math.round(canvas.width * .8)); canvas.height = Math.max(1, Math.round(canvas.height * .8));
    }
    throw new Error(`圖片壓縮後仍超過 ${REGISTRATION_IMAGE_BYTES / 1024} KB，請換較小的圖片`);
  } finally { URL.revokeObjectURL(url); }
}

export default function RegistrationImageUpload({ label, value, onChange, disabled, onProcessing }: { label: string; value?: string; onChange: (value?: string) => void; disabled: boolean; onProcessing?: (busy: boolean) => void }) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  return <div className="registration-image-upload" aria-busy={processing}>
    <label><span>{label}</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || processing} onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      setError(""); setProcessing(true); onProcessing?.(true);
      try { onChange(await compressImage(file)); } catch (reason) { setError(reason instanceof Error ? reason.message : "圖片上傳失敗"); }
      finally { setProcessing(false); onProcessing?.(false); }
    }} /></label>
    <small>{processing ? "正在縮小圖片…" : "PNG、JPEG、WebP；自動縮小至每張 256 KB，整份表單圖片上限 1 MB。"}</small>
    {error && <p role="alert">{error}</p>}
    <RegistrationImage value={value} alt={label} />
    {value && <button type="button" disabled={disabled || processing} onClick={() => { onChange(undefined); setError(""); }}>移除圖片</button>}
  </div>;
}
