// After `vite build`, the single self-contained file lands at www/index.dev.html
// (named after the input template). Copy it to the two places that get deployed
// and remove the oddly-named original. Cross-platform (no shell `cp`) so it runs
// the same on Windows, macOS, and the Codemagic/CI Linux runners.
import { copyFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'www', 'index.dev.html');

if (!existsSync(src)) {
  console.error('postbuild: expected build output not found at', src);
  process.exit(1);
}

copyFileSync(src, resolve(root, 'www', 'index.html')); // Capacitor webDir
copyFileSync(src, resolve(root, 'index.html'));        // repo-root deployable
rmSync(src);

// Vite copies everything in public/ into www/. Mirror the icon/preview assets to
// the repo root too, so the directly-deployable set (index.html + icons) is
// self-contained when you drop it at getarsenal.app/castle-hassle/.
for (const f of ['icon.png', 'icon-512.png', 'icon-192.png', 'apple-touch-icon.png', 'favicon.png', 'og.jpg', 'manifest.webmanifest', 'intro.mp4']) {
  const from = resolve(root, 'www', f);
  if (existsSync(from)) copyFileSync(from, resolve(root, f));
}

console.log('postbuild: wrote self-contained index.html (+ icons) to repo root and www/');
