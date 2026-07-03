# Castle Hassle — Live Session Handoff (July 2026)

Branch: `claude/castle-hassle-design-qx278v` — everything committed & pushed through
"Semi-linear campaign route + bulletproof war-trumpet fanfare".
(`HANDOFF.md` is the original June project intro — still right about running/deploying.)

## Deploy model (why some fixes look odd)
One self-contained `index.html` (all assets inlined) + a media whitelist.
`npm run build` = vite → `scripts/postbuild.mjs` copies the bundle + media to repo
root and `www/`. The user drops root `index.html` (+ media) at getarsenal.app —
if a new media file isn't uploaded, references 404 (that's why the trumpet got
INLINED as a data URI in `src/trumpetdata.ts`).

## State: all DONE and verified
- **Battle**: sepia unit sprites (green-key → faction tint, objective-facing
  billboard flip), continuous swept earthwork ring (zig-zag fire trench, gabions,
  stakes; `siegeRingNodes()` in render.ts is the reusable ring path), gritty
  no-man's-land (craters/arrows/burnt wagons/wrecked engine/smoke), somber palette,
  `HP_SCALE = 2.5` in sim.ts (melee ~2.5x longer; ranged scaled to stay lethal;
  walls unscaled), defenders plug breaches (2 companies/breach), wall-climb
  "flying" fixed (climb down inner face), raid labels match difficulty.
- **Meta**: 3 save slots, profile/settings/difficulty/achievements, battle+map
  tutorials, defeat handling, veterancy, war council upgrades, raids ladder.
- **Title**: logo splash → single "Sound the War Trumpets" button → inlined
  fanfare (pre-decoded `Audio`), intro sting ducks 16%→100% over 2.6s beneath it.
- **Campaign map** (`worldmap3d.ts`): 2x-upsampled fractal terrain (slope crags,
  farmland quilt, smooth band blends), A*-routed winding roads (water impassable,
  climbs dear; no-land legs = dashed sea lanes), 15 landmark monuments with city
  sprawl (Venice = island city), per-style castle silhouettes, layout relaxation
  (castles avoid castles AND landmarks, never pushed to sea; landmarks anchored),
  rivers as ribbons, ambient cogs on coast-validated lanes, cog + column march.
- **Campaign order** (`campaign.ts` `generateCastles`): authored region order;
  within-region NN chain + 2-opt; Caernarfon opens, Jerusalem pinned finale.
  Reversals 35→17, march ~6% shorter. NOTE: castle ids shifted → existing saves
  now point at different castles (pre-ship, acceptable).

## 🎬 Director Mode — BUILT (`src/director.ts`)
Promo-recording toolkit, done and verified headless on both scenes.
- Floating 🎬 chip on battle + map opens a panel: smooth signed orbit-speed
  slider, hold-to-nudge pitch/zoom pads, one-tap **Auto-cine** (gentle drift +
  sinusoidal pitch/dolly breathing, applied as derivatives so it composes with
  manual nudges), **Hide HUD**, and **Clean screen** (hides even the chip;
  restore via the invisible bottom-left hot-corner `#dirHot`).
- Drives the live scene through the QA globals only: battle `window.__r`
  (camYaw/camPitch/camDist + `clampTarget()`); map `window.__map`
  (azimuth/pitch/dist + `clampTarget()`, sets `azReset=false` so orbit sticks).
  Map is live ⇔ `#map` has class `show`.
- Enable via `#director` URL hash **or** the Settings toggle (menu.ts
  `openSettings`); persisted at localStorage `castlehassle.director.v1`.
  `window.__director.setDirectorEnabled(bool)` for QA.
- Note: this session was branched onto `claude/castle-route-trumpet-fix-zwj0gf`
  off the design branch (the assigned branch started empty off `main`).

## Headless verification recipe
puppeteer-core + chrome-headless-shell (SwiftShader flags), tiny http server on
repo root — see git history of `scripts/_map3.mjs` for the full template (temp
`scripts/_*.mjs` are deleted before each commit; `scripts/shrink.mjs` stays).
Navigate: wait 2.2s → set localStorage tutorial/maptour flags → click
`#startGameBtn` → pointerdown on `#intro` (skip sting) → click `[data-new="0"]`.
Battles: `__battle(n)` → `#musterBtn` → `#startbtn`; `__sim.assaultAll()`.
Hooks: `__r __map __sim __balance __raids __surveyCastle __audio`.
**Screenshots**: jpeg quality ≤72, deviceScaleFactor ≤1.5, then
`node scripts/shrink.mjs <file>` — and read images SPARINGLY (the previous chat
hit the 32MB request cap and could not read any image by the end).

## Open items
1. User to try Director Mode (Settings → Director Mode, or add `#director` to the
   URL) and confirm the chip/controls feel right for filming.
2. User to eyeball the new campaign route on the map (the fix for their circled
   backtracking screenshot was done blind — image unreadable at the time).
3. Deferred backlog: late-game snowball tuning (use `__balance`), cloud save,
   New Game+, enemy variety, continuous-mound earthworks (sculpt along
   `siegeRingNodes`), app icon swap when the user delivers it.
4. Full user walkthrough before ship — expect bug reports. Tuning dials:
   `HP_SCALE` (sim.ts), breach-plug company count (sim.ts `plugBreach`),
   smoke source counts (render.ts), road width/opacity (worldmap3d.ts).

## Conventions
- Commits: imperative summary, why-focused body, footer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + Claude-Session trailer.
- The user's brief, verbatim north star: "SCALE IS THE name OF THE GAME, big and
  loud" — gritty medieval, enterprise polish, visually impeccable, verify with
  screenshots before claiming done.
