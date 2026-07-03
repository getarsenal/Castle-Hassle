// Downscale screenshots so they're safe to attach/read (avoids request-size limits).
let sharp;
try { sharp = (await import('sharp')).default; }
catch { console.error('shrink: sharp not installed (npm i sharp) — leaving files untouched'); process.exit(0); }
for (const f of process.argv.slice(2)) {
  const out = f.replace(/\.(jpe?g|png)$/i, '') + '.small.jpg';
  await sharp(f).resize({ width: 460 }).jpeg({ quality: 62 }).toFile(out);
  console.log(out);
}
