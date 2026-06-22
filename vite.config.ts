import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// Stamp the build with the commit + time so the in-game dev panel can show exactly
// which version is running — no more confusing a stale deploy with a code bug.
const BUILD_ID = (() => {
  let hash = 'local';
  try { hash = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git checkout */ }
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${hash} ${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
})();

// The Vite *source* template is index.dev.html (it references /src/main.ts and
// only works under `vite dev`). The build inlines the ENTIRE game into one
// self-contained file; postbuild.mjs then writes it to BOTH:
//   - index.html       (repo root → the directly-deployable game, committed)
//   - www/index.html   (Capacitor webDir for the iOS app)
// so "deploy the repo's index.html" just works, like the other getarsenal games.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  define: { __BUILD__: JSON.stringify(BUILD_ID) },
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
