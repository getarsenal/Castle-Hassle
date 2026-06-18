import * as THREE from 'three';
import { Sim, CASTLE, Faction, WORLD, HALF } from './sim';
import { makeSoldierTexture, makeArrowTexture, SpriteKind } from './sprites';

const KIND: SpriteKind[] = ['heavy', 'light', 'archer', 'cavalry'];
const SPRITE_W = [2.0, 1.8, 1.8, 3.0];
const SPRITE_H = [2.7, 2.4, 2.4, 2.8];
const SHADOW_R = [0.95, 0.8, 0.8, 1.35];

const COL_ATTACK = new THREE.Color('#e2673b');
const COL_DEFEND = new THREE.Color('#4f8fd0');

function jit(i: number, s: number): number { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); }

interface SegVis { box: THREE.Mesh; extras: THREE.Object3D[]; crumbled: boolean; h: number; }
interface Treb { group: THREE.Group; arm: THREE.Group; idx: number; prevCd: number; ang: number; throwing: boolean; tp: number; }

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  gl: THREE.WebGLRenderer;
  private meshes: THREE.InstancedMesh[] = [];
  private shadowMesh!: THREE.InstancedMesh;
  private projMesh!: THREE.InstancedMesh;
  private boulderMesh!: THREE.InstancedMesh;
  private segVis: (SegVis | null)[] = [];
  private trebs: Treb[] = [];
  private selRing: THREE.Mesh;
  private targetRing: THREE.Mesh;
  private preview: THREE.Mesh;
  private previewArrow: THREE.Mesh;
  private dummy = new THREE.Object3D();
  private billboard = new THREE.Quaternion();
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

    const ringGeo = new THREE.RingGeometry(2.6, 3.4, 40); ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.85 }));
    this.selRing.visible = false; this.scene.add(this.selRing);
    const tg = new THREE.RingGeometry(2.2, 3.2, 4); tg.rotateX(-Math.PI / 2);
    this.targetRing = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: '#ff5a3c', transparent: true, opacity: 0.95 }));
    this.targetRing.visible = false; this.scene.add(this.targetRing);

    this.preview = new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 1), new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.preview.visible = false; this.scene.add(this.preview);
    const ag = new THREE.ConeGeometry(1.5, 3.2, 4); ag.rotateX(Math.PI / 2);
    this.previewArrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.previewArrow.visible = false; this.scene.add(this.previewArrow);

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
    const moat = new THREE.Mesh(new THREE.RingGeometry(HALF + 6, HALF + 16, 64).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#5d7b8c' }));
    moat.position.y = 0.004; this.scene.add(moat);
    const path = new THREE.Mesh(new THREE.PlaneGeometry(22, 120).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#cba877' }));
    path.position.set(0, 0.01, HALF + 50); this.scene.add(path);
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
        const mat = b.kind === 'gate' ? timber : wallMat;
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), mat);
        box.position.set(cx, b.h / 2, cz); this.scene.add(box);

        if (b.kind === 'wall') {
          const along = w > d ? 'x' : 'z'; const len = Math.max(w, d);
          // parapet walkway cap (slightly proud, for archers to stand on)
          const walk = new THREE.Mesh(new THREE.BoxGeometry(w + (along === 'z' ? 1 : 0), 0.4, d + (along === 'x' ? 1 : 0)), walkMat);
          walk.position.set(cx, b.h + 0.2, cz); this.scene.add(walk); extras.push(walk);
          // crenellations along the outer edge
          const n = Math.floor(len / 1.8);
          for (let k = 0; k < n; k++) {
            if (k % 2) continue;
            const m = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? 1.1 : d + 0.6, 1.3, along === 'x' ? d + 0.6 : 1.1), crenMat);
            if (along === 'x') m.position.set(b.x0 + 0.9 + k * 1.8, b.h + 1.0, cz);
            else m.position.set(cx, b.h + 1.0, b.z0 + 0.9 + k * 1.8);
            this.scene.add(m); extras.push(m);
          }
        } else {
          // gate: two timber doors + stone arch
          for (const sx of [-1, 1]) {
            const door = new THREE.Mesh(new THREE.BoxGeometry(w / 2 - 0.3, b.h - 1.2, 0.6), timber);
            door.position.set(cx + sx * w / 4, (b.h - 1.2) / 2, b.z1); this.scene.add(door); extras.push(door);
          }
          const arch = new THREE.Mesh(new THREE.BoxGeometry(w + 2, 1.6, d + 1), wallMat);
          arch.position.set(cx, b.h + 0.4, cz); this.scene.add(arch); extras.push(arch);
        }
        this.segVis[s] = { box, extras, crumbled: false, h: b.h };
      } else if (b.kind === 'tower') {
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), towerMat);
        box.position.set(cx, b.h / 2, cz); this.scene.add(box);
        // battlement ring
        for (const [ex, ez, ew, ed] of [[0, d / 2, w, 0.8], [0, -d / 2, w, 0.8], [w / 2, 0, 0.8, d], [-w / 2, 0, 0.8, d]] as const) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(ew, 1.3, ed), crenMat); m.position.set(cx + ex, b.h + 0.6, cz + ez); this.scene.add(m);
        }
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, 5.5, 4), roofMat);
        roof.rotation.y = Math.PI / 4; roof.position.set(cx, b.h + 3.4, cz); this.scene.add(roof);
        // banner
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4), timber); pole.position.set(cx, b.h + 7, cz); this.scene.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), new THREE.MeshLambertMaterial({ color: COL_DEFEND, side: THREE.DoubleSide }));
        flag.position.set(cx + 1.2, b.h + 8, cz); this.scene.add(flag);
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
      }
    }
  }

  private buildProps() {
    const woodMat = this.stone('#7a5230'); const hutMat = this.stone('#c79a64'); const hutRoof = this.stone('#9a6b3f');
    const hut = (x: number, z: number, r: number) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 5), hutMat); body.position.y = 2; g.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 3, 4), hutRoof); roof.rotation.y = Math.PI / 4; roof.position.y = 5.4; g.add(roof);
      g.position.set(x, 0, z); g.rotation.y = r; this.scene.add(g);
    };
    hut(-31, -28, 0.3); hut(31, -28, -0.4); hut(-32, 12, 0.1); hut(32, 12, 0.6);
    // a well (tucked near a wall, away from the troop blocks)
    const well = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.2, 2, 12), this.stone('#cdbb90')); ring.position.y = 1; well.add(ring);
    const r1 = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 6), woodMat); r1.position.set(-1.8, 2, 0); well.add(r1);
    const r2 = r1.clone(); r2.position.set(1.8, 2, 0); well.add(r2);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 0.3), woodMat); beam.position.y = 4; well.add(beam);
    well.position.set(-30, 0, -10); this.scene.add(well);
  }

  private crumble(s: number) {
    const v = this.segVis[s]; if (!v || v.crumbled) return;
    v.crumbled = true; v.box.material = this.rubbleMat; v.box.scale.y = 0.3; v.box.position.y = v.h * 0.15;
    for (const e of v.extras) e.visible = false;
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
    this.projMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.4, 1.5), arrowMat, 900);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.projMesh.frustumCulled = false; this.scene.add(this.projMesh);
    this.boulderMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.0, 0), new THREE.MeshLambertMaterial({ color: '#6f655a', flatShading: true }), 60);
    this.boulderMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.boulderMesh.frustumCulled = false; this.scene.add(this.boulderMesh);
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

  render(dt = 0.016) {
    const sim = this.sim;
    for (let s = 0; s < CASTLE.length; s++) if (CASTLE[s].dead && this.segVis[s] && !this.segVis[s]!.crumbled) this.crumble(s);

    for (let i = 0; i < sim.n; i++) {
      const t = sim.typ[i]; const mesh = this.meshes[t];
      if (!mesh) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.shadowMesh.setMatrixAt(i, this.dummy.matrix); continue; } // siege -> 3D
      const slot = sim.slot[i]; const s = this.sscale[i] || 1;
      if (!sim.alive[i]) {
        this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.quaternion.identity(); this.dummy.updateMatrix();
        mesh.setMatrixAt(slot, this.dummy.matrix); this.shadowMesh.setMatrixAt(i, this.dummy.matrix); continue;
      }
      this.dummy.position.set(sim.px[i], sim.py[i] + (SPRITE_H[t] * s) / 2, sim.pz[i]);
      this.dummy.quaternion.copy(this.billboard); this.dummy.scale.set(s, s, s); this.dummy.updateMatrix(); mesh.setMatrixAt(slot, this.dummy.matrix);
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

    let ac = 0, bc = 0; const up = new THREE.Vector3(0, 1, 0); const v = new THREE.Vector3();
    for (const p of sim.projectiles) {
      if (!p.active) continue;
      if (p.big) {
        if (bc >= 60) continue;
        this.dummy.position.set(p.x, Math.max(0.3, p.y), p.z); this.dummy.quaternion.set(jit(bc, 1), jit(bc, 2), jit(bc, 3), 1).normalize();
        this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix(); this.boulderMesh.setMatrixAt(bc++, this.dummy.matrix);
      } else {
        if (ac >= 900) continue;
        this.dummy.position.set(p.x, Math.max(0.1, p.y), p.z); v.set(p.vx, p.vy, p.vz); if (v.lengthSq() > 0.0001) { v.normalize(); this.dummy.quaternion.setFromUnitVectors(up, v); }
        this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix(); this.projMesh.setMatrixAt(ac++, this.dummy.matrix);
      }
    }
    for (let k = ac; k < 900; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.projMesh.setMatrixAt(k, this.dummy.matrix); }
    for (let k = bc; k < 60; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.boulderMesh.setMatrixAt(k, this.dummy.matrix); }
    this.projMesh.count = 900; this.boulderMesh.count = 60;
    this.projMesh.instanceMatrix.needsUpdate = true; this.boulderMesh.instanceMatrix.needsUpdate = true;

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
