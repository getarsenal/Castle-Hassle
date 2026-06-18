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
| **Engine** | **Unity 6** (Personal license — free) | Free under the revenue threshold. Best-in-class iOS pipeline and the strongest *thousands-of-agents-on-a-phone* story (Burst/Jobs/DOTS + GPU instancing) — directly serves the scale you want to maximize. |
| **Target platform** | **iOS App Store first** (iPhone), iPad next, Android later | You have an Apple developer account; ship there first. One Unity codebase ports to the rest. |
| **Test distribution** | **TestFlight public links** | Preserves your "send friends a link" workflow — they tap a link and install a real native build on their own device. Better perf signal than a browser, and it's the standard pre-release path to the App Store. |
| **Render model** | **2.5D** — real low-poly 3D terrain & castles, **billboarded sprite soldiers** | The cheapest possible way to draw a soldier, while keeping the "deep detail from above" 3D feel. Rendered via GPU instancing (`BatchRendererGroup` / `RenderMeshInstanced`). The biggest single efficiency lever. |
| **Sim architecture** | **Data-oriented** (Jobs + Burst + flow-field pathfinding), deterministic, fixed-timestep | Thousands of agents at 60fps; Burst compiles to native SIMD. Deterministic buys replays now and async PvP later for free. Start with Jobs + `NativeArray`; adopt full Entities/ECS only if profiling demands it (avoids the DOTS learning tax up front). |
| **Art & sound (100% free)** | **CC0 asset packs** (Kenney.nl) + procedural geometry; **CC0 SFX** (Freesound) | Zero-cost, license-clean. Procedurally-assembled low-poly castles + a single recolorable soldier sprite sheet. No paid asset store needed. |
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
- All soldier rendering through **GPU instancing** (`BatchRendererGroup` / `RenderMeshInstanced`) — effectively one draw call per unit type.
- Faction recolor via **shader tint** on one shared sprite sheet (no per-faction art).

If M1 hits this, the whole "holy shit, on a phone?" vision is real. If it doesn't, we find out in week one, not month six.

---

## 3. The Efficiency Levers (how we go fast)

1. **Buy art, don't make it.** Start on asset-store low-poly modular castle/terrain kits and a 2D soldier rig (Spine / Unity 2D) baked to 8-direction sprite sheets. Bespoke art comes last, only where it raises the wow.
2. **One soldier rig, recolored & re-equipped** by shader → all unit types and factions from minimal source art.
3. **Everything is data.** Units, weapons, factions, and castles are defined in JSON/ScriptableObjects so *you* tune the game without touching code.
4. **Modular castles** assembled from a parts kit, semi-procedurally → dozens of maps for the cost of one art set.
5. **Abstraction over simulation.** We never simulate a man we don't need to. Off-screen and campaign-layer armies are pure numbers.
6. **Deterministic core** → free replays now, cheap multiplayer later, and trivial automated testing of the sim.

---

## 4. Build Order (vertical-slice-first)

Each milestone is a thing you can hold and judge. We do not widen until the core is fun.

- **M0 — Skeleton.** Unity project, URP-mobile, data schemas (unit/weapon/castle), iOS build + TestFlight pipeline. *(See §6 for how we split this given the dev environment.)*
- **M1 — "Crowd on a phone."** Render + move **1,500+ instanced sprites** via flow-field at 60fps on a real device. No game yet — pure tech proof of the scale budget. **This is the make-or-break milestone; we do it first.**
- **M2 — "First blood."** Two armies clash on open ground: 4 unit types with rock-paper-scissors roles + **morale/routing**. The core combat must feel good here.
- **M3 — "The wall."** One modular castle, archers-on-walls, **one breach mechanic** (trebuchet crumbles a wall section → chokepoint fight), one siege weapon.
- **M4 — "It's a game."** Pre-battle deployment phase (Total War-style), win/lose + the counter-siege loop, **the juice** (dust, debris, arrow volleys, banners, camera shake, lighting), and the **touch control scheme** (tap-select, drag-formation, pause-to-command). *Exit test: hand someone the phone — do they say "this is a mobile game?"*
- **M5 — Campaign.** One region (not two continents yet): strategic map, economy (gold/upkeep/recruit), AI, the per-campaign weapon-unlock tech tree, and the loop feeding battles into the map and back.
- **M6+ — Breadth & polish.** Widen the map, more weapons/factions/castles, audio pass, tutorial, save/resume, accessibility, perf hardening. PvP only if/when SP is proven.

---

## 5. Constraints (locked in)

- **Solo developer.** Scope is cut accordingly — everything is vertical-slice-first, and we lean hard on free CC0 assets and procedural content so one person can carry it.
- **100% free *tools*** — Unity Personal, CC0 art/sound, free CI. Distribution costs (your existing Apple account) are fine.
- **Ships to the iOS App Store**, tested via TestFlight links to friends.

---

## 6. How We Build It (given the dev environment)

The honest constraint: **Unity needs the Unity Editor on your Mac** — it can't be
created or compiled in this cloud Linux container. So we split M0 cleanly:

**You do (once, ~30 min, on your Mac):**
1. Install **Unity Hub** + **Unity 6 LTS** with the **iOS Build Support** module.
2. Create a new project (**Universal 3D / URP** template), name it `CastleHassle`,
   inside this repo folder.
3. Add packages via Package Manager: **Burst**, **Collections**, **Mathematics**
   (and **Entities** later if/when we need full ECS).
4. Commit the generated `Assets/`, `Packages/`, `ProjectSettings/` (I'll provide
   the `.gitignore` so we don't commit `Library/`).

**I do (now, in this repo):**
1. A Unity-correct **`.gitignore`**.
2. The **data schemas as C# `ScriptableObject` scripts** (`UnitDef`, `WeaponDef`,
   `CastleDef`) — drop into `Assets/Scripts/Data/`.
3. The **M1 core**: a Jobs+Burst crowd system (flat `NativeArray` agent data,
   flow-field movement) + an instanced sprite renderer — the make-or-break
   "1,500 sprites moving at 60fps" proof, as ready-to-compile C#.
4. A written **M1 tech spec** and a step-by-step **TestFlight deploy guide**.

You open the project, the scripts compile, and you press Play. From there the
loop is: I write systems here → you pull, compile, test on device → send the
TestFlight link to friends.

**Say "go" and I'll commit the `.gitignore`, the data-schema scripts, the M1
crowd system, and the setup + TestFlight guide to this branch.**
