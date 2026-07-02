import express from 'express';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { fetchCandidates, HORROR_CATEGORIES } from './wikimedia.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(`${__dirname}/../public`));

const ADMIN_KEY = process.env.CH_ADMIN_KEY || 'dev-admin-key';

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'admin key required' });
  next();
}

function toPublic(img) {
  if (!img) return null;
  return {
    id: img.id,
    title: img.title,
    image_url: img.image_url,
    source_url: img.source_url,
    credit: img.credit,
    score: img.score ?? undefined,
    upvotes: img.upvotes ?? undefined,
    downvotes: img.downvotes ?? undefined,
    day: img.day ?? undefined,
  };
}

// --- Public read endpoints -------------------------------------------------

app.get('/api/today', (req, res) => {
  const horror = store.horrorOfTheDay();
  if (!horror) return res.status(404).json({ error: 'no approved images yet' });
  res.json({ day: store.today(), horror: toPublic(horror) });
});

app.get('/api/candidates', (req, res) => {
  res.json({ candidates: store.leaderboard(50).map(toPublic) });
});

app.get('/api/history', (req, res) => {
  res.json({ history: store.recentSelections(30).map(toPublic) });
});

app.get('/api/stats', (req, res) => {
  res.json(store.stats());
});

// The endpoint an iOS Shortcut / Android job hits to grab today's wallpaper.
// 302-redirects straight to the image bytes so "Get Contents of URL" just works.
app.get('/api/wallpaper/today.jpg', (req, res) => {
  const horror = store.horrorOfTheDay();
  if (!horror) return res.status(404).json({ error: 'no approved images yet' });
  res.redirect(302, horror.image_url);
});

// --- Public write endpoints ------------------------------------------------

app.post('/api/submit', (req, res) => {
  const { title, image_url, source_url, credit, submitted_by } = req.body ?? {};
  if (!title || !image_url) {
    return res.status(400).json({ error: 'title and image_url are required' });
  }
  if (!/^https:\/\//i.test(image_url)) {
    return res.status(400).json({ error: 'image_url must be an https URL' });
  }
  try {
    const result = store.addImage({
      title,
      image_url,
      source_url,
      credit,
      submitted_by,
      status: 'pending',
    });
    res.status(result.created ? 201 : 200).json({
      ...result,
      message: result.created
        ? 'Submitted! It will appear once a moderator approves it.'
        : 'That image was already submitted.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/candidates/:id/vote', (req, res) => {
  const id = Number(req.params.id);
  const { voter_token, value } = req.body ?? {};
  try {
    const score = store.vote(id, voter_token, value === -1 ? -1 : 1);
    res.json({ id, score });
  } catch (err) {
    const code = err.message === 'image not found' ? 404 : 400;
    res.status(code).json({ error: err.message });
  }
});

// --- Moderation (admin) ----------------------------------------------------

app.get('/api/moderation/pending', requireAdmin, (req, res) => {
  res.json({ pending: store.listByStatus('pending', 200).map(toPublic) });
});

app.post('/api/moderation/:id/approve', requireAdmin, (req, res) => {
  const ok = store.setStatus(Number(req.params.id), 'approved');
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/moderation/:id/reject', requireAdmin, (req, res) => {
  const ok = store.setStatus(Number(req.params.id), 'rejected');
  res.status(ok ? 200 : 404).json({ ok });
});

// Pull fresh candidates from Wikimedia Commons into the pending queue.
app.post('/api/moderation/import', requireAdmin, async (req, res) => {
  const { categories, perCategory } = req.body ?? {};
  try {
    const found = await fetchCandidates({
      categories: Array.isArray(categories) && categories.length ? categories : HORROR_CATEGORIES,
      perCategory: Number(perCategory) || 5,
    });
    let added = 0;
    for (const item of found) {
      const { created } = store.addImage({ ...item, submitted_by: 'wikimedia-import', status: 'pending' });
      if (created) added += 1;
    }
    res.json({ found: found.length, added, queued_for_review: true });
  } catch (err) {
    res.status(502).json({ error: `import failed: ${err.message}` });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

// Only start listening when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`🏰 Castle Hassle running on http://localhost:${PORT}`);
    console.log(`   Horror-of-the-day API:  GET /api/today`);
    console.log(`   Wallpaper for Shortcut: GET /api/wallpaper/today.jpg`);
    console.log(`   Admin key: ${ADMIN_KEY === 'dev-admin-key' ? '(using insecure dev default — set CH_ADMIN_KEY)' : '(set)'}`);
  });
}

export default app;
