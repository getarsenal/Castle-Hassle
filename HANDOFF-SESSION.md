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

## Battle-beauty batch (July 2026, after Director Mode)
Grade/stonework/atmosphere passes are all in `render.ts` (see git history).
Notables for future sessions:
- **Time of day**: each castle rolls dawn/noon/dusk/night from its seed
  (`newGame` in main.ts). Override with localStorage `castlehassle.tod` =
  `dawn|noon|dusk|night` — for QA and Director-Mode promo filming.
- Sim exposes `clashes`/`fireLands` (flat x,z pairs, drained by render) for
  melee sparks + town ignition — pure output logs, determinism untouched.
- Auto-director drifts the camera to the freshest breach / thickest melee after
  ~7s of no input; any pointer/wheel input cancels (also cancels the assault
  intro crane, `renderer.cinematicIntro()`).
- `renderer.heroVictory()`: keep banner swap on win. Burning houses capped at 6.
- Adaptive score: audio.ts drives drum gain from siege heat, cries from melee.

## Combat overhaul (July 2026 — the deep dive)
The sim gained a full combat-resolution layer; `scripts/simbench.mjs N mins`
fights scripted battles across seeds (THE tuning instrument — run before/after
any combat change; naive-assault baseline ~6/8 wins, 56s-185s durations).
- **Morale**: live per-company nerve (casualties, flank/rear blows, contagious
  fear capped at 3 neighbours) with SHAKEN → BROKEN states, self-rally for
  attackers, `rallyDiv()` horn, `generalsPush()` (once/battle). Constants MOR_*.
- **Counters**: flank ×1.3 / rear ×1.6, heavy spears vs cavalry, braced
  shield-wall balks charges (horse takes spearpoints), charge knockback+stagger.
- **Body blocking**: enemies are solid (ENEMY_BLOCK_*) — lines are fought
  through; same-faction spacing widened for sprite depth.
- **LOS**: ground archers can't shoot through walls/buildings (`losClear`);
  elevated shooters blocked only by cover at the target end. Ballistae too.
- **Crews**: 'Engine Crews' (2/engine, div=Siege, crewFor links) — engines idle
  without them; fire arrows burn engines ×3. 'Ballista Crews' on walls.
- **Defence director** (`stepDefence`): pre-plugs threatened walls/gates (hp<62%
  or ram) with tight close-order companies (u.tight), replenishes broken plugs,
  counter-masses vs attackers inside (keep guard never leaves). Castellan
  personalities seeded per castle (cmd.*: Baldric/Odo/Renaud/Hugh) scale
  behaviour with difficulty. Gatehouse OIL while manned (sfx.oil/oilPours).
- **War Council**: branching doctrine trees (upgrades.ts) — per-arm A/B paths,
  per-arm buffs plumbed via AtkBuff.hpA/dmgA/spdA/cdA/rngA/ammoA + chargeMul/
  braceMul/lightFlank/firepot/surgeons. Old saves migrate via treeState legacy.
- **Firepots**: siege path B — incendiary ammo toggle (tools), burning ground
  patches (sim.burnPatches → flameMesh slots 6-15), houses ignite.
- **Desktop**: WASD/QE/RF camera, 1-5 arm select, Space pause, G charge,
  right-drag orbit, right-click = detach nearest company order. Landscape:
  manifest 'any' + short-height CSS. Battle report: kills/MVP/surgeons in the
  Butcher's Bill; telemetry at localStorage castlehassle.blog.v1.

## Combat expansion II (the '10 more' batch)
- Horizon: ground folds to a 300m disc under a hill ring reaching the sky dome
  (r0 250 → r1 1150), feet brightness-matched; coastal sea 2400x1500.
- Weather per battle (seed roll, override localStorage 'castlehassle.weather'):
  rain (weak bows, no fire, mud, dim+rain streaks), mist (range 0.75, thick fog),
  wind (arrow drift, fast haze/flags, eager fire spread). Footing: mud ring at
  walls (MUD_RING) slows all, bogs charges (0.55 dmg, no knockback). Battlement
  archers get HIGH_GROUND 1.15.
- Banner bearers: u.bearer (first man of fighting companies); alive = fear x0.6,
  killed = -18 morale + fear x1.3. Pennants = render pennantMesh (200 cap).
- Facing: sim.faceDiv(div, delta) + Wheel/About Face tools (hold-ground only).
- Assault works (per-siege equipment, muster 'Siege Works' row; reset in
  enterCastle/enterRaid): towers 250g x3 (dock = 3 permanent ladders), covered
  ram 300g (rams hard, roof = arrow/oil cover 4.2m). Pushed by the host (3
  nearby = full speed, else crawl), burnable (fire x3), ballistae target them
  FIRST. sim.assaultWorks / render workModels.
- Barricades: low 'gate' segs (h<=3) 13m inside real gates — bashed fast, ONE
  plug company, no oil/treb/ram targeting (h>3 filters real gates).
- Sorties: aggressive/cunning castellans send 2 light companies out through an
  open breach at your engines (~26s raid, then recall).
- Fire spreads house-to-house downwind (never in rain); slow-mo (0.32x, 1.3s)
  on first breach + garrison break, tap skips.
- Balance state: naive assault 4/8 wins avg; equipment converts stall seeds
  (17283: bare STALL → towers+ram WIN); rain flips it back. Plug discipline:
  keep guard exempt from plugs, barricades rate 1 company.

## Full code audit (July 2026) — fixes landed
Ranked audit executed in phases; all verified (tsc clean repo-wide, build, bench,
headless map screenshot):
- **Leaks**: `Renderer.dispose()` (render.ts) — traverse-dispose geometry/
  material/texture + composer/passes, `forceContextLoss()`, bound resize listener
  removed; called from `newGame()`. Same treatment in worldmap3d `destroy()`.
  audio.ts `bus()` one-shot chains now self-disconnect after 4s (were wired to
  master forever). `keysDown` cleared on window blur + newGame.
- **Correctness**: Siege Works gold deducted at MARCH not at buy (buy handlers
  only stage; muster start deducts `worksCost`); engine/ballista crews excluded
  from assault orders, divAgg, attacker counts, kill credit, victory check;
  `campaignsWon` only increments when the winning battle IS the first capture
  (was re-counting on every replay after the crusade); `surveyCastle()` restores
  the previous castle's module globals after surveying (generation is seed-
  deterministic, so re-gen = restore).
- **Perf**: projectile InstancedMesh draws use `.count` instead of hide-fill
  loops; per-frame scratch vectors hoisted; flags no longer recompute normals
  per frame; sim + render both skip when a full-screen overlay covers the scene
  (`covered2()` in main.ts).
- **worldmap3d dedupe**: the file had byte-identical duplicate copies of
  buildLandmarks/buildRivers/buildAmbientShips/buildSkyDome/grainTex/softSprite
  (+ dup `ships`/`_grain` fields) — first copies deleted (~218 lines), Float32Array
  generic fixed. `npx tsc --noEmit` is now FULLY clean — keep it that way; CI
  (`deploy.yml`) runs `npm run typecheck` before build.
- **Render**: barricades (h<=3 'gate' segs) draw as timber stake barriers, no
  gatehouse doors/merlons/braziers.
- iOS Info.plist: dropped the obsolete `armv7` UIRequiredDeviceCapabilities.
- Known-and-accepted (LOW, not fixed): Director hot-corner discoverability, dev
  gold grant in debug, `(this.sim as any)` casts, pennant 200 cap.

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
