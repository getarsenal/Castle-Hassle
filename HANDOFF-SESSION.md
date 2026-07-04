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

## Campaign map overhaul (July 2026 — 28 upgrades, worldmap3d.ts)
The map got the siege treatment. Everything below is in `worldmap3d.ts`:
- **Atmosphere**: drifting cumulus (the once-orphaned `cloudSprite()`) with
  parallax ground shadows; sea sparkle points; river-mouth foam; crusade-progress
  lighting (sun hardens/coppers as completed/total grows); `.mapVig` CSS vignette;
  layered cartography — realm names fade IN past dist~150, castle labels fade out
  (current always full).
- **Life**: hearth smoke on held settlements (last 8 + objective); a siege camp
  (tents/fire/smoke) pitched on dry ground outside the objective; ship wakes;
  2 of 5 gull flocks orbit harbours; dust puffs behind the marching column.
- **Roads/march**: `roadLegs` map keeps each A*-leg's world points — the march
  animation WALKS THE ROAD now (sea legs still take the boat); marched legs render
  gold-dust, the next leg pulses (`nextLegMat`).
- **Input**: wheel zoom toward cursor, right-drag orbit (pitch clamped 0.5-1.28),
  double-tap dive, WASD/QE/RF keys (guarded by cssW()>0), mouse hover = pointer
  cursor + marker swell, LOCKED castles tappable (rumour panel: rounded strength,
  'Beyond the frontier', no siege button), ⚑/🌍 chips under the compass glide via
  `camTween` (cancelled by any manual input).
- **Panel intel**: 'Skies at the siege' forecast row — SAME seed rolls as main.ts
  newGame (WX[(seed>>>7)%10], TODS[(seed>>>3)%8]); keep in sync if those change.
  Garrison composition bar (.gbar) + tactical weather note for the objective.
- **Correctness**: frame() now advances on real dt (pulse 3/s) — was 2x speed on
  120Hz phones; ships/birds/march-camera all dt-based; the 99-castle threat pass
  pre-warms 1.1s after build so the first tap doesn't jank.

## Polish batch (July 2026 — the LOW list + ambience)
- Map ambience: `battleAudio.mapAmbience(bool)` — wind bed (roaming bandpass
  noise + breathing LFO) + occasional synthesized gull cries; on in openMap,
  off at muster/menu. Volume deliberately faint (0.07 bed).
- ⚙ dev chip on the map now hidden unless `#dev` in URL or Director Mode on
  (players could reach the Battle Lab + gold grants before).
- gameConfirm backdrop listener wired once (was stacking per call); menu
  screens de-dup on open; pennant cap 200→320; Director clean-screen shows a
  fading "tap this corner to restore" toast; shrink.mjs degrades gracefully
  without sharp; render.ts sim any-casts removed (members were real).
- Earthworks backlog item was STALE — the continuous swept ribbon w/ parapet
  already exists in render.ts ("THE CONTINUOUS EARTHWORK").
- Snowball check (measured, scripts/_bal.ts pattern — esbuild bundle
  campaign+sim+balance in node): START host Q1 = 9 Costly/14 Grim/1 Even,
  Q2-Q4 all Grim; LATE host (950H/820L/720A/360C/14S, vet 1.3, buffs 1.35)
  Q4 = 14 Rout / 13 Strong. Ceiling holds — no runaway snowball; revisit with
  real telemetry (castlehassle.blog.v1) after play.
- Still open (need product/backend decisions): cloud save, New Game+, enemy
  variety, app icon swap (user asset).

## Landscape phone pass (July 2026 — 'unplayable' report fixed)
All in the `@media (orientation:landscape) and (max-height:480px)` blocks —
NOTE the index.dev.html block sits at the END of the stylesheet on purpose
(it must out-cascade the base rules; it was silently losing before).
- Battle: hint bar docked under the top bar (was dead-centre of the field);
  topHud pads by --safe-left/right (the notch is on the SIDE in landscape).
- Muster: compact header, roster two-abreast (#rosterRows grid 1fr 1fr).
- Main menu (menu.ts): crest 24vh, three campaign slots side by side.
- Map castle panel (worldmap3d.ts): two-column grid — schematic left
  (grid-row span), intel right, March/Close row STICKY at the panel bottom.
- Battle report: .bannerCard capped at 100vh-20 and scrolls.
Verified at 844x390 (iPhone 12-15 landscape) headless: title, menu, map,
panel, muster, battle w/ tools all fit and reachable.

## TRUE CASTLES (July 2026 — the blob enceinte)
generateCastle no longer stamps rectangles. The curtain is traced from a seeded
CELL BLOB (CS=12 world units/cell, grids to 18x13 → footprints to ~216x156, two
to four times the old ground) into an irregular RECTILINEAR polygon — so every
downstream contract survives untouched (WallLine archers/ballistae/ladders,
AABB segs, breaches, plugs, schematic).
- Four silhouette archetypes (`CastleStyle.form`, seeded when unset, set for
  all 21 famous castles in campaign.ts): 'crag' stepped diagonal wards
  (Gaillard, Krak), 'bastion' jutting corner works + gatehouse block (Dover,
  Coucy), 'sprawl' anchored-ward walled towns (Carcassonne, Jerusalem),
  'shell' lobed superellipse ring-works (Harlech). Organic jitter (domino
  bites) + sanitise passes (dangle strip, hole fill, one component, dilation
  mass guarantee ≥42% of grid).
- Gate = best south-facing run (southern/central/long score) — often RECESSED
  in a bay = a natural killing ground. front stays bbox D (deploy safe).
- Towers only at REAL corners (both adjoining runs ≥ one cell) + interval
  flankers on long curtains; caps 44/52.
- Keep/citadel seat at the blob's DEEPEST cell (BFS from boundary), NOT the
  origin (which can be outside a crag trace); citadel rect shrinks to fit.
- `Seg.out` stores each wall's outward side — render's old sign-of-centre
  trick lies on irregular traces (merlons/doors flipped in notches).
- `insideCastle(x,z)` = exact blob test, exported from sim.ts — used by
  footing (mud follows the REAL walls), openBailey spawn, insideWalls,
  attInside. LAYOUT.blob carries {x0,z0,cs,gw,gh,cells,area}.
- defenderPlan: garrison from blob area (cap 1060), archer spacing scales
  with perimeter (2.6..3.4, perim/185) — re-tuned to the simbench
  equilibrium: 3/6 naive wins with genuine stalls (was 6/6 easy pre-tune).
- WORLD widened to x±158, z -128..214 for the great fortresses' siege ring.
- Verified: bench 6 seeds, overhead + three-quarter screenshots (campaign
  castles 0/24/55/98), map schematic panel, tsc clean.

## CASTLE WORKSHOP (July 2026 — hand-authored castles)
`src/editor.ts` — phone-first top-down editor, opened from Settings ("Castle
Workshop") or `window.__openWorkshop()`. Tools: Wall (polyline, ANY angle,
✓ finish / ◌ close ring), Gate (tap on a wall), Tower (⬤ Big toggle), Keep,
House, Tree, Earthwork ring, Erase; select/drag anything incl. individual wall
vertices; pinch zoom, 4u grid snap, undo(50); saves ≤30 named layouts at
localStorage `castlehassle.layouts.v1`; Export = JSON to clipboard (the user
sends it to be baked into the build), Import replaces.
- `CastleDoc` (sim.ts) is the interchange format — TRUE angles preserved.
- `generateCastleFromDoc(doc)`: recentres, stair-steps diagonal edges at SEG
  pitch into rectilinear runs (real stepped curtains), gates attach to the
  nearest edge, rasterises closed rings into LAYOUT.blob (cs=4) for exact
  inside tests, auto-ballistae. Sim env gains `doc?: CastleDoc`.
- DOC_DECO (trees/works) consumed by render: authored trees replace the
  scatter; the earthworks ring follows the drawn polygon (siegeRingNodes).
  Courtyard apron now follows the blob cells, not the bbox (all castles).
- Campaign: with ≥5 saved layouts, sieges use docs[(seed>>>2)%n] — each
  design recurs, varied by biome/TOD/weather. Playtest = default army, d=1.
- TDZ traps hit twice: module-top `generateCastle(1)` in sim.ts and the menu
  backdrop's top-level `newGame()` in main.ts both run BEFORE later `let`
  declarations — DOC_DECO and pendingDoc had to be hoisted above them.
- NEXT (the promised rewrite): render + collide TRUE angled walls straight
  from CastleDoc polylines (oriented segs), replacing the stair-step approx.
  The doc format already carries everything needed.

## UI alignment pass (July 2026 — post-launch phone polish)
- Map top bar: #mapMenuBtn + #muteBtn are now 44px twins (12px radius, opaque
  leather, right 64/12 — they used to OVERLAP by 4px at different sizes);
  #mapHeader max-width min(62vw, 100vw-212px) so it never runs under them.
- Map right rail: compass + host/world chips share one axis (chips right:25
  centres them on the compass at right:14/66w), both safe-top offset; chip
  glyphs are drawn SVGs in the compass ink (#4a3514) — emoji were mismatched.
- Muster: h1 ribbon margin-top 58px under 560px width (cleared the fixed
  Map/sound chips); #muteBtn opaque so scrolling under it reads deliberate.
- Siege Works row: buttons moved to the 'rec' grid row (.worksBtns 1fr 1fr,
  full-width) — they overflowed the qty column off-screen on phones; icon is
  an inline SVG timber tower (the red 🗼 emoji read as a broadcast mast).
- DEPLOY TOPOLOGY RESTORED: on.push [main, claude/**] again — the main-only
  audit change broke the user's months-old push→live flow (getarsenal.app is
  GitHub Pages via custom domain; DNS A records → Pages IPs since June 9).
  Keep pushing all three branches; every push deploys.

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
0. **Pages deploy from main needs one settings change**: the game history is
   promoted to `main` (fast-forward) and deploy.yml now only deploys `main`.
   CI build + typecheck pass, but the `github-pages` environment still has a
   deployment-branch policy from the claude/** era that rejects `main` — the
   deploy job dies in 2s with no runner. Fix: repo Settings → Environments →
   github-pages → Deployment branches and tags → allow `main` (or "No
   restriction"), then re-run the failed "Deploy web build to GitHub Pages"
   run from the Actions tab.
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
