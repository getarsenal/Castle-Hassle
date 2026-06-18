import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Build the ENTIRE game (three.js + game code + CSS) inlined into a single
// self-contained www/index.html — no separate assets/ folder. This matches the
// single-file deployment workflow used by the other getarsenal games (copy one
// index.html), and it's what Capacitor bundles into the iOS app (webDir: www).
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: 'www',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
  },
});
