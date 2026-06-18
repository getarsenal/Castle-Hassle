import * as THREE from 'three';
import { Sim, CASTLE, Faction, WORLD } from './sim';
import { makeSoldierTexture, makeArrowTexture, SpriteKind } from './sprites';

const KIND: SpriteKind[] = ['heavy', 'light', 'archer', 'cavalry'];
const SPRITE_W = [1.8, 1.6, 1.6, 2.7];
const SPRITE_H = [2.4, 2.1, 2.1, 2.5];
const SHADOW_R = [0.85, 0.75, 0.75, 1.25];

// ---- "Bluey meets medieval" palette: warm, soft, storybook, but readable ----
const COL_ATTACK = new THREE.Color('#e2673b'); // warm terracotta-orange
const COL_DEFEND = new THREE.Color('#4f8fd0'); // soft cornflower blue

// deterministic per-soldier jitter (stable across frames)
function jit(i: number, s: number): number {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  gl: THREE.WebGLRenderer;
  private meshes: THREE.InstancedMesh[] = [];
  private shadowMesh!: THREE.InstancedMesh;
  private projMesh!: THREE.InstancedMesh;
  private selRing: THREE.Mesh;
  private preview: THREE.Mesh;
  private previewArrow: THREE.Mesh;
  private dummy = new THREE.Object3D();
  private billboard = new THREE.Quaternion();
  private sscale: Float32Array;

  // orbit camera state
  camTarget = new THREE.Vector3(0, 0, 18);
  camDist = 110; camYaw = 0; camPitch = 0.95; // pitch: 0 = horizon, ~1.4 = top-down

  constructor(private sim: Sim, canvasParent: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    canvasParent.appendChild(this.gl.domElement);

    this.scene.background = new THREE.Color('#cfe3f2');
    this.scene.fog = new THREE.Fog('#d8e8f2', 150, 300);
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, 800);

    // soft warm lighting
    const hemi = new THREE.HemisphereLight('#eaf4ff', '#7e8a4e', 1.0);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1d4', 1.15);
    sun.position.set(70, 130, 50);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight('#fff4e0', 0.25));

    this.sscale = new Float32Array(sim.n);
    for (let i = 0; i < sim.n; i++) this.sscale[i] = 0.88 + jit(i, 1) * 0.3;

    this.buildSky();
    this.buildGround();
    this.buildCastle();
    this.buildSoldiers();
    this.buildShadows();
    this.buildProjectiles();

    const ringGeo = new THREE.RingGeometry(2.6, 3.4, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.85 }));
    this.selRing.visible = false; this.scene.add(this.selRing);

    // formation preview: a bright line where troops will form + a facing arrow
    this.preview = new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 1),
      new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.preview.visible = false; this.scene.add(this.preview);
    const arrowGeo = new THREE.ConeGeometry(1.4, 3, 4); arrowGeo.rotateX(Math.PI / 2);
    this.previewArrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.previewArrow.visible = false; this.scene.add(this.previewArrow);

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
  }

  private buildSky() {
    // gradient dome: warm cream near the horizon, soft blue overhead
    const geo = new THREE.SphereGeometry(400, 24, 16);
    const top = new THREE.Color('#bcd9f0'), bot = new THREE.Color('#f4ead2');
    const colors: number[] = []; const pos = geo.attributes.position; const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, (pos.getY(i) / 400) * 1.4 + 0.25));
      c.copy(bot).lerp(top, t); colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }));
    this.scene.add(sky);
  }

  private buildGround() {
    const g = new THREE.PlaneGeometry(560, 560, 70, 70);
    g.rotateX(-Math.PI / 2);
    const base = new THREE.Color('#90b257'); // warm sage grass
    const c = new THREE.Color(); const colors: number[] = []; const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const n = 0.84 + ((Math.sin(pos.getX(i) * 0.3) * Math.cos(pos.getZ(i) * 0.27) + 1) / 2) * 0.32;
      c.copy(base).multiplyScalar(n); colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.position.y = -0.02; this.scene.add(ground);

    const ring = new THREE.Mesh(new THREE.RingGeometry(31, 44, 56).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: '#86a64e' }));
    ring.position.y = 0.005; this.scene.add(ring);

    const path = new THREE.Mesh(new THREE.PlaneGeometry(16, 80).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: '#cba877' }));
    path.position.set(0, 0.01, 58); this.scene.add(path);
  }

  private buildCastle() {
    const wallMat = new THREE.MeshLambertMaterial({ color: '#ecdcb6' });  // warm sandstone
    const towerMat = new THREE.MeshLambertMaterial({ color: '#e3d0a6' });
    const keepMat = new THREE.MeshLambertMaterial({ color: '#dcc79a' });
    const roofMat = new THREE.MeshLambertMaterial({ color: '#cf6a40' });  // terracotta
    const group = new THREE.Group();

    for (const b of CASTLE) {
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      const mat = b.kind === 'wall' ? wallMat : b.kind === 'tower' ? towerMat : keepMat;
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), mat);
      box.position.set((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2);
      group.add(box);

      if (b.kind === 'wall' && b.h > 4) {
        const along = w > d ? 'x' : 'z';
        const n = Math.floor(Math.max(w, d) / 2);
        for (let k = 0; k < n; k++) {
          if (k % 2) continue;
          const merlon = along === 'x'
            ? new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, Math.min(d, 1.5)), wallMat)
            : new THREE.Mesh(new THREE.BoxGeometry(Math.min(w, 1.5), 1.1, 1), wallMat);
          if (along === 'x') merlon.position.set(b.x0 + k * 2 + 1, b.h + 0.55, (b.z0 + b.z1) / 2);
          else merlon.position.set((b.x0 + b.x1) / 2, b.h + 0.55, b.z0 + k * 2 + 1);
          group.add(merlon);
        }
      }
      if (b.kind === 'tower') {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, 4.5, 6), roofMat);
        cone.position.set((b.x0 + b.x1) / 2, b.h + 2.2, (b.z0 + b.z1) / 2);
        group.add(cone);
      }
      if (b.kind === 'keep') {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(w * 0.82, 8, 6), roofMat);
        cone.position.set((b.x0 + b.x1) / 2, b.h + 4, (b.z0 + b.z1) / 2); group.add(cone);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 5), new THREE.MeshLambertMaterial({ color: '#6b513a' }));
        pole.position.set((b.x0 + b.x1) / 2, b.h + 10, (b.z0 + b.z1) / 2); group.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.8), new THREE.MeshBasicMaterial({ color: COL_DEFEND, side: THREE.DoubleSide }));
        flag.position.set((b.x0 + b.x1) / 2 + 1.6, b.h + 11, (b.z0 + b.z1) / 2); group.add(flag);
      }
    }
    this.scene.add(group);
  }

  private buildSoldiers() {
    const col = new THREE.Color();
    for (let t = 0; t < 4; t++) {
      const total = this.sim.typeCount[t];
      const tex = makeSoldierTexture(KIND[t]);
      const geo = new THREE.PlaneGeometry(SPRITE_W[t], SPRITE_H[t]);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, total));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      for (let i = 0; i < this.sim.n; i++) {
        if (this.sim.typ[i] !== t) continue;
        const base = this.sim.fac[i] === Faction.Attacker ? COL_ATTACK : COL_DEFEND;
        const b = 0.8 + jit(i, 2) * 0.34; // brightness variety
        col.setRGB(base.r * b * (0.95 + jit(i, 3) * 0.1), base.g * b, base.b * b * (0.95 + jit(i, 4) * 0.1));
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
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowMesh.frustumCulled = false;
    this.scene.add(this.shadowMesh);
  }

  private buildProjectiles() {
    const tex = makeArrowTexture();
    const geo = new THREE.PlaneGeometry(0.35, 1.4);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
    this.projMesh = new THREE.InstancedMesh(geo, mat, 800);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.frustumCulled = false; this.scene.add(this.projMesh);
  }

  setSelection(cx: number | null, cz: number | null) {
    if (cx === null || cz === null) { this.selRing.visible = false; return; }
    this.selRing.visible = true; this.selRing.position.set(cx, 0.06, cz);
  }

  // formation preview while dragging an order (world points + facing vector)
  setPreview(p0: THREE.Vector3 | null, p1?: THREE.Vector3, fx = 0, fz = 0) {
    if (!p0 || !p1) { this.preview.visible = false; this.previewArrow.visible = false; return; }
    const len = Math.max(2, Math.hypot(p1.x - p0.x, p1.z - p0.z));
    const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2;
    this.preview.visible = true;
    this.preview.position.set(mx, 0.08, mz);
    this.preview.scale.set(len, 1, 1.1);
    this.preview.rotation.y = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    this.previewArrow.visible = true;
    this.previewArrow.position.set(mx + fx * 5, 0.1, mz + fz * 5);
    this.previewArrow.rotation.y = Math.atan2(fx, fz);
  }

  updateCamera() {
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
    const off = new THREE.Vector3(sy * cp, sp, cy * cp).multiplyScalar(this.camDist);
    this.camera.position.copy(this.camTarget).add(off);
    this.camera.lookAt(this.camTarget);
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.camTarget);
    this.billboard.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dir.x, dir.z));
  }

  render() {
    const sim = this.sim;
    for (let i = 0; i < sim.n; i++) {
      const t = sim.typ[i]; const mesh = this.meshes[t]; if (!mesh) continue;
      const slot = sim.slot[i]; const s = this.sscale[i] || 1;
      if (!sim.alive[i]) {
        this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001);
        this.dummy.quaternion.identity(); this.dummy.updateMatrix();
        mesh.setMatrixAt(slot, this.dummy.matrix);
        this.shadowMesh.setMatrixAt(i, this.dummy.matrix); continue;
      }
      // sprite (billboarded, height-jittered)
      this.dummy.position.set(sim.px[i], sim.py[i] + (SPRITE_H[t] * s) / 2, sim.pz[i]);
      this.dummy.quaternion.copy(this.billboard);
      this.dummy.scale.set(s, s, s); this.dummy.updateMatrix();
      mesh.setMatrixAt(slot, this.dummy.matrix);
      // ground shadow (flat, only for ground troops)
      this.dummy.position.set(sim.px[i], sim.py[i] < 1 ? 0.03 : -1000, sim.pz[i]);
      this.dummy.quaternion.identity();
      this.dummy.scale.set(SHADOW_R[t] * s, 1, SHADOW_R[t] * s); this.dummy.updateMatrix();
      this.shadowMesh.setMatrixAt(i, this.dummy.matrix);
    }
    for (let t = 0; t < 4; t++) this.meshes[t].instanceMatrix.needsUpdate = true;
    this.shadowMesh.instanceMatrix.needsUpdate = true;

    // projectiles
    let pc = 0; const up = new THREE.Vector3(0, 1, 0); const v = new THREE.Vector3();
    for (const p of sim.projectiles) {
      if (!p.active || pc >= 800) continue;
      this.dummy.position.set(p.x, Math.max(0.1, p.y), p.z);
      v.set(p.vx, p.vy, p.vz);
      if (v.lengthSq() > 0.0001) { v.normalize(); this.dummy.quaternion.setFromUnitVectors(up, v); }
      this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix();
      this.projMesh.setMatrixAt(pc++, this.dummy.matrix);
    }
    for (let k = pc; k < 800; k++) {
      this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix();
      this.projMesh.setMatrixAt(k, this.dummy.matrix);
    }
    this.projMesh.count = 800;
    this.projMesh.instanceMatrix.needsUpdate = true;

    this.updateCamera();
    this.gl.render(this.scene, this.camera);
  }

  raycastGround(nx: number, ny: number): THREE.Vector3 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, pt) ? pt : null;
  }

  clampTarget() {
    this.camTarget.x = Math.max(WORLD.minX, Math.min(WORLD.maxX, this.camTarget.x));
    this.camTarget.z = Math.max(WORLD.minZ - 10, Math.min(WORLD.maxZ + 10, this.camTarget.z));
    this.camDist = Math.max(28, Math.min(170, this.camDist));
    this.camPitch = Math.max(0.32, Math.min(1.45, this.camPitch));
  }
}
