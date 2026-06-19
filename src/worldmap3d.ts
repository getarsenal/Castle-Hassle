// The campaign world as a real 3D terrain (Total War style): an oblique camera
// over projected Europe→Levant geography with elevation, water, forests and
// settlement markers. Built from the baked land/coast grid + mountain ranges.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CampaignCastle, Progress } from './campaign';
import { RANGES, FORESTS } from './mapfeatures';
import mapData from './worldmapdata.json';

const mercYdeg = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 180 / Math.PI;
const hash = (x: number, z: number) => { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };

interface BB { w: number; e: number; s: number; n: number; }

export class WorldMap3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private raf = 0; private pulse = 0;
  private bb!: BB; private GW = 0; private GH = 0; private heights = new Float32Array(0);
  private readonly K = 11; private lonMid = 0; private myMid = 0;
  private target = new THREE.Vector3(); private dist = 200; private azimuth = 0; private pitch = 40 * Math.PI / 180;
  private markers: { node: CampaignCastle; pos: THREE.Vector3; ring?: THREE.Mesh }[] = [];
  private labels: THREE.Sprite[] = [];
  private dragging = false; private lastX = 0; private lastY = 0; private moved = 0; private downX = 0; private downY = 0; private downT = 0; private pinchD = 0;
  private ready = false;

  constructor(private canvas: HTMLCanvasElement, private nodes: CampaignCastle[], private prog: Progress, private onSelect: (c: CampaignCastle) => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.08;
    this.scene.background = new THREE.Color('#cfe1ef');
    this.scene.fog = new THREE.Fog('#cfe1ef', 850, 2200);   // gentle haze far off only
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 3000);
    this.scene.add(new THREE.HemisphereLight('#eaf4ff', '#8a9358', 1.25));
    const sun = new THREE.DirectionalLight('#fff3d8', 1.15); sun.position.set(-120, 220, 160); this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight('#fff6e6', 0.5));
    this.resize();
    this.bind();
    try { this.build(mapData as any); }   // data is bundled in — no fetch, no stale-asset risk
    catch (e: any) { const h = document.getElementById('mapHeader'); if (h) { h.textContent = 'MAP ERROR: ' + (e?.message || e); (h as HTMLElement).style.maxWidth = '90vw'; } }
    const loop = () => { this.pulse += 0.05; this.frame(); this.raf = requestAnimationFrame(loop); };
    loop();
    (window as any).__map = this;
  }
  destroy() { cancelAnimationFrame(this.raf); this.renderer.dispose(); this.canvas.replaceWith(this.canvas.cloneNode(false)); }

  private cssW() { return this.canvas.clientWidth; }
  private cssH() { return this.canvas.clientHeight; }
  resize() { const w = this.cssW(), h = this.cssH(); this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  private wX(lon: number) { return (lon - this.lonMid) * this.K; }
  private wZ(lat: number) { return -(mercYdeg(lat) - this.myMid) * this.K; }
  private terrainY(lon: number, lat: number) {
    const { bb, GW, GH } = this;
    const gx = Math.max(0, Math.min(GW - 1, Math.round((lon - bb.w) / (bb.e - bb.w) * (GW - 1))));
    const gy = Math.max(0, Math.min(GH - 1, Math.round((lat - bb.s) / (bb.n - bb.s) * (GH - 1))));
    return Math.max(0.4, this.heights[gy * GW + gx]);
  }
  private distRidge(lon: number, lat: number, r: [number, number][]) {
    let m = 1e9;
    for (let s = 0; s < r.length - 1; s++) { const a = r[s], b = r[s + 1]; const dx = b[1] - a[1], dy = b[0] - a[0]; const t = Math.max(0, Math.min(1, ((lon - a[1]) * dx + (lat - a[0]) * dy) / (dx * dx + dy * dy || 1))); const px = a[1] + dx * t, py = a[0] + dy * t; const d = Math.hypot(lon - px, lat - py); if (d < m) m = d; }
    return m;
  }
  // Relief from real ridge lines: a sharp peak band along each range plus a wide
  // gentle skirt of foothills, so mountains sit where they actually are.
  private mountain(lon: number, lat: number) { let h = 0; for (const r of RANGES) { const d = this.distRidge(lon, lat, r.ridge); h += r.h * Math.exp(-Math.pow(d / 0.42, 2)) + r.h * 0.32 * Math.exp(-Math.pow(d / 1.4, 2)); } return Math.min(h, 36); }
  private hill(lon: number, lat: number) { return (hash(lon * 1.7, lat * 1.7) * 0.6 + hash(lon * 0.7, lat * 0.7) * 0.4) * 2.6; }

  private build(d: { bb: BB; grid: { w: number; h: number; mask: string; cdist: string } }) {
    this.bb = d.bb; this.GW = d.grid.w; this.GH = d.grid.h;
    this.lonMid = (d.bb.w + d.bb.e) / 2; this.myMid = mercYdeg((d.bb.s + d.bb.n) / 2);
    const mask = Uint8Array.from(atob(d.grid.mask), c => c.charCodeAt(0));
    const cdist = Uint8Array.from(atob(d.grid.cdist), c => c.charCodeAt(0));
    const { GW, GH, bb } = this;
    this.heights = new Float32Array(GW * GH);
    const pos: number[] = [], col: number[] = [], idx: number[] = []; const c = new THREE.Color();
    const green = new THREE.Color('#6fa148'), tan = new THREE.Color('#ccb06a');
    for (let gy = 0; gy < GH; gy++) {
      const lat = bb.s + (bb.n - bb.s) * (gy / (GH - 1));
      for (let gx = 0; gx < GW; gx++) {
        const lon = bb.w + (bb.e - bb.w) * (gx / (GW - 1)); const i = gy * GW + gx; const land = mask[i];
        // Shallow sea shelf so coasts meet the water softly; flat-ish lowlands
        // with ruggedness that grows only near real ranges, so the relief stays
        // tied to actual geography.
        let y: number;
        if (!land) y = -1.6; else { const cd = cdist[i]; const m = this.mountain(lon, lat); y = 3.0 + Math.min(cd * 1.3, 6.5) + m + this.hill(lon, lat) * (0.3 + Math.min(1, m * 0.07)); }
        this.heights[i] = y; pos.push(this.wX(lon), y, this.wZ(lat));
        const latT = (bb.n - lat) / (bb.n - bb.s);
        if (!land || y < 0.05) c.setRGB(0.30, 0.45, 0.55);
        else if (y < 4.4) c.set('#ddc794');                                  // beach / coastal flats
        else if (y < 14) c.copy(green).lerp(tan, Math.min(1, latT * 1.05));  // lowland farmland
        else if (y < 23) c.set('#83864c');                                   // upland
        else if (y < 31) c.set('#8e8068');                                   // bare mountain rock
        else c.set('#efeae0');                                               // snow
        col.push(c.r, c.g, c.b);
      }
    }
    // winding chosen so face normals point UP (else the whole map is backface-
    // culled from the overhead camera and the sea shows through — looks all-blue)
    for (let gy = 0; gy < GH - 1; gy++) for (let gx = 0; gx < GW - 1; gx++) { const a = gy * GW + gx, b = a + 1, dd = a + GW, e = dd + 1; idx.push(a, b, dd, b, e, dd); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));

    // sea
    const water = new THREE.Mesh(new THREE.PlaneGeometry(2600, 1900).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#3d6f9a' }));
    water.position.y = 0.5; this.scene.add(water);

    this.buildTrees(mask);
    this.buildSettlements();
    this.buildRoute();

    this.frameOn(mask, this.nodes[Math.min(this.prog.unlocked, this.nodes.length - 1)]);
    this.ready = true;
  }

  // Aim the oblique camera so LAND fills the view: look at the centroid of the
  // land around the objective, from the seaward side (so the coast & castle sit
  // in the foreground and the country rolls away into the distance — RTW style).
  private frameOn(mask: Uint8Array, cur: CampaignCastle) {
    const { GW, GH, bb } = this;
    const cgx = Math.round((cur.lon - bb.w) / (bb.e - bb.w) * (GW - 1));
    const cgy = Math.round((cur.lat - bb.s) / (bb.n - bb.s) * (GH - 1));
    const rad = 14; // ~2.5° of grid cells around the objective
    let lx = 0, lz = 0, lw = 0;
    for (let gy = Math.max(0, cgy - rad); gy <= Math.min(GH - 1, cgy + rad); gy++)
      for (let gx = Math.max(0, cgx - rad); gx <= Math.min(GW - 1, cgx + rad); gx++) {
        if (!mask[gy * GW + gx]) continue;
        const lon = bb.w + (bb.e - bb.w) * (gx / (GW - 1)), lat = bb.s + (bb.n - bb.s) * (gy / (GH - 1));
        const d = Math.hypot(gx - cgx, gy - cgy); const w = 1 / (1 + d * 0.18); // nearer land counts more
        lx += this.wX(lon) * w; lz += this.wZ(lat) * w; lw += w;
      }
    const cwx = this.wX(cur.lon), cwz = this.wZ(cur.lat);
    const landX = lw ? lx / lw : cwx, landZ = lw ? lz / lw : cwz;
    // look-point: pulled off the coastal castle toward the body of land so land
    // fills the frame, but keep the objective near centre.
    this.target.set(cwx * 0.6 + landX * 0.4, this.terrainY((cur.lon), (cur.lat)), cwz * 0.6 + landZ * 0.4);
    // Classic campaign view: looking due north, north at the top of the screen
    // (a per-castle 'seaward' azimuth felt rotated ~90° and disorienting).
    this.azimuth = 0;
    // zoom from how spread the NEARBY castles are (the few closest objectives),
    // so the current siege stays prominent even in sprawling regions.
    const near = this.nodes.map(n => Math.hypot(this.wX(n.lon) - this.target.x, this.wZ(n.lat) - this.target.z)).sort((a, b) => a - b);
    const spread = near[Math.min(4, near.length - 1)]; // distance to ~4th nearest
    this.dist = Math.max(115, Math.min(185, spread * 2.2 + 80));
    this.pitch = 40 * Math.PI / 180;
  }

  private buildTrees(mask: Uint8Array) {
    const { GW, GH, bb } = this;
    const trunk = new THREE.CylinderGeometry(0.18, 0.26, 1.2, 5).translate(0, 0.6, 0);
    const fol = new THREE.ConeGeometry(1.1, 2.6, 6).translate(0, 2.2, 0);
    const treeGeo = mergeGeometries([trunk, fol], false)!;
    const places: number[] = [];
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const i = gy * GW + gx; if (!mask[i]) continue; const y = this.heights[i]; if (y < 4.0 || y > 21) continue;
      const lon = bb.w + (bb.e - bb.w) * (gx / (GW - 1)), lat = bb.s + (bb.n - bb.s) * (gy / (GH - 1));
      let dens = 0.05; for (const f of FORESTS) if (Math.hypot(lon - f[1], lat - f[0]) < f[2]) dens = 0.5;
      if ((bb.n - lat) / (bb.n - bb.s) > 0.7) dens *= 0.3;
      if (hash(gx * 1.3, gy * 2.1) < dens) places.push(this.wX(lon) + (hash(gx, gy) - 0.5) * 1.5, y, this.wZ(lat) + (hash(gy, gx) - 0.5) * 1.5);
    }
    const n = places.length / 3;
    const tm = new THREE.InstancedMesh(treeGeo, new THREE.MeshLambertMaterial({ vertexColors: false, color: '#ffffff', flatShading: true }), n);
    const d = new THREE.Object3D(), c = new THREE.Color();
    for (let k = 0; k < n; k++) {
      d.position.set(places[k * 3], places[k * 3 + 1], places[k * 3 + 2]); const s = 0.8 + hash(k, k * 3) * 0.7; d.scale.set(s, s, s); d.rotation.y = hash(k, 7) * 6; d.updateMatrix(); tm.setMatrixAt(k, d.matrix);
      c.setRGB(0.22 + hash(k, 2) * 0.14, 0.42 + hash(k, 3) * 0.16, 0.16); tm.setColorAt(k, c);
    }
    tm.instanceColor!.needsUpdate = true; this.scene.add(tm);
  }

  private buildSettlements() {
    const wallM = new THREE.MeshLambertMaterial({ color: '#efe0bb' });
    const roofM = new THREE.MeshLambertMaterial({ color: '#c8643f' });
    const doneM = new THREE.MeshLambertMaterial({ color: '#cf9b3a' });
    const lockM = new THREE.MeshLambertMaterial({ color: '#9a978f' });
    for (const node of this.nodes) {
      const x = this.wX(node.lon), z = this.wZ(node.lat), y = this.terrainY(node.lon, node.lat);
      const done = this.prog.completed.includes(node.id), current = node.id === this.prog.unlocked, locked = node.id > this.prog.unlocked;
      const g = new THREE.Group();
      const wm = locked ? lockM : done ? doneM : wallM;
      // a little walled town: a few houses + a keep
      for (let h = 0; h < 4; h++) { const a = h / 4 * 6.28; const house = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), wm); house.position.set(Math.cos(a) * 1.7, 0.55, Math.sin(a) * 1.7); g.add(house); }
      const keep = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 1.8), wm); keep.position.y = 1.3; g.add(keep);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.5, 1.7, 4), locked ? lockM : roofM); roof.position.y = 3.5; roof.rotation.y = Math.PI / 4; g.add(roof);
      const sc = current ? 2.0 : 1.5; g.scale.set(sc, sc, sc); g.position.set(x, y, z); this.scene.add(g);
      let ring: THREE.Mesh | undefined;
      if (current) {
        ring = new THREE.Mesh(new THREE.RingGeometry(5, 6.4, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.9, depthWrite: false }));
        ring.position.set(x, y + 0.4, z); this.scene.add(ring);
      }
      this.markers.push({ node, pos: new THREE.Vector3(x, y, z), ring });
      // label sprite for unlocked / current / done
      if (!locked || current) this.addLabel(node, x, y + (current ? 12 : 9), z, current);
    }
  }

  private addLabel(node: CampaignCastle, x: number, y: number, z: number, current: boolean) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const ctx = cv.getContext('2d')!;
    ctx.font = '700 30px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(20,14,6,0.85)'; ctx.strokeText(node.name, 128, 34);
    ctx.fillStyle = current ? '#ffe27a' : '#fff4e2'; ctx.fillText(node.name, 128, 34);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.position.set(x, y, z); sp.scale.set(22, 5.5, 1); sp.renderOrder = 10; this.scene.add(sp); this.labels.push(sp);
  }

  private buildRoute() {
    const pts: THREE.Vector3[] = [], colors: number[] = []; const reached = new THREE.Color('#6e3d18'), future = new THREE.Color('#8a7250');
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i];
      const steps = 6; if (i > 0) { const p = this.nodes[i - 1]; for (let s = 1; s <= steps; s++) { const t = s / steps; const lon = p.lon + (a.lon - p.lon) * t, lat = p.lat + (a.lat - p.lat) * t; pts.push(new THREE.Vector3(this.wX(lon), this.terrainY(lon, lat) + 1.2, this.wZ(lat))); const cc = i <= this.prog.unlocked ? reached : future; colors.push(cc.r, cc.g, cc.b); } }
      else { pts.push(new THREE.Vector3(this.wX(a.lon), this.terrainY(a.lon, a.lat) + 1.2, this.wZ(a.lat))); colors.push(reached.r, reached.g, reached.b); }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts); g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true })));
  }

  // ---- camera + interaction ----
  private updateCamera() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    this.camera.position.set(this.target.x + sa * cp * this.dist, this.target.y + sp * this.dist, this.target.z + ca * cp * this.dist);
    this.camera.lookAt(this.target);
  }
  private clampTarget() {
    const { bb } = this; if (!bb) return;
    this.target.x = Math.max(this.wX(bb.w), Math.min(this.wX(bb.e), this.target.x));
    this.target.z = Math.max(this.wZ(bb.n), Math.min(this.wZ(bb.s), this.target.z));
    this.dist = Math.max(45, Math.min(520, this.dist));
  }
  private bind() {
    const c = this.canvas; const pts = new Map<number, { x: number; y: number }>();
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 1) { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; this.downX = e.clientX; this.downY = e.clientY; this.moved = 0; this.downT = performance.now(); } });
    c.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId); if (!p) return; p.x = e.clientX; p.y = e.clientY;
      if (pts.size >= 2) { const a = [...pts.values()]; const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); if (this.pinchD) { this.dist *= this.pinchD / d; this.clampTarget(); } this.pinchD = d; this.dragging = false; return; }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY; this.lastX = e.clientX; this.lastY = e.clientY; this.moved += Math.abs(dx) + Math.abs(dy);
      const k = this.dist * 0.0016, ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
      // drag moves the map: pan in the camera's ground plane
      this.target.x -= (dx * ca - dy * sa) * k; this.target.z -= (dx * -sa + dy * ca) * k * 1.4; this.clampTarget();
    });
    const end = (e: PointerEvent) => { const tap = pts.size === 1 && this.moved < 9 && performance.now() - this.downT < 400; pts.delete(e.pointerId); if (pts.size < 2) this.pinchD = 0; if (pts.size === 0) this.dragging = false; if (tap) this.pick(this.downX, this.downY); };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => this.resize());
  }
  private pick(sx: number, sy: number) {
    const rect = this.canvas.getBoundingClientRect(); const px = sx - rect.left, py = sy - rect.top;
    const v = new THREE.Vector3(); let best = -1, bd = 40 * 40;
    for (const m of this.markers) {
      if (m.node.id > this.prog.unlocked) continue;
      v.copy(m.pos); v.y += 4; v.project(this.camera);
      const ex = (v.x * 0.5 + 0.5) * this.cssW(), ey = (1 - (v.y * 0.5 + 0.5)) * this.cssH();
      const d = (ex - px) ** 2 + (ey - py) ** 2; if (d < bd && v.z < 1) { bd = d; best = m.node.id; }
    }
    if (best >= 0) this.onSelect(this.nodes[best]);
  }
  private frame() {
    if (!this.ready) { this.renderer.render(this.scene, this.camera); return; }
    this.clampTarget(); this.updateCamera();
    for (const m of this.markers) if (m.ring) { const s = 1 + 0.12 * Math.sin(this.pulse); m.ring.scale.set(s, 1, s); }
    this.renderer.render(this.scene, this.camera);
  }
}
