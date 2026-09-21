import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./preview/", import.meta.url)),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "next/navigation": normalizePath(fileURLToPath(new URL("./preview/next-navigation.ts", import.meta.url))),
    },
  },
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("./pages-dist/", import.meta.url)),
    emptyOutDir: true,
    modulePreload: false,
  },
  server: {host:"127.0.0.1",port:5174,strictPort:true},
  preview: {host:"127.0.0.1",port:4173,strictPort:true}
});
