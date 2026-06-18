# Castle Hassle — Locked Direction

> You said: *"do this as efficiently as possible while maximizing gameplay
> scale, you tell me the direction."* So this document **makes the decisions.**
> Everything here optimizes one core idea:
>
> ## **Perceived scale is decoupled from compute cost.**
>
> We make the battle *look and feel* like tens of thousands of troops while the
> machine only ever pays for a few thousand. That single principle drives every
> choice below. Treat these as decided unless you veto a specific one.

---

## 1. The Decisions (locked)

| Question | Decision | Why |
|---|---|---|
| **Stack** | **Web game (TypeScript) + WebGL via three.js**, wrapped by **Capacitor** | This is *your proven pipeline* (see §6), upgraded only in the renderer. Develops on Windows with no Mac, ships native to iOS, and I can build the whole thing in the cloud. three.js (WebGL2) replaces Canvas2D to unlock GPU instancing — thousands of sprites — and 2.5D depth. |
| **Build & ship** | **GitHub → Codemagic → TestFlight / App Store Connect** | Identical to how `Leave-Her-Johnny` ships today. Push to `main` → Codemagic builds + signs + publishes to TestFlight. No new workflow to learn. |
| **Test distribution** | **TestFlight link** (native) **+ web build** on GitHub Pages | Two link options for friends: a real native TestFlight build, *and* an instant browser URL (like `getarsenal.app`) for zero-friction quick looks. |
| **Render model** | **2.5D** — low-poly 3D terrain & castles, **billboarded sprite soldiers** via `THREE.InstancedMesh` | Cheapest possible way to draw a soldier while keeping the "deep detail from above" feel. One draw call per unit type. The biggest single efficiency lever. Runs in iOS WKWebView (WebGL2). |
| **Sim architecture** | **Data-oriented** (flat `Float32Array` agent data + flow-field pathfinding), deterministic, fixed-timestep | Thousands of agents in JS without GC churn: store agents in typed arrays, one shared flow-field per destination (no per-agent A*). Deterministic buys replays now and async PvP later for free. WebGPU later for extra headroom. |
| **Art & sound (100% free)** | **House style** (chunky, rounded, flat-shaded, warm "Bluey" palette — same as your other games) + procedural geometry; **procedural + CC0 SFX** | Matches your existing art language. Procedurally-assembled low-poly castles + one recolorable soldier sprite sheet. Music synthesized live (as in Leave Her Johnny); SFX procedural or CC0 (Freesound). |
| **Scale model** | **1 rendered sprite = N soldiers.** Units are *blocks*; "thousands" is unit *strength*, not 1:1 bodies | A unit of 200 men rendered as ~30 sprites. ~1,500 sprites on screen reads as an army of ~10,000+. This is how we "maximize scale" without melting the phone. |
| **Tone / art** | **Soft, hand-painted, charming, bloodless** — original IP. "Bluey" = *aesthetic reference only* | Keeps the wow + family-friendly rating; sidesteps the Bluey IP/legal trap entirely. |
| **Combat** | **Morale & routing**, not annihilation | Battles resolve fast and feel real; makes the "barely took it → counter-siege" loop natural. |
| **Players** | **Single-player first.** Sim is deterministic so async PvP is *possible* later without a rewrite | SP is the cheap, provable core. PvP is a whole discipline — defer it. |
| **Business model** | **Premium / paid** (or free-with-one-unlock), original IP | No live-ops treadmill. F2P done right is a second full-time job; don't take it on in v1. |
| **Map framing** | Europe/Middle East geography, **fictionalized factions** | Keeps the aesthetic and campaign fantasy; avoids real Crusades-era religious conflict. |
| **Content strategy** | **Modular castle kit** (wall/tower/gate/keep parts) + a few hero castles | Castles are *assembled*, not handcrafted one-by-one. The only way two continents of sieges is affordable. |

---

## 2. The Scale Budget (the target we engineer toward)

These are the numbers M1 must prove on a **real mid-range phone**, not a desktop:

- **~1,500–2,500 animated sprite-soldiers on screen** at a locked **60fps** (30fps floor on low-power devices).
- Each sprite = **4–8 men** → perceived armies of **~10,000–20,000**.
- **20–40 unit blocks per side**, ~8 unit types.
- **One flow-field per destination**, shared by every soldier in a unit — no per-agent A*.
- All soldier rendering through **GPU instancing** (`THREE.InstancedMesh`) — effectively one draw call per unit type.
- Faction recolor via **shader tint** on one shared sprite sheet (no per-faction art).

If M1 hits this, the whole "holy shit, on a phone?" vision is real. If it doesn't, we find out in week one, not month six.

---

## 3. The Efficiency Levers (how we go fast)

1. **Free art, procedural first.** Low-poly castle/terrain built procedurally in three.js + free CC0 kits (Kenney); a soldier sprite sheet (8-direction) drawn once. Bespoke art comes last, only where it raises the wow.
2. **One soldier sprite sheet, recolored & re-equipped** by shader tint → all unit types and factions from minimal source art.
3. **Everything is data.** Units, weapons, factions, and castles are defined in typed data files (TS/JSON) so *you* tune the game without touching engine code.
4. **Modular castles** assembled from a parts kit, semi-procedurally → dozens of maps for the cost of one art set.
5. **Abstraction over simulation.** We never simulate a man we don't need to. Off-screen and campaign-layer armies are pure numbers.
6. **Deterministic core** → free replays now, cheap multiplayer later, and trivial automated testing of the sim.

---

## 4. Build Order (vertical-slice-first)

Each milestone is a thing you can hold and judge. We do not widen until the core is fun.

- **M0 — Skeleton.** Web project (TS + three.js + Vite), Capacitor config, `codemagic.yaml`, data schemas (unit/weapon/castle), GitHub Pages web build. **I can build all of this in the cloud now** — it's all code. *(See §6.)*
- **M1 — "Crowd on a phone."** Render + move **1,500+ instanced sprites** via flow-field at 60fps on a real device. No game yet — pure tech proof of the scale budget. **This is the make-or-break milestone; we do it first.**
- **M2 — "First blood."** Two armies clash on open ground: 4 unit types with rock-paper-scissors roles + **morale/routing**. The core combat must feel good here.
- **M3 — "The wall."** One modular castle, archers-on-walls, **one breach mechanic** (trebuchet crumbles a wall section → chokepoint fight), one siege weapon.
- **M4 — "It's a game."** Pre-battle deployment phase (Total War-style), win/lose + the counter-siege loop, **the juice** (dust, debris, arrow volleys, banners, camera shake, lighting), and the **touch control scheme** (tap-select, drag-formation, pause-to-command). *Exit test: hand someone the phone — do they say "this is a mobile game?"*
- **M5 — Campaign.** One region (not two continents yet): strategic map, economy (gold/upkeep/recruit), AI, the per-campaign weapon-unlock tech tree, and the loop feeding battles into the map and back.
- **M6+ — Breadth & polish.** Widen the map, more weapons/factions/castles, audio pass, tutorial, save/resume, accessibility, perf hardening. PvP only if/when SP is proven.

---

## 5. Constraints (locked in)

- **Solo developer.** Scope is cut accordingly — everything is vertical-slice-first, and we lean hard on free CC0 assets and procedural content so one person can carry it.
- **100% free *tools*** — three.js/Vite/Capacitor (all open-source), CC0 art/sound, Codemagic free tier. Distribution costs (your existing Apple account) are fine.
- **Ships to the iOS App Store**, tested via TestFlight links to friends.

---

## 6. How We Build & Ship It (your proven pipeline, upgraded renderer)

This mirrors how **`Leave-Her-Johnny`** already ships to the App Store — the only
change is the renderer (Canvas2D → three.js/WebGL) and a light build step.

**The pipeline (unchanged from what works):**
- Game is a **web app** in this repo. Develops on Windows, no Mac.
- **Capacitor** wraps it into the native iOS app. `capacitor.config.ts` →
  `webDir: 'www'`, `appId: com.scheidelholdings.castlehassle`, app name "Castle Hassle".
- **Codemagic** (`codemagic.yaml`) builds on push to `main`: `npm install` →
  `npx cap sync ios` → `xcode-project use-profiles` → set build number from
  timestamp → `xcode-project build-ipa` → **publish to TestFlight**.
- **Signing** (the solved part): App Store distribution **provisioning profile
  uploaded into Codemagic's UI** (not API fetch), built off the shared distribution
  cert. For this new bundle id you'll: register the App ID + app record in App
  Store Connect, create an App Store distribution profile in the Apple Developer
  portal, download the `.mobileprovision`, and upload it into Codemagic with a
  reference name. (One-time, ~15 min — same steps as LHJ.)
- **Web test link**: the same build also deploys to GitHub Pages for an instant
  browser URL.

**One upgrade — the build step.** Castle Hassle is far bigger than a single
`index.html`, and three.js needs bundling. So instead of the manual
`cp index.html www/index.html`, we add a tiny **Vite** build that outputs the
game into `www/`. Codemagic runs `npm run build` before `cap sync`. Everything
else about the pipeline is identical.

**I do now, in this repo (all of M0):**
1. `package.json` (Capacitor `^8.x` + `@capacitor/haptics` + `three` + `vite` + `typescript`).
2. `capacitor.config.ts`, `codemagic.yaml` (adapted from LHJ — new bundle id/app name + `npm run build`).
3. Vite project: `index.html`, `src/` with the data schemas (`UnitDef`/`WeaponDef`/`CastleDef` as typed data), build → `www/`.
4. **M1 core**: a three.js `InstancedMesh` sprite renderer + a flat-`Float32Array`
   crowd sim with flow-field movement — the make-or-break "1,500+ sprites at
   60fps" proof, runnable in a browser immediately.
5. A `HANDOFF.md` for this project + a step-by-step **Codemagic/TestFlight setup guide**.

**You do (one-time, ~15 min):** the App Store Connect app record + Codemagic
provisioning-profile upload (per §6 signing), then connect the repo to Codemagic.
After that, **deploy = push to `main`.**

**Say "go" and I'll scaffold all of M0 in this branch and verify the web build runs.**
