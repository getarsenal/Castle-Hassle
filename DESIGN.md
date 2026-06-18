# Castle Hassle — Design Document & Concept Review

> Status: pre-production concept. This document captures the vision, then
> pressure-tests it: open decisions, gaps, technical risks, and a phased plan
> to get from "idea" to "playable vertical slice."

---

## 1. The Pitch (as it stands today)

A medieval **castle-siege game** with two layers, inspired by Total War:

- **Strategy layer** — a top-down campaign map of Europe and the Middle East.
  You manage a kingdom, an economy, and armies, moving across the map to
  attack or defend castles.
- **Battle layer** — the hook. When armies meet at a castle, the game drops
  into a real-time, top-down **commander's view** of a single siege. You place
  troops and artillery, the battle kicks off, and you move units, put archers
  on walls, and direct trebuchets.

Core fantasy: command thousands of troops in a beautiful, deeply detailed
siege that makes people say *"this is a mobile game?"* — with a soft, warm,
"Bluey-themed" art direction rather than a gritty/gory one.

Two ways to play: **Attacker** (take a castle — wipe out the garrison to hold
it 100%; leave survivors and the enemy recovers and counter-sieges you next
turn) and **Defender** (a kingdom defending its castle).

Progression via a **credit/economy system** that unlocks better
period-accurate offensive and defensive weapons.

---

## 2. The Three Hardest Tensions (read this first)

Before any feature work, three tensions in the current vision need a
conscious decision. Each one quietly changes almost everything downstream.

### 2.1 "Bluey-themed" vs. siege warfare — the **tone** problem
Bluey is a gentle preschool cartoon about a family of dogs. Siege warfare is
crumbling walls and thousands of troops dying. These don't automatically fit.
"Bluey-themed" could mean any of:

- **Art style only** — soft, rounded, warm painterly look, friendly colors,
  no blood. The mechanics stay as a real war game. *(Most likely what you mean.)*
- **Tone & characters** — anthropomorphic dogs, comedic, bloodless,
  family-friendly. Troops "tap out" instead of die. Aims at a younger/family
  audience and a friendlier store rating.
- **Actual Bluey IP** — ⚠️ **do not.** Bluey is owned by Ludo Studio / BBC.
  You cannot ship a game using Bluey characters, names, or assets without a
  license, and you won't get one for a war game. Treat "Bluey" strictly as an
  *aesthetic reference* ("warm, soft, hand-painted, charming"), never as
  shipped content. The internal/public name and art must be original.

**Recommendation:** "soft, charming, hand-painted art direction; bloodless but
real tactical combat." This keeps the wow-factor and the depth while sidestepping
both the IP problem and the tonal whiplash. Decide this now because it drives art,
audience, rating, and monetization.

### 2.2 "Thousands of troops + beautiful 3D + low system cost" on a **phone**
This is the headline technical risk. Total War runs thousands of agents on
desktop GPUs. On a phone you cannot individually mesh-render and path-find
"thousands" of soldiers and also have a gorgeous scene without melting the
battery. The honest version:

- **Visible vs. abstract.** Show a few hundred animated sprite-soldiers per
  side at full detail; represent "thousands" as unit *strength* (a unit of
  120 men rendered as ~20–40 sprites, scaling its footprint/health). Players
  read "a thousands-strong army" from many dense blocks, not 1:1 bodies.
- **Sprites, not meshes.** Billboarded 2D sprite soldiers (your instinct is
  right) drawn with GPU instancing — one draw call for thousands. 8-direction
  sprite sheets read fine from a top-down ¾ camera.
- **Flow-field pathfinding,** not per-agent A*. One field per destination,
  every soldier just samples it. This is how RTS games move large crowds cheaply.
- **The "wow" comes from art direction, not body count** — lighting, dust and
  debris particles, arrow volleys, parallax, camera shake on impacts, animated
  banners, smoke from burning towers. A scene of 300 beautifully-lit sprites
  with great juice reads as more impressive than 3000 ugly ones.

**Recommendation:** design the sim around "hundreds rendered, thousands
abstracted," deterministic fixed-step, with aggressive LOD. Prove this in the
vertical slice before committing to the fantasy of literal thousands.

### 2.3 Scope vs. who's building it
As written, this is "Total War, on mobile, with a campaign across two
continents." That is a multi-studio, multi-year effort. **Scope is the single
most likely thing to kill this project.** The plan below is built entirely
around cutting a tiny vertical slice first and only widening once the core
"holy shit" siege is fun in your hand.

---

## 3. Gaps & Things Not Yet Decided

These are real holes in the current concept. Each needs an answer eventually;
recommendations are given.

### 3.1 Combat resolution — morale, not annihilation
The current win rule is "wipe out **all** defenders for 100% capture." But
historically (and for fun pacing) medieval battles ended by **morale collapse
and routing**, not last-man-standing. A fight-to-the-death rule makes battles
drag and feel grindy, and makes the "barely took it" state rare and fiddly.

**Recommendation:** add a **morale system**. Units rout when morale breaks
(flanked, taking losses, commander/general dead, losing the wall). Capture is
measured by **control + remaining enemy strength**, not literal extinction.
This also makes "you barely took it, they recover and counter-siege" natural:
a routed-but-not-destroyed garrison rallies. Keep "total annihilation = clean
hold" as the *best* outcome, not the *only* win.

### 3.2 The counter-siege / recovery loop needs rules
"Leave survivors → they recover → you're besieged next turn" is a great hook,
but undefined it can become a punishing death spiral. Define:

- How survivors convert into a besieging force (garrison regen rate, reinforcements).
- A floor so the player isn't endlessly counter-sieged with no recovery of their own.
- Whether holding a castle gives *you* the same recovery advantage (it should —
  symmetry makes it fair and teaches the mechanic).

### 3.3 Sieges have more than one win condition
Right now the siege is assault-only (storm the walls). Real sieges were often
won by **starvation, mining/sapping, or surrender**. You don't need all of it,
but decide which to model — even one or two alternate paths add huge depth:

- **Assault** — ladders, siege towers, ram the gate, breach with artillery. (core)
- **Breach** — trebuchets/sappers crumble a wall section, creating a chokepoint fight.
- **Starvation / supply** — a campaign-layer timer; cuts both ways (your
  besieging army also needs supply).
- **Surrender / morale** — garrison capitulates when hopeless.

### 3.4 Economy: two different systems are being conflated
You mention "some sort of economy" **and** "a credit system to unlock weapons."
These are probably two layers:

- **Campaign economy** — gold/food/manpower from territory, upkeep on armies,
  recruitment cost. Drives strategic decisions.
- **Progression / unlock economy** — earn credits from battles to permanently
  unlock weapon *types* (trebuchet, siege tower, ballista, Greek fire…).

Decide whether unlocks are **persistent meta-progression** (roguellike; carry
across campaigns) or **per-campaign tech tree** (researched within a playthrough).
They feel very different. Recommendation: per-campaign tech tree for the main
mode; optional persistent cosmetic/QoL unlocks if you go free-to-play.

### 3.5 Mobile RTS controls — the silent killer
"Move troops, put archers on walls, direct artillery" is RTS-grade control on a
touchscreen, which is genuinely hard and is where many mobile strategy games die.
You need a deliberate control scheme:

- **Tap to select**, drag to draw a formation/destination line, two-finger to
  rotate facing.
- **Pause or slow-mo** to issue orders (huge for mobile; lets the player think).
- **Command groups / radial menus** for "all archers," "all cavalry."
- **Smart context actions** — tapping a wall with archers selected = "garrison
  the wall," not a raw move order.

This deserves a prototype of its own. If the controls aren't satisfying, nothing
else matters.

### 3.6 Single-player only, or multiplayer?
Not mentioned, but it's a foundational architecture decision:

- **SP campaign only** — simpler; AI opponents; deterministic sim still useful
  for replays.
- **Async PvP** (Clash-of-Clans-style: attack other players' castles) — huge
  potential mobile hook, but adds servers, accounts, balancing, anti-cheat, and
  shapes the whole economy/monetization. **Decide before architecture.**

**Recommendation:** ship SP first; design the sim to be deterministic and
replayable so async PvP is *possible* later without a rewrite, but don't build
it in v1.

### 3.7 Business model — decide on purpose, not by accident
"Mobile game" + "credit system" drifts toward free-to-play. F2P vs premium
changes design profoundly (pacing, energy systems, IAP, ads, retention loops).
Pick consciously:

- **Premium ($)** — design for a complete, fair experience; no dark patterns.
- **F2P** — needs live-ops, retention, monetization design from day one.

**Recommendation for a first title:** premium or free-with-one-unlock. F2P
done well is its own full-time discipline.

### 3.8 Historical/cultural framing
"Conquering across Europe and the Middle East" is literally Crusades territory —
real religious and cultural conflict. With a soft, charming tone this can clash
badly or read as insensitive. **Recommendation:** lightly fictionalize.
Invent factions/banners inspired by the period rather than depicting real
religious conflict. Keeps the aesthetic and the map fantasy without the baggage.

### 3.9 Content scale: dozens of unique castle maps
A two-continent campaign implies many siege maps. Handcrafting each is a massive
art/level-design burden. **Recommendation:** a **modular castle kit**
(wall segments, gates, towers, keeps, terrain tiles) so castles are assembled,
semi-procedurally, from parts — with a handful of hero/handcrafted set-piece
castles for key campaign beats.

### 3.10 Smaller-but-real gaps
- **Tutorialization** — teaching a deep systems game on a small screen.
- **Save / persistence** — campaign state, mid-battle saves on mobile (calls
  interrupt; you need robust suspend/resume).
- **Accessibility** — colorblind-safe faction colors, text size, one-handed play.
- **Audio** — siege ambience and impact SFX are 50% of the "wow."
- **Battery / thermal** — frame-rate cap, dynamic resolution, "low power" LOD.

---

## 4. What I'd Build First — Phased Plan

The whole strategy is: **prove the fun and the tech in the smallest possible
slice, in your hand, before building breadth.**

### Phase 0 — Decisions (no code)
Lock: tone (§2.1), engine, SP-only-for-now (§3.6), business model (§3.7).
These four answers unblock everything else.

### Phase 1 — Vertical Slice: "One Great Siege"
Build a single, replayable battle that already feels great:
- One castle (from the modular kit), one attacker army vs one defender garrison.
- 3–4 unit types with the rock-paper-scissors roles (light inf, heavy inf,
  cavalry, archers) **and morale/routing**.
- One siege mechanic (recommend **breach**: trebuchet crumbles a wall section,
  fight pours through the gap).
- Hundreds of sprite soldiers via instancing + flow-field movement, hitting a
  stable frame rate on a *real mid-range phone* (test on device early and often).
- The juice: dust, debris, arrow volleys, banners, camera shake, lighting.
- The mobile control scheme (§3.5) with pause-to-command.

**Exit test:** hand the phone to someone. Do they say *"this is a mobile game?"*
and want to play again? If not, fix this before anything else.

### Phase 2 — The Siege, Deepened
Add the second siege win-path, the deployment/placement phase (Total War-style
pre-battle setup), the full unit roster, defender mode, and the
"barely-took-it → counter-siege" loop (§3.2).

### Phase 3 — The Campaign Layer
Minimal strategic map (a region, not two continents), campaign economy (§3.4),
recruitment/upkeep, AI opponents, the unlock tech tree, and the loop that feeds
battles into the map and back.

### Phase 4 — Breadth & Polish
Widen the map toward Europe/Middle East, modular + hero castles, more weapons,
factions, audio pass, tutorial, save/resume, accessibility, performance hardening.

### Phase 5 (optional/later) — Async PvP, live-ops
Only if SP is proven and the sim's determinism makes it cheap to add.

---

## 5. Recommended Tech Direction (starting point, not gospel)

- **Engine:** Unity (mature mobile pipeline, ECS/DOTS for thousands of agents,
  huge asset ecosystem) **or** Godot 4 (free, lighter, improving mobile story).
  For "thousands of agents + mobile," Unity DOTS is the safer bet today.
- **Rendering:** GPU-instanced billboard sprites for soldiers; URP with mobile
  settings; dynamic resolution + frame cap.
- **Sim:** deterministic, fixed-timestep, flow-field pathfinding, spatial
  hashing for combat queries. Determinism buys you replays now and PvP later.
- **Data-driven content:** units, weapons, castles defined in data files so
  designers (you) can iterate without code changes.

---

## 6. Top Concerns, Ranked

1. **Scope.** This is a studio-sized vision. Without a ruthless vertical-slice-first
   discipline, it won't ship. (Biggest risk by far.)
2. **The "thousands of troops + beautiful + cheap on mobile" triangle.** Achievable
   only via abstraction + instancing + flow fields + art-direction-led "wow."
3. **Mobile RTS controls.** Easy to underestimate; can sink the whole thing.
4. **Tonal coherence** of "Bluey-themed siege warfare," and the **Bluey IP trap**.
5. **Combat that's fun, not grindy** — needs morale/routing, not annihilation.
6. **Underspecified economy + counter-siege loop** — risk of death spirals or
   incoherent progression.
7. **Content burden** of many unique castles across two continents.
8. **Business-model-by-accident** — decide premium vs F2P deliberately.
9. **Cultural framing** of a Crusades-era conquest map.

---

## 7. Open Questions for You

1. **Tone:** soft *art style* on a real war game, or a fully family-friendly
   bloodless game? (Confirm "Bluey" = aesthetic reference only.)
2. **Platform target:** phones only, or tablets/PC too? (Controls & fidelity hinge on this.)
3. **Single-player first, with multiplayer possible later — agreed?**
4. **Business model:** premium or free-to-play?
5. **Solo or team?** (Sets how aggressively we must cut scope.)
6. **Engine preference**, or should I recommend and prototype in one?

Answer these and Phase 1 can start.
