import { defineConfig } from 'vite';

// Relative base so the same build works both as a GitHub Pages project site
// (served from /Castle-Hassle/) and inside the Capacitor iOS WKWebView
// (served from the local file system). Output goes to www/ which is the
// Capacitor webDir.
export default defineConfig({
  base: './',
  build: {
    outDir: 'www',
    emptyOutDir: true,
    target: 'es2020',
  },
});
