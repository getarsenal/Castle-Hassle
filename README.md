# 🏰 Castle Hassle — The Horror of the Day

A deliberately **disgusting (but strictly SFW)** daily wallpaper, chosen by
community vote, meant to make you *not* want to be on your phone. Every day the
image changes, so you actively avoid opening your phone lest you meet the new
horror of the day.

> Idea: like a "Wikipedia Picture of the Day," but the community votes for the
> most revolting SFW image, and you set it as your phone wallpaper as a
> deterrent.

## The honest constraint (read this first)

**No App Store app can silently reset your Home Screen wallpaper every day on
its own** — iOS sandboxes that. So the "my phone changed itself overnight"
magic has two real paths, and this project provides the backend both consume:

- **iOS** → an **Apple Shortcut** with a daily *Automation* + the built-in
  **Set Wallpaper** action that fetches today's image from this server. Works
  today, no jailbreak. Setup steps are in the app UI and below.
- **Android** → a small native app (planned) can do it fully automatically via
  `WallpaperManager` on a daily background job.

Everything else — voting, the daily "photo of the day" selection, submissions,
moderation, sourcing — is this web app / JSON API.

## What's here

- **Daily selection** — the top community-voted, approved image becomes the
  "Horror of the Day" and stays fixed for the whole calendar day, with a
  cooldown so the same image doesn't repeat on back-to-back days.
- **Community voting** — 👍 "horrifying" / 👎 "not scary enough", one vote per
  browser per image, net-scored leaderboard.
- **Submissions + moderation queue** — anyone can submit an image URL; nothing
  is votable until a human approves it.
- **Wikimedia Commons importer** — pull candidates from curated gross-but-SFW
  categories (deep-sea creatures, parasites, insects, fungi…) straight into the
  moderation queue.
- **Wallpaper endpoint** — `GET /api/wallpaper/today.jpg` 302-redirects to
  today's image bytes, so an iOS Shortcut's "Get Contents of URL" just works.

## Quick start

```bash
npm install
npm run seed          # load the curated starter set (day-one content)
npm start             # http://localhost:3000
```

Optional — pull fresh candidates from Wikimedia Commons into the review queue
(requires outbound network):

```bash
npm run import:wikimedia -- 5   # ~5 images per category
```

### Config

| Env var         | Default          | Purpose                                  |
| --------------- | ---------------- | ---------------------------------------- |
| `PORT`          | `3000`           | HTTP port                                |
| `CH_ADMIN_KEY`  | `dev-admin-key`  | Key for moderation endpoints (set this!) |
| `CH_DB_PATH`    | `data/castle-hassle.db` | SQLite location (`:memory:` for tests) |

## API

Public:

| Method | Path                          | Description                                   |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/api/today`                  | Today's Horror of the Day (auto-selects)      |
| GET    | `/api/wallpaper/today.jpg`    | 302 → today's image bytes (for Shortcuts)     |
| GET    | `/api/candidates`             | Approved images, ranked by net vote score     |
| GET    | `/api/history`                | Past days' horrors                            |
| GET    | `/api/stats`                  | Catalog counts                                |
| POST   | `/api/submit`                 | Submit `{title, image_url, ...}` (→ pending)  |
| POST   | `/api/candidates/:id/vote`    | `{voter_token, value: 1 or -1}`               |

Admin (require header `x-admin-key: <CH_ADMIN_KEY>`):

| Method | Path                            | Description                          |
| ------ | ------------------------------- | ------------------------------------ |
| GET    | `/api/moderation/pending`       | List images awaiting review          |
| POST   | `/api/moderation/:id/approve`   | Make an image votable                 |
| POST   | `/api/moderation/:id/reject`    | Hide an image                         |
| POST   | `/api/moderation/import`        | Import from Wikimedia Commons         |

## iOS auto-wallpaper (the deterrent)

1. **Shortcuts** app → **Automation** → **+** → **Time of Day** → pick a time
   (e.g. 6:00 AM), Daily, **Run Immediately**.
2. Add **Get Contents of URL** → `https://<your-server>/api/wallpaper/today.jpg`
3. Add **Set Wallpaper Photo** → use the downloaded image; turn *off* "Show
   Preview" so it applies silently.

Now every morning your Home & Lock screen becomes the day's new horror. To make
your phone even less inviting, set the automation before your usual wake time.

## Content policy

SFW only: disturbing, gross, unsettling — **nothing sexual or graphically
violent**. Imported and submitted images always pass through the human
moderation queue before they can be voted on or featured. Images from Wikimedia
Commons carry their source link and credit/license.

## Project layout

```
src/
  db.js          SQLite schema + connection
  store.js       Domain logic: submit, vote, leaderboard, daily selection
  wikimedia.js   Wikimedia Commons category importer
  server.js      Express JSON API + static hosting
  seed.js        Curated starter set (npm run seed)
  import-cli.js  CLI importer (npm run import:wikimedia)
public/          Frontend (vote, submit, setup instructions)
test/            node:test suite for the domain logic
```

## Roadmap

- Native Android app (true daily auto-wallpaper via `WallpaperManager`)
- Downscale/crop imports to a phone aspect ratio and cache the bytes
- Accounts / rate limiting to harden voting against ballot-stuffing
- Auto-run the Wikimedia import + a nightly "select tomorrow's horror" job

## Tests

```bash
npm test
```

## License

MIT
