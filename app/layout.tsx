import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拼圖聯盟 OS｜團隊工作空間",
  description: "活動營運、任務流轉、會議協調與跨裝置團隊協作。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}

