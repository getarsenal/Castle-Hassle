// CLI: pull candidates from Wikimedia Commons into the pending moderation queue.
// Usage: npm run import:wikimedia [-- perCategory]
import * as store from './store.js';
import { fetchCandidates } from './wikimedia.js';

const perCategory = Number(process.argv[2]) || 5;

console.log(`Fetching ~${perCategory} images per category from Wikimedia Commons...`);
const found = await fetchCandidates({ perCategory });

let added = 0;
for (const item of found) {
  const { created } = store.addImage({ ...item, submitted_by: 'wikimedia-import', status: 'pending' });
  if (created) added += 1;
}

console.log(`Found ${found.length}, queued ${added} new candidate(s) for moderation.`);
console.log('Review them: GET /api/moderation/pending  (needs x-admin-key header)');
