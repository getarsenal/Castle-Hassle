import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Use an isolated in-memory DB for every run.
process.env.CH_DB_PATH = ':memory:';

let store;
before(async () => {
  store = await import('../src/store.js');
});

test('addImage queues as pending by default and dedupes by URL', () => {
  const a = store.addImage({ title: 'Tick', image_url: 'https://x/tick.jpg' });
  assert.equal(a.created, true);
  const dup = store.addImage({ title: 'Tick again', image_url: 'https://x/tick.jpg' });
  assert.equal(dup.created, false);
  assert.equal(dup.id, a.id);
  assert.equal(store.getImage(a.id).status, 'pending');
});

test('cannot vote on unapproved images', () => {
  const { id } = store.addImage({ title: 'Pending', image_url: 'https://x/p.jpg' });
  assert.throws(() => store.vote(id, 'voter1', 1), /not open for voting/);
});

test('voting is one-per-voter and net-scored', () => {
  const { id } = store.addImage({ title: 'Blob', image_url: 'https://x/blob.jpg', status: 'approved' });
  assert.equal(store.vote(id, 'a', 1), 1);
  assert.equal(store.vote(id, 'b', 1), 2);
  assert.equal(store.vote(id, 'c', -1), 1); // net = +1 +1 -1
  // Re-voting overwrites, does not stack.
  assert.equal(store.vote(id, 'a', -1), -1); // a flips: -1 +1 -1 = -1
});

test('leaderboard ranks by net score', () => {
  const low = store.addImage({ title: 'Low', image_url: 'https://x/low.jpg', status: 'approved' });
  const high = store.addImage({ title: 'High', image_url: 'https://x/high.jpg', status: 'approved' });
  store.vote(high.id, 'a', 1);
  store.vote(high.id, 'b', 1);
  store.vote(low.id, 'a', 1);
  const board = store.leaderboard();
  const highRow = board.find((r) => r.id === high.id);
  const lowRow = board.find((r) => r.id === low.id);
  assert.ok(board.indexOf(highRow) < board.indexOf(lowRow));
  assert.equal(highRow.score, 2);
});

test('horrorOfTheDay picks top image and stays fixed for the day', () => {
  const day = '2026-01-01';
  const winner = store.addImage({ title: 'Winner', image_url: 'https://x/win.jpg', status: 'approved' });
  store.vote(winner.id, 'a', 1);
  store.vote(winner.id, 'b', 1);
  store.vote(winner.id, 'c', 1);
  const first = store.horrorOfTheDay(day);
  assert.equal(first.id, winner.id);
  // Even if a new image out-votes it later, today's pick is locked.
  const challenger = store.addImage({ title: 'Challenger', image_url: 'https://x/ch.jpg', status: 'approved' });
  for (const v of ['d', 'e', 'f', 'g']) store.vote(challenger.id, v, 1);
  const second = store.horrorOfTheDay(day);
  assert.equal(second.id, winner.id, 'selection must not change within the same day');
});

test('cooldown avoids repeating a recent horror on consecutive days', () => {
  process.env.CH_DB_PATH = ':memory:';
  const A = store.addImage({ title: 'A', image_url: 'https://y/a.jpg', status: 'approved' });
  const B = store.addImage({ title: 'B', image_url: 'https://y/b.jpg', status: 'approved' });
  store.vote(A.id, 'a', 1); // A leads
  const d1 = store.horrorOfTheDay('2026-02-01', { cooldownDays: 7 });
  const d2 = store.horrorOfTheDay('2026-02-02', { cooldownDays: 7 });
  assert.notEqual(d2.id, d1.id, 'consecutive days should differ when alternatives exist');
});
