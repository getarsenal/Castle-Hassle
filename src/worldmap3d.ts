// The campaign world as a real 3D terrain (Total War style): an oblique camera
// over projected Europe→Levant geography with elevation, water, forests and
// settlement markers. Built from the baked land/coast grid + mountain ranges.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CampaignCastle, Progress, garrisonStrength } from './campaign';
import { RANGES, FORESTS, REALMS } from './mapfeatures';
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
  private water?: THREE.Mesh; private waterBase?: Float32Array;
  private banners: { mesh: THREE.Mesh; phase: number }[] = [];
  private clouds: { mesh: THREE.Sprite; speed: number }[] = [];
  private birds: { grp: THREE.Group; speed: number; phase: number }[] = [];
  private march?: { t: number; dur: number; last: number; path: { p: THREE.Vector3; water: boolean }[]; army: THREE.Group; boat: THREE.Group; done: () => void; skip: boolean };
  private maskRef!: Uint8Array;
  private compassEl?: HTMLElement; private panelEl?: HTMLElement; private styleEl?: HTMLElement;
  private dragging = false; private lastX = 0; private lastY = 0; private moved = 0; private downX = 0; private downY = 0; private downT = 0; private pinchD = 0; private pinchA?: number; private azReset = false;
  private compassRose?: HTMLElement; private _tp = new THREE.Vector3(); private _np = new THREE.Vector3();
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
  destroy() {
    cancelAnimationFrame(this.raf); this.renderer.dispose();
    this.compassEl?.remove(); this.panelEl?.remove(); (this as any).hintEl?.remove();
    this.canvas.replaceWith(this.canvas.cloneNode(false));
  }

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
  // Relief from real ridge lines — deliberately gentle so the map reads flat and
  // map-like, with only the great ranges standing proud.
  private mountain(lon: number, lat: number) { let h = 0; for (const r of RANGES) { const d = this.distRidge(lon, lat, r.ridge); h += r.h * 0.42 * Math.exp(-Math.pow(d / 0.62, 2)) + r.h * 0.2 * Math.exp(-Math.pow(d / 2.0, 2)); } return Math.min(h, 15); }
  private hill(lon: number, lat: number) { return (hash(lon * 1.7, lat * 1.7) * 0.6 + hash(lon * 0.7, lat * 0.7) * 0.4) * 1.2; }

  // Box-blur the heightmap to soften peaks and especially coasts. We only clamp
  // land-above-water / sea-below-water on the FINAL pass, so the blur is free to
  // pull the coastline into a gentle ramp instead of re-stepping every iteration.
  private smoothHeights(h: Float32Array, mask: Uint8Array, iters: number) {
    const { GW, GH } = this; let cur = h;
    for (let it = 0; it < iters; it++) {
      const last = it === iters - 1; const out = new Float32Array(GW * GH);
      for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= GW || y >= GH) continue; const wt = (dx === 0 && dy === 0) ? 2 : 1; s += cur[y * GW + x] * wt; n += wt; }
        const i = gy * GW + gx; let v = s / n;
        if (last) { if (mask[i]) v = Math.max(v, 0.9); else v = Math.min(v, -0.4); }
        out[i] = v;
      }
      cur = out;
    }
    return cur;
  }

  private build(d: { bb: BB; grid: { w: number; h: number; mask: string; cdist: string } }) {
    this.bb = d.bb; this.GW = d.grid.w; this.GH = d.grid.h;
    this.lonMid = (d.bb.w + d.bb.e) / 2; this.myMid = mercYdeg((d.bb.s + d.bb.n) / 2);
    const mask = Uint8Array.from(atob(d.grid.mask), c => c.charCodeAt(0));
    const cdist = Uint8Array.from(atob(d.grid.cdist), c => c.charCodeAt(0));
    this.maskRef = mask;
    const { GW, GH, bb } = this;
    // 1) raw heights — gentle coastal ramp + range relief
    const raw = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) {
      const lat = bb.s + (bb.n - bb.s) * (gy / (GH - 1));
      for (let gx = 0; gx < GW; gx++) {
        const lon = bb.w + (bb.e - bb.w) * (gx / (GW - 1)); const i = gy * GW + gx;
        if (!mask[i]) { raw[i] = -1.7; continue; }
        const cd = cdist[i], m = this.mountain(lon, lat);
        raw[i] = 1.0 + Math.min(cd * 1.0, 5) + m + this.hill(lon, lat) * (0.25 + Math.min(1, m * 0.06));
      }
    }
    // 2) smooth (softer mountains + much gentler shores)
    this.heights = this.smoothHeights(raw, mask, 4);
    // 3) geometry
    const pos: number[] = [], col: number[] = [], idx: number[] = []; const c = new THREE.Color();
    const green = new THREE.Color('#6fa148'), tan = new THREE.Color('#ccb06a'), haze = new THREE.Color('#cfe1ef');
    for (let gy = 0; gy < GH; gy++) {
      const lat = bb.s + (bb.n - bb.s) * (gy / (GH - 1));
      for (let gx = 0; gx < GW; gx++) {
        const lon = bb.w + (bb.e - bb.w) * (gx / (GW - 1)); const i = gy * GW + gx; const land = mask[i]; const y = this.heights[i];
        pos.push(this.wX(lon), y, this.wZ(lat));
        const latT = (bb.n - lat) / (bb.n - bb.s);
        if (!land || y < 0.05) c.setRGB(0.30, 0.45, 0.55);
        else if (y < 2.6) c.set('#ddc794');                                  // beach / coastal flats
        else if (y < 9.5) c.copy(green).lerp(tan, Math.min(1, latT * 1.05)); // lowland farmland
        else if (y < 14) c.set('#83864c');                                   // upland
        else if (y < 19) c.set('#8e8068');                                   // bare mountain rock
        else c.set('#efeae0');                                               // snow
        // gentle per-vertex shade jitter so the flat colour bands don't read blocky
        if (land && y >= 0.05) c.offsetHSL((hash(gx * 1.3, gy * 2.7) - 0.5) * 0.012, (hash(gx * 2.1, gy * 0.7) - 0.5) * 0.05, (hash(gx * 1.7, gy * 2.3) - 0.5) * 0.05);
        // dissolve the map edge into haze along a wavy, noisy border (not a hard rectangle)
        const ex = gx / (GW - 1), ey = gy / (GH - 1);
        const dEdge = Math.min(ex, 1 - ex, ey, 1 - ey) + (hash(gx * 0.8, gy * 1.1) - 0.5) * 0.07;
        const fade = Math.max(0, Math.min(1, dEdge / 0.14));
        if (fade < 1) c.lerp(haze, (1 - fade) * (1 - fade));
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

    this.buildWater(mask);
    this.buildTrees(mask);
    this.buildSettlements();
    this.buildRoute();
    this.buildRealmLabels();
    this.buildClouds();
    this.buildBirds();
    this.makeCompass();
    this.makePanel();

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

  // Sea as a gently rippling grid, coloured from deep blue out at sea to bright
  // turquoise shallows along the coasts (so shorelines read soft, not abrupt).
  private buildWater(mask: Uint8Array) {
    const { GW, GH, bb } = this; const WX = 150, WZ = 104;
    const pos: number[] = [], col: number[] = [], idx: number[] = []; const c = new THREE.Color();
    const deep = new THREE.Color('#2f6391'), shallow = new THREE.Color('#62c2cf'), haze = new THREE.Color('#cfe1ef');
    const landNear = (lon: number, lat: number) => {
      const gx = (lon - bb.w) / (bb.e - bb.w) * (GW - 1), gy = (lat - bb.s) / (bb.n - bb.s) * (GH - 1);
      let near = 0; const R = 3;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = Math.round(gx + dx), y = Math.round(gy + dy); if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
        if (mask[y * GW + x]) near = Math.max(near, 1 - Math.hypot(dx, dy) / (R + 1));
      }
      return near;
    };
    for (let j = 0; j < WZ; j++) for (let i = 0; i < WX; i++) {
      const lon = bb.w + (bb.e - bb.w) * (i / (WX - 1)), lat = bb.s + (bb.n - bb.s) * (j / (WZ - 1));
      pos.push(this.wX(lon), 0.3, this.wZ(lat));
      c.copy(deep).lerp(shallow, Math.min(1, landNear(lon, lat) * 1.15));
      // fade the sea's rectangular rim into haze along the same wavy border
      const ex = i / (WX - 1), ey = j / (WZ - 1);
      const dEdge = Math.min(ex, 1 - ex, ey, 1 - ey) + (hash(i * 0.7, j * 1.3) - 0.5) * 0.07;
      const fade = Math.max(0, Math.min(1, dEdge / 0.16));
      if (fade < 1) c.lerp(haze, (1 - fade) * (1 - fade));
      col.push(c.r, c.g, c.b);
    }
    for (let j = 0; j < WZ - 1; j++) for (let i = 0; i < WX - 1; i++) { const a = j * WX + i, b = a + 1, d = a + WX, e = d + 1; idx.push(a, b, d, b, e, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    this.waterBase = Float32Array.from(pos);
    this.water = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.scene.add(this.water);
  }

  private buildTrees(mask: Uint8Array) {
    const { GW, GH, bb } = this;
    const trunk = new THREE.CylinderGeometry(0.16, 0.28, 1.1, 6).translate(0, 0.55, 0);
    const fol1 = new THREE.ConeGeometry(1.25, 2.0, 7).translate(0, 1.7, 0);
    const fol2 = new THREE.ConeGeometry(0.92, 1.7, 7).translate(0, 2.75, 0); // layered crown reads softer than one stark cone
    const treeGeo = mergeGeometries([trunk, fol1, fol2], false)!;
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
      c.setHSL(0.30 + (hash(k, 2) - 0.5) * 0.05, 0.5, 0.24 + hash(k, 3) * 0.08); tm.setColorAt(k, c); // forest greens, slight variation
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
      const rm = locked ? lockM : roofM;
      // a little round castle: a crenellated curtain ring, four drum towers with
      // conical roofs, and a central keep — reads as a castle, not a box pile
      const curtain = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.7, 1.5, 8), wm); curtain.position.y = 0.75; g.add(curtain);
      const merlons = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.16, 4, 8).rotateX(Math.PI / 2), wm); merlons.position.y = 1.5; g.add(merlons);
      for (let h = 0; h < 4; h++) {
        const a = h / 4 * 6.28 + Math.PI / 4, tx = Math.cos(a) * 2.5, tz = Math.sin(a) * 2.5;
        const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.74, 2.7, 8), wm); tw.position.set(tx, 1.35, tz); g.add(tw);
        const tr = new THREE.Mesh(new THREE.ConeGeometry(0.72, 0.95, 8), rm); tr.position.set(tx, 3.25, tz); g.add(tr);
      }
      const keep = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.35, 3.6, 10), wm); keep.position.y = 1.8; g.add(keep);
      const keepRing = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.17, 4, 10).rotateX(Math.PI / 2), wm); keepRing.position.y = 3.6; g.add(keepRing);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.18, 1.5, 10), rm); roof.position.y = 4.4; g.add(roof);
      // a banner on the keep: your colours once taken/under siege, the enemy's while it holds out
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.4), new THREE.MeshLambertMaterial({ color: '#5a4326' })); pole.position.set(0, 5.4, 0); g.add(pole);
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95).translate(0.75, 0, 0), new THREE.MeshLambertMaterial({ color: locked ? '#7c2b27' : done ? '#caa53c' : '#c43d34', side: THREE.DoubleSide }));
      cloth.position.set(0, 6.0, 0); g.add(cloth);
      const sc = current ? 2.0 : 1.5; g.scale.set(sc, sc, sc); g.position.set(x, y, z); this.scene.add(g);
      this.banners.push({ mesh: cloth, phase: node.id * 1.3 });
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
    ctx.font = "700 30px 'Cinzel', Georgia, serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(20,14,6,0.85)'; ctx.strokeText(node.name, 128, 34);
    ctx.fillStyle = current ? '#ffe27a' : '#fff4e2'; ctx.fillText(node.name, 128, 34);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.position.set(x, y, z); sp.scale.set(22, 5.5, 1); sp.renderOrder = 10; this.scene.add(sp); this.labels.push(sp);
  }

  // big, faint realm names floating over their territory (Total War flavour)
  private buildRealmLabels() {
    for (const [name, lat, lon] of REALMS) {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 80; const ctx = cv.getContext('2d')!;
      ctx.font = "700 38px 'Cinzel', Georgia, serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(60,44,20,0.72)'; ctx.fillText(name, 256, 44);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.5, depthTest: true, depthWrite: false }));
      sp.position.set(this.wX(lon), this.terrainY(lon, lat) + 16, this.wZ(lat)); sp.scale.set(58, 9, 1); sp.renderOrder = 2; this.scene.add(sp);
    }
  }

  private softSprite(hex: string) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62); g.addColorStop(0, hex); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; return tex;
  }
  // soft clouds drifting west→east, high over the map
  private buildClouds() {
    const tex = this.softSprite('rgba(255,255,255,0.92)');
    for (let i = 0; i < 14; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false }));
      sp.position.set(this.wX(this.bb.w) + Math.random() * (this.wX(this.bb.e) - this.wX(this.bb.w)) + 200, 95 + Math.random() * 60, this.wZ(this.bb.n) + Math.random() * (this.wZ(this.bb.s) - this.wZ(this.bb.n)));
      const s = 60 + Math.random() * 80; sp.scale.set(s, s * 0.6, 1); sp.renderOrder = 1; this.scene.add(sp);
      this.clouds.push({ mesh: sp, speed: 0.06 + Math.random() * 0.08 });
    }
  }
  // small V-flocks of gull silhouettes, each a pair of swept wings that flap;
  // kept small and high so they read as distant birds, not objects on the ground
  private oneBird(mat: THREE.Material) {
    const b = new THREE.Group();
    const wing = new THREE.PlaneGeometry(1.4, 0.34).translate(0.7, 0, 0); // pivots at the body
    const lw = new THREE.Mesh(wing, mat), rw = new THREE.Mesh(wing, mat);
    lw.rotation.y = -0.5; rw.rotation.y = Math.PI + 0.5; // swept back into a chevron
    b.add(lw); b.add(rw); (b as any).lw = lw; (b as any).rw = rw;
    return b;
  }
  private buildBirds() {
    const mat = new THREE.MeshBasicMaterial({ color: '#2c2c33', side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    for (let f = 0; f < 5; f++) {
      const grp = new THREE.Group();
      const k = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < k; i++) { const bird = this.oneBird(mat); const col = (i % 2 ? 1 : -1) * Math.ceil(i / 2); bird.position.set(col * 3.2, -Math.abs(col) * 0.6, -Math.abs(col) * 2.6); bird.scale.setScalar(0.9 + Math.random() * 0.3); grp.add(bird); }
      grp.position.set(this.wX(this.bb.w) + Math.random() * (this.wX(this.bb.e) - this.wX(this.bb.w)), 78 + Math.random() * 34, this.wZ(this.bb.n) + Math.random() * (this.wZ(this.bb.s) - this.wZ(this.bb.n)));
      this.scene.add(grp); this.birds.push({ grp, speed: 0.16 + Math.random() * 0.12, phase: f * 1.7 });
    }
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

  // ---- compass + castle info panel (DOM overlays on the map screen) ----
  private injectStyles() {
    if (document.getElementById('map3d-styles')) { this.styleEl = document.getElementById('map3d-styles')!; return; }
    const s = document.createElement('style'); s.id = 'map3d-styles';
    s.textContent = `
    .mapCompass{position:absolute;top:84px;right:14px;width:62px;height:62px;border-radius:50%;
      background:radial-gradient(circle at 50% 38%,#f6ecd2,#d8c69a);border:2px solid #6b5126;
      box-shadow:0 2px 8px rgba(0,0,0,.4);z-index:6;font:700 12px 'EB Garamond',Georgia,serif;color:#4a3514;cursor:pointer}
    .mapCompass .rose{position:absolute;inset:0;transform-origin:50% 50%}
    .mapCompass span{position:absolute;left:0;right:0;text-align:center}
    .mapCompass .n{top:3px;color:#a6301f}.mapCompass .s{bottom:3px}.mapCompass .e{top:24px;right:5px;left:auto}.mapCompass .w{top:24px;left:5px;right:auto}
    .mapCompass .needle{position:absolute;left:50%;top:50%;width:0;height:0;transform:translate(-50%,-100%);
      border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:22px solid #a6301f}
    .mapCompass .needle.s{transform:translate(-50%,0);border-bottom:none;border-top:22px solid #3a4a66}
    .castlePanel{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);width:min(88vw,400px);
      background:linear-gradient(#241a10f2,#160f08f2);border:1px solid #7a5e2e;border-radius:16px;
      padding:20px 20px 18px;color:#f3e6cf;z-index:7;box-shadow:0 6px 22px rgba(0,0,0,.55);display:none;font-family:'EB Garamond',Georgia,serif;text-align:center}
    .castlePanel.show{display:block;animation:cpIn .18s ease-out}
    @keyframes cpIn{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
    .castlePanel h3{margin:0 0 4px;font-size:23px;color:#ffe6a6;letter-spacing:.4px;line-height:1.1}
    .castlePanel .reg{font-size:11px;color:#c7a86e;margin-bottom:13px;text-transform:uppercase;letter-spacing:2.5px}
    .castlePanel .blurb{font-size:13.5px;line-height:1.5;color:#e3d4ba;margin:0 auto 16px;max-width:330px}
    .castlePanel .stats{margin:0 auto 18px;text-align:left;max-width:340px}
    .castlePanel .stat{font-size:13.5px;display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:8px 2px;border-bottom:1px solid #3a2c19}
    .castlePanel .stat:last-child{border-bottom:none}
    .castlePanel .stat span{color:#bda981;white-space:nowrap}
    .castlePanel .stat b{color:#ffd98a;font-weight:600;text-align:right}
    .castlePanel .row{display:flex;gap:11px}
    .castlePanel button{flex:1;border:none;border-radius:10px;padding:12px 10px;font:600 15px 'EB Garamond',Georgia,serif;cursor:pointer;line-height:1.15}
    .castlePanel .go{background:linear-gradient(#b5402f,#8c2b20);color:#fff}
    .castlePanel .close{background:#3a2e1e;color:#d9c8a8}
    .marchHint{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);z-index:7;
      background:#000a;color:#f3e6cf;padding:7px 14px;border-radius:20px;font:600 13px 'EB Garamond',Georgia,serif;display:none}
    .marchHint.show{display:block}`;
    document.head.appendChild(s); this.styleEl = s;
  }
  private host() { return this.canvas.parentElement || document.body; }
  private makeCompass() {
    this.injectStyles();
    const c = document.createElement('div'); c.className = 'mapCompass'; c.title = 'Tap to face north';
    c.innerHTML = '<div class="rose"><div class="needle"></div><div class="needle s"></div><span class="n">N</span><span class="s">S</span><span class="e">E</span><span class="w">W</span></div>';
    c.addEventListener('click', () => { this.azReset = true; });
    this.host().appendChild(c); this.compassEl = c; this.compassRose = c.querySelector('.rose') as HTMLElement;
  }
  private makePanel() {
    this.injectStyles();
    const p = document.createElement('div'); p.className = 'castlePanel';
    const hint = document.createElement('div'); hint.className = 'marchHint'; hint.textContent = 'Marching to the siege…  (tap to skip)';
    this.host().appendChild(p); this.host().appendChild(hint); this.panelEl = p; (this as any).hintEl = hint;
  }
  // historical one-liners for the famous castles; generic flavour for the rest
  private static BLURBS: Record<string, string> = {
    'Caernarfon': "Edward I's mighty seat in Wales, its polygonal towers banded in coloured stone, raised to overawe the Welsh.",
    'Conwy': 'A perfectly preserved Edwardian fortress and walled town guarding the Conwy estuary.',
    'Harlech': "Perched on a crag above the sea, its concentric walls withstood the longest siege in British history.",
    'Caerphilly': "Britain's second-largest castle, ringed by vast water defences and concentric curtain walls.",
    'Dover': "The 'Key to England' — colossal concentric defences guarding the narrowest crossing to the continent.",
    'Château Gaillard': "Richard the Lionheart's masterwork above the Seine, built in a single year to bar Normandy.",
    'Carcassonne': 'A double ring of walls and fifty-odd towers crowning a hill above the Aude — the model walled city.',
    'Krak des Chevaliers': "The Hospitallers' concentric crusader fortress, called the finest castle in the world; it never fell to assault.",
    'Castel del Monte': "Frederick II's enigmatic octagon, eight towers in flawless geometry on a Apulian hill.",
    'Rhodes': "The Knights Hospitaller's island bastion, its land walls among the strongest in Christendom.",
    'Acre': "The crusaders' last great port-fortress in the Holy Land, ringed by a double wall.",
    'Jerusalem': 'The holy city itself, its Tower of David and ancient walls the ultimate prize of the crusade.',
    'Windsor': "A royal fortress-palace since the Conqueror, its round tower rising over the Thames.",
    'Salzburg': "The Hohensalzburg towers over the Salzach, one of the largest medieval castles to survive intact.",
  };
  private describe(node: CampaignCastle): { blurb: string; stats: [string, string][]; canSiege: boolean } {
    const st = node.style; const done = this.prog.completed.includes(node.id); const current = node.id === this.prog.unlocked;
    const defenders = garrisonStrength(st, 1 + node.tier * 0.8);
    const stars = Math.max(1, Math.min(5, 1 + Math.round(node.tier * 4)));
    const def = st.concentric ? 'Concentric double walls' : st.strongKeep ? 'Mighty central keep' : st.round ? 'Round drum towers' : 'Curtain wall & towers';
    const blurb = WorldMap3D.BLURBS[node.name] || `A ${st.concentric ? 'concentric' : st.round ? 'drum-towered' : 'stout'} stronghold of ${node.region}, ${node.tier > 0.6 ? 'strongly held and richly garrisoned' : 'guarding the road east'}.`;
    return {
      blurb,
      stats: [['Region', node.region], ['Garrison', `~${defenders} men`], ['Defenses', def], ['Difficulty', '★'.repeat(stars) + '☆'.repeat(5 - stars)], ['Status', done ? 'Conquered' : current ? 'Your objective' : 'Awaiting']],
      canSiege: current,
    };
  }
  private showPanel(node: CampaignCastle) {
    const p = this.panelEl; if (!p) return; const d = this.describe(node);
    p.innerHTML = `<h3>${node.name}</h3><div class="reg">${node.region}</div><div class="blurb">${d.blurb}</div>`
      + `<div class="stats">${d.stats.map(s => `<div class="stat"><span>${s[0]}</span><b>${s[1]}</b></div>`).join('')}</div>`
      + `<div class="row">${d.canSiege ? '<button class="go">March &amp; Lay Siege</button>' : ''}<button class="close">Close</button></div>`;
    p.classList.add('show');
    p.querySelector('.close')!.addEventListener('click', () => p.classList.remove('show'));
    const go = p.querySelector('.go'); if (go) go.addEventListener('click', () => { p.classList.remove('show'); this.marchTo(node); });
  }

  // ---- the march: an army (banners flying) crossing land, boats over water ----
  private isWater(lon: number, lat: number) {
    const gx = Math.round((lon - this.bb.w) / (this.bb.e - this.bb.w) * (this.GW - 1));
    const gy = Math.round((lat - this.bb.s) / (this.bb.n - this.bb.s) * (this.GH - 1));
    if (gx < 0 || gy < 0 || gx >= this.GW || gy >= this.GH) return true;
    return !this.maskRef[gy * this.GW + gx];
  }
  private buildArmy() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: '#41372a' }), steel = new THREE.MeshLambertMaterial({ color: '#8b8f98' });
    const figs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 9; i++) { const col = (i % 3 - 1) * 1.2, row = Math.floor(i / 3) * 1.4; figs.push(new THREE.BoxGeometry(0.7, 1.5, 0.7).translate(col, 0.75, row)); }
    g.add(new THREE.Mesh(mergeGeometries(figs, false), bodyMat));
    const heads: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 9; i++) { const col = (i % 3 - 1) * 1.2, row = Math.floor(i / 3) * 1.4; heads.push(new THREE.SphereGeometry(0.34, 6, 5).translate(col, 1.7, row)); }
    g.add(new THREE.Mesh(mergeGeometries(heads, false), steel));
    // standard-bearer with a big banner
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.2), new THREE.MeshLambertMaterial({ color: '#4a3620' })); pole.position.set(0, 2.1, -1.4); g.add(pole);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.3).translate(1.0, 0, 0), new THREE.MeshLambertMaterial({ color: '#c43d34', side: THREE.DoubleSide })); cloth.position.set(0, 3.4, -1.4); g.add(cloth);
    (g as any).cloth = cloth;
    g.scale.set(2.4, 2.4, 2.4); g.visible = false; this.scene.add(g); return g;
  }
  private buildBoat() {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.0, 7.0), new THREE.MeshLambertMaterial({ color: '#6b4a2a' })); hull.position.y = 0.4; g.add(hull);
    const prow = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.2, 4).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#5a3d22' })); prow.position.set(0, 0.4, 4.2); prow.rotation.z = Math.PI / 4; g.add(prow);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5), new THREE.MeshLambertMaterial({ color: '#3f2d18' })); mast.position.y = 3; g.add(mast);
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.0), new THREE.MeshLambertMaterial({ color: '#efe6cf', side: THREE.DoubleSide })); sail.position.set(0, 3.3, 0.1); g.add(sail);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.8).translate(0.7, 0, 0), new THREE.MeshLambertMaterial({ color: '#c43d34', side: THREE.DoubleSide })); flag.position.set(0, 5.3, 0); g.add(flag);
    g.scale.set(2.6, 2.6, 2.6); g.visible = false; this.scene.add(g); return g;
  }
  private marchTo(node: CampaignCastle) {
    const src = node.id > 0 ? this.nodes[node.id - 1] : null;
    const A = src ? { lon: src.lon, lat: src.lat } : { lon: node.lon, lat: node.lat - 2.2 };
    const B = { lon: node.lon, lat: node.lat };
    const N = 60, path: { p: THREE.Vector3; water: boolean }[] = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N, lon = A.lon + (B.lon - A.lon) * t, lat = A.lat + (B.lat - A.lat) * t;
      const water = this.isWater(lon, lat);
      const y = water ? 0.7 : this.terrainY(lon, lat) + 0.4;
      path.push({ p: new THREE.Vector3(this.wX(lon), y, this.wZ(lat)), water });
    }
    const dur = Math.max(2.6, Math.min(5.5, A && src ? Math.hypot(B.lon - A.lon, B.lat - A.lat) * 1.4 + 2.2 : 2.6));
    const army = this.buildArmy(), boat = this.buildBoat();
    (this as any).hintEl?.classList.add('show');
    this.march = { t: 0, dur, last: performance.now(), path, army, boat, done: () => this.onSelect(node), skip: false };
  }
  private stepMarch() {
    const m = this.march; if (!m) return;
    const now = performance.now(); const dt = Math.min(0.05, (now - m.last) / 1000); m.last = now;
    m.t += dt / m.dur; let f = m.t;
    if (m.skip || f >= 1) { this.endMarch(); return; }
    // ease in/out
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    const fi = e * (m.path.length - 1); const i0 = Math.min(m.path.length - 2, Math.floor(fi)); const fr = fi - i0;
    const a = m.path[i0], b = m.path[i0 + 1];
    const pos = a.p.clone().lerp(b.p, fr);
    const heading = Math.atan2(b.p.x - a.p.x, b.p.z - a.p.z);
    const water = a.water || b.water;
    m.army.visible = !water; m.boat.visible = water;
    const unit = water ? m.boat : m.army; unit.position.copy(pos); unit.rotation.y = heading;
    if (water) { m.boat.position.y = pos.y + Math.sin(this.pulse * 2) * 0.25; }
    else { const cloth = (m.army as any).cloth as THREE.Mesh; if (cloth) cloth.rotation.y = 0.5 + Math.sin(this.pulse * 2.4) * 0.5; }
    // ease the camera in & follow the column (cinematic)
    this.dist += (96 - this.dist) * 0.04;
    this.target.x += (pos.x - this.target.x) * 0.07; this.target.z += (pos.z + 10 - this.target.z) * 0.07;
  }
  private endMarch() {
    const m = this.march; if (!m) return; this.march = undefined;
    this.scene.remove(m.army); this.scene.remove(m.boat);
    (this as any).hintEl?.classList.remove('show');
    m.done();
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
      if (pts.size >= 2) {
        const a = [...pts.values()]; const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (this.pinchD) this.dist *= this.pinchD / d; this.pinchD = d;
        const ang = Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x);                  // twist to rotate the POV
        if (this.pinchA !== undefined) { this.azimuth += ang - this.pinchA; this.azReset = false; } this.pinchA = ang;
        this.clampTarget(); this.dragging = false; return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY; this.lastX = e.clientX; this.lastY = e.clientY; this.moved += Math.abs(dx) + Math.abs(dy);
      const k = this.dist * 0.0016, ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
      // drag moves the map: pan in the camera's ground plane
      this.target.x -= (dx * ca - dy * sa) * k; this.target.z -= (dx * -sa + dy * ca) * k * 1.4; this.clampTarget();
    });
    const end = (e: PointerEvent) => { const tap = pts.size === 1 && this.moved < 9 && performance.now() - this.downT < 400; pts.delete(e.pointerId); if (pts.size < 2) { this.pinchD = 0; this.pinchA = undefined; } if (pts.size === 0) this.dragging = false; if (tap) this.pick(this.downX, this.downY); };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => this.resize());
  }
  private pick(sx: number, sy: number) {
    if (this.march) { this.march.skip = true; return; } // tap skips the march
    const rect = this.canvas.getBoundingClientRect(); const px = sx - rect.left, py = sy - rect.top;
    const v = new THREE.Vector3(); let best = -1, bd = 44 * 44;
    for (const m of this.markers) {
      if (m.node.id > this.prog.unlocked) continue;
      v.copy(m.pos); v.y += 4; v.project(this.camera);
      const ex = (v.x * 0.5 + 0.5) * this.cssW(), ey = (1 - (v.y * 0.5 + 0.5)) * this.cssH();
      const d = (ex - px) ** 2 + (ey - py) ** 2; if (d < bd && v.z < 1) { bd = d; best = m.node.id; }
    }
    if (best >= 0) this.showPanel(this.nodes[best]);
  }
  private animateWater() {
    const w = this.water, base = this.waterBase; if (!w || !base) return;
    const p = (w.geometry.attributes.position as THREE.BufferAttribute);
    const arr = p.array as Float32Array; const t = this.pulse;
    for (let k = 0; k < arr.length; k += 3) { const x = base[k], z = base[k + 2]; arr[k + 1] = 0.3 + Math.sin(t * 1.3 + x * 0.06) * 0.1 + Math.cos(t * 1.0 + z * 0.05) * 0.09; }
    p.needsUpdate = true;
  }

  private frame() {
    if (this.cssW() === 0) return; // map hidden behind muster/battle — don't burn cycles
    if (!this.ready) { this.renderer.render(this.scene, this.camera); return; }
    this.azimuth = Math.atan2(Math.sin(this.azimuth), Math.cos(this.azimuth)); // keep in [-π,π]
    if (this.azReset) { this.azimuth *= 0.82; if (Math.abs(this.azimuth) < 0.008) { this.azimuth = 0; this.azReset = false; } }
    this.clampTarget(); this.updateCamera();
    if (this.compassRose) {
      // point the rose at where due north actually projects on screen (accounts
      // for the camera pitch, so it stays accurate as you twist the view)
      this._tp.copy(this.target).project(this.camera);
      this._np.set(this.target.x, this.target.y, this.target.z - 20).project(this.camera);
      this.compassRose.style.transform = `rotate(${Math.atan2(this._np.x - this._tp.x, this._np.y - this._tp.y)}rad)`;
    }
    for (const m of this.markers) if (m.ring) { const s = 1 + 0.12 * Math.sin(this.pulse); m.ring.scale.set(s, 1, s); }
    this.animateWater();
    for (const b of this.banners) b.mesh.rotation.y = 0.5 + Math.sin(this.pulse * 1.7 + b.phase) * 0.5;
    for (const cl of this.clouds) { cl.mesh.position.x += cl.speed; if (cl.mesh.position.x > this.wX(this.bb.e) + 200) cl.mesh.position.x = this.wX(this.bb.w) - 200; }
    for (const bd of this.birds) {
      bd.grp.position.x += bd.speed;
      if (bd.grp.position.x > this.wX(this.bb.e) + 150) bd.grp.position.x = this.wX(this.bb.w) - 150;
      bd.grp.children.forEach((b, k) => { const a = 0.55 * Math.sin(this.pulse * 7 + bd.phase + k * 0.7); (b as any).lw.rotation.z = a; (b as any).rw.rotation.z = a; });
    }
    if (this.march) this.stepMarch();
    this.renderer.render(this.scene, this.camera);
  }
}
