import * as THREE from 'three';
import { Sim, CASTLE, Faction, WORLD, LAYOUT } from './sim';
import { makeSoldierTexture, makeArrowTexture, SpriteKind } from './sprites';

const KIND: SpriteKind[] = ['heavy', 'light', 'archer', 'cavalry'];
const SPRITE_W = [2.0, 1.8, 1.8, 3.0];
const SPRITE_H = [2.7, 2.4, 2.4, 2.8];
const SHADOW_R = [0.95, 0.8, 0.8, 1.35];

const COL_ATTACK = new THREE.Color('#e2673b');
const COL_DEFEND = new THREE.Color('#4f8fd0');

function jit(i: number, s: number): number { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); }

interface SegVis { box: THREE.Mesh; mat: THREE.MeshLambertMaterial; base: THREE.Color; extras: THREE.Object3D[]; h: number; maxhp: number; prevHp: number; crumbling: number; }
interface Treb { group: THREE.Group; arm: THREE.Group; idx: number; prevCd: number; ang: number; throwing: boolean; tp: number; }
interface Debris { x: number; y: number; z: number; vx: number; vy: number; vz: number; rx: number; ry: number; rz: number; vr: number; active: boolean; }
interface Dust { x: number; y: number; z: number; s: number; life: number; max: number; active: boolean; }

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  gl: THREE.WebGLRenderer;
  private meshes: THREE.InstancedMesh[] = [];
  private shadowMesh!: THREE.InstancedMesh;
  private projMesh!: THREE.InstancedMesh;
  private boulderMesh!: THREE.InstancedMesh;
  private fireMesh!: THREE.InstancedMesh;
  private segVis: (SegVis | null)[] = [];
  private trebs: Treb[] = [];
  private debrisMesh!: THREE.InstancedMesh; private debris: Debris[] = []; private debrisHead = 0;
  private dustMesh!: THREE.InstancedMesh; private dust: Dust[] = []; private dustHead = 0;
  private dmgColor = new THREE.Color('#8f8166'); // wall colour at near-zero hp
  private selRing: THREE.Mesh;
  private targetRing: THREE.Mesh;
  private rangeFan: THREE.Group;
  private preview: THREE.Mesh;
  private previewArrow: THREE.Mesh;
  private dummy = new THREE.Object3D();
  private billboard = new THREE.Quaternion();
  private _roll = new THREE.Quaternion();
  private _zAxis = new THREE.Vector3(0, 0, 1);
  private time = 0;
  private sscale: Float32Array;
  private rubbleMat = new THREE.MeshLambertMaterial({ color: '#a3987f' });

  camTarget = new THREE.Vector3(0, 0, 34);
  camDist = 165; camYaw = 0; camPitch = 0.92;

  constructor(private sim: Sim, canvasParent: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    canvasParent.appendChild(this.gl.domElement);

    this.scene.background = new THREE.Color('#cfe3f2');
    this.scene.fog = new THREE.Fog('#dceaf3', 200, 420);
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, 1100);

    this.scene.add(new THREE.HemisphereLight('#eaf4ff', '#7e8a4e', 1.0));
    const sun = new THREE.DirectionalLight('#fff1d4', 1.2); sun.position.set(80, 150, 60); this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight('#fff4e0', 0.28));

    this.sscale = new Float32Array(sim.n);
    for (let i = 0; i < sim.n; i++) this.sscale[i] = 0.9 + jit(i, 1) * 0.28;

    this.buildSky();
    this.buildGround();
    this.buildCastle();
    this.buildProps();
    this.buildSoldiers();
    this.buildShadows();
    this.buildProjectiles();
    this.buildTrebuchets();
    this.buildEffects();

    const ringGeo = new THREE.RingGeometry(2.6, 3.4, 40); ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.85 }));
    this.selRing.visible = false; this.scene.add(this.selRing);
    const tg = new THREE.RingGeometry(2.2, 3.2, 4); tg.rotateX(-Math.PI / 2);
    this.targetRing = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: '#ff5a3c', transparent: true, opacity: 0.95 }));
    this.targetRing.visible = false; this.scene.add(this.targetRing);

    // range fan (translucent disc + bright edge ring), radius set per unit
    this.rangeFan = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 56).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.07, depthWrite: false }));
    const edge = new THREE.Mesh(new THREE.RingGeometry(0.975, 1.0, 56).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.5, depthWrite: false }));
    this.rangeFan.add(disc, edge); this.rangeFan.visible = false; this.scene.add(this.rangeFan);

    this.preview = new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 1), new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.preview.visible = false; this.scene.add(this.preview);
    const ag = new THREE.ConeGeometry(1.5, 3.2, 4); ag.rotateX(Math.PI / 2);
    this.previewArrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.previewArrow.visible = false; this.scene.add(this.previewArrow);

    // frame the whole siege: between the castle centre and the attacker camp
    this.camTarget.set(LAYOUT.gate.x * 0.5, 0, LAYOUT.D * 0.5);
    this.camDist = Math.min(228, Math.hypot(LAYOUT.W, LAYOUT.D) * 2.3 + 60);

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight; this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
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
    const base = new THREE.Color('#90b257'); const c = new THREE.Color(); const colors: number[] = []; const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const n = 0.84 + ((Math.sin(pos.getX(i) * 0.3) * Math.cos(pos.getZ(i) * 0.27) + 1) / 2) * 0.32; c.copy(base).multiplyScalar(n); colors.push(c.r, c.g, c.b); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })); ground.position.y = -0.02; this.scene.add(ground);
    const rad = Math.hypot(LAYOUT.W, LAYOUT.D);
    const moat = new THREE.Mesh(new THREE.RingGeometry(rad + 6, rad + 16, 72).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#5d7b8c' }));
    moat.position.y = 0.004; this.scene.add(moat);
    const path = new THREE.Mesh(new THREE.PlaneGeometry(22, 130).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#cba877' }));
    path.position.set(LAYOUT.gate.x, 0.01, LAYOUT.D + 60); this.scene.add(path);
  }

  // shared stone materials (slight tone variation for richness)
  private stone(hex: string, v = 0) { const c = new THREE.Color(hex); if (v) c.offsetHSL(0, 0, v); return new THREE.MeshLambertMaterial({ color: c }); }

  private buildCastle() {
    const wallMat = this.stone('#e6d6af');
    const towerMat = this.stone('#dfcca2');
    const keepMat = this.stone('#d6c499');
    const crenMat = this.stone('#ecdcb6');
    const roofMat = this.stone('#c8643f');
    const timber = this.stone('#7a4f2c');
    const walkMat = this.stone('#c9b887');

    for (let s = 0; s < CASTLE.length; s++) {
      const b = CASTLE[s];
      const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const extras: THREE.Object3D[] = [];

      if (b.kind === 'wall' || b.kind === 'gate') {
        const mat = (b.kind === 'gate' ? timber : wallMat).clone(); // own material → can darken with damage
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), mat);
        box.position.set(cx, b.h / 2, cz); this.scene.add(box);

        if (b.kind === 'wall') {
          const horiz = w > d, len = horiz ? w : d;
          const outer = (horiz ? Math.sign(cz) : Math.sign(cx)) || 1;
          // worn walkway floor — the DEFINED area units stand within
          const wf = new THREE.Mesh(new THREE.BoxGeometry(horiz ? w : w - 0.8, 0.5, horiz ? d - 0.8 : d), walkMat);
          wf.position.set(cx, b.h + 0.25, cz); this.scene.add(wf); extras.push(wf);
          // LOW crenellated parapet on the OUTER edge only
          const n = Math.floor(len / 1.7);
          for (let k = 0; k <= n; k++) {
            if (k % 2) continue;
            const m = new THREE.Mesh(new THREE.BoxGeometry(horiz ? 1.0 : 0.7, 1.7, horiz ? 0.7 : 1.0), crenMat);
            if (horiz) m.position.set(b.x0 + 0.85 + k * 1.7, b.h + 0.85, cz + outer * (d / 2 - 0.35));
            else m.position.set(cx + outer * (w / 2 - 0.35), b.h + 0.85, b.z0 + 0.85 + k * 1.7);
            this.scene.add(m); extras.push(m);
          }
          // low inner rail so the walkway reads as an enclosed walk
          const rail = new THREE.Mesh(new THREE.BoxGeometry(horiz ? w : 0.5, 0.7, horiz ? 0.5 : d), crenMat);
          rail.position.set(horiz ? cx : cx - outer * (w / 2 - 0.25), b.h + 0.35, horiz ? cz - outer * (d / 2 - 0.25) : cz);
          this.scene.add(rail); extras.push(rail);
        } else {
          // gate: two timber doors + stone arch
          for (const sx of [-1, 1]) {
            const door = new THREE.Mesh(new THREE.BoxGeometry(w / 2 - 0.3, b.h - 1.2, 0.6), timber);
            door.position.set(cx + sx * w / 4, (b.h - 1.2) / 2, b.z1); this.scene.add(door); extras.push(door);
          }
          const arch = new THREE.Mesh(new THREE.BoxGeometry(w + 2, 1.6, d + 1), wallMat);
          arch.position.set(cx, b.h + 0.4, cz); this.scene.add(arch); extras.push(arch);
        }
        this.segVis[s] = { box, mat, base: mat.color.clone(), extras, h: b.h, maxhp: b.maxhp, prevHp: b.hp, crumbling: 0 };
      } else if (b.kind === 'tower') {
        const tmat = towerMat.clone(); // own material → darkens with damage
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), tmat);
        box.position.set(cx, b.h / 2, cz); this.scene.add(box);
        for (const [ex, ez, ew, ed] of [[0, d / 2, w, 0.8], [0, -d / 2, w, 0.8], [w / 2, 0, 0.8, d], [-w / 2, 0, 0.8, d]] as const) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(ew, 1.3, ed), crenMat); m.position.set(cx + ex, b.h + 0.6, cz + ez); this.scene.add(m); extras.push(m);
        }
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, 5.5, 4), roofMat);
        roof.rotation.y = Math.PI / 4; roof.position.set(cx, b.h + 3.4, cz); this.scene.add(roof); extras.push(roof);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4), timber); pole.position.set(cx, b.h + 7, cz); this.scene.add(pole); extras.push(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), new THREE.MeshLambertMaterial({ color: COL_DEFEND, side: THREE.DoubleSide }));
        flag.position.set(cx + 1.2, b.h + 8, cz); this.scene.add(flag); extras.push(flag);
        this.segVis[s] = { box, mat: tmat, base: tmat.color.clone(), extras, h: b.h, maxhp: b.maxhp, prevHp: b.hp, crumbling: 0 };
      } else if (b.kind === 'keep') {
        const base = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), keepMat); base.position.set(cx, b.h / 2, cz); this.scene.add(base);
        const upper = new THREE.Mesh(new THREE.BoxGeometry(w - 5, 5, d - 5), keepMat); upper.position.set(cx, b.h + 2.5, cz); this.scene.add(upper);
        // battlements on the base
        for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.4, 1), crenMat); m.position.set(cx + Math.sin(a) * (d / 2), b.h + 0.7, cz + Math.cos(a) * (d / 2)); m.rotation.y = a; this.scene.add(m); }
        const roof = new THREE.Mesh(new THREE.ConeGeometry((w - 5) * 0.75, 8, 4), roofMat); roof.rotation.y = Math.PI / 4; roof.position.set(cx, b.h + 9, cz); this.scene.add(roof);
        const door = new THREE.Mesh(new THREE.BoxGeometry(2.6, 4, 0.4), timber); door.position.set(cx, 2, b.z1); this.scene.add(door);
        for (const [wx, wy] of [[-3, 8], [3, 8], [-3, 13], [3, 13]] as const) { const win = new THREE.Mesh(new THREE.BoxGeometry(1, 1.6, 0.3), timber); win.position.set(cx + wx, wy, b.z1); this.scene.add(win); }
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6), timber); pole.position.set(cx, b.h + 15, cz); this.scene.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), new THREE.MeshLambertMaterial({ color: COL_DEFEND, side: THREE.DoubleSide })); flag.position.set(cx + 2, b.h + 16, cz); this.scene.add(flag);
      } else if (b.kind === 'building') {
        // a town house: plastered walls, timber framing, pitched thatch/tile roof
        const tone = 0.78 + jit(s, 7) * 0.34;
        const wm = this.stone('#cbb083'); wm.color.multiplyScalar(tone);
        const rm = jit(s, 9) > 0.5 ? this.stone('#9a6b3f') : this.stone('#7d5a37'); rm.color.multiplyScalar(tone);
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), wm); body.position.set(cx, b.h / 2, cz); this.scene.add(body);
        const long = w >= d;
        const roof = new THREE.Mesh(new THREE.CylinderGeometry((long ? d : w) * 0.62, (long ? d : w) * 0.62, (long ? w : d) * 1.04, 3), rm);
        roof.rotation.z = Math.PI / 2; if (!long) roof.rotation.y = Math.PI / 2;
        roof.position.set(cx, b.h + (long ? d : w) * 0.31, cz); this.scene.add(roof);
      }
    }
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
    for (const e of v.extras) e.visible = false;
    this.spawnDebris(v.box.position.x, v.h * 0.5, v.box.position.z, 16);
    this.spawnDust(v.box.position.x, v.h * 0.5, v.box.position.z, 9, 6);
  }

  private buildSoldiers() {
    const col = new THREE.Color();
    for (let t = 0; t < 4; t++) {
      const total = this.sim.typeCount[t];
      const tex = makeSoldierTexture(KIND[t]);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(SPRITE_W[t], SPRITE_H[t]), mat, Math.max(1, total));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false;
      for (let i = 0; i < this.sim.n; i++) {
        if (this.sim.typ[i] !== t) continue;
        const bse = this.sim.fac[i] === Faction.Attacker ? COL_ATTACK : COL_DEFEND;
        const br = 0.82 + jit(i, 2) * 0.32;
        col.setRGB(bse.r * br * (0.95 + jit(i, 3) * 0.1), bse.g * br, bse.b * br * (0.95 + jit(i, 4) * 0.1));
        mesh.setColorAt(this.sim.slot[i], col);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.meshes[t] = mesh; this.scene.add(mesh);
    }
  }

  private buildShadows() {
    const geo = new THREE.CircleGeometry(0.7, 14); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: '#23311c', transparent: true, opacity: 0.2, depthWrite: false });
    this.shadowMesh = new THREE.InstancedMesh(geo, mat, this.sim.n);
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.shadowMesh.frustumCulled = false; this.scene.add(this.shadowMesh);
  }

  private buildProjectiles() {
    const arrowMat = new THREE.MeshBasicMaterial({ map: makeArrowTexture(), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
    this.projMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.4, 1.5), arrowMat, 1400);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.projMesh.frustumCulled = false; this.scene.add(this.projMesh);
    this.boulderMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.0, 0), new THREE.MeshLambertMaterial({ color: '#6f655a', flatShading: true }), 60);
    this.boulderMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.boulderMesh.frustumCulled = false; this.scene.add(this.boulderMesh);
    // flaming arrows — additive glowing blob
    const fc = document.createElement('canvas'); fc.width = fc.height = 32; const fx = fc.getContext('2d')!;
    const fg = fx.createRadialGradient(16, 16, 1, 16, 16, 15); fg.addColorStop(0, 'rgba(255,240,180,1)'); fg.addColorStop(0.4, 'rgba(255,150,40,0.9)'); fg.addColorStop(1, 'rgba(255,80,0,0)');
    fx.fillStyle = fg; fx.fillRect(0, 0, 32, 32);
    const ftex = new THREE.CanvasTexture(fc); ftex.colorSpace = THREE.SRGBColorSpace;
    this.fireMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: ftex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 700);
    this.fireMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.fireMesh.frustumCulled = false; this.scene.add(this.fireMesh);
  }

  private makeTreb(): { group: THREE.Group; arm: THREE.Group } {
    const timber = this.stone('#8a6a42'); const dark = this.stone('#6a4f30');
    const g = new THREE.Group();
    // base sled
    for (const sx of [-1.6, 1.6]) { const beam = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 8), timber); beam.position.set(sx, 0.4, 0); g.add(beam); }
    for (const sz of [-3, 3]) { const cross = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.6, 0.7), timber); cross.position.set(0, 0.4, sz); g.add(cross); }
    // A-frame to pivot at y≈6
    for (const sx of [-1.6, 1.6]) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.55, 8, 0.55), timber);
      a.position.set(sx, 3.4, 0.9); a.rotation.x = -0.32; g.add(a);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.55, 8, 0.55), timber);
      b.position.set(sx, 3.4, -0.9); b.rotation.x = 0.32; g.add(b);
    }
    // axle
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4), dark); axle.rotation.z = Math.PI / 2; axle.position.y = 6.4; g.add(axle);
    // arm pivot group
    const arm = new THREE.Group(); arm.position.set(0, 6.4, 0); g.add(arm);
    const longArm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 11), timber); longArm.position.set(0, 0, -3.2); arm.add(longArm);
    const shortArm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 4), timber); shortArm.position.set(0, 0, 3.2); arm.add(shortArm);
    const cw = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.2), dark); cw.position.set(0, -0.6, 5.4); arm.add(cw);
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 0), new THREE.MeshLambertMaterial({ color: '#6f655a', flatShading: true })); rock.position.set(0, -1.2, -8.4); arm.add(rock);
    arm.rotation.x = -1.0; // cocked
    return { group: g, arm };
  }

  private buildTrebuchets() {
    for (let i = 0; i < this.sim.n; i++) {
      if (this.sim.typ[i] !== 4) continue;
      const { group, arm } = this.makeTreb();
      this.scene.add(group);
      this.trebs.push({ group, arm, idx: i, prevCd: 0, ang: -1.0, throwing: false, tp: 0 });
    }
  }

  setSelection(cx: number | null, cz: number | null) { if (cx === null || cz === null) { this.selRing.visible = false; return; } this.selRing.visible = true; this.selRing.position.set(cx, 0.06, cz); }
  setTargetMarker(cx: number | null, cz: number | null) { if (cx === null || cz === null) { this.targetRing.visible = false; return; } this.targetRing.visible = true; this.targetRing.position.set(cx, 0.5, cz); }
  setRangeFan(cx: number | null, cz: number | null, r = 0) { if (cx === null || cz === null) { this.rangeFan.visible = false; return; } this.rangeFan.visible = true; this.rangeFan.position.set(cx, 0.04, cz); this.rangeFan.scale.set(r, 1, r); }

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
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.camTarget);
    this.billboard.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dir.x, dir.z));
  }

  // wall damage tint, impact puffs, and the animated collapse
  private updateWalls(dt: number) {
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
        v.box.scale.y = k; v.box.position.y = (v.h / 2) * k - 0.4 * e; v.box.rotation.z = e * 0.12 * (s % 2 ? 1 : -1);
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
    this.updateWalls(dt);
    this.updateEffects(dt);

    for (let i = 0; i < sim.n; i++) {
      const t = sim.typ[i]; const mesh = this.meshes[t];
      if (!mesh) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.shadowMesh.setMatrixAt(i, this.dummy.matrix); continue; } // siege -> 3D
      const slot = sim.slot[i]; const s = this.sscale[i] || 1;
      if (!sim.alive[i]) {
        this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.quaternion.identity(); this.dummy.updateMatrix();
        mesh.setMatrixAt(slot, this.dummy.matrix); this.shadowMesh.setMatrixAt(i, this.dummy.matrix); continue;
      }
      // marching bob + side sway so soldiers feel alive (not flat & static)
      const sp = Math.hypot(sim.vx[i], sim.vz[i]); const m = sp > 0.5 ? 1 : 0.28;
      const w = Math.sin(this.time * 9 + i * 1.7);
      const yb = w * 0.17 * m * s, h2 = (1 + Math.abs(w) * 0.06 * m); // bounce + slight stretch
      this._roll.setFromAxisAngle(this._zAxis, w * 0.13 * m);
      this.dummy.position.set(sim.px[i], sim.py[i] + (SPRITE_H[t] * s * h2) / 2 + yb, sim.pz[i]);
      this.dummy.quaternion.copy(this.billboard).multiply(this._roll); this.dummy.scale.set(s, s * h2, s); this.dummy.updateMatrix(); mesh.setMatrixAt(slot, this.dummy.matrix);
      this.dummy.position.set(sim.px[i], sim.py[i] < 1 ? 0.03 : sim.py[i] - 0.05, sim.pz[i]);
      this.dummy.quaternion.identity(); this.dummy.scale.set(SHADOW_R[t] * s, 1, SHADOW_R[t] * s); this.dummy.updateMatrix(); this.shadowMesh.setMatrixAt(i, this.dummy.matrix);
    }
    for (let t = 0; t < 4; t++) this.meshes[t].instanceMatrix.needsUpdate = true;
    this.shadowMesh.instanceMatrix.needsUpdate = true;

    // trebuchets — position + throw animation
    for (const tr of this.trebs) {
      const alive = sim.alive[tr.idx];
      tr.group.visible = !!alive;
      if (!alive) continue;
      tr.group.position.set(sim.px[tr.idx], 0, sim.pz[tr.idx]);
      const cd = sim.cd[tr.idx];
      if (cd > tr.prevCd + 1) { tr.throwing = true; tr.tp = 0; } // just fired
      tr.prevCd = cd;
      if (tr.throwing) { tr.tp += dt / 0.35; const e = 1 - Math.pow(1 - Math.min(1, tr.tp), 2); tr.ang = -1.0 + e * 2.4; if (tr.tp >= 1) tr.throwing = false; }
      else tr.ang += (-1.0 - tr.ang) * Math.min(1, dt * 1.5); // slow re-cock
      tr.arm.rotation.x = tr.ang;
    }

    let ac = 0, bc = 0, fc = 0; const up = new THREE.Vector3(0, 1, 0); const v = new THREE.Vector3();
    for (const p of sim.projectiles) {
      if (!p.active) continue;
      if (p.big) {
        if (bc >= 60) continue;
        this.dummy.position.set(p.x, Math.max(0.3, p.y), p.z); this.dummy.quaternion.set(jit(bc, 1), jit(bc, 2), jit(bc, 3), 1).normalize();
        this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix(); this.boulderMesh.setMatrixAt(bc++, this.dummy.matrix);
      } else if (p.fire) {
        if (fc >= 700) continue;
        this.dummy.position.set(p.x, Math.max(0.1, p.y), p.z); this.dummy.quaternion.copy(this.billboard);
        const fl = 0.8 + jit(fc, 5) * 0.5; this.dummy.scale.set(fl, fl, fl); this.dummy.updateMatrix(); this.fireMesh.setMatrixAt(fc++, this.dummy.matrix);
      } else {
        if (ac >= 1400) continue;
        this.dummy.position.set(p.x, Math.max(0.1, p.y), p.z); v.set(p.vx, p.vy, p.vz); if (v.lengthSq() > 0.0001) { v.normalize(); this.dummy.quaternion.setFromUnitVectors(up, v); }
        this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix(); this.projMesh.setMatrixAt(ac++, this.dummy.matrix);
      }
    }
    for (let k = ac; k < 1400; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.projMesh.setMatrixAt(k, this.dummy.matrix); }
    for (let k = bc; k < 60; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.boulderMesh.setMatrixAt(k, this.dummy.matrix); }
    for (let k = fc; k < 700; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.fireMesh.setMatrixAt(k, this.dummy.matrix); }
    this.projMesh.count = 1400; this.boulderMesh.count = 60; this.fireMesh.count = 700;
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
    this.camDist = Math.max(30, Math.min(230, this.camDist));
    this.camPitch = Math.max(0.3, Math.min(1.46, this.camPitch));
  }
}
