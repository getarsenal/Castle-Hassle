// After `vite build`, the single self-contained file lands at www/index.dev.html
// (named after the input template). Copy it to the two places that get deployed
// and remove the oddly-named original. Cross-platform (no shell `cp`) so it runs
// the same on Windows, macOS, and the Codemagic/CI Linux runners.
import { copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'www', 'index.dev.html');

if (!existsSync(src)) {
  console.error('postbuild: expected build output not found at', src);
  process.exit(1);
}

// Stamp the build so any device can prove WHICH build it is showing
// (Settings displays window.__BUILD — ends the "did the deploy land?" guessing)
let sha = 'local';
try { sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* no git in some CI images */ }
const when = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const stamped = readFileSync(src, 'utf8').replace('</body>', `<script>window.__BUILD='${sha} \u00b7 ${when}';</script></body>`);
writeFileSync(src, stamped);

copyFileSync(src, resolve(root, 'www', 'index.html')); // Capacitor webDir
copyFileSync(src, resolve(root, 'index.html'));        // repo-root deployable
rmSync(src);

// Vite copies everything in public/ into www/. Mirror the icon/preview assets to
// the repo root too, so the directly-deployable set (index.html + icons) is
// self-contained when you drop it at getarsenal.app/castle-hassle/.
for (const f of ['icon.png', 'icon-512.png', 'icon-192.png', 'apple-touch-icon.png', 'favicon.png', 'title.png', 'og.jpg', 'manifest.webmanifest', 'intro.mp4', 'theme.mp3',
  'archers-shot.mp3', 'battle-cries.mp3', 'battle-swords-1.mp3', 'battle-swords-2.mp3', 'cavalry-charge-loop.mp3', 'siege-background-drum.mp3', 'trebuchet-firing.mp3', 'trebuchet-hit-crash.mp3', 'trumpet.mp3']) {
  const from = resolve(root, 'www', f);
  if (existsSync(from)) copyFileSync(from, resolve(root, f));
}

console.log('postbuild: wrote self-contained index.html (+ icons) to repo root and www/');
