# Castle Hassle — Project Handoff

> **Current work state lives in `HANDOFF-SESSION.md`** (July 2026) — read that
> first; this file is the original project intro and some of it is stale.

A 2.5D medieval **siege** game. You command an army storming a castle: ~2,200
soldiers fight at once, flooding through a gate and a breached wall while archers
rain from the battlements. Soft, chunky, flat-shaded "house style" (same art
language as Leave Her Johnny), built to run on a phone.

This is the **M0 + M1 base game**: one playable battle that proves the
renderer + simulation at scale. See `DIRECTION.md` for the full roadmap and
`DESIGN.md` for the game-design thinking.

---

## 1. Run it

```bash
npm install
npm run dev        # http://localhost:5173  — play in a browser
npm run build      # production build → www/
npm run preview    # serve the production build
```

It's a desktop/mobile **web** game (TypeScript + three.js + Vite). On a phone it
ships as a native iOS app via Capacitor + Codemagic (§5). Two ways to test:
a live web URL (GitHub Pages) and a TestFlight build — both link-shareable.

---

## 2. How to play

- **⚔ Begin Assault** launches the battle. Your army (red) auto-advances on the
  castle; the garrison (blue) holds the courtyard with archers on the walls.
- Tap a **unit card** (bottom) to select that unit, then **tap the field** to
  send them there. "ALL" orders the whole army.
- **Drag** to pan the camera, **pinch / scroll** to zoom.
- Take the castle by breaking the garrison. A clean sweep = a full capture; if
  defenders survive they'd regroup (the counter-siege loop — see DESIGN.md).

---

## 3. Architecture

Everything is a small set of TypeScript modules bundled by Vite. No framework.

```
src/
  main.ts      Entry: game loop (fixed-step sim + render), input (pan/zoom/tap), HUD wiring.
  sim.ts       The battle simulation — NO browser/three deps, so it runs & tests headless.
  render.ts    three.js scene: terrain, castle, instanced sprite soldiers, projectiles, camera.
  sprites.ts   Procedurally-drawn soldier/arrow textures (canvas) — no art files.
index.html     Canvas host + HUD markup + styles.
```

### The simulation (`sim.ts`) — the important part
- **Struct-of-Arrays.** Every soldier is an index into flat typed arrays
  (`px, pz, py, vx, vz, hp, cd, unit, fac, typ, alive, slot`). ~2,200 agents,
  zero per-entity allocation. This is what makes the scale cheap.
- **Flow-field pathfinding.** Movement is a shared **Dijkstra flow field per
  destination cell** (`computeField`), not per-agent A*. Walls are blocked grid
  cells, so soldiers route through the gate/breach automatically. Fields are
  cached by goal cell.
  - ⚠️ **Gotcha (already fixed, don't reintroduce):** the cost array MUST be
    `Float64Array`. With `Float32Array`, rounding makes the stale-node check
    `co > cost[cell]` skip valid nodes and the field only half-fills — units
    then freeze at spawn. See the comment in `computeField`.
- **Combat & morale.** Fixed 30 Hz step. Spatial hash for nearest-enemy queries
  (vertical separation is weighted so ground troops ignore archers up on walls).
  Melee strike in range; archers fire ballistic arrows (pooled). Units **rout**
  below 30% strength; when the courtyard garrison is broken the walls are
  overrun and the wall archers rout too (that's the win trigger).
- **Deterministic**: seeded `mulberry32`, fixed timestep → replays/PvP later.

### Rendering (`render.ts`)
- Soldiers are **billboarded sprites** drawn with one `THREE.InstancedMesh` per
  unit type (4 draw calls for the whole army), tinted per-instance by faction.
- The castle is built from the same `CASTLE` box list the sim uses for
  collision, so geometry and gameplay always match (incl. the breach gap).
- Camera is an angled top-down orbit; one billboard quaternion faces all sprites
  at the camera each frame.

### Headless sim test
Because `sim.ts` has no DOM deps you can run the battle in Node:
```bash
npx esbuild src/sim.ts --bundle --format=esm --outfile=/tmp/sim.mjs
node -e "import('/tmp/sim.mjs').then(({Sim})=>{const s=new Sim(42);s.begin();for(let i=0;i<3600&&s.phase!=='over';i++)s.step(1/30);console.log(s.phase,s.winner,s.countAlive(0),s.countAlive(1));})"
```

---

## 4. Tuning knobs (in `sim.ts`)

- Unit stats: `HP, SPEED, MELEE, ATKCD, RANGE, SENSE, RADIUS` (indexed by type).
- Army composition / positions: the `addUnit(...)` calls in `setup()`.
- Castle & breach: the `CASTLE` box list + `GATE`/`HALF` constants.
- Battle currently resolves as a decisive-but-costly attacker win in ~20s with
  ~850 soldiers flooding the courtyard. Adjust garrison size / `MELEE` to taste.

---

## 5. Build & ship to iOS (your proven pipeline)

Same as Leave Her Johnny: **web → Capacitor → Codemagic → TestFlight**, from
Windows, no Mac. `codemagic.yaml` is already adapted (bundle id
`com.scheidelholdings.castlehassle`, with an added `npm run build` step).

**One-time setup (not yet done):**
1. **Create the iOS native project.** It isn't committed yet. Easiest is to copy
   the proven `ios/` folder from a sibling app (e.g. Don't-Touch-My-Boats /
   Leave-Her-Johnny — SPM flavor, no CocoaPods) and update its bundle id to
   `com.scheidelholdings.castlehassle` + display name "Castle Hassle". Then
   `npx cap sync ios`. (Or `npx cap add ios` if generating fresh.)
2. **App Store Connect:** register the App ID + app record for the bundle id.
3. **Signing:** in the Apple Developer portal create an **App Store distribution
   provisioning profile** off the shared distribution cert, download the
   `.mobileprovision`, and **upload it into Codemagic** with a reference name
   (exactly as you did for LHJ — that's the mechanism that works on this account).
4. Connect the repo to Codemagic. After that, **push to `main` → TestFlight.**

**Web test link (works today):** repo Settings → Pages → Source: *GitHub
Actions*. Then every push builds and publishes a live URL (see
`.github/workflows/deploy.yml`) you can send to friends.

---

## 6. Conventions

- `sim.ts` stays free of `three`/DOM imports so it remains headless-testable.
- Keep soldier rendering to instanced meshes (one per type) — don't create
  per-soldier objects.
- `www/` and `node_modules/` are git-ignored; the build regenerates `www/`.
