import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'node:path';

// The Vite *source* template is index.dev.html (it references /src/main.ts and
// only works under `vite dev`). The build inlines the ENTIRE game into one
// self-contained file; postbuild.mjs then writes it to BOTH:
//   - index.html       (repo root → the directly-deployable game, committed)
//   - www/index.html   (Capacitor webDir for the iOS app)
// so "deploy the repo's index.html" just works, like the other getarsenal games.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: 'www',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'index.dev.html'),
    },
  },
});
