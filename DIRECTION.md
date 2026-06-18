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
| **Engine** | **Unity 6** (URP mobile) | Only mainstream engine that ships *thousands of agents on a phone* (Burst/Jobs + GPU instancing) **and** has an asset store that slashes art/content cost. One codebase → iOS, Android, PC. |
| **Render model** | **2.5D** — real low-poly 3D terrain & castles, **billboarded sprite soldiers** | The cheapest possible way to draw a soldier, while keeping the "deep detail from above" 3D feel. This is the biggest single efficiency lever. |
| **Sim architecture** | **Data-oriented** (Jobs + Burst + flow-field pathfinding), deterministic, fixed-timestep | Thousands of agents at 60fps; deterministic buys replays now and async PvP later for free. Start with Jobs+NativeArrays; adopt full Entities/ECS only if profiling demands it (avoids the DOTS learning tax up front). |
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

- **M0 — Skeleton.** Unity project, URP-mobile, data schemas (unit/weapon/castle), CI, on-device deploy pipeline. *(I can scaffold the repo structure + data schemas now.)*
- **M1 — "Crowd on a phone."** Render + move **1,500+ instanced sprites** via flow-field at 60fps on a real device. No game yet — pure tech proof of the scale budget. **This is the make-or-break milestone; we do it first.**
- **M2 — "First blood."** Two armies clash on open ground: 4 unit types with rock-paper-scissors roles + **morale/routing**. The core combat must feel good here.
- **M3 — "The wall."** One modular castle, archers-on-walls, **one breach mechanic** (trebuchet crumbles a wall section → chokepoint fight), one siege weapon.
- **M4 — "It's a game."** Pre-battle deployment phase (Total War-style), win/lose + the counter-siege loop, **the juice** (dust, debris, arrow volleys, banners, camera shake, lighting), and the **touch control scheme** (tap-select, drag-formation, pause-to-command). *Exit test: hand someone the phone — do they say "this is a mobile game?"*
- **M5 — Campaign.** One region (not two continents yet): strategic map, economy (gold/upkeep/recruit), AI, the per-campaign weapon-unlock tech tree, and the loop feeding battles into the map and back.
- **M6+ — Breadth & polish.** Widen the map, more weapons/factions/castles, audio pass, tutorial, save/resume, accessibility, perf hardening. PvP only if/when SP is proven.

---

## 5. What I Need From You (only the truly blocking ones)

I've decided everything I reasonably can. Two things genuinely change the plan and only you can answer:

1. **Do you have Unity experience / a preference against it?** If you'd rather a web-first build (instant share-by-URL, faster iteration) I'll adapt — but it trades away some peak scale. My pick stands at Unity for the scale you asked to maximize.
2. **Solo or small team?** Sets exactly how hard we cut scope. I've planned as if it's small/solo.

If neither is a blocker, say "go" and I'll **scaffold M0** — the Unity project layout, the data schemas (unit/weapon/castle definitions), and a written M1 tech spec — committed to this branch.
