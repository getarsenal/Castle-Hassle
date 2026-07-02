// Hand-picked starter set so the app has content on day one.
// All are gross/unsettling but strictly SFW, from Wikimedia Commons.
// Special:FilePath URLs resolve to the current file bytes and are stable.
import * as store from './store.js';

const fp = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;
const page = (file) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`;

export const SEED = [
  {
    title: 'Blobfish (Psychrolutes marcidus)',
    file: 'Psychrolutes_marcidus.jpg',
    credit: 'NORFANZ · Wikimedia Commons',
  },
  {
    title: 'Giant deep-sea isopod',
    file: 'Bathynomus_giganteus.jpg',
    credit: 'NOAA · Wikimedia Commons',
  },
  {
    title: 'Humpback anglerfish',
    file: 'Humpback_anglerfish.png',
    credit: 'Masaki Miya et al. · CC BY 2.0',
  },
  {
    title: 'Engorged tick',
    file: 'Tick_male_(aka).jpg',
    credit: 'André Karwath · CC BY-SA 2.5',
  },
  {
    title: 'Giant centipede (Scolopendra)',
    file: 'Scolopendra_cingulata_-_2.jpg',
    credit: 'Wikimedia Commons',
  },
  {
    title: 'Wolf spider carrying its young',
    file: 'Wolf_spider_with_young.jpg',
    credit: 'Wikimedia Commons',
  },
  {
    title: 'Dog vomit slime mould (Fuligo septica)',
    file: 'Fuligo_septica_-_Lindsey.jpg',
    credit: 'Wikimedia Commons',
  },
  {
    title: 'Lamprey mouth',
    file: 'Lamprey_mouth.jpg',
    credit: 'Wikimedia Commons',
  },
];

export function runSeed() {
  let added = 0;
  for (const item of SEED) {
    const { created } = store.addImage({
      title: item.title,
      image_url: fp(item.file),
      source_url: page(item.file),
      credit: item.credit,
      submitted_by: 'seed',
      status: 'approved', // trusted curated data goes live immediately
    });
    if (created) added += 1;
  }
  return { total: SEED.length, added };
}

// Run directly: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runSeed();
  console.log(`Seeded ${result.added} new image(s) (${result.total} in set).`);
}
