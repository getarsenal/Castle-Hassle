import * as THREE from 'three';
import { Sim, CASTLE, UType, Faction, WORLD } from './sim';
import { makeSoldierTexture, makeArrowTexture, SpriteKind } from './sprites';

const KIND: SpriteKind[] = ['heavy', 'light', 'archer', 'cavalry'];
const SPRITE_W = [1.7, 1.5, 1.5, 2.6];
const SPRITE_H = [2.3, 2.0, 2.0, 2.4];

// House-style palette
const COL_ATTACK = new THREE.Color('#e8513a');
const COL_DEFEND = new THREE.Color('#3d7be0');

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  gl: THREE.WebGLRenderer;
  private meshes: THREE.InstancedMesh[] = [];
  private projMesh!: THREE.InstancedMesh;
  private selRing: THREE.Mesh;
  private dummy = new THREE.Object3D();
  private billboard = new THREE.Quaternion();
  camTarget = new THREE.Vector3(0, 0, 28);
  camDist = 95; camYaw = 0; camPitch = 0.92; // radians from horizontal-ish

  constructor(private sim: Sim, canvasParent: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.shadowMap.enabled = false;
    canvasParent.appendChild(this.gl.domElement);

    this.scene.background = new THREE.Color('#acc7e8');
    this.scene.fog = new THREE.Fog('#acc7e8', 140, 260);

    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 1, 600);

    // lighting — warm key + cool sky fill, flat & bright (matches the look)
    const sky = new THREE.HemisphereLight('#dff0ff', '#5a7042', 0.95);
    this.scene.add(sky);
    const sun = new THREE.DirectionalLight('#fff2d6', 1.05);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);

    this.buildGround();
    this.buildCastle();
    this.buildSoldiers();
    this.buildProjectiles();

    // selection ring
    const ringGeo = new THREE.RingGeometry(2.4, 3.1, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.9 }));
    this.selRing.visible = false;
    this.scene.add(this.selRing);

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
  }

  private buildGround() {
    // Big ground plane with subtle vertex-colour variation for texture-free detail
    const g = new THREE.PlaneGeometry(420, 420, 60, 60);
    g.rotateX(-Math.PI / 2);
    const colors: number[] = [];
    const base = new THREE.Color('#6f8a3f');
    const c = new THREE.Color();
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const n = 0.85 + Math.random() * 0.3;
      c.copy(base).multiplyScalar(n);
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    const ground = new THREE.Mesh(g, m);
    ground.position.y = -0.01;
    this.scene.add(ground);

    // a darker "moat"/ground ring around the castle for readability
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(30, 40, 48).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: '#5c7336' })
    );
    ring.position.y = 0.005;
    this.scene.add(ring);

    // dirt approach path from the gate toward attackers
    const path = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 70).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: '#9b8158' })
    );
    path.position.set(0, 0.006, 55);
    this.scene.add(path);
  }

  private buildCastle() {
    const wallMat = new THREE.MeshLambertMaterial({ color: '#c9c2b4' });
    const towerMat = new THREE.MeshLambertMaterial({ color: '#bdb6a8' });
    const keepMat = new THREE.MeshLambertMaterial({ color: '#b0a896' });
    const roofMat = new THREE.MeshLambertMaterial({ color: '#7c4a3a' });

    const group = new THREE.Group();
    for (const b of CASTLE) {
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      const mat = b.kind === 'wall' ? wallMat : b.kind === 'tower' ? towerMat : keepMat;
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), mat);
      box.position.set((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2);
      group.add(box);
      // crenellations along wall tops
      if (b.kind === 'wall') {
        const along = w > d ? 'x' : 'z';
        const len = Math.max(w, d);
        const n = Math.floor(len / 2);
        for (let k = 0; k < n; k++) {
          if (k % 2) continue;
          const merlon = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, Math.min(d, 1.4)), wallMat);
          if (along === 'x') merlon.position.set(b.x0 + k * 2 + 1, b.h + 0.55, (b.z0 + b.z1) / 2);
          else { merlon.geometry = new THREE.BoxGeometry(Math.min(w, 1.4), 1.1, 1); merlon.position.set((b.x0 + b.x1) / 2, b.h + 0.55, b.z0 + k * 2 + 1); }
          group.add(merlon);
        }
      }
      // tower roofs (cones) and keep roof
      if (b.kind === 'tower') {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.75, 4, 4), roofMat);
        cone.rotation.y = Math.PI / 4;
        cone.position.set((b.x0 + b.x1) / 2, b.h + 2, (b.z0 + b.z1) / 2);
        group.add(cone);
      }
      if (b.kind === 'keep') {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(w * 0.8, 7, 4), roofMat);
        cone.rotation.y = Math.PI / 4;
        cone.position.set((b.x0 + b.x1) / 2, b.h + 3.5, (b.z0 + b.z1) / 2);
        group.add(cone);
        // a banner pole
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5), new THREE.MeshLambertMaterial({ color: '#5a4632' }));
        pole.position.set((b.x0 + b.x1) / 2, b.h + 9, (b.z0 + b.z1) / 2);
        group.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.6), new THREE.MeshLambertMaterial({ color: '#3d7be0', side: THREE.DoubleSide }));
        flag.position.set((b.x0 + b.x1) / 2 + 1.5, b.h + 10, (b.z0 + b.z1) / 2);
        group.add(flag);
      }
    }
    this.scene.add(group);
  }

  private buildSoldiers() {
    for (let t = 0; t < 4; t++) {
      const total = this.sim.typeCount[t];
      const tex = makeSoldierTexture(KIND[t]);
      const geo = new THREE.PlaneGeometry(SPRITE_W[t], SPRITE_H[t]);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, total));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      // assign per-instance faction colour (stable slots)
      const col = new THREE.Color();
      for (let i = 0; i < this.sim.n; i++) {
        if (this.sim.typ[i] !== t) continue;
        col.copy(this.sim.fac[i] === Faction.Attacker ? COL_ATTACK : COL_DEFEND);
        mesh.setColorAt(this.sim.slot[i], col);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.meshes[t] = mesh;
      this.scene.add(mesh);
    }
  }

  private buildProjectiles() {
    const tex = makeArrowTexture();
    const geo = new THREE.PlaneGeometry(0.35, 1.4);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
    this.projMesh = new THREE.InstancedMesh(geo, mat, 700);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.frustumCulled = false;
    this.scene.add(this.projMesh);
  }

  setSelection(cx: number | null, cz: number | null) {
    if (cx === null || cz === null) { this.selRing.visible = false; return; }
    this.selRing.visible = true;
    this.selRing.position.set(cx, 0.05, cz);
  }

  updateCamera() {
    // angled top-down orbit around camTarget
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
    const off = new THREE.Vector3(sy * cp, sp, cy * cp).multiplyScalar(this.camDist);
    this.camera.position.copy(this.camTarget).add(off);
    this.camera.lookAt(this.camTarget);
    // billboard quaternion: face sprites toward the camera around Y
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.camTarget);
    const yaw = Math.atan2(dir.x, dir.z);
    this.billboard.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  }

  render() {
    const sim = this.sim;
    // soldiers
    const counters = [0, 0, 0, 0];
    for (let t = 0; t < 4; t++) { /* slots are stable; we write all */ }
    for (let i = 0; i < sim.n; i++) {
      const t = sim.typ[i];
      const mesh = this.meshes[t];
      const slot = sim.slot[i];
      if (!sim.alive[i]) {
        this.dummy.position.set(0, -1000, 0); this.dummy.scale.set(0.0001, 0.0001, 0.0001);
        this.dummy.quaternion.identity(); this.dummy.updateMatrix();
        mesh.setMatrixAt(slot, this.dummy.matrix); continue;
      }
      this.dummy.position.set(sim.px[i], sim.py[i] + SPRITE_H[t] / 2, sim.pz[i]);
      this.dummy.quaternion.copy(this.billboard);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(slot, this.dummy.matrix);
      counters[t]++;
    }
    for (let t = 0; t < 4; t++) this.meshes[t].instanceMatrix.needsUpdate = true;

    // projectiles
    let pc = 0;
    const up = new THREE.Vector3(0, 1, 0);
    for (const p of sim.projectiles) {
      if (!p.active || pc >= 700) continue;
      this.dummy.position.set(p.x, Math.max(0.1, p.y), p.z);
      const v = new THREE.Vector3(p.vx, p.vy, p.vz);
      if (v.lengthSq() > 0.0001) { v.normalize(); this.dummy.quaternion.setFromUnitVectors(up, v); }
      this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix();
      this.projMesh.setMatrixAt(pc++, this.dummy.matrix);
    }
    for (let k = pc; k < this.projMesh.count; k++) {
      this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix();
      this.projMesh.setMatrixAt(k, this.dummy.matrix);
    }
    this.projMesh.count = 700;
    this.projMesh.instanceMatrix.needsUpdate = true;

    this.updateCamera();
    this.gl.render(this.scene, this.camera);
  }

  // screen → ground (y=0) world point
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
    this.camDist = Math.max(40, Math.min(150, this.camDist));
  }
}
