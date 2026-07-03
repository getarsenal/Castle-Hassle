// Downscale screenshots so they're safe to attach/read (avoids request-size limits).
import sharp from 'sharp';
for (const f of process.argv.slice(2)) {
  const out = f.replace(/\.(jpe?g|png)$/i, '') + '.small.jpg';
  await sharp(f).resize({ width: 460 }).jpeg({ quality: 62 }).toFile(out);
  console.log(out);
}
