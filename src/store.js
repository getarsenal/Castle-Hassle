import db from './db.js';

/** Today's date in YYYY-MM-DD (UTC). Override for testing/timezones. */
export function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Add a candidate image. New images land in the moderation queue as `pending`
 * unless explicitly approved (e.g. trusted curated seed data).
 * Returns { id, created } — created=false if the URL already existed.
 */
export function addImage({ title, image_url, source_url, credit, submitted_by, status }) {
  if (!title || !image_url) throw new Error('title and image_url are required');
  const existing = db.prepare('SELECT id FROM images WHERE image_url = ?').get(image_url);
  if (existing) return { id: existing.id, created: false };

  const info = db
    .prepare(
      `INSERT INTO images (title, image_url, source_url, credit, submitted_by, status)
       VALUES (@title, @image_url, @source_url, @credit, @submitted_by, @status)`
    )
    .run({
      title,
      image_url,
      source_url: source_url ?? null,
      credit: credit ?? null,
      submitted_by: submitted_by ?? null,
      status: status ?? 'pending',
    });
  return { id: info.lastInsertRowid, created: true };
}

export function setStatus(id, status) {
  const info = db.prepare('UPDATE images SET status = ? WHERE id = ?').run(status, id);
  return info.changes > 0;
}

export function getImage(id) {
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id);
}

export function listByStatus(status, limit = 100) {
  return db
    .prepare('SELECT * FROM images WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(status, limit);
}

/**
 * Cast (or change) a vote. value must be +1 or -1. One vote per voter per image;
 * re-voting overwrites the previous value. Returns the image's new score.
 */
export function vote(imageId, voterToken, value = 1) {
  if (![1, -1].includes(value)) throw new Error('vote value must be 1 or -1');
  const img = getImage(imageId);
  if (!img) throw new Error('image not found');
  if (img.status !== 'approved') throw new Error('image is not open for voting');
  if (!voterToken) throw new Error('voter token required');

  db.prepare(
    `INSERT INTO votes (image_id, voter_token, value) VALUES (?, ?, ?)
     ON CONFLICT (image_id, voter_token) DO UPDATE SET value = excluded.value`
  ).run(imageId, voterToken, value);

  return scoreFor(imageId);
}

export function scoreFor(imageId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE image_id = ?')
    .get(imageId);
  return row.score;
}

/**
 * Approved candidates ranked by net score (upvotes minus downvotes), newest as
 * tie-breaker. This is the leaderboard the community is fighting over.
 */
export function leaderboard(limit = 50) {
  return db
    .prepare(
      `SELECT i.*,
              COALESCE(SUM(v.value), 0)                       AS score,
              COALESCE(SUM(CASE WHEN v.value = 1  THEN 1 END), 0) AS upvotes,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 END), 0) AS downvotes
         FROM images i
         LEFT JOIN votes v ON v.image_id = i.id
        WHERE i.status = 'approved'
        GROUP BY i.id
        ORDER BY score DESC, i.created_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/**
 * The Horror of the Day. If a selection already exists for `day` we return it
 * (the image is fixed for the whole day). Otherwise we pick the top-voted
 * approved image that has NOT been featured in the last `cooldownDays`, record
 * it, and return it. Returns null if there are no eligible images at all.
 */
export function horrorOfTheDay(day = today(), { cooldownDays = 7 } = {}) {
  const existing = db
    .prepare(
      `SELECT i.*, d.score_at_pick AS score
         FROM daily_selections d JOIN images i ON i.id = d.image_id
        WHERE d.day = ?`
    )
    .get(day);
  if (existing) return existing;

  // Candidates: approved, and not featured within the cooldown window.
  const board = leaderboard(200).filter((img) => !featuredRecently(img.id, day, cooldownDays));
  // If everything is on cooldown (small catalogs), fall back to the full board.
  const pick = board[0] ?? leaderboard(1)[0];
  if (!pick) return null;

  db.prepare(
    'INSERT OR IGNORE INTO daily_selections (day, image_id, score_at_pick) VALUES (?, ?, ?)'
  ).run(day, pick.id, pick.score);

  // Re-read to guard against a race where another request inserted first.
  return horrorOfTheDay(day, { cooldownDays });
}

function featuredRecently(imageId, day, cooldownDays) {
  const row = db
    .prepare(
      `SELECT 1 FROM daily_selections
        WHERE image_id = ?
          AND day < ?
          AND day >= date(?, '-' || ? || ' days')
        LIMIT 1`
    )
    .get(imageId, day, day, cooldownDays);
  return !!row;
}

export function recentSelections(limit = 30) {
  return db
    .prepare(
      `SELECT d.day, d.score_at_pick AS score, i.*
         FROM daily_selections d JOIN images i ON i.id = d.image_id
        ORDER BY d.day DESC LIMIT ?`
    )
    .all(limit);
}

export function stats() {
  const c = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    approved: c("SELECT COUNT(*) n FROM images WHERE status = 'approved'"),
    pending: c("SELECT COUNT(*) n FROM images WHERE status = 'pending'"),
    rejected: c("SELECT COUNT(*) n FROM images WHERE status = 'rejected'"),
    total_votes: c('SELECT COUNT(*) n FROM votes'),
    days_featured: c('SELECT COUNT(*) n FROM daily_selections'),
  };
}
