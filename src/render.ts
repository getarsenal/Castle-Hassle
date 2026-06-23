import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Sim, CASTLE, Faction, WORLD, LAYOUT } from './sim';
import { makeSoldierTexture, makeArrowTexture, SpriteKind } from './sprites';
import { stoneTexture, roofTexture, grassTexture, plasterTexture, dirtTexture } from './textures';

const KIND: SpriteKind[] = ['heavy', 'light', 'archer', 'cavalry'];
const SPRITE_W = [2.0, 1.8, 1.8, 3.0];
const SPRITE_H = [2.7, 2.4, 2.4, 2.8];
const SHADOW_R = [0.95, 0.8, 0.8, 1.35];
// GPU billboarding: the vertex shader turns a per-instance position (+scale/phase/
// state/yaw) into a camera-facing, bobbing sprite — so the CPU only writes 3 floats
// of position per soldier each frame instead of composing a 4x4 matrix. iState:
// 0 = standing, 1 = marching (bob+roll), 2 = corpse (laid flat with a random yaw).
const SOLDIER_VERT = `
  float w = sin(uTime + iPhase);
  vec3 wp;
  if (iState > 1.5) {
    float sc = iScale * 0.95;
    float cyaw = cos(iYaw), syaw = sin(iYaw);
    vec2 q = position.xy * sc;
    wp = vec3(iPos.x + q.x * cyaw - q.y * syaw, 0.13, iPos.z + q.x * syaw + q.y * cyaw);
  } else {
    float moving = step(0.5, iState);
    float stretch = 1.0 + moving * abs(w) * 0.06;
    float bob = moving * w * 0.17 * iScale;
    float roll = moving * w * 0.13;
    float cr = cos(roll), sr = sin(roll);
    vec2 q = position.xy * iScale;
    vec2 qr = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);
    qr.y *= stretch;
    float centerY = iPos.y + uHalfH * iScale * stretch + bob;
    wp = vec3(iPos.x + uRight.x * qr.x, centerY + qr.y, iPos.z + uRight.z * qr.x);
  }
  vec3 transformed = wp;`;

const COL_ATTACK = new THREE.Color('#e0552f');
const COL_DEFEND = new THREE.Color('#3f86d8');

function jit(i: number, s: number): number { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); }

interface SegVis { box: THREE.Mesh; mat: THREE.MeshLambertMaterial; base: THREE.Color; extras: THREE.Object3D[]; h: number; maxhp: number; prevHp: number; crumbling: number; }
interface Treb { group: THREE.Group; arm: THREE.Group; rock: THREE.Mesh; idx: number; prevCd: number; ang: number; throwing: boolean; tp: number; }
interface Debris { x: number; y: number; z: number; vx: number; vy: number; vz: number; rx: number; ry: number; rz: number; vr: number; active: boolean; }
interface Dust { x: number; y: number; z: number; s: number; life: number; max: number; active: boolean; }

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  gl: THREE.WebGLRenderer;
  private meshes: THREE.InstancedMesh[] = [];
  // per-type instance attributes driven each frame (position) and on-change (state/yaw)
  private iPosA: THREE.InstancedBufferAttribute[] = [];
  private iStateA: THREE.InstancedBufferAttribute[] = [];
  private iYawA: THREE.InstancedBufferAttribute[] = [];
  private posDirty = [false, false, false, false];
  private uTime = { value: 0 };                       // shared shader clock (= time * 9)
  private uRight = { value: new THREE.Vector3(1, 0, 0) }; // billboard right vector (camera yaw)
  private shadowMesh!: THREE.InstancedMesh;
  private shadowsOn = true; // per-soldier ground blobs; off for very large musters
  private projMesh!: THREE.InstancedMesh;
  private boulderMesh!: THREE.InstancedMesh;
  private fireMesh!: THREE.InstancedMesh;
  private segVis: (SegVis | null)[] = [];
  private trebs: Treb[] = [];
  private ladderMeshes: THREE.Mesh[] = [];
  private ladderGeo?: THREE.BufferGeometry;
  private ladderMat?: THREE.MeshLambertMaterial;
  private ramModels: { group: THREE.Group; beam: THREE.Object3D }[] = [];
  private ramPhase = 0;
  private flags: { mesh: THREE.Mesh; base: Float32Array; amp: number; ph: number }[] = [];
  private sun!: THREE.DirectionalLight;
  private debrisMesh!: THREE.InstancedMesh; private debris: Debris[] = []; private debrisHead = 0;
  private dustMesh!: THREE.InstancedMesh; private dust: Dust[] = []; private dustHead = 0;
  private dmgColor = new THREE.Color('#8f8166'); // wall colour at near-zero hp
  private shadowDirtyT = -1; // >0: a collapse is settling; refresh the shadow map ONCE when it elapses
  private selRing: THREE.Mesh;
  private targetRing: THREE.Mesh;
  private rangeFans: THREE.Group[] = [];
  private fanGeoDisc!: THREE.BufferGeometry; private fanGeoEdge!: THREE.BufferGeometry;
  private fanMatDisc!: THREE.Material; private fanMatEdge!: THREE.Material;
  private preview: THREE.Mesh;
  private previewArrow: THREE.Mesh;
  private dummy = new THREE.Object3D();
  private billboard = new THREE.Quaternion(); // dust + projectiles still billboard on the CPU
  private _col = new THREE.Color();
  private corpse?: Uint8Array;                 // which units have been laid down as bodies
  private colorDirty = [false, false, false, false];
  private moveMarker?: THREE.Group;
  private moveMarkerT = 0;
  private time = 0;
  private sscale: Float32Array;
  private rubbleMat = new THREE.MeshLambertMaterial({ color: '#a3987f' });
  // shared procedural textures (one GPU upload each; materials clone but keep the map)
  private texStone = stoneTexture();
  private texRoof = roofTexture();
  private texGrass = grassTexture();
  private texPlaster = plasterTexture();

  camTarget = new THREE.Vector3(0, 0, 34);
  camDist = 165; camYaw = 0; camPitch = 0.92;
  private shakeAmt = 0; // transient camera-shake magnitude (impacts, breaches)
  shake(a: number) { this.shakeAmt = Math.min(2.2, this.shakeAmt + a); }
  private focusT = 0; private focusX = 0; private focusZ = 0; // victory push-in toward the keep
  focusKeep(x: number, z: number) { this.focusT = 1; this.focusX = x; this.focusZ = z; }

  constructor(private sim: Sim, canvasParent: HTMLElement) {
    // Mobile is fill-rate + draw-call bound. Render at device-pixel 1 (the HUD
    // is DOM so text stays crisp) and skip MSAA — the chunky art doesn't need it.
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.setPixelRatio(1);
    // Filmic tone mapping — the single biggest "real game" upgrade: warm highlight
    // rolloff + richer contrast, matching the icon's golden, punchy look.
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.14;
    // Real sun shadows. Only the (few, merged, mostly-static) structures cast — not
    // the 2000 sprite soldiers — so it stays cheap on mobile while giving the field
    // genuine 3D form. A soft PCF kernel keeps the chunky art from getting jaggy.
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    canvasParent.appendChild(this.gl.domElement);

    this.scene.background = new THREE.Color('#b7d3ec');
    // warm golden haze on the horizon so the big field reads with depth
    this.scene.fog = new THREE.Fog('#e7d9bd', 235, 590);
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, 1100);

    // Warm raking key light (low golden sun) + cool sky fill so shadows stay alive.
    this.scene.add(new THREE.HemisphereLight('#fff4da', '#6d7b3e', 0.78));
    const sun = new THREE.DirectionalLight('#ffe1ad', 2.0); sun.position.set(96, 132, 64);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536); // frozen + re-baked rarely, so 1536 stays crisp on the big static structures at a fraction of 2048's memory/bake cost
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -185; sc.right = 185; sc.top = 210; sc.bottom = -210; sc.near = 20; sc.far = 460;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 1.1; sun.shadow.radius = 2.2;
    // The structures are static, so the shadow map is FROZEN after the first frame and
    // only re-rendered when a wall is being damaged/crumbling — near-zero cost on mobile.
    sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true; this.sun = sun;
    this.scene.add(sun); this.scene.add(sun.target); // target defaults to the castle centre (origin)
    const fill = new THREE.DirectionalLight('#aac6e4', 0.3); fill.position.set(-70, 55, -45); this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight('#fff0d6', 0.18));

    this.sscale = new Float32Array(sim.n);
    for (let i = 0; i < sim.n; i++) this.sscale[i] = 0.9 + jit(i, 1) * 0.28;

    this.buildSky();
    this.buildGround();
    this.buildCastle();
    this.buildProps();
    this.buildTrees();
    this.buildSoldiers();
    this.buildShadows();
    this.buildProjectiles();
    this.buildTrebuchets();
    this.buildBallistae();
    this.buildEffects();
    this.buildMotes();

    const ringGeo = new THREE.RingGeometry(2.6, 3.4, 40); ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.85 }));
    this.selRing.visible = false; this.scene.add(this.selRing);
    const tg = new THREE.RingGeometry(2.2, 3.2, 4); tg.rotateX(-Math.PI / 2);
    this.targetRing = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: '#ff5a3c', transparent: true, opacity: 0.95 }));
    this.targetRing.visible = false; this.scene.add(this.targetRing);

    // move-order ping: a ground ring + a bouncing arrow pointing down at the spot
    this.moveMarker = new THREE.Group();
    const mr = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.4, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#9ef07a', transparent: true, opacity: 0.9, depthWrite: false }));
    const ac = new THREE.ConeGeometry(1.1, 2.4, 5); // points down (apex -Y)
    const arrow = new THREE.Mesh(ac, new THREE.MeshBasicMaterial({ color: '#9ef07a', transparent: true, opacity: 0.95 }));
    arrow.rotation.x = Math.PI; arrow.position.y = 5; arrow.name = 'arrow';
    this.moveMarker.add(mr, arrow); this.moveMarker.visible = false; this.scene.add(this.moveMarker);
    this.corpse = new Uint8Array(sim.n);

    // range fans — one per COMPANY (translucent disc + edge ring), so a spread-out
    // arm shows the area its men actually cover, not a single circle from the centre
    this.fanGeoDisc = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this.fanGeoEdge = new THREE.RingGeometry(0.97, 1.0, 48).rotateX(-Math.PI / 2);
    this.fanMatDisc = new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.05, depthWrite: false });
    this.fanMatEdge = new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.4, depthWrite: false });

    this.preview = new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 1), new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.preview.visible = false; this.scene.add(this.preview);
    const ag = new THREE.ConeGeometry(1.5, 3.2, 4); ag.rotateX(Math.PI / 2);
    this.previewArrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.previewArrow.visible = false; this.scene.add(this.previewArrow);

    // frame the whole siege: between the castle centre and the (roomier) camp
    this.camTarget.set(LAYOUT.gate.x * 0.5, 0, LAYOUT.D * 0.5 + 48);
    this.camDist = Math.min(250, Math.hypot(LAYOUT.W, LAYOUT.D) * 2.3 + 92);

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight; this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
  }

  // Adaptive resolution: render the 3D buffer at `q`× screen pixels (HUD is DOM,
  // stays crisp). Driven by measured fps so weak devices auto-scale down.
  quality = 1;
  setQuality(q: number) {
    q = Math.max(0.6, Math.min(1, Math.round(q * 100) / 100));
    if (q === this.quality) return;
    this.quality = q; this.gl.setPixelRatio(q); this.gl.setSize(window.innerWidth, window.innerHeight);
  }

  private buildSky() {
    const geo = new THREE.SphereGeometry(560, 24, 16);
    const top = new THREE.Color('#bcd9f0'), bot = new THREE.Color('#f4ead2');
    const colors: number[] = []; const pos = geo.attributes.position; const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) { const t = Math.max(0, Math.min(1, (pos.getY(i) / 560) * 1.4 + 0.25)); c.copy(bot).lerp(top, t); colors.push(c.r, c.g, c.b); }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })));
  }

  private buildGround() {
    const g = new THREE.PlaneGeometry(760, 760, 80, 80); g.rotateX(-Math.PI / 2);
    // gentle vertex tint variation on top of the grass texture for large-scale richness
    const base = new THREE.Color('#9bbb5c'); const c = new THREE.Color(); const colors: number[] = []; const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const n = 0.9 + ((Math.sin(pos.getX(i) * 0.07) * Math.cos(pos.getZ(i) * 0.06) + 1) / 2) * 0.2; c.copy(base).multiplyScalar(n); colors.push(c.r, c.g, c.b); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const grass = this.texGrass.clone(); grass.wrapS = grass.wrapT = THREE.RepeatWrapping; grass.repeat.set(60, 60); grass.needsUpdate = true;
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: grass, vertexColors: true }));
    ground.position.y = -0.02; ground.receiveShadow = true; this.scene.add(ground);

    // One packed-earth texture drives the road and the castle courtyard so the bare
    // ground reads as trodden earth, not flat tan card. (Generated once — no per-frame cost.)
    const earth = dirtTexture(); earth.wrapS = earth.wrapT = THREE.RepeatWrapping;
    // The COURTYARD: textured earth inside the walls, seated only ~2m past them so the
    // castle no longer sits on a big tan box on the grass (it hugs the base instead).
    const apW = (LAYOUT.W + 2) * 2, apD = (LAYOUT.D + 2) * 2;
    const apronTex = earth.clone(); apronTex.repeat.set(apW / 12, apD / 12); apronTex.needsUpdate = true;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(apW, apD).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ map: apronTex, color: '#b39a72' }));
    apron.position.set(0, 0.005, 0); apron.receiveShadow = true; this.scene.add(apron);
    // a worn approach road from the attacker camp up to the gate — textured ruts, and a
    // soft feathered head/edge (vertex alpha-ish via a darker centre) instead of a hard slab.
    const roadTex = earth.clone(); roadTex.repeat.set(2.2, 16); roadTex.needsUpdate = true;
    const roadGeo = new THREE.PlaneGeometry(17, 156, 1, 10).rotateX(-Math.PI / 2);
    const road = new THREE.Mesh(roadGeo, new THREE.MeshLambertMaterial({ map: roadTex, color: '#9c8158' }));
    road.position.set(LAYOUT.gate.x, 0.012, LAYOUT.D + 72); road.receiveShadow = true; this.scene.add(road);
  }

  // shared stone materials (slight tone variation for richness)
  private stone(hex: string, v = 0) { const c = new THREE.Color(hex); if (v) c.offsetHSL(0, 0, v); return new THREE.MeshLambertMaterial({ color: c }); }

  // a UV'd box geometry baked into local space (optionally Y-rotated first)
  private boxG(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BoxGeometry {
    const g = new THREE.BoxGeometry(w, h, d); if (ry) g.rotateY(ry); g.translate(x, y, z); return g;
  }
  // stamp a flat vertex colour onto a geometry (so many tinted pieces can merge
  // into ONE mesh and still vary per-piece)
  private paint(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
    const n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3)); return g;
  }

  private buildCastle() {
    const coneRoofTex = this.texRoof.clone(); coneRoofTex.wrapS = coneRoofTex.wrapT = THREE.RepeatWrapping; coneRoofTex.repeat.set(5, 3); coneRoofTex.needsUpdate = true;
    const roofMat = this.stone('#d06a40'); roofMat.map = coneRoofTex;
    const timber = this.stone('#7a4f2c');
    const stoneCol = (hex: string) => new THREE.Color(hex);
    // STATIC batches (buildings + keep never crumble) — merged into a few meshes
    const bodyGeos: THREE.BufferGeometry[] = [], houseRoofGeos: THREE.BufferGeometry[] = [];
    const doorGeos: THREE.BufferGeometry[] = [], keepStoneGeos: THREE.BufferGeometry[] = [], keepTimberGeos: THREE.BufferGeometry[] = [];

    for (let s = 0; s < CASTLE.length; s++) {
      const b = CASTLE[s];
      const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const extras: THREE.Object3D[] = [];

      if (b.kind === 'wall' || b.kind === 'gate') {
        // every part of the section merges into ONE mesh (origin at ground)
        const parts: THREE.BufferGeometry[] = [this.boxG(w, b.h, d, 0, b.h / 2, 0)];
        const isStone = b.kind === 'wall';
        const horiz = w > d, len = horiz ? w : d;
        const outer = (horiz ? Math.sign(cz) : Math.sign(cx)) || 1;
        // both a curtain wall AND a gatehouse get a crenellated parapet on top
        parts.push(this.boxG(horiz ? w : w - 0.8, 0.5, horiz ? d - 0.8 : d, 0, b.h + 0.25, 0)); // walkway
        const n = Math.floor(len / 1.7);
        for (let k = 0; k <= n; k++) {
          if (k % 2) continue;
          if (horiz) parts.push(this.boxG(1.0, 1.7, 0.7, b.x0 + 0.85 + k * 1.7 - cx, b.h + 0.85, outer * (d / 2 - 0.35)));
          else parts.push(this.boxG(0.7, 1.7, 1.0, outer * (w / 2 - 0.35), b.h + 0.85, b.z0 + 0.85 + k * 1.7 - cz));
        }
        if (b.kind === 'wall') parts.push(this.boxG(horiz ? w : 0.5, 0.7, horiz ? 0.5 : d, horiz ? 0 : -outer * (w / 2 - 0.25), b.h + 0.35, horiz ? -outer * (d / 2 - 0.25) : 0)); // inner rail
        const wood = LAYOUT.palisade; // a town's walls are timber, not dressed stone
        // the gatehouse mass is dressed stone (or a timber frame in a palisade town);
        // the actual planked gate is added as detailed doors below.
        const mat = !wood ? this.stone(b.kind === 'gate' ? '#cdb892' : '#e6d6af') : this.stone(b.kind === 'gate' ? '#6e4a28' : '#8a5a31');
        if (!wood) mat.map = this.texStone;
        const box = new THREE.Mesh(mergeGeometries(parts, false), mat);
        box.position.set(cx, 0, cz); box.castShadow = box.receiveShadow = true; this.scene.add(box);
        if (b.kind === 'gate') this.addGateDoors(extras, cx, cz, w, d, b.h, horiz, outer, wood);
        this.segVis[s] = { box, mat, base: mat.color.clone(), extras, h: b.h, maxhp: b.maxhp, prevHp: b.hp, crumbling: 0 };
      } else if (b.kind === 'tower') {
        const round = LAYOUT.round;
        const parts: THREE.BufferGeometry[] = [];
        if (round) {
          // drum tower — a stone cylinder with a crenellated parapet ring
          const r = Math.max(w, d) / 2;
          parts.push(new THREE.CylinderGeometry(r, r * 1.04, b.h, 14).translate(0, b.h / 2, 0));
          const ring = new THREE.CylinderGeometry(r + 0.5, r + 0.5, 1.4, 14, 1, true).translate(0, b.h + 0.6, 0);
          parts.push(ring);
        } else {
          parts.push(this.boxG(w, b.h, d, 0, b.h / 2, 0));
          for (const [ex, ez, ew, ed] of [[0, d / 2, w, 0.8], [0, -d / 2, w, 0.8], [w / 2, 0, 0.8, d], [-w / 2, 0, 0.8, d]] as const)
            parts.push(this.boxG(ew, 1.3, ed, ex, b.h + 0.6, ez));
        }
        const mat = this.stone('#dfcca2'); mat.map = this.texStone;
        const box = new THREE.Mesh(mergeGeometries(parts, false), mat);
        box.position.set(cx, 0, cz); box.castShadow = box.receiveShadow = true; this.scene.add(box);
        // roof + pole + flag stay separate (different materials) and hide on crumble
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * (round ? 0.74 : 0.82), round ? 7.5 : 6.5, round ? 14 : 12), roofMat);
        roof.rotation.y = Math.PI / 4; roof.position.set(cx, b.h + 3.7, cz); roof.castShadow = true; this.scene.add(roof); extras.push(roof);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4), timber); pole.position.set(cx, b.h + 7, cz); this.scene.add(pole); extras.push(pole);
        const flag = this.makeBanner(cx + 0.18, b.h + 8.4, cz, 2.6, 1.5, COL_DEFEND); this.scene.add(flag); extras.push(flag);
        this.segVis[s] = { box, mat, base: mat.color.clone(), extras, h: b.h, maxhp: b.maxhp, prevHp: b.hp, crumbling: 0 };
      } else if (b.kind === 'keep') {
        keepStoneGeos.push(this.boxG(w, b.h, d, cx, b.h / 2, cz), this.boxG(w - 5, 5, d - 5, cx, b.h + 2.5, cz));
        for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; keepStoneGeos.push(this.boxG(w, 1.4, 1, cx + Math.sin(a) * (d / 2), b.h + 0.7, cz + Math.cos(a) * (d / 2), a)); }
        const roof = new THREE.Mesh(new THREE.ConeGeometry((w - 5) * 0.8, 9, 14), roofMat); roof.position.set(cx, b.h + 9.5, cz); roof.castShadow = true; this.scene.add(roof);
        keepTimberGeos.push(this.boxG(2.6, 4, 0.4, cx, 2, b.z1));
        for (const [wx, wy] of [[-3, 8], [3, 8], [-3, 13], [3, 13]] as const) keepTimberGeos.push(this.boxG(1, 1.6, 0.3, cx + wx, wy, b.z1));
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6), timber); pole.position.set(cx, b.h + 15, cz); pole.castShadow = true; this.scene.add(pole);
        const flag = this.makeBanner(cx + 0.26, b.h + 16.4, cz, 4.2, 2.5, COL_DEFEND); this.scene.add(flag);
      } else if (b.kind === 'building') {
        // half-timbered plaster house + tiled gabled roof — colour baked into
        // vertex colours so every house merges into one mesh yet varies.
        const tone = 0.84 + jit(s, 7) * 0.26;
        bodyGeos.push(this.paint(this.boxG(w, b.h, d, cx, b.h / 2, cz), new THREE.Color('#d8c39a').multiplyScalar(tone)));
        doorGeos.push(this.boxG(1.4, Math.min(2.6, b.h - 1), 0.2, cx, Math.min(2.6, b.h - 1) / 2, b.z1 + 0.06));
        const long = w >= d, span = long ? d : w, runL = long ? w : d;
        const rh = span * 0.42 + 0.6, half = span / 2 + 0.5;
        const x0 = -runL / 2 - 0.4, x1 = runL / 2 + 0.4, ey = b.h - 0.2, ry = b.h + rh;
        const ur = runL / 4, vr = Math.hypot(half, rh) / 2.6;
        const P: Record<string, [number[], number[]]> = {
          a0: [[x0, ry, 0], [0, vr]], a1: [[x1, ry, 0], [ur, vr]],
          e0L: [[x0, ey, -half], [0, 0]], e0R: [[x0, ey, half], [0, 0]],
          e1L: [[x1, ey, -half], [ur, 0]], e1R: [[x1, ey, half], [ur, 0]],
        };
        const vv: number[] = [], uv: number[] = [];
        const tri = (...names: string[]) => names.forEach(nm => { const [p, u] = P[nm]; vv.push(p[0], p[1], p[2]); uv.push(u[0], u[1]); });
        tri('e0L', 'e1L', 'a1', 'e0L', 'a1', 'a0');
        tri('e1R', 'e0R', 'a0', 'e1R', 'a0', 'a1');
        tri('e0R', 'e0L', 'a0'); tri('e1L', 'e1R', 'a1');
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(vv, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        if (!long) geo.rotateY(Math.PI / 2);
        geo.translate(cx, 0, cz); geo.computeVertexNormals();
        this.paint(geo, (jit(s, 9) > 0.5 ? new THREE.Color('#c06a3a') : new THREE.Color('#a98a52')).multiplyScalar(tone));
        houseRoofGeos.push(geo);
      }
    }

    // ---- collapse the static batches into a handful of draw calls ----
    if (bodyGeos.length) {
      const m = new THREE.Mesh(mergeGeometries(bodyGeos, false), new THREE.MeshLambertMaterial({ map: this.texPlaster, vertexColors: true }));
      m.castShadow = m.receiveShadow = true; this.scene.add(m);
    }
    if (houseRoofGeos.length) {
      const m = new THREE.Mesh(mergeGeometries(houseRoofGeos, false), new THREE.MeshLambertMaterial({ map: this.texRoof, vertexColors: true, side: THREE.DoubleSide }));
      m.castShadow = true; this.scene.add(m);
    }
    if (doorGeos.length) this.scene.add(new THREE.Mesh(mergeGeometries(doorGeos, false), timber));
    if (keepStoneGeos.length) { const km = this.stone('#d6c499'); km.map = this.texStone; const m = new THREE.Mesh(mergeGeometries(keepStoneGeos, false), km); m.castShadow = m.receiveShadow = true; this.scene.add(m); }
    if (keepTimberGeos.length) this.scene.add(new THREE.Mesh(mergeGeometries(keepTimberGeos, false), timber));
  }

  private buildTrees() {
    const W = LAYOUT.W, D = LAYOUT.D, gx = LAYOUT.gate.x;
    // rejection-sample positions: outside the castle, clear of the south army lane
    const pts: [number, number, number][] = [];
    let guard = 0;
    while (pts.length < 40 && guard++ < 2000) {
      const x = WORLD.minX + 8 + Math.random() * (WORLD.maxX - WORLD.minX - 16);
      const z = WORLD.minZ + 8 + Math.random() * (WORLD.maxZ - WORLD.minZ - 16);
      if (Math.abs(x) < W + 16 && Math.abs(z) < D + 16) continue;          // not on the castle
      if (z > D + 8 && z < D + 100 && Math.abs(x - gx) < 78) continue;     // keep the assault field clear
      pts.push([x, z, 0.8 + Math.random() * 0.7]);
    }
    const n = pts.length;
    const trunkGeo = new THREE.CylinderGeometry(0.32, 0.62, 4.4, 6);
    const trunk = new THREE.InstancedMesh(trunkGeo, this.stone('#5e4128'), n);
    // A fuller canopy: three lumps merged into ONE geometry (still one instanced draw),
    // so each tree reads as a leafy crown instead of a single floating ball.
    const canopyGeo = mergeGeometries([
      new THREE.IcosahedronGeometry(2.7, 0),
      new THREE.IcosahedronGeometry(1.95, 0).translate(1.5, 1.7, 0.5),
      new THREE.IcosahedronGeometry(1.75, 0).translate(-1.3, 1.25, -0.7),
    ], false);
    const canopy = new THREE.InstancedMesh(canopyGeo, new THREE.MeshLambertMaterial({ flatShading: true, color: '#ffffff' }), n);
    trunk.frustumCulled = false; canopy.frustumCulled = false;
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const [x, z, sc] = pts[i];
      this.dummy.position.set(x, 2.2 * sc, z); this.dummy.rotation.set(0, Math.random() * 6, 0); this.dummy.scale.set(sc, sc, sc);
      this.dummy.updateMatrix(); trunk.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(x, (4.4 + Math.random() * 0.8) * sc, z); this.dummy.rotation.set(0, Math.random() * 6, 0);
      this.dummy.scale.set(sc * (0.9 + Math.random() * 0.35), sc * (0.95 + Math.random() * 0.45), sc * (0.9 + Math.random() * 0.35));
      this.dummy.updateMatrix(); canopy.setMatrixAt(i, this.dummy.matrix);
      // warm, varied foliage — a touch of autumn here and there to match the dusk brand
      const g = 0.78 + Math.random() * 0.4, warm = Math.random() < 0.22;
      if (warm) col.setRGB(0.46 * g, 0.4 * g, 0.16 * g); else col.setRGB(0.27 * g, 0.5 * g, 0.2 * g);
      canopy.setColorAt(i, col);
    }
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(1, 1, 1); this.dummy.rotation.set(0, 0, 0);
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    this.scene.add(trunk); this.scene.add(canopy);
  }

  private buildProps() {
    // Siege camp OUTSIDE the south gate — tents on the approach, clear of the
    // army deployment lane. (The town now lives inside the walls.)
    const canvas = this.stone('#d8cbb0'); const woodMat = this.stone('#7a5230');
    const tent = (x: number, z: number, r: number) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.ConeGeometry(3.6, 4.5, 6), canvas.clone()); body.position.y = 2.25; g.add(body);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 5.5), woodMat); pole.position.y = 2.75; g.add(pole);
      g.position.set(x, 0, z); g.rotation.y = r; this.scene.add(g);
    };
    const z0 = LAYOUT.D + 42;
    for (let k = 0; k < 7; k++) { const sx = (k - 3) * 17; tent(LAYOUT.gate.x + sx, z0 + (k % 2) * 12, k * 0.7); }
  }

  private buildEffects() {
    const rock = new THREE.IcosahedronGeometry(0.6, 0);
    this.debrisMesh = new THREE.InstancedMesh(rock, new THREE.MeshLambertMaterial({ color: '#b3a685', flatShading: true }), 240);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.debrisMesh.frustumCulled = false; this.scene.add(this.debrisMesh);
    for (let i = 0; i < 240; i++) this.debris.push({ x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, vr: 0, active: false });

    const c = document.createElement('canvas'); c.width = c.height = 64; const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30); g.addColorStop(0, 'rgba(228,218,196,0.92)'); g.addColorStop(1, 'rgba(228,218,196,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const dtex = new THREE.CanvasTexture(c); dtex.colorSpace = THREE.SRGBColorSpace;
    this.dustMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: dtex, transparent: true, depthWrite: false }), 140);
    this.dustMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.dustMesh.frustumCulled = false; this.scene.add(this.dustMesh);
    for (let i = 0; i < 140; i++) this.dust.push({ x: 0, y: -1000, z: 0, s: 1, life: 0, max: 1, active: false });
  }

  private spawnDebris(x: number, y: number, z: number, n: number) {
    for (let k = 0; k < n; k++) {
      const d = this.debris[this.debrisHead]; this.debrisHead = (this.debrisHead + 1) % this.debris.length;
      d.x = x + (Math.random() - 0.5) * 5; d.y = y + Math.random() * 3; d.z = z + (Math.random() - 0.5) * 5;
      d.vx = (Math.random() - 0.5) * 9; d.vy = 4 + Math.random() * 9; d.vz = (Math.random() - 0.5) * 9;
      d.rx = Math.random() * 6; d.ry = Math.random() * 6; d.rz = Math.random() * 6; d.vr = (Math.random() - 0.5) * 8; d.active = true;
    }
  }
  private spawnDust(x: number, y: number, z: number, size: number, n: number) {
    for (let k = 0; k < n; k++) {
      const p = this.dust[this.dustHead]; this.dustHead = (this.dustHead + 1) % this.dust.length;
      p.x = x + (Math.random() - 0.5) * 3; p.y = y + Math.random() * 2; p.z = z + (Math.random() - 0.5) * 3;
      p.s = size * (0.6 + Math.random() * 0.6); p.max = 0.7 + Math.random() * 0.6; p.life = p.max; p.active = true;
    }
  }

  // Begin the collapse: debris + dust burst; the box sinks over ~0.7s (render()).
  private crumble(s: number) {
    const v = this.segVis[s]; if (!v || v.crumbling > 0) return;
    v.crumbling = 0.0001; v.mat.color.copy(this.rubbleMat.color);
    // Schedule ONE shadow-map refresh for just after the collapse settles. The
    // frozen map only needs re-baking once the rubble has stopped moving — doing
    // it per frame for 0.7s was re-rendering the whole scene depth ~40 times and
    // is exactly what stuttered the moment a gate fell. New collapses extend the
    // timer so a cluster of breaches coalesces into a single re-bake.
    this.shadowDirtyT = 0.85;
    for (const e of v.extras) e.visible = false;
    this.spawnDebris(v.box.position.x, v.h * 0.5, v.box.position.z, 16);
    this.spawnDust(v.box.position.x, v.h * 0.5, v.box.position.z, 9, 6);
  }

  private buildSoldiers() {
    const col = new THREE.Color(), idn = new THREE.Matrix4();
    for (let t = 0; t < 4; t++) {
      const total = Math.max(1, this.sim.typeCount[t]);
      const tex = makeSoldierTexture(KIND[t]);
      // Opaque alpha-cutout (depth-writing, no blend overdraw), FrontSide (the
      // yaw-billboard and face-up corpses never show a back face), and the transform
      // itself runs on the GPU: a custom vertex stage (injected via onBeforeCompile)
      // billboards + bobs each sprite from a per-instance position, so the CPU never
      // composes a matrix. instanceMatrix is left identity and ignored by the shader.
      const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.FrontSide, toneMapped: false });
      const halfH = SPRITE_H[t] * 0.5;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.uTime; shader.uniforms.uRight = this.uRight; shader.uniforms.uHalfH = { value: halfH };
        shader.vertexShader = 'attribute vec3 iPos;\nattribute float iScale;\nattribute float iPhase;\nattribute float iState;\nattribute float iYaw;\n'
          + 'uniform float uTime;\nuniform vec3 uRight;\nuniform float uHalfH;\n'
          + shader.vertexShader.replace('#include <begin_vertex>', SOLDIER_VERT);
      };
      mat.customProgramCacheKey = () => 'castleSoldier';
      const geo = new THREE.PlaneGeometry(SPRITE_W[t], SPRITE_H[t]);
      const mesh = new THREE.InstancedMesh(geo, mat, total);
      mesh.frustumCulled = false;
      for (let k = 0; k < total; k++) mesh.setMatrixAt(k, idn); // identity -> shader supplies the transform
      mesh.instanceMatrix.needsUpdate = true;
      const iPos = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const iScale = new THREE.InstancedBufferAttribute(new Float32Array(total), 1);
      const iPhase = new THREE.InstancedBufferAttribute(new Float32Array(total), 1);
      const iState = new THREE.InstancedBufferAttribute(new Float32Array(total), 1).setUsage(THREE.DynamicDrawUsage);
      const iYaw = new THREE.InstancedBufferAttribute(new Float32Array(total), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iPos', iPos); geo.setAttribute('iScale', iScale); geo.setAttribute('iPhase', iPhase);
      geo.setAttribute('iState', iState); geo.setAttribute('iYaw', iYaw);
      for (let i = 0; i < this.sim.n; i++) {
        if (this.sim.typ[i] !== t) continue;
        const slot = this.sim.slot[i];
        const bse = this.sim.fac[i] === Faction.Attacker ? COL_ATTACK : COL_DEFEND;
        const br = 0.82 + jit(i, 2) * 0.32;
        col.setRGB(bse.r * br * (0.95 + jit(i, 3) * 0.1), bse.g * br, bse.b * br * (0.95 + jit(i, 4) * 0.1));
        mesh.setColorAt(slot, col);
        iScale.array[slot] = this.sscale[i]; iPhase.array[slot] = i * 1.7;
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.iPosA[t] = iPos; this.iStateA[t] = iState; this.iYawA[t] = iYaw;
      this.meshes[t] = mesh; this.scene.add(mesh);
    }
  }

  private buildShadows() {
    // Per-soldier shadow blobs double the transparent-quad draw. At huge musters
    // they overlap into mush anyway, so drop them past a threshold to keep the
    // "go wild" battles moving — the army still reads, just without ground dots.
    this.shadowsOn = this.sim.n <= 2400;
    const geo = new THREE.CircleGeometry(0.7, 12); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: '#23311c', transparent: true, opacity: 0.2, depthWrite: false });
    this.shadowMesh = new THREE.InstancedMesh(geo, mat, this.shadowsOn ? this.sim.n : 1);
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.shadowMesh.frustumCulled = false;
    if (!this.shadowsOn) { this.shadowMesh.visible = false; return; }
    this.scene.add(this.shadowMesh);
    // Shadow scale/rotation are constant per unit, so bake them once into the
    // instance matrices; the render loop then only patches the translation.
    const a = this.shadowMesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.sim.n; i++) {
      const t = this.sim.typ[i], sr = (t < 4 ? SHADOW_R[t] : 0) * (this.sscale[i] || 1), o = i * 16;
      a[o] = sr; a[o + 5] = 1; a[o + 10] = sr; a[o + 15] = 1; a[o + 13] = -1000;
    }
  }

  private buildProjectiles() {
    const arrowMat = new THREE.MeshBasicMaterial({ map: makeArrowTexture(), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
    this.projMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.4, 1.5), arrowMat, 3200);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.projMesh.frustumCulled = false; this.scene.add(this.projMesh);
    this.boulderMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.0, 0), new THREE.MeshLambertMaterial({ color: '#6f655a', flatShading: true }), 60);
    this.boulderMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.boulderMesh.frustumCulled = false; this.scene.add(this.boulderMesh);
    // flaming arrows — additive glowing blob
    const fc = document.createElement('canvas'); fc.width = fc.height = 32; const fx = fc.getContext('2d')!;
    const fg = fx.createRadialGradient(16, 16, 1, 16, 16, 15); fg.addColorStop(0, 'rgba(255,240,180,1)'); fg.addColorStop(0.4, 'rgba(255,150,40,0.9)'); fg.addColorStop(1, 'rgba(255,80,0,0)');
    fx.fillStyle = fg; fx.fillRect(0, 0, 32, 32);
    const ftex = new THREE.CanvasTexture(fc); ftex.colorSpace = THREE.SRGBColorSpace;
    this.fireMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: ftex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 450);
    this.fireMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.fireMesh.frustumCulled = false; this.scene.add(this.fireMesh);
  }

  // Forward (toward the castle) is -Z. A real trebuchet: counterweight on the
  // SHORT arm (front/target side), the sling + stone on the LONG arm at the
  // REAR. Loaded, the weight is up at the front and the long arm is down at the
  // back with the stone near the ground; on release the weight drops and the
  // long arm whips up and over the top, slinging the stone forward.
  private makeTreb(): { group: THREE.Group; arm: THREE.Group; rock: THREE.Mesh } {
    const timber = this.stone('#8a6a42'); const dark = this.stone('#6a4f30');
    const g = new THREE.Group();
    // static frame (sled + A-frame) merged into ONE mesh
    const frame: THREE.BufferGeometry[] = [];
    for (const sx of [-1.6, 1.6]) frame.push(new THREE.BoxGeometry(0.7, 0.7, 8).translate(sx, 0.4, 0));
    for (const sz of [-3, 3]) frame.push(new THREE.BoxGeometry(3.9, 0.6, 0.7).translate(0, 0.4, sz));
    for (const sx of [-1.6, 1.6]) {
      const a = new THREE.BoxGeometry(0.55, 8, 0.55); a.rotateX(-0.32); a.translate(sx, 3.4, 0.9); frame.push(a);
      const b = new THREE.BoxGeometry(0.55, 8, 0.55); b.rotateX(0.32); b.translate(sx, 3.4, -0.9); frame.push(b);
    }
    g.add(new THREE.Mesh(mergeGeometries(frame, false), timber));
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4), dark); axle.rotation.z = Math.PI / 2; axle.position.y = 6.4; g.add(axle);
    // arm pivot group (animates): long arm to +Z (rear), short arm to -Z (front)
    const arm = new THREE.Group(); arm.position.set(0, 6.4, 0); g.add(arm);
    const beams = mergeGeometries([
      new THREE.BoxGeometry(0.5, 0.5, 12).translate(0, 0, 3.6),  // long arm, rear
      new THREE.BoxGeometry(0.5, 0.5, 4).translate(0, 0, -3.0),  // short arm, front
    ], false);
    arm.add(new THREE.Mesh(beams, timber));
    const cw = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.4), dark); cw.position.set(0, -0.8, -5.2); arm.add(cw); // counterweight (front)
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 0), new THREE.MeshLambertMaterial({ color: '#6f655a', flatShading: true }));
    rock.position.set(0, -1.2, 8.8); arm.add(rock); // stone in the sling at the long-arm tip (rear)
    arm.rotation.x = 0.75; // cocked: long arm down (stone near the ground, rear), weight up at the front
    return { group: g, arm, rock };
  }

  private buildTrebuchets() {
    for (let i = 0; i < this.sim.n; i++) {
      if (this.sim.typ[i] !== 4) continue;
      const { group, arm, rock } = this.makeTreb();
      this.scene.add(group);
      this.trebs.push({ group, arm, rock, idx: i, prevCd: 0, ang: 0.75, throwing: false, tp: 0 });
    }
  }

  // Defensive ballistae mounted on the widened wall sections.
  private ballistaModels: { group: THREE.Group; stock: THREE.Group; bolt: THREE.Mesh; e: number }[] = [];
  private makeBallista() {
    const g = new THREE.Group();
    const wood = this.stone('#6e4d28'), dark = this.stone('#4a3219'), iron = this.stone('#9a958c');
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 2.4), wood); base.position.y = 0.25; g.add(base);
    for (const sx of [-0.9, 0.9]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 0.3), dark); leg.position.set(sx, 0.6, -0.6); g.add(leg); }
    const stock = new THREE.Group(); stock.position.set(0, 1.05, 0); g.add(stock);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 3.0), wood); rail.position.z = 0.5; stock.add(rail);
    const bow = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.28, 0.28), dark); bow.position.z = 1.4; stock.add(bow);
    for (const sx of [-1.7, 1.7]) { const tip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.9), dark); tip.position.set(sx, 0, 1.0); stock.add(tip); }
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 2.6, 6).rotateX(Math.PI / 2), iron); bolt.position.z = 0.7; stock.add(bolt);
    g.add(stock); return { group: g, stock, bolt };
  }
  private buildBallistae() {
    const list = (this.sim as any).ballistae as { x: number; z: number; y: number }[];
    for (let i = 0; i < list.length; i++) {
      const { group, stock, bolt } = this.makeBallista();
      group.position.set(list[i].x, list[i].y, list[i].z);
      this.scene.add(group); this.ballistaModels.push({ group, stock, bolt, e: i });
    }
  }

  // A real-looking gate: two heavy planked oak leaves with iron banding and a stud
  // line down the seam, under a stone (or timber) arch — added as extras so they
  // hide when the gate is breached. Built facing local +Z, then turned to the wall.
  private addGateDoors(extras: THREE.Object3D[], cx: number, cz: number, w: number, d: number, h: number, horiz: boolean, outer: number, palisade: boolean) {
    const oakA = this.stone('#46300f'), oakB = this.stone('#3a2710'), ironMat = this.stone('#2c2d33');
    const archMat = palisade ? this.stone('#6e4a28') : (() => { const m = this.stone('#d8c39a'); m.map = this.texStone; return m; })();
    const g = new THREE.Group();
    const open = Math.max(2.5, (horiz ? w : d) - 0.6); // door opening across the wall
    const face = (horiz ? d : w) / 2;                  // half-depth → the outer face
    const doorH = Math.max(3, h - 1.3), th = 0.55, fz = face + th / 2 - 0.05;
    for (const side of [-1, 1]) {                       // two leaves with a centre seam
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(open / 2 - 0.12, doorH, th), side < 0 ? oakA : oakB);
      leaf.position.set(side * open / 4, doorH / 2, fz); g.add(leaf);
    }
    for (const f of [0.16, 0.5, 0.84]) {                // horizontal iron bands
      const band = new THREE.Mesh(new THREE.BoxGeometry(open, 0.32, th + 0.14), ironMat);
      band.position.set(0, doorH * f, fz); g.add(band);
    }
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.22, doorH, th + 0.12), ironMat); seam.position.set(0, doorH / 2, fz); g.add(seam);
    const arch = new THREE.Mesh(new THREE.BoxGeometry(open + 1.0, 1.0, (horiz ? d : w) + 0.4), archMat); arch.position.set(0, doorH + 0.5, 0); g.add(arch);
    g.position.set(cx, 0, cz);
    g.rotation.y = horiz ? (outer > 0 ? 0 : Math.PI) : (outer > 0 ? Math.PI / 2 : -Math.PI / 2);
    this.scene.add(g); extras.push(g);
  }

  // Ambient dust motes drifting over the field — warm specks catching the sun, the
  // cheap "breathing world" trick. 90 points, soft dot sprite, slow drift + recycle.
  private motes!: THREE.Points; private moteVel!: Float32Array;
  private buildMotes() {
    const N = 90, pos = new Float32Array(N * 3); this.moteVel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 280; pos[i * 3 + 1] = 2 + Math.random() * 46; pos[i * 3 + 2] = -110 + Math.random() * 300;
      this.moteVel[i * 3] = 0.6 + Math.random() * 1.4; this.moteVel[i * 3 + 1] = (Math.random() - 0.5) * 0.5; this.moteVel[i * 3 + 2] = (Math.random() - 0.5) * 0.8;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const cv = document.createElement('canvas'); cv.width = cv.height = 32; const g = cv.getContext('2d')!;
    const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16); rg.addColorStop(0, 'rgba(255,244,214,0.9)'); rg.addColorStop(1, 'rgba(255,244,214,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
    const tex = new THREE.CanvasTexture(cv);
    this.motes = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.5, map: tex, transparent: true, opacity: 0.5, depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending }));
    this.motes.frustumCulled = false; this.scene.add(this.motes);
  }
  private updateMotes(dt: number) {
    const a = this.motes.geometry.attributes.position.array as Float32Array, v = this.moteVel;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += v[i] * dt; a[i + 1] += v[i + 1] * dt + Math.sin(this.time * 0.6 + i) * 0.01; a[i + 2] += v[i + 2] * dt;
      if (a[i] > 150) { a[i] = -150; a[i + 1] = 2 + Math.random() * 46; a[i + 2] = -110 + Math.random() * 300; }
    }
    this.motes.geometry.attributes.position.needsUpdate = true;
  }

  // A heraldic banner flying from a pole: a segmented cloth (so it can ripple) with
  // a gold top band, registered for the per-frame wind wave. Left edge sits at the pole.
  private makeBanner(x: number, y: number, z: number, len: number, h: number, color: THREE.ColorRepresentation): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(len, h, 9, 2); geo.translate(len / 2, 0, 0); // pole at local x=0
    // a slim gold valance along the top edge for a richer, period look
    const col: number[] = []; const c = new THREE.Color(color), gold = new THREE.Color('#e6bb52');
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) { const top = pos.getY(i) > h * 0.32; const cc = top ? gold : c; col.push(cc.r, cc.g, cc.b); }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.position.set(x, y, z);
    this.flags.push({ mesh, base: (pos.array as Float32Array).slice(), amp: 0.12 + len * 0.05, ph: x * 0.3 + z * 0.2 });
    return mesh;
  }
  // ripple every banner in the wind (cheap: a handful of small segmented planes)
  private updateFlags() {
    const t = this.time * 2.4;
    for (const f of this.flags) {
      if (!f.mesh.visible) continue;
      const p = f.mesh.geometry.attributes.position, a = p.array as Float32Array, b = f.base;
      for (let i = 0; i < a.length; i += 3) {
        const lx = b[i]; // distance from the pole along the cloth
        a[i + 2] = Math.sin(t + lx * 1.5 + f.ph) * f.amp * (0.25 + lx * 0.13); // more flutter toward the fly
      }
      p.needsUpdate = true; f.mesh.geometry.computeVertexNormals();
    }
  }

  setSelection(cx: number | null, cz: number | null) { if (cx === null || cz === null) { this.selRing.visible = false; return; } this.selRing.visible = true; this.selRing.position.set(cx, 0.06, cz); }
  setTargetMarker(cx: number | null, cz: number | null) { if (cx === null || cz === null) { this.targetRing.visible = false; return; } this.targetRing.visible = true; this.targetRing.position.set(cx, 0.5, cz); }
  // flash a move-order marker at a ground point for ~1.6s
  pingMove(x: number, z: number) { if (!this.moveMarker) return; this.moveMarker.position.set(x, 0, z); this.moveMarker.visible = true; this.moveMarkerT = 1.6; }
  // Show a translucent range fan per company; their overlap reveals the true reach
  // of a deep formation (the forward edge = the front rank's position + range).
  setRangeFans(list: { x: number; z: number; r: number }[] | null) {
    const n = list ? list.length : 0;
    for (let i = 0; i < n; i++) {
      let g = this.rangeFans[i];
      if (!g) { g = new THREE.Group(); g.add(new THREE.Mesh(this.fanGeoDisc, this.fanMatDisc), new THREE.Mesh(this.fanGeoEdge, this.fanMatEdge)); this.scene.add(g); this.rangeFans[i] = g; }
      const it = list![i]; g.visible = true; g.position.set(it.x, 0.04, it.z); g.scale.set(it.r, 1, it.r);
    }
    for (let i = n; i < this.rangeFans.length; i++) this.rangeFans[i].visible = false;
  }

  setPreview(p0: THREE.Vector3 | null, p1?: THREE.Vector3, fx = 0, fz = 0) {
    if (!p0 || !p1) { this.preview.visible = false; this.previewArrow.visible = false; return; }
    const len = Math.max(2, Math.hypot(p1.x - p0.x, p1.z - p0.z)); const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2;
    this.preview.visible = true; this.preview.position.set(mx, 0.08, mz); this.preview.scale.set(1.4, 1, len); this.preview.rotation.y = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    this.previewArrow.visible = true; this.previewArrow.position.set(mx + fx * 5, 0.1, mz + fz * 5); this.previewArrow.rotation.y = Math.atan2(fx, fz);
  }

  updateCamera() {
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch), cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
    this.camera.position.copy(this.camTarget).add(new THREE.Vector3(sy * cp, sp, cy * cp).multiplyScalar(this.camDist));
    this.camera.lookAt(this.camTarget);
    if (this.shakeAmt > 0.002) { // jolt the camera on impacts (scaled to zoom so it reads at any distance)
      const s = this.shakeAmt * this.camDist * 0.012;
      this.camera.position.x += (Math.random() - 0.5) * s; this.camera.position.y += (Math.random() - 0.5) * s; this.camera.position.z += (Math.random() - 0.5) * s;
    }
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.camTarget);
    const ang = Math.atan2(dir.x, dir.z);
    this.billboard.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang); // dust/projectiles still use the quaternion
    this.uRight.value.set(Math.cos(ang), 0, -Math.sin(ang));           // soldier shader billboard basis
  }

  // Scaling ladders: one mesh per sim ladder, swinging up from the foot (raise).
  private updateLadders() {
    if (!this.ladderGeo) {
      const parts: THREE.BufferGeometry[] = [];
      const H = 10.5, wd = 1.5;
      for (const sx of [-wd / 2, wd / 2]) parts.push(new THREE.BoxGeometry(0.18, H, 0.18).translate(sx, H / 2, 0));
      for (let r = 0; r < 6; r++) parts.push(new THREE.BoxGeometry(wd, 0.16, 0.16).translate(0, 1.0 + r * ((H - 1.6) / 5), 0));
      this.ladderGeo = mergeGeometries(parts, false);
      this.ladderMat = this.stone('#855a2f');
    }
    const lads = this.sim.ladders;
    for (let l = 0; l < lads.length; l++) {
      let m = this.ladderMeshes[l];
      if (!m) { m = new THREE.Mesh(this.ladderGeo, this.ladderMat!); m.rotation.order = 'YXZ'; this.scene.add(m); this.ladderMeshes[l] = m; }
      const L = lads[l];
      const inwardX = L.horiz ? 0 : -L.outer, inwardZ = L.horiz ? -L.outer : 0;
      m.visible = true;
      m.position.set(L.bx, 0, L.bz);
      m.rotation.y = Math.atan2(inwardX, inwardZ);
      m.rotation.x = Math.PI / 2 + (0.28 - Math.PI / 2) * L.raise; // flat -> leaning on the wall
    }
    for (let l = lads.length; l < this.ladderMeshes.length; l++) if (this.ladderMeshes[l]) this.ladderMeshes[l].visible = false;
  }

  // A wheeled battering ram: an A-frame on wheels carrying a slung, iron-headed log
  // that lunges forward (+Z) on the swing. Local +Z faces the gate.
  private makeRam() {
    const g = new THREE.Group();
    const timber = this.stone('#5a3d1e'), dark = this.stone('#3c2813'), iron = this.stone('#8f8a82'), roof = this.stone('#6b4a25');
    for (const sx of [-1.0, 1.0]) {            // wheels
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 10).rotateZ(Math.PI / 2), dark);
      const wb = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 10).rotateZ(Math.PI / 2), dark);
      w.position.set(sx, 0.55, 1.3); wb.position.set(sx, 0.55, -1.3); g.add(w); g.add(wb);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.3, 3.6), timber); sill.position.y = 0.9; g.add(sill);
    for (const sz of [-1.2, 1.2]) {            // A-frame uprights + a peak beam
      for (const sx of [-0.9, 0.9]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.4, 0.22), timber); post.position.set(sx, 2.1, sz); g.add(post); }
    }
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 3.4), timber); ridge.position.set(0, 3.2, 0); g.add(ridge);
    const cover = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 3.6), roof); cover.position.set(0, 3.32, 0); cover.rotation.z = 0; g.add(cover);
    const beam = new THREE.Group();            // the slung ram log (lunges along +Z)
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 3.4, 10).rotateX(Math.PI / 2), timber); beam.add(log);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.6, 10).rotateX(Math.PI / 2), iron); head.position.z = 1.8; beam.add(head);
    beam.position.set(0, 1.7, 0); g.add(beam);
    g.add(beam); return { group: g, beam };
  }
  // Show a ram at every gate the infantry are currently battering; lunge the log.
  private updateRams(dt: number) {
    this.ramPhase += dt * 6.0;
    const rams = this.sim.rammingGates();
    for (let r = 0; r < rams.length; r++) {
      let m = this.ramModels[r];
      if (!m) { m = this.makeRam(); this.scene.add(m.group); this.ramModels[r] = m; }
      const info = rams[r];
      m.group.visible = true;
      m.group.scale.setScalar(1.3);             // a touch oversized so it reads over the crowd
      m.group.position.set(info.x, 0, info.z);
      m.group.rotation.y = info.ang;            // local +Z points at the gate
      m.beam.position.z = 0.6 + Math.max(0, Math.sin(this.ramPhase + r)) * 1.1; // forward lunges
    }
    for (let r = rams.length; r < this.ramModels.length; r++) if (this.ramModels[r]) this.ramModels[r].group.visible = false;
  }

  // wall damage tint, impact puffs, and the animated collapse
  private updateWalls(dt: number) {
    // single, deferred shadow re-bake after collapses settle (see crumble())
    if (this.shadowDirtyT > 0) { this.shadowDirtyT -= dt; if (this.shadowDirtyT <= 0) this.sun.shadow.needsUpdate = true; }
    for (let s = 0; s < CASTLE.length; s++) {
      const v = this.segVis[s]; if (!v) continue;
      const seg = CASTLE[s];
      if (seg.dead) { if (v.crumbling === 0) this.crumble(s); }
      else if (seg.hp < v.prevHp) {
        this.spawnDust(v.box.position.x, v.h * 0.62, v.box.position.z, 5, 2);
        this.spawnDebris(v.box.position.x, v.h * 0.62, v.box.position.z, 3);
        const ratio = Math.max(0, seg.hp / v.maxhp);
        v.mat.color.copy(v.base).lerp(this.dmgColor, 1 - ratio);
      }
      v.prevHp = seg.hp;
      if (v.crumbling > 0 && v.crumbling < 1) {
        v.crumbling = Math.min(1, v.crumbling + dt / 0.7);
        const e = v.crumbling, k = 1 - 0.72 * e;
        // merged section meshes have their origin at the ground, so collapse =
        // squash toward y=0 plus a small sink.
        v.box.scale.y = k; v.box.position.y = -0.5 * e; v.box.rotation.z = e * 0.12 * (s % 2 ? 1 : -1);
        if (e >= 1) v.box.material = this.rubbleMat;
      }
    }
  }

  private updateEffects(dt: number) {
    // debris physics → settle into rubble
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      if (!d.active) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.debrisMesh.setMatrixAt(i, this.dummy.matrix); continue; }
      if (d.y > 0.4) { d.vy -= 26 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; d.rx += d.vr * dt; d.ry += d.vr * 0.7 * dt; }
      else if (d.y !== 0.4) { d.y = 0.4; d.vx *= 0.2; d.vz *= 0.2; d.vy = 0; } // settled
      this.dummy.position.set(d.x, d.y, d.z); this.dummy.rotation.set(d.rx, d.ry, d.rz); this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(i, this.dummy.matrix); this.dummy.rotation.set(0, 0, 0);
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    // dust puffs → expand and fade (shrink-out near end of life)
    for (let i = 0; i < this.dust.length; i++) {
      const p = this.dust[i];
      if (!p.active) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.dustMesh.setMatrixAt(i, this.dummy.matrix); continue; }
      p.life -= dt; if (p.life <= 0) { p.active = false; }
      p.y += dt * 1.2; const t = 1 - p.life / p.max; const grow = 0.5 + t * 1.4, fade = t > 0.7 ? (1 - t) / 0.3 : 1;
      const sc = p.s * grow * fade;
      this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.billboard); this.dummy.scale.set(sc, sc, sc); this.dummy.updateMatrix();
      this.dustMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.dustMesh.instanceMatrix.needsUpdate = true;
  }

  render(dt = 0.016) {
    const sim = this.sim;
    this.time += dt;
    this.shakeAmt *= Math.exp(-dt * 7); // camera-shake decay
    if (this.focusT > 0) { // ease the camera in over the keep on victory
      this.focusT = Math.max(0, this.focusT - dt / 1.6); const k = (1 - this.focusT) * 0.06;
      this.camTarget.x += (this.focusX - this.camTarget.x) * k; this.camTarget.z += (this.focusZ + 14 - this.camTarget.z) * k;
      this.camDist += (Math.max(60, this.camDist * 0.62) - this.camDist) * k;
    }
    this.updateWalls(dt);
    this.updateLadders();
    this.updateRams(dt);
    this.updateFlags();
    this.updateMotes(dt);
    this.updateEffects(dt);

    this.uTime.value = this.time * 9; // advance the shader bob clock
    const shOn = this.shadowsOn;
    const sa = this.shadowMesh.instanceMatrix.array as Float32Array;
    const posD = this.posDirty;
    let anyLive = false;
    // The CPU now writes only per-instance position (3 floats) + a state byte; the
    // billboard, bob, roll and corpse-flatten all happen on the GPU (SOLDIER_VERT).
    for (let i = 0; i < sim.n; i++) {
      const t = sim.typ[i];
      if (t >= 4) { if (shOn) sa[i * 16 + 13] = -1000; continue; } // siege -> 3D model, no sprite
      const slot = sim.slot[i], b3 = slot * 3;
      const ip = this.iPosA[t].array as Float32Array, ist = this.iStateA[t].array as Float32Array;
      if (!sim.alive[i]) {
        if (this.corpse![i]) continue;     // already a body — its instance is frozen
        this.corpse![i] = 1; anyLive = true;
        this._col.setRGB(0.17, 0.16, 0.15); this.meshes[t].setColorAt(slot, this._col); this.colorDirty[t] = true; // grey out
        (this.iYawA[t].array as Float32Array)[slot] = jit(i, 6) * 6.283;
        ip[b3] = sim.px[i]; ip[b3 + 1] = sim.py[i]; ip[b3 + 2] = sim.pz[i];
        ist[slot] = 2; posD[t] = true; this.iYawA[t].needsUpdate = true;
        if (shOn) sa[i * 16 + 13] = -1000; continue;
      }
      ip[b3] = sim.px[i]; ip[b3 + 1] = sim.py[i]; ip[b3 + 2] = sim.pz[i];
      ist[slot] = (Math.abs(sim.vx[i]) + Math.abs(sim.vz[i]) > 0.5) ? 1 : 0;
      posD[t] = true;
      // shadow blob: translation only (off for very large musters)
      if (shOn) { const o = i * 16; sa[o + 12] = sim.px[i]; sa[o + 13] = sim.py[i] < 1 ? 0.03 : sim.py[i] - 0.05; sa[o + 14] = sim.pz[i]; }
      anyLive = true;
    }
    if (anyLive) {
      for (let t = 0; t < 4; t++) {
        if (posD[t]) { this.iPosA[t].needsUpdate = true; this.iStateA[t].needsUpdate = true; posD[t] = false; }
        if (this.colorDirty[t] && this.meshes[t].instanceColor) { this.meshes[t].instanceColor!.needsUpdate = true; this.colorDirty[t] = false; }
      }
      if (shOn) this.shadowMesh.instanceMatrix.needsUpdate = true;
    }

    // move-order ping: bounce the arrow, pulse + fade the ring, then hide
    if (this.moveMarkerT > 0 && this.moveMarker) {
      this.moveMarkerT -= dt;
      const age = 1.6 - this.moveMarkerT, fade = Math.min(1, this.moveMarkerT / 0.4);
      const arrow = this.moveMarker.getObjectByName('arrow') as THREE.Mesh;
      if (arrow) arrow.position.y = 4 + Math.abs(Math.sin(age * 6)) * 2.2;
      this.moveMarker.scale.setScalar(1 + Math.sin(age * 5) * 0.06);
      (this.moveMarker.children as THREE.Mesh[]).forEach(c => { const m = c.material as THREE.MeshBasicMaterial; m.opacity = (c.name === 'arrow' ? 0.95 : 0.9) * fade; });
      this.moveMarker.rotation.y += dt * 1.5;
      if (this.moveMarkerT <= 0) this.moveMarker.visible = false;
    }

    // trebuchets — position + throw animation
    for (const tr of this.trebs) {
      const alive = sim.alive[tr.idx];
      tr.group.visible = !!alive;
      if (!alive) continue;
      tr.group.position.set(sim.px[tr.idx], 0, sim.pz[tr.idx]);
      const cd = sim.cd[tr.idx];
      if (cd > tr.prevCd + 1) { tr.throwing = true; tr.tp = 0; } // just fired
      tr.prevCd = cd;
      if (tr.throwing) {
        tr.tp += dt / 0.35; const e = 1 - Math.pow(1 - Math.min(1, tr.tp), 2);
        tr.ang = 0.75 - e * 2.2;         // whip up and over the top toward the castle
        if (tr.tp >= 1) tr.throwing = false;
      } else tr.ang += (0.75 - tr.ang) * Math.min(1, dt * 1.5); // slow re-cock to loaded
      tr.arm.rotation.x = tr.ang;
      // the stone leaves the sling as the arm passes the top, then a fresh one is
      // loaded as it re-cocks
      tr.rock.visible = tr.ang > -0.4;
    }

    // defensive ballistae: aim at their target, recoil on firing, vanish when the
    // wall section beneath them is breached
    for (const bm of this.ballistaModels) {
      const e = sim.ballistae[bm.e]; const seg = CASTLE[e.seg];
      const dead = !seg || seg.dead; bm.group.visible = !dead;
      if (dead) continue;
      bm.group.rotation.y = Math.atan2(e.aimX - e.x, e.aimZ - e.z);
      bm.bolt.position.z = 0.7 - e.recoil * 2.2;   // yanked back as it looses
      bm.stock.position.z = -e.recoil * 0.4;
    }

    let ac = 0, bc = 0, fc = 0; const up = new THREE.Vector3(0, 1, 0); const v = new THREE.Vector3();
    for (const p of sim.projectiles) {
      if (!p.active) continue;
      if (p.big) {
        if (bc >= 60) continue;
        this.dummy.position.set(p.x, Math.max(0.3, p.y), p.z); this.dummy.quaternion.set(jit(bc, 1), jit(bc, 2), jit(bc, 3), 1).normalize();
        this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix(); this.boulderMesh.setMatrixAt(bc++, this.dummy.matrix);
      } else if (p.fire) {
        if (fc >= 450) continue;
        this.dummy.position.set(p.x, Math.max(0.1, p.y), p.z); this.dummy.quaternion.copy(this.billboard);
        const fl = 0.8 + jit(fc, 5) * 0.5; this.dummy.scale.set(fl, fl, fl); this.dummy.updateMatrix(); this.fireMesh.setMatrixAt(fc++, this.dummy.matrix);
      } else {
        if (ac >= 3200) continue;
        this.dummy.position.set(p.x, Math.max(0.1, p.y), p.z); v.set(p.vx, p.vy, p.vz); if (v.lengthSq() > 0.0001) { v.normalize(); this.dummy.quaternion.setFromUnitVectors(up, v); }
        const bs = p.bolt ? 2.0 : 1; this.dummy.scale.set(bs, bs, bs); this.dummy.updateMatrix(); this.projMesh.setMatrixAt(ac++, this.dummy.matrix);
      }
    }
    for (let k = ac; k < 3200; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.projMesh.setMatrixAt(k, this.dummy.matrix); }
    for (let k = bc; k < 60; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.boulderMesh.setMatrixAt(k, this.dummy.matrix); }
    for (let k = fc; k < 450; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.fireMesh.setMatrixAt(k, this.dummy.matrix); }
    this.projMesh.count = 3200; this.boulderMesh.count = 60; this.fireMesh.count = 450;
    this.projMesh.instanceMatrix.needsUpdate = true; this.boulderMesh.instanceMatrix.needsUpdate = true; this.fireMesh.instanceMatrix.needsUpdate = true;

    this.updateCamera(); this.gl.render(this.scene, this.camera);
  }

  raycastGround(nx: number, ny: number): THREE.Vector3 | null {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const pt = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt) ? pt : null;
  }

  clampTarget() {
    this.camTarget.x = Math.max(WORLD.minX, Math.min(WORLD.maxX, this.camTarget.x));
    this.camTarget.z = Math.max(WORLD.minZ - 10, Math.min(WORLD.maxZ + 10, this.camTarget.z));
    this.camDist = Math.max(30, Math.min(252, this.camDist));
    this.camPitch = Math.max(0.3, Math.min(1.46, this.camPitch));
  }
}
