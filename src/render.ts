import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Sim, CASTLE, Faction, WORLD, LAYOUT, T, DOC_DECO } from './sim';
import { Biome } from './campaign';
import { makeSoldierTexture, makeArrowTexture, spriteAspect, SpriteKind } from './sprites';
import { stoneTexture, stoneNormalTexture, roofTexture, grassTexture, plasterTexture, dirtTexture } from './textures';

// ── Cinematic colour-grade ────────────────────────────────────────────────
// One cheap fullscreen pass that turns the storybook-bright frame into a
// dustier, filmic one — the biggest perceived-quality jump per GPU cycle.
// We take tone-mapping fully in-shader (the renderer runs NoToneMapping when
// the composer is on) so ACES → grade → sRGB happens exactly once, with no
// version-dependent double-encode. Grade acts in display-referred space
// (after ACES) so the knobs stay intuitive: desaturate a touch, nudge
// contrast, warm the shadows toward dusk, and vignette the corners.
const CINEMATIC_GRADE = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1.17 },
    // A restrained warm balance — clear naturalistic daylight, not a golden-hour
    // wash. Just enough warmth to feel sunlit; the stone and grass keep their real
    // colour. (Reference tone: clear, raw, overcast-bright.)
    uBalance: { value: new THREE.Vector3(1.028, 1.004, 0.965) },
    uSat: { value: 0.93 },      // keep colour real — only a hair of desaturation
    uContrast: { value: 1.08 }, // a touch more bite for a crisp, raw read
    uWarm: { value: new THREE.Vector3(0.028, 0.012, -0.004) },  // shadow tint (subtle earth)
    uHigh: { value: new THREE.Vector3(0.008, 0.004, -0.008) },  // highlight tint (barely warm)
    uVignette: { value: 0.08 }, // gentle — a CSS #vignette already darkens the frame edges
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uExposure, uContrast, uVignette, uSat;
    uniform vec3 uWarm, uHigh, uBalance;
    vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure * uBalance; // warm the light, then
      c = aces(c);                                            // HDR → display-referred 0..1
      float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(L), c, uSat);                              // gentle desaturate
      float sh = 1.0 - smoothstep(0.0, 0.55, L);             // shadow mask
      float hi = smoothstep(0.5, 1.0, L);                    // highlight mask
      c += uWarm * sh + uHigh * hi;                          // split-tone, warm throughout
      c = (c - 0.5) * uContrast + 0.5;                       // filmic contrast
      c = clamp(c, 0.0, 1.0);
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - uVignette * smoothstep(0.42, 0.9, d);       // corner falloff
      gl_FragColor = vec4(pow(c, vec3(1.0/2.2)), 1.0);       // sRGB encode
    }`,
};

// Per-region siege scenery: sky, fog, light, ground and the horizon ring of
// hills/mountains/dunes — so a battle looks like where it is in the world.
interface BiomeCfg {
  bg: string; skyTop: string; skyBot: string; fog: string; fogNear: number; fogFar: number;
  hemiSky: string; hemiGround: string; sun: string; sunInt: number; amb: string;
  ground: string; sand: boolean; hill: string; hillTop: string; snow: boolean; hillH: number; dune: boolean; tree: string;
}
// Palette note: grounds/hills/trees are kept SOMBER — desaturated, slightly darker
// greens — so the field reads clear, defined and medieval rather than candy-bright.
const BIOMES: Record<Biome, BiomeCfg> = {
  britain: { bg: '#b8cade', skyTop: '#b7ccdf', skyBot: '#ecddc0', fog: '#cdd2c4', fogNear: 430, fogFar: 1060, hemiSky: '#f7ebd2', hemiGround: '#767041', sun: '#fbdca6', sunInt: 2.02, amb: '#f3e4cb', ground: '#a2a15a', sand: false, hill: '#666a3d', hillTop: '#909054', snow: false, hillH: 62, dune: false, tree: '#3f4f28' },
  france:  { bg: '#bccbdd', skyTop: '#bcccdd', skyBot: '#eddfc6', fog: '#d1d1c1', fogNear: 450, fogFar: 1080, hemiSky: '#f7edd6', hemiGround: '#79763f', sun: '#fbddaa', sunInt: 2.02, amb: '#f3e6cd', ground: '#a9a660', sand: false, hill: '#6e753f', hillTop: '#959457', snow: false, hillH: 40, dune: false, tree: '#455829' },
  alpine:  { bg: '#bacfe4', skyTop: '#b2cbe6', skyBot: '#dee5e8', fog: '#d1dbe2', fogNear: 470, fogFar: 1120, hemiSky: '#eef2f8', hemiGround: '#57653c', sun: '#f7ddb4', sunInt: 1.9, amb: '#e6eaf3', ground: '#7c944e', sand: false, hill: '#4f5f3c', hillTop: '#b8bfba', snow: true, hillH: 205, dune: false, tree: '#2e4526' },
  med:     { bg: '#c2ccce', skyTop: '#b2c5cd', skyBot: '#e6dcba', fog: '#d9d1b6', fogNear: 410, fogFar: 1040, hemiSky: '#f5e8c4', hemiGround: '#7d7443', sun: '#f5d494', sunInt: 2.05, amb: '#f3e4c1', ground: '#93925a', sand: false, hill: '#7b7043', hillTop: '#968a57', snow: false, hillH: 58, dune: false, tree: '#505e30' },
  desert:  { bg: '#d6ccb2', skyTop: '#c3cac4', skyBot: '#e8dab6', fog: '#ded1b2', fogNear: 430, fogFar: 1060, hemiSky: '#f5e6bd', hemiGround: '#a2874f', sun: '#f5d89b', sunInt: 2.1, amb: '#f3e4c3', ground: '#bda471', sand: true, hill: '#b7a071', hillTop: '#c9b485', snow: false, hillH: 42, dune: true, tree: '#6d7039' },
};

const KIND: SpriteKind[] = ['heavy', 'light', 'archer', 'cavalry'];
// On-screen billboard HEIGHTS (world units). Widths are DERIVED from each sprite's
// native aspect so the commissioned art is never stretched — heavy is a tall lone
// figure (narrow), cavalry a horse+rider (wide). Feet are anchored to the ground.
const SPRITE_H = [2.9, 2.6, 2.7, 3.1];
const SPRITE_W = KIND.map((k, i) => SPRITE_H[i] * spriteAspect(k));
// Mirror sprites whose art faces the "wrong" way so the whole host faces one way.
const FLIP = [true, false, false, false]; // heavy is drawn facing left; the rest face right
const SHADOW_R = [0.9, 0.78, 0.8, 1.5];
// GPU billboarding: the vertex shader turns a per-instance position (+scale/phase/
// state/yaw) into a camera-facing, bobbing sprite — so the CPU only writes 3 floats
// of position per soldier each frame instead of composing a 4x4 matrix. iState:
// 0 = standing, 1 = marching (bob+roll), 2 = corpse (laid flat with a random yaw).
const SOLDIER_VERT = `
  float w = sin(uTime + iPhase);
  vec3 wp;
  vFlip = 1.0;
  if (iState > 1.5) {
    float sc = iScale * 0.95;
    float cyaw = cos(iYaw), syaw = sin(iYaw);
    vec2 q = position.xy * sc;
    // a fallen man lies flat at ground level; an old corpse sinks away via a
    // negative iPos.y written CPU-side (the field slowly reclaims its dead)
    wp = vec3(iPos.x + q.x * cyaw - q.y * syaw, 0.13 + min(0.0, iPos.y), iPos.z + q.x * syaw + q.y * cyaw);
  } else {
    float moving = step(0.5, iState);
    float stretch = 1.0 + moving * abs(w) * 0.06;
    float bob = moving * w * 0.17 * iScale;
    float roll = moving * w * 0.13;
    float cr = cos(roll), sr = sin(roll);
    // Face the objective regardless of camera side: the baked art faces local +x
    // (screen-right). When the objective (attackers -> castle, defenders -> field,
    // via iFace) lies to screen-left, flag a horizontal mirror — done in the FRAGMENT
    // by flipping the texture U, so the quad winding (and FrontSide culling) is intact.
    vec2 toObj = uObj.xz - iPos.xz;
    vFlip = (dot(toObj, uRight.xz) * iFace >= 0.0) ? 1.0 : 0.0;
    vec2 q = position.xy * iScale;
    vec2 qr = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);
    qr.y *= stretch;
    float centerY = iPos.y + uHalfH * iScale * stretch + bob;
    wp = vec3(iPos.x + uRight.x * qr.x, centerY + qr.y, iPos.z + uRight.z * qr.x);
  }
  vec3 transformed = wp;`;

const COL_ATTACK = new THREE.Color('#e0552f');
const COL_DEFEND = new THREE.Color('#3f86d8');

// ── Time of day ───────────────────────────────────────────────────────────
// Each siege happens at an hour of its own — dawn assaults, dusk bombardments
// and the occasional night storm where the braziers carry the scene. The biome
// palette is overridden per-hour, the sun moves, and the colour grade re-tunes.
export type TimeOfDay = 'dawn' | 'noon' | 'dusk' | 'night';
interface TodCfg {
  sky?: Partial<Pick<BiomeCfg, 'bg' | 'skyTop' | 'skyBot' | 'fog' | 'hemiSky' | 'hemiGround' | 'sun' | 'amb'>>;
  sunPos: [number, number, number]; sunInt: number; hemiInt: number; ambInt: number;
  exposure: number; balance: [number, number, number]; sat: number;
  glow: [number, number, number]; glowScale: number; stars: boolean;
}
const TOD: Record<TimeOfDay, TodCfg> = {
  noon:  { sunPos: [96, 132, 64], sunInt: 1, hemiInt: 0.78, ambInt: 0.18,
    exposure: 1.17, balance: [1.028, 1.004, 0.965], sat: 0.93, glow: [2.9, 2.4, 1.7], glowScale: 150, stars: false },
  dawn:  { sky: { skyTop: '#a3b4d8', skyBot: '#f4cfa4', fog: '#d3c3ab', bg: '#b3b6cf', sun: '#ffc98e', hemiSky: '#eedbC8', amb: '#e8d4bd' },
    sunPos: [-150, 52, 55], sunInt: 0.92, hemiInt: 0.62, ambInt: 0.2,
    exposure: 1.13, balance: [1.05, 1.0, 0.96], sat: 0.9, glow: [2.9, 2.2, 1.5], glowScale: 175, stars: false },
  dusk:  { sky: { skyTop: '#8fa0c6', skyBot: '#efb280', fog: '#c9b394', bg: '#a9a7bd', sun: '#ff9f5e', hemiSky: '#e5cdb4', amb: '#d9c3ac' },
    sunPos: [152, 44, -34], sunInt: 0.88, hemiInt: 0.56, ambInt: 0.2,
    exposure: 1.12, balance: [1.07, 1.0, 0.93], sat: 0.92, glow: [3.0, 2.0, 1.2], glowScale: 190, stars: false },
  night: { sky: { skyTop: '#0d1526', skyBot: '#233150', fog: '#1c2438', bg: '#141c2e', sun: '#a8bce4', hemiSky: '#48587c', hemiGround: '#262b38', amb: '#525f7e' },
    // the moon sits HIGH on the camera side (like the day sun) so the walls the
    // player actually sees catch the blue wash — readable game-night, not a void
    sunPos: [58, 140, 88], sunInt: 0.52, hemiInt: 0.58, ambInt: 0.36,
    exposure: 1.3, balance: [0.93, 0.99, 1.12], sat: 0.85, glow: [1.5, 1.7, 2.3], glowScale: 82, stars: true },
};

// Soldier fragment: keep the baked detail (steel/leather/skin/weapon) and tint ONLY
// the green-keyed surcoat/shield with the per-instance faction colour (vColor). The
// instance colour's brightness also darkens the whole body, so the corpse grey-out
// still works.
const SOLDIER_FRAG = `
  vec2 sUv = vec2(vFlip > 0.5 ? vMapUv.x : 1.0 - vMapUv.x, vMapUv.y); // mirror to face the objective
  vec4 texColor = texture2D( map, sUv );
  // Heraldry is a canonical pure-green key (r=b=0): green-dominance is unambiguous,
  // so a low threshold keys every arm's colours cleanly while sepia stays untouched.
  float keyAmt = smoothstep(0.05, 0.20, texColor.g - max(texColor.r, texColor.b));
  float vlum = max(max(vColor.r, vColor.g), vColor.b);
  vec3 body = texColor.rgb * (0.6 + 0.4 * vlum);
  // texColor.g carries the cloth shading (folds); lift it so the faction colour reads bright.
  vec3 team = vColor.rgb * clamp(texColor.g * 1.7 + 0.22, 0.0, 1.0);
  diffuseColor = vec4( mix(body, team, keyAmt), texColor.a );`;

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
  private uObj = { value: new THREE.Vector3(0, 0, 0) };   // siege objective (castle centre) sprites face toward
  private shadowMesh!: THREE.InstancedMesh;
  private shadowsOn = true; // per-soldier ground blobs; off for very large musters
  private projMesh!: THREE.InstancedMesh;
  private boulderMesh!: THREE.InstancedMesh;
  private fireMesh!: THREE.InstancedMesh;
  private fireTex!: THREE.CanvasTexture;
  private brazierMesh?: THREE.InstancedMesh; private braziers: { x: number; y: number; z: number; ph: number; seg: number }[] = [];
  private emberMesh?: THREE.InstancedMesh; private embers: { x: number; y: number; z: number; vy: number; life: number; max: number }[] = []; private emberHead = 0;
  private shockMesh?: THREE.InstancedMesh; private shocks: { x: number; y: number; z: number; life: number; max: number; scale: number }[] = []; private shockHead = 0;
  private sunGlow?: THREE.Sprite;
  // drifting battlefield haze — big soft sheets on the wind
  private hazeMesh?: THREE.InstancedMesh; private haze: { x: number; y: number; z: number; s: number }[] = [];
  private rainMesh?: THREE.InstancedMesh; private rain: { x: number; y: number; z: number; v: number }[] = [];
  private pennantMesh?: THREE.InstancedMesh; // one small standard per company, above its bearer
  // melee clash sparks (fed by sim.drainClashes())
  private sparkMesh?: THREE.InstancedMesh; private sparks: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number }[] = []; private sparkHead = 0;
  // the town burns — houses ignited by fire arrows / breaches
  private houses: { x: number; z: number; h: number }[] = []; private burning: { x: number; z: number; h: number; ph: number; spreadT?: number }[] = [];
  private flameMesh?: THREE.InstancedMesh;
  // auto-director points of interest
  private lastBreach = { x: 0, z: 0, t: -1e9 };
  private clashPoi = { x: 0, z: 0, heat: 0 };
  // cinematic intro sweep (assault start) — 1→0, lerping from → to
  introT = 0;
  private introFrom = { tx: 0, tz: 0, d: 0, yaw: 0, pitch: 0 };
  private introTo = { tx: 0, tz: 0, d: 0, yaw: 0, pitch: 0 };
  // rout tint + corpse decay
  private routFlag?: Uint8Array; private corpseAge?: Float32Array;
  // victory hero moment
  private victT = 0; private victOld?: THREE.Mesh; private victNew?: THREE.Mesh;
  private keepFlag?: THREE.Mesh; private keepTop = { x: 0, y: 0, z: 0 };
  private segVis: (SegVis | null)[] = [];
  private trebs: Treb[] = [];
  private ladderMeshes: THREE.Mesh[] = [];
  private ladderGeo?: THREE.BufferGeometry;
  private ladderMat?: THREE.MeshLambertMaterial;
  private ramModels: { group: THREE.Group; beam: THREE.Object3D }[] = [];
  private ramPhase = 0;
  private flags: { mesh: THREE.Mesh; base: Float32Array; amp: number; ph: number }[] = [];
  private sun!: THREE.DirectionalLight;
  private composer!: EffectComposer; private gradePass!: ShaderPass; private bloomPass!: UnrealBloomPass;
  private debrisMesh!: THREE.InstancedMesh; private debris: Debris[] = []; private debrisHead = 0;
  private dustMesh!: THREE.InstancedMesh; private dust: Dust[] = []; private dustHead = 0;
  private smokeMesh!: THREE.InstancedMesh; private smoke: { x: number; y: number; z: number; s: number; life: number; max: number }[] = []; private smokeHead = 0;
  private smokeSources: { x: number; y: number; z: number; s: number; rate: number; dark: number; t: number; seg?: number }[] = []; // castle fires + camp fires (seg-linked ones die with their wall)
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
  private _up = new THREE.Vector3(0, 1, 0); private _v1 = new THREE.Vector3(); private _v2 = new THREE.Vector3(); private _fogCol: THREE.Color | null = null;
  private corpse?: Uint8Array;                 // which units have been laid down as bodies
  private colorDirty = [false, false, false, false];
  private moveMarker?: THREE.Group;
  private moveMarkerT = 0;
  private time = 0;
  private sscale: Float32Array;
  private rubbleMat = new THREE.MeshLambertMaterial({ color: '#a3987f' });
  // shared procedural textures (one GPU upload each; materials clone but keep the map)
  private texStone = stoneTexture();
  private texStoneN = stoneNormalTexture(); // matching normal map — blocks catch real light
  private texRoof = roofTexture();
  private texPlaster = plasterTexture();

  camTarget = new THREE.Vector3(0, 0, 34);
  camDist = 165; camYaw = 0; camPitch = 0.92;
  private shakeAmt = 0; // transient camera-shake magnitude (impacts, breaches)
  shake(a: number) { this.shakeAmt = Math.min(2.2, this.shakeAmt + a); }
  private focusT = 0; private focusX = 0; private focusZ = 0; // victory push-in toward the keep
  focusKeep(x: number, z: number) { this.focusT = 1; this.focusX = x; this.focusZ = z; }

  private biomeCfg: BiomeCfg = BIOMES.britain;
  private coastal = false;
  private tod: TimeOfDay = 'noon'; private todCfg: TodCfg = TOD.noon;
  private weather: 'clear' | 'rain' | 'mist' | 'wind' = 'clear';
  constructor(private sim: Sim, canvasParent: HTMLElement, env?: { biome: Biome; coastal: boolean; tod?: TimeOfDay; weather?: 'clear' | 'rain' | 'mist' | 'wind' }) {
    this.tod = env?.tod ?? 'noon'; this.todCfg = TOD[this.tod];
    this.weather = env?.weather ?? 'clear';
    // fold the hour's sky/light palette over the biome's (biome sets the land, the hour sets the light)
    this.biomeCfg = { ...BIOMES[env?.biome ?? 'britain'], ...(this.todCfg.sky ?? {}) };
    this.coastal = !!env?.coastal;
    (window as any).__r = this; // console/QA access (like __sim / __map / __audio)
    // Mobile is fill-rate + draw-call bound. Render at device-pixel 1 (the HUD
    // is DOM so text stays crisp) and skip MSAA — the chunky art doesn't need it.
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.setPixelRatio(1);
    // Tone mapping now lives in the cinematic-grade pass (buildComposer), so the
    // scene renders linear HDR into the composer target and ACES is applied once,
    // in-shader, alongside the grade. Leaving this at NoToneMapping avoids a
    // double tone-map when the frame flows through the composer.
    this.gl.toneMapping = THREE.NoToneMapping;
    // Real sun shadows. Only the (few, merged, mostly-static) structures cast — not
    // the 2000 sprite soldiers — so it stays cheap on mobile while giving the field
    // genuine 3D form. A soft PCF kernel keeps the chunky art from getting jaggy.
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    canvasParent.appendChild(this.gl.domElement);

    const B = this.biomeCfg;
    this.scene.background = new THREE.Color(B.bg);
    // light, far biome haze so the horizon hills read with depth without the old
    // wall of fog swallowing the field
    let fogNear = B.fogNear, fogFar = B.fogFar, fogCol = B.fog;
    if (this.weather === 'mist') { fogNear = 90; fogFar = 420; fogCol = '#cfd3cd'; }       // the field swims in murk
    else if (this.weather === 'rain') { fogNear = B.fogNear * 0.6; fogFar = B.fogFar * 0.7; }
    this.scene.fog = new THREE.Fog(fogCol, fogNear, fogFar);
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, 2800); // far covers the enlarged sky dome at full zoom-out

    // Warm raking key light (the sun at this siege's hour) + sky fill so shadows stay alive.
    const T = this.todCfg;
    this.scene.add(new THREE.HemisphereLight(B.hemiSky, B.hemiGround, T.hemiInt));
    const sun = new THREE.DirectionalLight(B.sun, B.sunInt * T.sunInt * (this.weather === 'rain' ? 0.72 : 1)); sun.position.set(...T.sunPos);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536); // frozen + re-baked rarely, so 1536 stays crisp on the big static structures at a fraction of 2048's memory/bake cost
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -185; sc.right = 185; sc.top = 210; sc.bottom = -210; sc.near = 20; sc.far = 460;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 1.1; sun.shadow.radius = 2.2;
    // The structures are static, so the shadow map is FROZEN after the first frame and
    // only re-rendered when a wall is being damaged/crumbling — near-zero cost on mobile.
    sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true; this.sun = sun;
    this.scene.add(sun); this.scene.add(sun.target); // target defaults to the castle centre (origin)
    const fill = new THREE.DirectionalLight(this.tod === 'night' ? '#5a6d94' : '#aac6e4', this.tod === 'night' ? 0.22 : 0.3); fill.position.set(-70, 55, -45); this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(B.amb, T.ambInt));

    this.sscale = new Float32Array(sim.n);
    for (let i = 0; i < sim.n; i++) this.sscale[i] = 0.9 + jit(i, 1) * 0.28;

    this.buildSky();
    this.buildGround();
    this.buildHorizon();
    this.buildCastle();
    this.buildProps();
    this.buildInterior();
    this.buildTrees();
    this.buildSiegeCamp();
    this.buildSmoke();
    this.buildSoldiers();
    this.buildShadows();
    this.buildProjectiles();
    this.buildTrebuchets();
    this.buildBallistae();
    this.buildEffects();
    this.buildMotes();
    this.buildAssaultWorks();
    this.buildAtmosphere();
    this.buildComposer();

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
    this.routFlag = new Uint8Array(sim.n);
    this.corpseAge = new Float32Array(sim.n);

    // range fans — one per COMPANY (translucent disc + edge ring), so a spread-out
    // arm shows the area its men actually cover, not a single circle from the centre
    this.fanGeoDisc = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this.fanGeoEdge = new THREE.RingGeometry(0.97, 1.0, 48).rotateX(-Math.PI / 2);
    // soft fill + a FAINT edge: per-company discs union into one honest reach
    // region without the bold ring-per-company clutter of before
    this.fanMatDisc = new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.06, depthWrite: false });
    this.fanMatEdge = new THREE.MeshBasicMaterial({ color: '#ffe7a0', transparent: true, opacity: 0.16, depthWrite: false });

    this.preview = new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 1), new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.preview.visible = false; this.scene.add(this.preview);
    const ag = new THREE.ConeGeometry(1.5, 3.2, 4); ag.rotateX(Math.PI / 2);
    this.previewArrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: '#ffe27a', transparent: true, opacity: 0.9 }));
    this.previewArrow.visible = false; this.scene.add(this.previewArrow);

    // frame the whole siege: between the castle centre and the (roomier) camp
    this.camTarget.set(LAYOUT.gate.x * 0.5, 0, LAYOUT.D * 0.5 + 48);
    this.camDist = Math.min(330, Math.hypot(LAYOUT.W, LAYOUT.D) * 2.3 + 92); // the great fortresses need the wider frame

    window.addEventListener('resize', this.onResizeBound);
  }

  // The post chain: render (linear HDR) → selective bloom → cinematic grade → screen.
  // Bloom threshold sits ABOVE the lit daytime scene (which tops out near 1) so only
  // the HDR-bright emissives — fires, embers, flaming arrows, the sun disc — actually
  // glow. Runs before the grade's tone-map, in linear, which is where bloom belongs.
  private buildComposer() {
    this.composer = new EffectComposer(this.gl); // default HalfFloat target keeps highlights for the grade
    this.composer.setPixelRatio(this.quality);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // threshold ABOVE bright sunlit surfaces (~1.5-2) so only the explicit HDR
    // emissives — fires (2.6+), embers, shockwaves, the sun disc — bloom
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.9, 0.6, 2.25);
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass(CINEMATIC_GRADE as any);
    this.gradePass.renderToScreen = true;
    // re-tune the grade for the siege's hour (dawn warm-soft, dusk amber, night cool)
    const T = this.todCfg, u = this.gradePass.uniforms as any;
    u.uExposure.value = T.exposure; u.uSat.value = T.sat; u.uBalance.value.set(...T.balance);
    this.composer.addPass(this.gradePass);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  private onResizeBound = () => this.onResize();
  // Full teardown between battles. Without this every battle leaked its entire
  // scene (the anonymous resize closure pinned the Renderer) AND a live WebGL
  // context — enough to crash an iPhone inside one campaign session.
  dispose() {
    window.removeEventListener('resize', this.onResizeBound);
    const seen = new Set<object>();
    this.scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry && !seen.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); }
      const mat = (m as { material?: THREE.Material | THREE.Material[] }).material;
      if (mat) for (const mm of Array.isArray(mat) ? mat : [mat]) {
        if (seen.has(mm)) continue; seen.add(mm);
        const anyM = mm as any;
        for (const k of ['map', 'normalMap', 'alphaMap', 'aoMap', 'emissiveMap']) anyM[k]?.dispose?.();
        mm.dispose();
      }
    });
    (this.composer as any)?.dispose?.();
    (this.bloomPass as any)?.dispose?.();
    (this.gradePass as any)?.dispose?.();
    this.gl.dispose();
    this.gl.forceContextLoss(); // release the context NOW, not when the tab dies
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight; this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.composer?.setSize(window.innerWidth, window.innerHeight);
  }

  // Adaptive resolution: render the 3D buffer at `q`× screen pixels (HUD is DOM,
  // stays crisp). Driven by measured fps so weak devices auto-scale down.
  quality = 1;
  setQuality(q: number) {
    q = Math.max(0.6, Math.min(1, Math.round(q * 100) / 100));
    if (q === this.quality) return;
    this.quality = q; this.gl.setPixelRatio(q); this.gl.setSize(window.innerWidth, window.innerHeight);
    this.composer?.setPixelRatio(q); this.composer?.setSize(window.innerWidth, window.innerHeight);
    if (this.bloomPass) this.bloomPass.enabled = q >= 0.8; // drop the extra blur passes on weak devices
  }

  private buildSky() {
    // dome sized so the fully zoomed-out camera (dist ≤440 + target offset) never exits it
    const R = 1200;
    const geo = new THREE.SphereGeometry(R, 24, 16);
    const top = new THREE.Color(this.biomeCfg.skyTop), bot = new THREE.Color(this.biomeCfg.skyBot);
    const colors: number[] = []; const pos = geo.attributes.position; const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) { const t = Math.max(0, Math.min(1, (pos.getY(i) / R) * 1.4 + 0.25)); c.copy(bot).lerp(top, t); colors.push(c.r, c.g, c.b); }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })));
    if (this.todCfg.stars) { // a field of stars over a night assault (HDR → they twinkle in the bloom)
      const sp: number[] = [];
      for (let i = 0; i < 320; i++) {
        const az = Math.random() * Math.PI * 2, el = 0.12 + Math.random() * 1.4, r2 = 600;
        sp.push(Math.cos(az) * Math.cos(el) * r2, Math.sin(el) * r2, Math.sin(az) * Math.cos(el) * r2);
      }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      const sm = new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false, toneMapped: false });
      sm.color.setRGB(1.9, 1.9, 2.2);
      this.scene.add(new THREE.Points(sg, sm));
    }
  }

  private buildGround() {
    const g = new THREE.PlaneGeometry(960, 960, 110, 110); g.rotateX(-Math.PI / 2);
    { // shape the square sheet into a DISC: corners fold onto the rim circle, which
      // hides under the horizon ring's inner flats — the world edge is one circle now
      const pp = g.attributes.position, RIM = 435;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), z = pp.getZ(i), r = Math.hypot(x, z);
        if (r > RIM) { pp.setX(i, x / r * RIM); pp.setZ(i, z / r * RIM); }
      }
    }
    // NEUTRAL large-scale brightness modulation — soft sunlit/shaded meadow patches that
    // hide the texture tiling, with a faint warm cast. (NOT a second green multiply; that
    // double-darkening is what made the grass read dim and fake.)
    const c = new THREE.Color(); const colors: number[] = []; const pos = g.attributes.position;
    const gxg = LAYOUT.gate.x, Wg = LAYOUT.W, Dg = LAYOUT.D;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      let n = 1.02 + 0.1 * (Math.sin(x * 0.016) * Math.cos(z * 0.019)) + 0.05 * (Math.sin(x * 0.051 + 1.3) * Math.cos(z * 0.044));
      n = Math.max(0.88, Math.min(1.2, n));
      // DRYNESS: broad soft patches drift between lush green and sun-dried tan, so the
      // field reads as real meadow, not one flat green — greener in the hollows, drier
      // (warmer, yellower) on the sunlit rises.
      const dry = 0.5 + 0.4 * Math.sin(x * 0.021 + 2.0) * Math.cos(z * 0.017 - 1.1) + 0.18 * Math.sin(x * 0.06 - 0.4) * Math.sin(z * 0.048 + 1.7);
      const d = Math.max(0, Math.min(1, dry));
      let r = n * (0.92 + 0.18 * d), gch = n * (1.03 - 0.09 * d), b = n * (0.93 - 0.18 * d);
      // CHURN: a siege tears up the earth — a muddy scar hugs the walls and runs up the
      // gate lane where the host masses. Darken + brown the grass there (trampled ground).
      const distWall = Math.max(Math.abs(x) - Wg, Math.abs(z) - Dg);
      const ring = Math.max(0, 1 - Math.max(0, distWall) / 30);
      const lane = (z > Dg - 4 && z < Dg + 96 && Math.abs(x - gxg) < 46) ? Math.max(0, 1 - (z - Dg) / 96) * Math.max(0, 1 - Math.abs(x - gxg) / 46) : 0;
      const churn = Math.min(0.8, Math.max(ring, lane) * (0.5 + 0.5 * Math.sin(x * 0.3) * Math.sin(z * 0.27)) + Math.max(ring, lane) * 0.35);
      r = r * (1 - churn) + 0.66 * churn; gch = gch * (1 - churn) + 0.5 * churn; b = b * (1 - churn) + 0.34 * churn;
      c.setRGB(r, gch, b);
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    // biome grass — only a gentle lift (the somber, desaturated base colour must
    // survive), larger tiles so the repeat reads as meadow rather than a checkerboard
    const warmGround = new THREE.Color(this.biomeCfg.ground).multiplyScalar(1.16).lerp(new THREE.Color('#c2cf94'), this.biomeCfg.sand ? 0 : 0.08);
    const groundTex = this.biomeCfg.sand ? dirtTexture('#d3ba88') : grassTexture('#' + warmGround.getHexString());
    groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping; groundTex.repeat.set(40, 40); groundTex.needsUpdate = true;
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: groundTex, vertexColors: true }));
    ground.position.y = -0.02; ground.receiveShadow = true; this.scene.add(ground);

    // One packed-earth texture drives the road and the castle courtyard so the bare
    // ground reads as trodden earth, not flat tan card. (Generated once — no per-frame cost.)
    const earth = dirtTexture(); earth.wrapS = earth.wrapT = THREE.RepeatWrapping;
    // The COURTYARD: textured earth inside the walls, seated only ~2m past them so the
    // castle no longer sits on a big tan box on the grass (it hugs the base instead).
    const apW = (LAYOUT.W + 2) * 2, apD = (LAYOUT.D + 2) * 2;
    const apronTex = earth.clone(); apronTex.repeat.set(apW / 12, apD / 12); apronTex.needsUpdate = true;
    const apronMat = new THREE.MeshLambertMaterial({ map: apronTex, color: '#b39a72' });
    const blb = LAYOUT.blob;
    if (blb) {
      // the courtyard follows the enceinte's REAL footprint (one quad per blob
      // cell, slightly overgrown) — a bounding-box slab pokes out past angled
      // and notched walls and reads as a tan carpet under the castle
      const quads: THREE.BufferGeometry[] = [];
      for (let gz = 0; gz < blb.gh; gz++) for (let gx = 0; gx < blb.gw; gx++) {
        if (!blb.cells[gz * blb.gw + gx]) continue;
        quads.push(new THREE.PlaneGeometry(blb.cs + 2.4, blb.cs + 2.4).rotateX(-Math.PI / 2)
          .translate(blb.x0 + (gx + 0.5) * blb.cs, 0.005, blb.z0 + (gz + 0.5) * blb.cs));
      }
      if (quads.length) { const apron = new THREE.Mesh(mergeGeometries(quads, false), apronMat); apron.receiveShadow = true; this.scene.add(apron); }
    } else {
      const apron = new THREE.Mesh(new THREE.PlaneGeometry(apW, apD).rotateX(-Math.PI / 2), apronMat);
      apron.position.set(0, 0.005, 0); apron.receiveShadow = true; this.scene.add(apron);
    }
    // a worn approach road from the attacker camp up to the gate — textured ruts, and a
    // soft feathered head/edge (vertex alpha-ish via a darker centre) instead of a hard slab.
    const roadTex = earth.clone(); roadTex.repeat.set(2.0, 18); roadTex.needsUpdate = true;
    const RL = 156, roadGeo = new THREE.PlaneGeometry(1, RL, 2, 28).rotateX(-Math.PI / 2);
    // sculpt a worn dirt TRAIL: gently tapering, wavy edges and feathered ends that fade
    // into the grass via per-vertex alpha — no rigid rectangular slab
    const rp = roadGeo.attributes.position, rcol: number[] = []; const dirt = new THREE.Color('#9c8158');
    for (let i = 0; i < rp.count; i++) {
      const zL = rp.getZ(i) / RL + 0.5;                 // 0..1 along the path
      const edge = Math.sign(rp.getX(i));               // -1 / 0 / +1 (3 columns)
      const halfW = 8.4 - 1.4 * zL + Math.sin(zL * 7 + 0.6) * 1.2;
      rp.setX(i, edge * halfW + Math.sin(zL * 13 + (edge > 0 ? 0 : 2.1)) * 1.0);
      const a = (0.34 + 0.62 * (1 - Math.abs(edge))) * Math.min(1, Math.min(zL, 1 - zL) * 5); // fade sides + both ends
      rcol.push(dirt.r, dirt.g, dirt.b, a);
    }
    roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(rcol, 4));
    const road = new THREE.Mesh(roadGeo, new THREE.MeshLambertMaterial({ map: roadTex, vertexColors: true, transparent: true, depthWrite: false }));
    road.position.set(LAYOUT.gate.x, 0.012, LAYOUT.D + 72); road.renderOrder = 1; this.scene.add(road);
  }

  // A smooth, continuous ring of rolling hills / mountains / dunes around the field
  // so the map edge is real scenery, not fog. Built as one annulus mesh with gentle
  // low-frequency height variation and smooth shading (no jagged faceting), its far
  // rim dissolving into the horizon haze. Coastal castles get an ocean flank (north).
  private buildHorizon() {
    const B = this.biomeCfg;
    const RINGS = 22, SEG = 120, r0 = 385, r1 = 1250; // outer rim meets the sky dome — no bare band of dome below the hills
    const cBase = new THREE.Color(B.hill), cTop = new THREE.Color(B.hillTop), snow = new THREE.Color('#eef2f4'), fog = new THREE.Color(B.fog), groundC = new THREE.Color(B.ground).multiplyScalar(1.18), tmp = new THREE.Color();
    const seaDir = Math.PI, seaHalf = this.coastal ? 1.0 : -1;        // ~57° sea gap to the north
    const arc = (a: number) => { let d = Math.abs(a - seaDir); if (d > Math.PI) d = 2 * Math.PI - d; return d; };
    const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    // rolling height as a function of angle and radial position (sum of low-freq
    // sines → soft ridgelines, never spiky)
    const hAt = (ang: number, t: number) => {
      const rise = smooth(0.03, 0.22, t);                             // low at the field edge, rising soon after — an enclosing bowl of hills
      // INTEGER angular frequencies so the ridge wraps seamlessly (ang=0 ≡ ang=2π) —
      // non-integers tore a visible gap at the closing seam
      let n = Math.sin(ang * 3 + 1.3) * 0.5 + Math.sin(ang * 5 + 4.1) * 0.28 + Math.sin(ang * 9 + 2.0) * 0.16;
      n = 0.5 + 0.5 * (n * 0.5 + 0.5);                                // [0.5,1]
      n *= 0.82 + 0.32 * Math.sin(ang * 2 + t * 3.2);                 // slow swell so ridge depth varies
      // snow peaks get a sharper, taller profile so the range towers; rolling hills stay gentle
      if (B.snow) n = Math.pow(n, 0.55) * (0.9 + 0.5 * Math.max(0, Math.sin(ang * 4 + 0.7)));
      let h = B.hillH * rise * n * (B.dune ? 0.62 : 1);
      if (this.coastal) h *= smooth(seaHalf - 0.05, seaHalf + 0.45, arc(ang)); // drop to sea level on the coast flank
      return h;
    };
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    for (let ri = 0; ri <= RINGS; ri++) {
      const t = ri / RINGS, rad = r0 + (r1 - r0) * t;
      for (let si = 0; si <= SEG; si++) {
        const ang = (si / SEG) * Math.PI * 2, y = hAt(ang, t);
        pos.push(Math.sin(ang) * rad, y, Math.cos(ang) * rad);
        const frac = Math.max(0, Math.min(1, y / (B.hillH * 0.8)));
        tmp.copy(cBase).lerp(cTop, frac * 0.85);
        if (B.snow && frac > 0.42) tmp.lerp(snow, smooth(0.42, 0.9, frac));
        tmp.lerp(groundC, Math.max(0, 1 - frac * 2.4) * 0.82);       // hill feet all but ARE the field colour (kills the tan circle at the seam)
        tmp.lerp(fog, Math.pow(t, 2.4) * (B.snow ? 0.55 : 0.9));      // far rim melts into the haze (peaks keep their snow)
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let ri = 0; ri < RINGS; ri++) for (let si = 0; si < SEG; si++) {
      const a = ri * (SEG + 1) + si, b = a + 1, c = a + (SEG + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })));
    if (this.coastal) this.buildOcean();
  }

  private buildOcean() {
    const beach = new THREE.Mesh(new THREE.PlaneGeometry(2400, 96).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#cdbd92' }));
    beach.position.set(0, 0.03, -188); beach.receiveShadow = true; this.scene.add(beach);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(2400, 1500).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#2f6188' })); // reaches past the hills/fog — no floating rectangle edge at full zoom
    sea.position.set(0, 0.13, -970); this.scene.add(sea); // near edge stays on the coast at z=-220; the rest runs out past the fog
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
    const SEGC = 4; // fallback half-length for oriented chunks

    // Per-castle STONE + ROOF palette, chosen deterministically from the layout so no
    // two neighbouring strongholds read the same: grey granite, warm sandstone, pale
    // limestone, reddish stone — with slate / terracotta / lead roofs to match.
    const ph = Math.abs((LAYOUT.W * 131 + LAYOUT.D * 71 + LAYOUT.towers.length * 997 + Math.round(LAYOUT.gate.x * 37)) | 0);
    const STONE_TINT = ['#ffffff', '#cdd4d0', '#f2e2bc', '#e6c6a0', '#ece7d8', '#d6ccb4', '#c8ccc6'];
    // Weathered clay/slate/lead — the terracottas pulled back from fire-engine red
    // toward aged, sun-baked tile so the frame stops reading candy-bright.
    const ROOFS = ['#9d5a3e', '#7f838a', '#875039', '#8c9488', '#95563a', '#6d5340'];
    const stoneTint = new THREE.Color(STONE_TINT[ph % STONE_TINT.length]);
    const roofHex = LAYOUT.palisade ? '#7a4a26' : ROOFS[(ph >> 3) % ROOFS.length];
    const coneRoofTex = this.texRoof.clone(); coneRoofTex.wrapS = coneRoofTex.wrapT = THREE.RepeatWrapping; coneRoofTex.repeat.set(5, 3); coneRoofTex.needsUpdate = true;
    const roofMat = this.stone(roofHex); roofMat.map = coneRoofTex;
    // Per-tower roof variation: a small deterministic HSL jitter off the base so a
    // castle's roofscape reads like weathered tile — sun-bleached and patchy, some
    // paler, some deeper — instead of one flat monochrome red. Each cone is already
    // its own draw call, so the material clone is free (the texture map is shared).
    const roofFor = (seed: number) => {
      const m = roofMat.clone();
      m.color.offsetHSL((jit(seed, 21) - 0.5) * 0.05, (jit(seed, 22) - 0.5) * 0.14, (jit(seed, 23) - 0.5) * 0.16);
      return m;
    };
    const timber = this.stone('#7a4f2c');
    const tintStone = (m: THREE.MeshLambertMaterial) => { if (!LAYOUT.palisade) m.color.multiply(stoneTint); return m; };
    const stoneCol = (hex: string) => new THREE.Color(hex);
    // STATIC batches (buildings + keep never crumble) — merged into a few meshes
    const bodyGeos: THREE.BufferGeometry[] = [], houseRoofGeos: THREE.BufferGeometry[] = [];
    const doorGeos: THREE.BufferGeometry[] = [], keepStoneGeos: THREE.BufferGeometry[] = [], keepTimberGeos: THREE.BufferGeometry[] = [];

    for (let s = 0; s < CASTLE.length; s++) {
      const b = CASTLE[s];
      const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const extras: THREE.Object3D[] = [];

      if (b.kind === 'gate' && b.h <= 3) {
        // a street BARRICADE: rough planks + stakes, not a miniature gatehouse
        const horiz = w > d, len = horiz ? w : d;
        const parts: THREE.BufferGeometry[] = [this.boxG(w, b.h * 0.82, d, 0, b.h * 0.41, 0)];
        const nst = Math.max(3, Math.round(len / 1.6));
        for (let k = 0; k < nst; k++) {
          const t2 = (k + 0.5) / nst - 0.5;
          parts.push(this.boxG(0.22, b.h + 0.9 + jit(s * 31 + k, 3) * 0.5, 0.22, horiz ? t2 * len : (jit(k, 4) - 0.5) * d * 0.6, (b.h + 0.9) / 2, horiz ? (jit(k, 5) - 0.5) * d * 0.6 : t2 * len));
        }
        const mat = this.stone('#6b4b28');
        const box = new THREE.Mesh(mergeGeometries(parts, false), mat);
        box.position.set(cx, 0, cz); box.castShadow = box.receiveShadow = true; this.scene.add(box);
        this.segVis[s] = { box, mat, base: mat.color.clone(), extras, h: b.h, maxhp: b.maxhp, prevHp: b.hp, crumbling: 0 };
      } else if (b.kind === 'wall' || b.kind === 'gate') {
        // Build in a LOCAL frame — length along x, thickness along z — then spin
        // the merged geometry to the seg's angle. Axis walls use angle 0/90; an
        // ORIENTED chunk (hand-drawn diagonal curtain) uses its true bearing, so
        // the stone runs straight between the points the designer set.
        const oriented = b.ang !== undefined;
        const horiz = oriented ? true : w > d;
        const len = oriented ? (b.olen ?? SEGC) * 2 : (horiz ? w : d);
        const thick = oriented ? 4 : (horiz ? d : w);
        const segAng = oriented ? b.ang! : (horiz ? 0 : Math.PI / 2);
        const outer = b.out ?? ((w > d ? Math.sign(cz) : Math.sign(cx)) || 1);
        const gh = b.kind === 'gate' && b.h > 3 && !LAYOUT.palisade; // a wooden town gets timber doors, not a stone gatehouse
        const parts: THREE.BufferGeometry[] = [this.boxG(len, b.h, thick, 0, b.h / 2, 0)];
        parts.push(this.boxG(len, 0.5, thick - 0.8, 0, b.h + 0.25, 0)); // walkway
        const n = Math.floor(len / 1.7);
        for (let k = 0; k <= n; k++) {
          if (k % 2) continue;
          parts.push(this.boxG(1.0, 1.7, 0.7, -len / 2 + 0.85 + k * 1.7, b.h + 0.85, outer * (thick / 2 - 0.35)));
        }
        if (b.kind === 'wall') parts.push(this.boxG(len, 0.7, 0.5, 0, b.h + 0.35, -outer * (thick / 2 - 0.25))); // inner rail
        if (gh) { // A GATEHOUSE, not a wall with a hole: flanking jambs risen past the parapet
          for (const jx of [-len / 2 + 1.1, len / 2 - 1.1]) {
            parts.push(this.boxG(2.2, b.h + 3.2, thick + 2.6, jx, (b.h + 3.2) / 2, 0));
            parts.push(this.boxG(2.8, 0.9, thick + 3.2, jx, b.h + 3.6, 0)); // capstones
          }
          parts.push(this.boxG(len - 4, 1.1, thick + 1.2, 0, b.h + 1.0, 0)); // machicolation lip over the arch
        }
        const wood = LAYOUT.palisade; // a town's walls are timber, not dressed stone
        const mat = !wood ? tintStone(this.stone(b.kind === 'gate' ? '#cdb892' : '#e6d6af')) : this.stone(b.kind === 'gate' ? '#6e4a28' : '#8a5a31');
        if (!wood) { mat.map = this.texStone; mat.normalMap = this.texStoneN; mat.normalScale.set(0.8, 0.8); }
        const merged = mergeGeometries(parts, false);
        if (segAng) merged.rotateY(-segAng);
        const box = new THREE.Mesh(merged, mat);
        box.position.set(cx, 0, cz); box.castShadow = box.receiveShadow = true; this.scene.add(box);
        if (gh) { // the dark heart of the gate: recessed arch + portcullis grate
          const dark = this.stone(wood ? '#3a2614' : '#241a10');
          const gp: THREE.BufferGeometry[] = [];
          const aw = Math.min(len - 6, 9), ah = Math.min(b.h - 1.5, 6.5);
          for (const zc of [thick / 2 + 0.12, -thick / 2 - 0.12]) {
            gp.push(this.boxG(aw, ah, 0.3, 0, ah / 2, zc));                       // arch shadow panel
            gp.push(this.boxG(aw * 0.72, aw * 0.36, 0.3, 0, ah + aw * 0.1, zc));  // rounded head hint
          }
          for (let gk = -2; gk <= 2; gk++) gp.push(this.boxG(0.32, ah - 0.4, 0.32, gk * (aw / 5.4), (ah - 0.4) / 2, outer * (thick / 2 + 0.34))); // portcullis bars
          for (let gy = 1; gy <= 2; gy++) gp.push(this.boxG(aw * 0.8, 0.3, 0.3, 0, ah * gy / 3, outer * (thick / 2 + 0.36)));
          const gm = mergeGeometries(gp, false);
          if (segAng) gm.rotateY(-segAng);
          const gmesh = new THREE.Mesh(gm, dark); gmesh.position.set(cx, 0, cz); this.scene.add(gmesh); extras.push(gmesh);
        }
        if (b.kind === 'gate' && b.h > 3 && !gh) this.addGateDoors(extras, cx, cz, w, d, b.h, w > d, outer, true); // palisade gate doors
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
        const mat = tintStone(this.stone('#dfcca2')); mat.map = this.texStone; mat.normalMap = this.texStoneN; mat.normalScale.set(0.8, 0.8);
        const box = new THREE.Mesh(mergeGeometries(parts, false), mat);
        box.position.set(cx, 0, cz); box.castShadow = box.receiveShadow = true; this.scene.add(box);
        // roof + pole + flag stay separate (different materials) and hide on crumble
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * (round ? 0.74 : 0.82), round ? 7.5 : 6.5, round ? 14 : 12), roofFor(s));
        roof.rotation.y = Math.PI / 4; roof.position.set(cx, b.h + 3.7, cz); roof.castShadow = true; this.scene.add(roof); extras.push(roof);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4), timber); pole.position.set(cx, b.h + 7, cz); this.scene.add(pole); extras.push(pole);
        const flag = this.makeBanner(cx + 0.18, b.h + 8.4, cz, 2.6, 1.5, COL_DEFEND); this.scene.add(flag); extras.push(flag);
        this.segVis[s] = { box, mat, base: mat.color.clone(), extras, h: b.h, maxhp: b.maxhp, prevHp: b.hp, crumbling: 0 };
      } else if (b.kind === 'keep') {
        keepStoneGeos.push(this.boxG(w, b.h, d, cx, b.h / 2, cz), this.boxG(w - 5, 5, d - 5, cx, b.h + 2.5, cz));
        for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; keepStoneGeos.push(this.boxG(w, 1.4, 1, cx + Math.sin(a) * (d / 2), b.h + 0.7, cz + Math.cos(a) * (d / 2), a)); }
        const roof = new THREE.Mesh(new THREE.ConeGeometry((w - 5) * 0.8, 9, 14), roofFor(s)); roof.position.set(cx, b.h + 9.5, cz); roof.castShadow = true; this.scene.add(roof);
        keepTimberGeos.push(this.boxG(2.6, 4, 0.4, cx, 2, b.z1));
        for (const [wx, wy] of [[-3, 8], [3, 8], [-3, 13], [3, 13]] as const) keepTimberGeos.push(this.boxG(1, 1.6, 0.3, cx + wx, wy, b.z1));
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6), timber); pole.position.set(cx, b.h + 15, cz); pole.castShadow = true; this.scene.add(pole);
        const flag = this.makeBanner(cx + 0.26, b.h + 16.4, cz, 4.2, 2.5, COL_DEFEND); this.scene.add(flag);
        this.keepFlag = flag; this.keepTop = { x: cx, y: b.h + 16.4, z: cz }; // the banner that falls on victory
      } else if (b.kind === 'building') {
        this.houses.push({ x: cx, z: cz, h: b.h }); // ignition candidates for the burning-town pass
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

    // ---- BATTERED BASE + ARROW SLITS: the real-castle detailing ----
    // A tumble of embedded boulders forms a battered plinth at every wall/tower
    // foot (so the curtain grows OUT of the ground, not sits on it like a box), and
    // narrow loopholes are cut down the tower drums + wall faces for the archers.
    {
      const rnd = (a: number, b: number) => a + Math.random() * (b - a);
      const boulderG: THREE.BufferGeometry[] = [], slitG: THREE.BufferGeometry[] = [];
      const boulder = (r: number, x: number, y: number, z: number) => {
        // IcosahedronGeometry is NON-INDEXED (verts duplicated per face) and its
        // subdivision computes shared edge midpoints per-face, so displacing the
        // raw geometry can still tear hairline gaps between triangles. WELD it
        // into an indexed mesh first — shared vertices become literally the same
        // vertex — then displace freely: an indexed mesh cannot split at a seam.
        // (strip normals/uvs first — mergeVertices only welds verts whose EVERY
        // attribute matches, and the per-face normals would defeat the weld)
        const raw = new THREE.IcosahedronGeometry(r, 1); raw.deleteAttribute('normal'); raw.deleteAttribute('uv');
        const g = mergeVertices(raw, 1e-3), p = g.attributes.position;
        const seed = x * 7.13 + z * 3.71;
        const h = (i: number, k: number) => { const v = Math.sin(i * 12.9898 + seed + k * 53.7) * 43758.5453; return (v - Math.floor(v)) - 0.5; };
        for (let i = 0; i < p.count; i++)
          p.setXYZ(i, p.getX(i) * (1 + h(i, 1) * 0.24), p.getY(i) * (1 + h(i, 2) * 0.2), p.getZ(i) * (1 + h(i, 3) * 0.24));
        g.scale(1, 0.58, 1); g.rotateY((seed * 977) % 3.14); g.translate(x, y, z); g.computeVertexNormals();
        // warm weathered stone, tuned to the game's sandstone and never brighter than base
        this.paint(g, new THREE.Color('#968870').multiplyScalar(0.6 + Math.random() * 0.28));
        return g;
      };
      // keep the approach to every gate clear — no stones for the ram or the host to trip on
      const gates = CASTLE.filter(b => b.kind === 'gate').map(b => ({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, r: Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2 + 7 }));
      const nearGate = (px: number, pz: number) => gates.some(g2 => (px - g2.x) * (px - g2.x) + (pz - g2.z) * (pz - g2.z) < g2.r * g2.r);
      const pushBoulder = (r: number, px: number, py: number, pz: number) => { if (!nearGate(px, pz)) boulderG.push(boulder(r, px, py, pz)); };
      for (let s = 0; s < CASTLE.length; s++) {
        const b = CASTLE[s]; if (b.kind === 'building' || b.kind === 'keep') continue;
        const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
        if (b.kind === 'tower') {
          const r = Math.max(w, d) / 2, nb = 12 + Math.floor(r * 1.6);
          // two overlapping rings hugging the foot → a continuous embedded skirt
          for (let k = 0; k < nb; k++) { const a = Math.random() * 6.283, rr = r * rnd(0.9, 1.02); pushBoulder(rnd(1.3, 2.5), cx + Math.cos(a) * rr, rnd(-0.55, -0.05), cz + Math.sin(a) * rr); }
          for (let k = 0; k < nb * 0.7; k++) { const a = Math.random() * 6.283, rr = r * rnd(1.0, 1.32); pushBoulder(rnd(0.6, 1.4), cx + Math.cos(a) * rr, rnd(-0.4, 0.05), cz + Math.sin(a) * rr); }
          for (let k = 0; k < 4; k++) { const a = k / 4 * 6.283 + 0.5, sx = cx + Math.cos(a) * (r + 0.05), sz = cz + Math.sin(a) * (r + 0.05); slitG.push(new THREE.BoxGeometry(0.34, 2.3, 0.34).translate(sx, b.h * 0.55, sz)); }
        } else if (b.kind === 'wall') { // no stones at all under a gate — the approach stays clear
          const horiz = w > d, len = horiz ? w : d, outer = b.out ?? ((horiz ? Math.sign(cz) : Math.sign(cx)) || 1);
          const nb = Math.max(5, Math.round(len / 4));
          for (let k = 0; k < nb; k++) {
            const tv = (k + 0.5) / nb - 0.5, big = Math.random() < 0.5;
            const off = big ? rnd(0.2, 1.0) : rnd(1.0, 2.4); // big stones hug the foot, smaller ones tumble out
            const px = horiz ? cx + tv * len + rnd(-2, 2) : cx + outer * (w / 2 + off);
            const pz = horiz ? cz + outer * (d / 2 + off) : cz + tv * len + rnd(-2, 2);
            pushBoulder(big ? rnd(1.4, 2.8) : rnd(0.7, 1.5), px, big ? rnd(-0.55, -0.05) : rnd(-0.35, 0.1), pz);
          }
          if (b.kind === 'wall') { // loopholes on the outer face (skip gates)
            const ns = Math.max(1, Math.round(len / 16));
            for (let k = 0; k < ns; k++) {
              const tv = (k + 0.5) / ns - 0.5;
              const sx = horiz ? cx + tv * len : cx + outer * (w / 2 + 0.05);
              const sz = horiz ? cz + outer * (d / 2 + 0.05) : cz + tv * len;
              slitG.push(new THREE.BoxGeometry(horiz ? 0.42 : 0.3, 2.2, horiz ? 0.3 : 0.42).translate(sx, b.h * 0.52, sz));
            }
          }
        }
      }
      if (boulderG.length) { const m = new THREE.Mesh(mergeGeometries(boulderG, false), new THREE.MeshLambertMaterial({ vertexColors: true })); m.castShadow = m.receiveShadow = true; this.scene.add(m); }
      if (slitG.length) this.scene.add(new THREE.Mesh(mergeGeometries(slitG, false), this.stone('#171310')));
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
    if (keepStoneGeos.length) { const km = tintStone(this.stone('#d6c499')); km.map = this.texStone; km.normalMap = this.texStoneN; km.normalScale.set(0.8, 0.8); const m = new THREE.Mesh(mergeGeometries(keepStoneGeos, false), km); m.castShadow = m.receiveShadow = true; this.scene.add(m); }
    if (keepTimberGeos.length) this.scene.add(new THREE.Mesh(mergeGeometries(keepTimberGeos, false), timber));
  }

  private buildTrees() {
    const W = LAYOUT.W, D = LAYOUT.D, gx = LAYOUT.gate.x;
    // rejection-sample positions: outside the castle, clear of the south army lane
    const pts: [number, number, number][] = [];
    // a hand-authored castle plants ITS OWN trees, exactly where the designer put them
    if (DOC_DECO?.trees?.length) for (const [tx, tz] of DOC_DECO.trees) pts.push([tx, tz, 0.8 + Math.random() * 0.7]);
    let guard = 0;
    const treeN = pts.length ? 0 : this.biomeCfg.sand ? 8 : 40; // deserts are near-barren
    while (pts.length < treeN && guard++ < 2000) {
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
    const col = new THREE.Color(), treeBase = new THREE.Color(this.biomeCfg.tree);
    for (let i = 0; i < n; i++) {
      const [x, z, sc] = pts[i];
      this.dummy.position.set(x, 2.2 * sc, z); this.dummy.rotation.set(0, Math.random() * 6, 0); this.dummy.scale.set(sc, sc, sc);
      this.dummy.updateMatrix(); trunk.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(x, (4.4 + Math.random() * 0.8) * sc, z); this.dummy.rotation.set(0, Math.random() * 6, 0);
      this.dummy.scale.set(sc * (0.9 + Math.random() * 0.35), sc * (0.95 + Math.random() * 0.45), sc * (0.9 + Math.random() * 0.35));
      this.dummy.updateMatrix(); canopy.setMatrixAt(i, this.dummy.matrix);
      // foliage tinted to the biome (olive in the south, deep conifer in the Alps),
      // with an occasional warm/autumn crown — rare in the arid south
      const g = 0.78 + Math.random() * 0.4, warm = Math.random() < (this.biomeCfg.sand ? 0.06 : 0.2);
      if (warm) col.setRGB(0.46 * g, 0.4 * g, 0.16 * g); else col.copy(treeBase).multiplyScalar(g);
      canopy.setColorAt(i, col);
    }
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(1, 1, 1); this.dummy.rotation.set(0, 0, 0);
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    this.scene.add(trunk); this.scene.add(canopy);
  }

  // The besieging camp: this is a SIEGE, not an empty lawn. Behind the deploy line
  // sit the attacker's tents and cook-fires; nearer the walls, gabions and sharpened
  // stakes of the siege works. Everything static & merged by material (no frame cost).
  // Evenly-spaced points around an OFFSET of the castle footprint: a rounded
  // rectangle (edges pushed out by `g`, quarter-circle corners of radius `g`),
  // then perturbed outward by a smooth wobble so the siege line reads as an
  // irregular, hand-dug work that follows the walls at a constant gap. Each node
  // carries its outward normal (nx,nz) and bearing-from-centre (ang).
  private siegeRingNodes(ccx: number, ccz: number, hx: number, hz: number, g: number): { x: number; z: number; nx: number; nz: number; ang: number }[] {
    if (DOC_DECO?.works && DOC_DECO.works.length >= 3) {
      // the designer drew the siege line — sample their polygon at the same pitch
      const pts = DOC_DECO.works;
      let cx2 = 0, cz2 = 0; for (const p of pts) { cx2 += p[0]; cz2 += p[1]; } cx2 /= pts.length; cz2 /= pts.length;
      const out: { x: number; z: number; nx: number; nz: number; ang: number }[] = [];
      let per = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; per += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      const N = Math.max(24, Math.round(per / 9));
      let acc = 0, e = 0, into = 0;
      for (let k = 0; k < N; k++) {
        const target = k * per / N;
        while (true) {
          const a = pts[e], b = pts[(e + 1) % pts.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (acc + len >= target || e >= pts.length - 1) { into = (target - acc) / Math.max(1e-6, len); break; }
          acc += len; e = (e + 1) % pts.length;
        }
        const a = pts[e], b = pts[(e + 1) % pts.length];
        const x = a[0] + (b[0] - a[0]) * into, z = a[1] + (b[1] - a[1]) * into;
        let nx = -(b[1] - a[1]), nz = b[0] - a[0]; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
        if ((x - cx2) * nx + (z - cz2) * nz < 0) { nx = -nx; nz = -nz; }  // outward = away from the ring's heart
        out.push({ x, z, nx, nz, ang: Math.atan2(x - cx2, z - cz2) });
      }
      return out;
    }
    type Piece = { straight: boolean; x0: number; z0: number; x1: number; z1: number; nx: number; nz: number; cx: number; cz: number; a0: number; a1: number; len: number };
    const S = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number): Piece =>
      ({ straight: true, x0, z0, x1, z1, nx, nz, cx: 0, cz: 0, a0: 0, a1: 0, len: Math.hypot(x1 - x0, z1 - z0) });
    const A = (cx: number, cz: number, a0: number, a1: number): Piece =>
      ({ straight: false, x0: 0, z0: 0, x1: 0, z1: 0, nx: 0, nz: 0, cx, cz, a0, a1, len: Math.abs(a1 - a0) * g });
    const pieces: Piece[] = [
      S(-hx, -(hz + g), hx, -(hz + g), 0, -1),          // top edge
      A(hx, -hz, -Math.PI / 2, 0),                       // TR corner
      S(hx + g, -hz, hx + g, hz, 1, 0),                  // right edge
      A(hx, hz, 0, Math.PI / 2),                         // BR corner
      S(hx, hz + g, -hx, hz + g, 0, 1),                  // bottom edge
      A(-hx, hz, Math.PI / 2, Math.PI),                  // BL corner
      S(-(hx + g), hz, -(hx + g), -hz, -1, 0),           // left edge
      A(-hx, -hz, Math.PI, Math.PI * 1.5),               // TL corner
    ];
    let P = 0; for (const p of pieces) P += p.len;
    const N = Math.max(28, Math.round(P / 9));
    const out: { x: number; z: number; nx: number; nz: number; ang: number }[] = [];
    for (let k = 0; k < N; k++) {
      let sp = k * P / N, pi = 0;
      while (pi < pieces.length - 1 && sp > pieces[pi].len) { sp -= pieces[pi].len; pi++; }
      const p = pieces[pi]; let x: number, z: number, nx: number, nz: number;
      if (p.straight) { const f = p.len ? sp / p.len : 0; x = p.x0 + (p.x1 - p.x0) * f; z = p.z0 + (p.z1 - p.z0) * f; nx = p.nx; nz = p.nz; }
      else { const a = p.a0 + (p.a1 - p.a0) * (p.len ? sp / p.len : 0); nx = Math.cos(a); nz = Math.sin(a); x = p.cx + nx * g; z = p.cz + nz * g; }
      const j = Math.sin(k * 0.6) * 4 + Math.sin(k * 0.17 + 1.3) * 3 + (Math.random() - 0.5) * 3; // smooth irregular wobble
      x += nx * j; z += nz * j;
      out.push({ x: ccx + x, z: ccz + z, nx, nz, ang: Math.atan2(x, z) });
    }
    return out;
  }

  // Sweep a smooth cross-section along a run of ring nodes into ONE continuous
  // ribbon: `profile` = [lateralOffset, height, colour] (lateral + = away from the
  // castle). Ends taper into the turf, the whole section snakes gently side to
  // side and the crest height undulates — so the work reads as one fluent,
  // hand-raised earthwork rather than a row of blocks.
  private sweepRibbon(run: { x: number; z: number; nx: number; nz: number }[],
    profile: [number, number, THREE.Color][], snakeAmp = 0, taper = true): THREE.BufferGeometry | null {
    if (run.length < 3) return null;
    const P = profile.length, pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i < run.length; i++) {
      const nd = run[i];
      const endT = taper ? Math.min(1, Math.min(i, run.length - 1 - i) / 2.6) : 1;
      const hS = (0.86 + 0.2 * Math.sin(i * 0.83) * Math.sin(i * 0.31 + 2)) * (0.05 + 0.95 * endT);
      const sn = snakeAmp ? Math.sin(i * 0.52) * snakeAmp + Math.sin(i * 0.19 + 1.3) * snakeAmp * 0.7 : 0;
      for (let p = 0; p < P; p++) {
        const [off, h, c] = profile[p];
        pos.push(nd.x + nd.nx * (off + sn), Math.max(0.02, h * hS), nd.z + nd.nz * (off + sn));
        col.push(c.r, c.g, c.b); uv.push(p / (P - 1), i * 0.35);
      }
    }
    for (let i = 0; i < run.length - 1; i++) for (let p = 0; p < P - 1; p++) {
      const a = i * P + p, b = (i + 1) * P + p;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  private buildSiegeCamp() {
    const gx = LAYOUT.gate.x, F = LAYOUT.front;
    const maxZ = WORLD.maxZ - 10, minX = WORLD.minX + 12, maxX = WORLD.maxX - 12;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const chance = (p: number) => Math.random() < p;
    // geometry buckets, one merged mesh per material
    const cloth: THREE.BufferGeometry[] = [], poles: THREE.BufferGeometry[] = [], pavilion: THREE.BufferGeometry[] = [],
      ring: THREE.BufferGeometry[] = [], logs: THREE.BufferGeometry[] = [], wicker: THREE.BufferGeometry[] = [],
      stakes: THREE.BufferGeometry[] = [], planks: THREE.BufferGeometry[] = [], earth: THREE.BufferGeometry[] = [],
      crates: THREE.BufferGeometry[] = [], barrels: THREE.BufferGeometry[] = [], sacks: THREE.BufferGeometry[] = [],
      hay: THREE.BufferGeometry[] = [], cart: THREE.BufferGeometry[] = [], banner: THREE.BufferGeometry[] = [],
      flag: THREE.BufferGeometry[] = [], rock: THREE.BufferGeometry[] = [], trenchG: THREE.BufferGeometry[] = [],
      rubbleG: THREE.BufferGeometry[] = [], worksG: THREE.BufferGeometry[] = [], apronG: THREE.BufferGeometry[] = [],
      arrowG: THREE.BufferGeometry[] = [], fletchG: THREE.BufferGeometry[] = [], wreckG: THREE.BufferGeometry[] = [],
      scorchG: THREE.BufferGeometry[] = [];

    // ----- primitives -----
    const tent = (cx: number, cz: number, big = false) => {
      const h = big ? rnd(5.2, 6.2) : rnd(3.2, 4.4), rad = big ? rnd(4.2, 5.2) : rnd(2.4, 3.3);
      (big ? pavilion : cloth).push(new THREE.ConeGeometry(rad, h, big ? 9 : 7).translate(cx, h / 2, cz));
      poles.push(new THREE.CylinderGeometry(0.09, 0.09, h + 1.2, 5).translate(cx, (h + 1.2) / 2, cz));
      if (big) { // pennant on the command pavilion
        banner.push(new THREE.CylinderGeometry(0.07, 0.07, h + 4, 5).translate(cx, (h + 4) / 2, cz));
        flag.push(this.boxG(2.2, 1.1, 0.12, cx + 1.1, h + 2.8, cz));
      }
    };
    const cookfire = (fx: number, fz: number, smoke = true) => {
      for (let s = 0; s < 6; s++) { const a = s / 6 * 6.28; ring.push(new THREE.BoxGeometry(0.7, 0.5, 0.7).translate(fx + Math.cos(a) * 1.3, 0.24, fz + Math.sin(a) * 1.3)); }
      logs.push(new THREE.CylinderGeometry(0.16, 0.16, 2.0, 5).rotateZ(1.2).translate(fx, 0.4, fz), new THREE.CylinderGeometry(0.16, 0.16, 2.0, 5).rotateZ(-1.1).rotateY(1).translate(fx, 0.4, fz));
      if (smoke) this.smokeSources.push({ x: fx, y: 0.6, z: fz, s: 2.3, rate: 0.5, dark: 0.42, t: Math.random() * 0.5 });
    };
    const dump = (bx: number, bz: number) => { // a supply dump: stacked crates, barrels, sacks, hay
      for (let s = 0; s < 3 + Math.floor(Math.random() * 4); s++) {
        const ox = rnd(-3, 3), oz = rnd(-3, 3), pick = Math.random();
        if (pick < 0.4) crates.push(this.boxG(rnd(1, 1.6), rnd(0.9, 1.4), rnd(1, 1.6), bx + ox, 0.6, bz + oz, rnd(0, 0.7)));
        else if (pick < 0.68) barrels.push(new THREE.CylinderGeometry(0.62, 0.62, 1.35, 8).translate(bx + ox, 0.68, bz + oz));
        else if (pick < 0.86) sacks.push(new THREE.SphereGeometry(0.62, 6, 5).scale(1, 0.7, 1).translate(bx + ox, 0.42, bz + oz));
        else hay.push(new THREE.CylinderGeometry(0.8, 0.8, 1.7, 8).rotateZ(1.5708).translate(bx + ox, 0.8, bz + oz));
      }
      if (chance(0.5)) barrels.push(new THREE.CylinderGeometry(0.62, 0.62, 1.35, 8).translate(bx + rnd(-3, 3), 1.9, bz + rnd(-1, 1))); // one stacked on top
    };
    const wagon = (cx: number, cz: number, ry: number) => {
      cart.push(this.boxG(4.0, 0.7, 2.0, cx, 1.15, cz, ry));                  // bed
      for (const s of [-1, 1]) {                                             // two solid side boards
        const off = 0.95 * s;
        cart.push(this.boxG(4.0, 1.0, 0.22, cx + Math.sin(ry) * off, 1.75, cz + Math.cos(ry) * off, ry));
      }
      cart.push(this.boxG(0.22, 1.0, 2.0, cx + Math.cos(ry) * 2.0, 1.75, cz + Math.sin(ry) * 2.0, ry)); // front board
      for (const sx of [-1.5, 1.5]) for (const sz of [-1.0, 1.0]) {          // 4 wheels
        const wx = cx + Math.cos(ry) * sx - Math.sin(ry) * sz, wz = cz + Math.sin(ry) * sx + Math.cos(ry) * sz;
        cart.push(new THREE.CylinderGeometry(0.72, 0.72, 0.24, 9).rotateZ(1.5708).rotateY(ry).translate(wx, 0.72, wz));
      }
    };
    // A ground stain that reads as churned/scorched earth, NOT a stamped circle: an
    // irregular lobed outline, and — crucially — a radial ALPHA falloff (opaque core →
    // transparent rim) baked into vertex colours, so every patch feathers softly into
    // the surrounding grass instead of cutting a hard disc. RGB stays white so the
    // decal material's colour/texture shows through; alpha carries the blend. World-UV
    // keeps the dirt texture tiling continuously beneath the merged patches.
    const flatE = (r1: number, r2: number, x: number, z: number, ry: number, y = 0.035) => {
      const SEG = 20, ph = Math.sin(x * 12.9 + z * 7.3) * 6.283, cr = Math.cos(ry), sr = Math.sin(ry);
      const verts: number[] = [x, y, z], cols: number[] = [1, 1, 1, 0.9], uvs: number[] = [x * 0.05, z * 0.05], idx: number[] = [];
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        // layered lobes → an organic, non-circular rim (never the same twice)
        const lobe = 0.64 + 0.2 * Math.sin(a * 3 + ph) + 0.12 * Math.sin(a * 5 + ph * 1.7 + 1.1) + 0.09 * Math.sin(a * 2 - ph * 0.7);
        const lx = Math.cos(a) * r1 * lobe, lz = Math.sin(a) * r2 * lobe;
        const wx = x + lx * cr - lz * sr, wz = z + lx * sr + lz * cr;
        verts.push(wx, y, wz); cols.push(1, 1, 1, 0); uvs.push(wx * 0.05, wz * 0.05); // rim alpha 0 → fades out
      }
      for (let k = 0; k < SEG; k++) idx.push(0, 1 + k, 1 + ((k + 1) % SEG));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(verts.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(idx);
      return g;
    };
    // a smooth half-buried spoil mound (dug earth is rounded, never boxy)
    const mound = (r: number, x: number, z: number, squash = 0.55) =>
      new THREE.SphereGeometry(r, 7, 5).scale(1, squash, 1).translate(x, r * 0.16, z);

    // ---- THE INVESTMENT: siege lines encircling the WHOLE castle ----
    // The line traces an offset of the castle's own footprint (a jittered rounded
    // rectangle), so it follows the shape and keeps a constant gap all the way
    // around — gabions front the wall, a zig-zag fire trench runs behind them, and
    // churned earth/rubble fills the gap. One break on the gate side for the assault.
    let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
    for (const b of CASTLE) { if (b.kind === 'building') continue; bx0 = Math.min(bx0, b.x0); bx1 = Math.max(bx1, b.x1); bz0 = Math.min(bz0, b.z0); bz1 = Math.max(bz1, b.z1); }
    const ccx = (bx0 + bx1) / 2, ccz = (bz0 + bz1) / 2;
    const hx = (bx1 - bx0) / 2, hz = (bz1 - bz0) / 2, castleR = Math.max(hx, hz);
    const gap = 30;                                                            // clear gap from the wall to the works
    const nodes = this.siegeRingNodes(ccx, ccz, hx, hz, gap);
    const ga = Math.atan2(gx - ccx, F - ccz);                                  // bearing to the gate (assault gap)
    const gateOpen = (a: number) => Math.abs(((a - ga + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.5;

    // ---- THE CONTINUOUS EARTHWORK: one swept ribbon per run of the ring ----
    // Cross-section (castle side → rear): churned foot, the raised fighting parapet,
    // a dip, then the dark fire trench between two soft lips. Vertex colours carry
    // the earth tones so the whole work is a single smooth mesh — no boxes —
    // snaking gently and undulating in height as it goes.
    const C_FOOT = new THREE.Color('#5c4a34'), C_EARTH = new THREE.Color('#67533a'),
      C_LIT = new THREE.Color('#7a6342'), C_DITCH = new THREE.Color('#2a2013');
    const WORKS_PROFILE: [number, number, THREE.Color][] = [
      [-4.2, 0.0, C_FOOT],
      [-2.4, 1.05, C_LIT],     // fighting face (toward the castle, catches the sun)
      [-0.6, 1.5, C_LIT],      // parapet crest
      [1.0, 1.2, C_EARTH],
      [2.6, 0.32, C_EARTH],
      [3.4, 0.05, C_FOOT],     // rear foot of the parapet
      [4.4, 0.55, C_EARTH],    // trench inner lip
      [5.3, 0.06, C_DITCH],    // ...the fire trench floor...
      [7.4, 0.06, C_DITCH],
      [8.5, 0.5, C_EARTH],     // trench outer lip
      [9.8, 0.0, C_FOOT],
    ];
    const APRON_PROFILE: [number, number, THREE.Color][] = [[-8, 0.022, C_EARTH], [12, 0.022, C_EARTH]];
    // rotate the loop to start at the assault gap, then split into contiguous runs
    let start = nodes.findIndex((nd) => gateOpen(nd.ang)); if (start < 0) start = 0;
    const rot = nodes.slice(start).concat(nodes.slice(0, start));
    const runs: (typeof nodes)[] = []; let cur: typeof nodes = [];
    for (const nd of rot) { if (gateOpen(nd.ang)) { if (cur.length > 2) runs.push(cur); cur = []; } else cur.push(nd); }
    if (cur.length > 2) runs.push(cur);
    for (const run of runs) { const w = this.sweepRibbon(run, WORKS_PROFILE, 1.6); if (w) worksG.push(w); }
    { const a = this.sweepRibbon([...rot, rot[0]], APRON_PROFILE, 1.6, false); if (a) apronG.push(a); } // churned ground under the whole ring, gap included

    // gabions + stakes fronting the parapet (the basket line the trench is served from)
    for (const nd of nodes) {
      if (gateOpen(nd.ang)) continue;
      const inx = -nd.nx, inz = -nd.nz, tvx = -nd.nz, tvz = nd.nx, ry = Math.atan2(tvx, tvz);
      const gbx = nd.x + inx * 6.2, gbz = nd.z + inz * 6.2;
      for (let g = -1; g <= 1; g++) wicker.push(new THREE.CylinderGeometry(1.05, 1.2, 1.95, 8).translate(gbx + tvx * g * 3.4, 0.98, gbz + tvz * g * 3.4));
      const shead = Math.atan2(inx, inz);
      for (let s = -1; s <= 1; s++) stakes.push(new THREE.CylinderGeometry(0.12, 0.02, 2.7, 4).rotateX(-0.6).rotateY(shead).translate(gbx + inx * 2.8 + tvx * s * 2.4, 0.85, gbz + inz * 2.8 + tvz * s * 2.4));
      if (chance(0.18)) planks.push(new THREE.BoxGeometry(3.2, 2.4, 0.3).rotateX(-0.26).rotateY(ry).translate(gbx, 1.35, gbz)); // occasional mantlet
    }

    // ---- NO MAN'S LAND: the shot-torn ground between the works and the wall ----
    const nmSpot = (d0 = 7, d1 = gap - 7) => { const nd = nodes[Math.floor(Math.random() * nodes.length)]; const d = rnd(d0, Math.max(d0 + 2, d1)); return { x: nd.x - nd.nx * d, z: nd.z - nd.nz * d }; };
    // craters — boulder strikes: a scorched halo, a dark pit, a rim of thrown earth
    let smokers = 0;
    for (let i = 0; i < Math.round(nodes.length * 0.35); i++) {
      const p = nmSpot(); const cr = rnd(1.6, 3.4);
      scorchG.push(flatE(cr * rnd(1.15, 1.45), cr * rnd(1.15, 1.45), p.x, p.z, Math.random() * 3.14, 0.03));
      trenchG.push(flatE(cr, cr * rnd(0.85, 1.1), p.x, p.z, Math.random() * 3.14, 0.05));
      const rim = 4 + Math.floor(Math.random() * 3);
      for (let k = 0; k < rim; k++) { const a = k / rim * 6.28 + rnd(-0.3, 0.3); earth.push(mound(rnd(0.4, 0.8), p.x + Math.cos(a) * cr * rnd(0.95, 1.25), p.z + Math.sin(a) * cr * rnd(0.95, 1.25))); }
      if (smokers < 4 && chance(0.22)) { smokers++; this.smokeSources.push({ x: p.x, y: 0.3, z: p.z, s: 1.7, rate: 0.3, dark: 0.6, t: Math.random() }); }
    }
    // spent arrow flights bristling from the turf (thickest under the walls)
    for (let i = 0; i < Math.round(nodes.length * 0.3); i++) {
      const p = nmSpot(5, gap * 0.6);
      for (let k = 0; k < 5 + Math.floor(Math.random() * 6); k++) {
        const ax = p.x + rnd(-3.5, 3.5), az = p.z + rnd(-3.5, 3.5), tx = rnd(-0.38, 0.38), tz2 = rnd(-0.38, 0.38);
        arrowG.push(new THREE.CylinderGeometry(0.04, 0.04, 1.25, 4).translate(0, 0.62, 0).rotateX(tx).rotateZ(tz2).translate(ax, 0, az));
        fletchG.push(new THREE.BoxGeometry(0.15, 0.2, 0.15).translate(0, 1.18, 0).rotateX(tx).rotateZ(tz2).translate(ax, 0, az));
      }
    }
    // broken supply wagons, burnt where they were caught in the open
    for (let i = 0; i < 3; i++) {
      const p = nmSpot(10, gap - 8), ry = Math.random() * 3.14;
      wreckG.push(new THREE.BoxGeometry(3.8, 0.6, 1.9).rotateZ(rnd(0.7, 1.1)).rotateY(ry).translate(p.x, 0.8, p.z));
      wreckG.push(new THREE.CylinderGeometry(0.72, 0.72, 0.2, 9).rotateX(1.5708).rotateY(rnd(0, 3)).translate(p.x + rnd(-3, 3), 0.11, p.z + rnd(-3, 3)));
      wreckG.push(new THREE.CylinderGeometry(0.72, 0.72, 0.2, 9).rotateZ(1.26).rotateY(rnd(0, 3)).translate(p.x + rnd(-2, 2), 0.5, p.z + rnd(-2, 2)));
      for (let k = 0; k < 3; k++) wreckG.push(new THREE.BoxGeometry(rnd(1.4, 2.6), 0.14, 0.3).rotateY(rnd(0, 3)).translate(p.x + rnd(-3, 3), 0.08, p.z + rnd(-3, 3)));
      scorchG.push(flatE(rnd(3.5, 5), rnd(3.5, 5), p.x, p.z, rnd(0, 3), 0.028));
    }
    // a burnt siege engine, frame collapsed and still smouldering
    {
      const p = nmSpot(12, gap - 8), ry = Math.random() * 3.14;
      wreckG.push(new THREE.BoxGeometry(0.55, 6.4, 0.55).rotateZ(0.9).rotateY(ry).translate(p.x, 1.8, p.z));
      wreckG.push(new THREE.BoxGeometry(0.55, 5.6, 0.55).rotateZ(-0.75).rotateX(0.2).rotateY(ry).translate(p.x + 1, 1.5, p.z + 1));
      wreckG.push(new THREE.BoxGeometry(0.4, 8.5, 0.4).rotateZ(1.35).rotateY(ry).translate(p.x - 1, 1.1, p.z - 1)); // the thrown arm, flat on the ground
      wreckG.push(new THREE.BoxGeometry(3.4, 0.5, 0.7).rotateY(ry).translate(p.x, 0.28, p.z));
      wreckG.push(new THREE.CylinderGeometry(0.85, 0.85, 0.22, 9).rotateZ(1.5708).rotateY(ry).translate(p.x + 1.8, 0.5, p.z - 1.2));
      scorchG.push(flatE(4.5, 4.5, p.x, p.z, 0, 0.028));
      this.smokeSources.push({ x: p.x, y: 0.8, z: p.z, s: 2.2, rate: 0.45, dark: 0.65, t: Math.random() * 0.4 });
    }
    // dug spoil and shattered stone strewn through the gap
    for (let i = 0; i < Math.round(nodes.length * 0.7); i++) {
      const p = nmSpot(4, gap - 6);
      rubbleG.push(flatE(rnd(3.5, 7), rnd(3.5, 7), p.x, p.z, Math.random() * 3.14, 0.035));
      for (let k = 0; k < 2 + Math.floor(Math.random() * 3); k++) {
        const s = rnd(0.5, 1.3), ox = rnd(-3.5, 3.5), oz = rnd(-3.5, 3.5);
        if (chance(0.4)) rock.push(this.boxG(s, s * rnd(0.5, 0.8), s * rnd(0.8, 1.2), p.x + ox, s * 0.3, p.z + oz, Math.random() * 3.14)); // shattered stone stays angular
        else earth.push(mound(s * 0.8, p.x + ox, p.z + oz));                   // dug spoil is rounded
      }
    }

    // ---- ENCAMPMENTS: the besiegers' tents ringed OUTSIDE the line (main camp to the rear) ----
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const cluster = (ang: number, n: number, withFire = true) => {
      const rr = castleR + gap + rnd(16, 30), cxp = clamp(ccx + Math.cos(ang) * rr, minX + 6, maxX - 6), czp = clamp(ccz + Math.sin(ang) * rr, WORLD.minZ + 14, maxZ - 6);
      for (let k = 0; k < n; k++) tent(clamp(cxp + rnd(-16, 16), minX + 4, maxX - 4), clamp(czp + rnd(-13, 13), WORLD.minZ + 12, maxZ - 4), chance(0.16));
      if (withFire) cookfire(cxp + rnd(-8, 8), czp + rnd(-8, 8), chance(0.5));
      for (let s = 0; s < 1 + Math.floor(Math.random() * 2); s++) dump(cxp + rnd(-12, 12), czp + rnd(-12, 12));
      if (chance(0.7)) { banner.push(new THREE.CylinderGeometry(0.08, 0.08, 8, 5).translate(cxp, 4, czp)); flag.push(this.boxG(2.4, 1.2, 0.12, cxp + 1.2, 6.2, czp)); }
    };
    // main camp: several dense rows on the assault (gate) side, behind the host
    const campZ0 = Math.min(maxZ - 52, ccz + hz + gap + 40);
    for (let r = 0; r < 3; r++) {
      const cz = Math.min(maxZ - 8, campZ0 + r * 22);
      const span = Math.min((maxX - minX) * 0.9, castleR * 3 + 80), count = Math.round(span / 15);
      for (let k = 0; k < count; k++) {
        const cx = -span / 2 + span * (k + rnd(-0.18, 0.18)) / (count - 1 || 1);
        if (Math.abs(cx - gx) < 11 && r === 0) continue;                        // road mouth
        tent(clamp(cx, minX + 4, maxX - 4), cz + rnd(-4, 4), r === 1 && chance(0.12));
      }
      for (let f = 0; f < 3; f++) cookfire(rnd(-span / 2.3, span / 2.3), cz + rnd(-7, 7), r < 1);
      for (let s = 0; s < 4; s++) dump(rnd(-span / 2.2, span / 2.2), cz + rnd(-10, 10));
      if (r === 0) for (let b = 0; b < 4; b++) { const bx = rnd(-span / 2.4, span / 2.4); banner.push(new THREE.CylinderGeometry(0.08, 0.08, 8, 5).translate(bx, 4, cz + rnd(-6, 6))); flag.push(this.boxG(2.4, 1.2, 0.12, bx + 1.2, 6.2, cz + rnd(-6, 6))); }
    }
    for (let w = 0; w < 4; w++) wagon(clamp(rnd(-castleR - 20, castleR + 20), minX + 6, maxX - 6), campZ0 + rnd(-6, 30), rnd(0, 3.14));
    { const hz = maxZ - 6, x0 = -castleR * 0.6, x1 = castleR * 0.6; for (let p = 0; p <= 10; p++) poles.push(new THREE.CylinderGeometry(0.11, 0.11, 2.2, 5).translate(x0 + (x1 - x0) * p / 10, 1.1, hz)); } // horse-line
    // flanking & rear camps so the siege reads as a full investment
    const back = ga + Math.PI;
    cluster(ga - 1.25, 3); cluster(ga + 1.25, 3); cluster(back - 0.6, 3); cluster(back + 0.6, 3); cluster(back, 2);

    const add = (geos: THREE.BufferGeometry[], mat: THREE.Material) => { if (geos.length) { const m = new THREE.Mesh(mergeGeometries(geos, false), mat); m.castShadow = m.receiveShadow = true; this.scene.add(m); } };
    const dirt = (hex: string, col: string) => { const t = dirtTexture(hex); t.wrapS = t.wrapT = THREE.RepeatWrapping; return new THREE.MeshLambertMaterial({ map: t, color: col, vertexColors: true, transparent: true, depthWrite: false }); };
    const decal = (geos: THREE.BufferGeometry[], mat: THREE.Material) => { if (geos.length) { const m = new THREE.Mesh(mergeGeometries(geos, false), mat); m.receiveShadow = true; m.renderOrder = 1; this.scene.add(m); } };
    // the continuous earthwork ribbons (vertex-coloured, smooth-shaded)
    if (worksG.length) { const m = new THREE.Mesh(mergeGeometries(worksG, false), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); m.castShadow = m.receiveShadow = true; this.scene.add(m); }
    if (apronG.length) { const at = dirtTexture('#6f5c40'); at.wrapS = at.wrapT = THREE.RepeatWrapping; const m = new THREE.Mesh(mergeGeometries(apronG, false), new THREE.MeshLambertMaterial({ map: at, color: '#7d6a4d', side: THREE.DoubleSide })); m.receiveShadow = true; m.renderOrder = 1; this.scene.add(m); }
    decal(rubbleG, dirt('#84714e', '#95835f'));  // churned spoil / dug earth (somber)
    decal(trenchG, dirt('#3e3019', '#5c4a2e'));  // ditch floors / crater pits
    decal(scorchG, dirt('#3a2d1b', '#4a3a26'));  // scorched, fire-blackened ground
    add(arrowG, this.stone('#a8926a'));     // spent arrow shafts
    add(fletchG, this.stone('#ddd3ba'));    // pale goose-feather fletchings
    add(wreckG, this.stone('#31261a'));     // charred wreckage (wagons, engines)
    add(cloth, this.stone('#cbb894'));      // weathered linen tents
    add(pavilion, this.stone('#8a4436'));   // lords' command pavilions (dyed cloth)
    add(poles, this.stone('#6a4a2a'));
    add(banner, this.stone('#5a4326'));     // banner staves
    add(flag, this.stone('#b23b2f'));       // red crusader pennants
    add(ring, this.stone('#4a4038'));       // fire-ring stones
    add(logs, this.stone('#2a1c10'));       // charred logs
    add(earth, this.stone('#5a4632'));      // spoil ramparts / earth heaps
    add(rock, this.stone('#8a8072'));       // shattered stone rubble
    add(wicker, this.stone('#6a5230'));     // gabions (woven earth-baskets)
    add(planks, this.stone('#7a5a34'));     // mantlets / pavise shields
    add(stakes, this.stone('#6e5330'));     // sharpened stakes
    add(crates, this.stone('#7a5a34'));     // supply crates
    add(barrels, this.stone('#5f421f'));    // barrels
    add(sacks, this.stone('#b3a074'));      // grain sacks
    add(hay, this.stone('#c2a44c'));        // hay bales
    add(cart, this.stone('#63431f'));       // supply wagons
  }

  // A soft round smoke puff (white → transparent), tinted per-instance to grey/haze.
  private smokeTex(): THREE.CanvasTexture {
    const S = 96, cv = document.createElement('canvas'); cv.width = cv.height = S; const ctx = cv.getContext('2d')!;
    const lobe = (x: number, y: number, r: number, a: number) => { const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r); g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); };
    lobe(48, 52, 34, 0.5); lobe(36, 44, 22, 0.4); lobe(60, 46, 24, 0.4); lobe(48, 38, 20, 0.35);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  // Smoke: a besieged castle burns (columns from inside the walls) and the camp
  // cook-fires smoulder. A pooled billboard system fed by registered fire sources.
  private buildSmoke() {
    // castle fires — a few interior buildings ablaze
    const burn = CASTLE.filter(b => b.kind === 'building' || b.kind === 'keep');
    for (let i = 0; i < Math.min(3, burn.length); i++) {
      const b = burn[(i * 5 + 1) % burn.length];
      this.smokeSources.push({ x: (b.x0 + b.x1) / 2, y: b.h + 3, z: (b.z0 + b.z1) / 2, s: 9, rate: 0.16, dark: 0.62, t: Math.random() * 0.16 });
    }
    const N = 170;
    this.smokeMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.smokeTex(), transparent: true, opacity: 0.72, depthWrite: false }), N);
    this.smokeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.smokeMesh.frustumCulled = false; this.scene.add(this.smokeMesh);
    const dark = new THREE.Color('#3a352e');
    for (let i = 0; i < N; i++) { this.smoke.push({ x: 0, y: -1000, z: 0, s: 1, life: 0, max: 1 }); this.smokeMesh.setColorAt(i, dark); }
    if (this.smokeMesh.instanceColor) this.smokeMesh.instanceColor.needsUpdate = true;
  }

  // Dress the bailey so the inside reads as a lived-in castle, not an empty yard:
  // a cobble approach, a well, scattered stores (barrels/crates/hay) and heraldic
  // banners on the keep. Everything is merged by material into a handful of static
  // meshes — no extra per-frame cost.
  private buildInterior() {
    const W = LAYOUT.W, D = LAYOUT.D;
    const keepSeg = CASTLE.find(b => b.kind === 'keep');
    const kx = keepSeg ? (keepSeg.x0 + keepSeg.x1) / 2 : 0, kz = keepSeg ? (keepSeg.z0 + keepSeg.z1) / 2 : 0;
    const blocks = CASTLE.filter(b => b.kind === 'building' || b.kind === 'keep').map(b => ({ x0: b.x0 - 1.6, x1: b.x1 + 1.6, z0: b.z0 - 1.6, z1: b.z1 + 1.6 }));
    const free = (x: number, z: number) => Math.abs(x) < W - T - 1.5 && Math.abs(z) < D - T - 1.5 && !blocks.some(b => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);
    const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number) => new THREE.CylinderGeometry(rt, rb, h, 8).translate(x, y, z);
    const wood: THREE.BufferGeometry[] = [], hoop: THREE.BufferGeometry[] = [], hay: THREE.BufferGeometry[] = [], wellStone: THREE.BufferGeometry[] = [];

    // cobble approach just inside the gate, aimed at the keep — kept short so it
    // never runs through an inner wall on a concentric castle
    const sx = LAYOUT.gate.x, sz = D - T - 2, dxk = kx - sx, dzk = kz - sz, dl = Math.hypot(dxk, dzk) || 1;
    const plen = Math.min(dl - 6, 30);
    if (plen > 8) {
      const earth = dirtTexture('#8c8267'); earth.wrapS = earth.wrapT = THREE.RepeatWrapping; earth.repeat.set(1, plen / 9); earth.needsUpdate = true;
      const path = new THREE.Mesh(new THREE.PlaneGeometry(6.5, plen).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: earth, color: '#9a8f74' }));
      path.position.set(sx + dxk / dl * plen / 2, 0.02, sz + dzk / dl * plen / 2); path.rotation.y = Math.atan2(dxk, dzk); path.receiveShadow = true; this.scene.add(path);
    }
    // a well, a clear focal point in the bailey
    let wx = sx + dxk / dl * Math.min(dl * 0.5, 22), wz = sz + dzk / dl * Math.min(dl * 0.5, 22);
    for (let t = 0; t < 8 && !free(wx, wz); t++) { wx += (Math.random() - 0.5) * 8; wz += (Math.random() - 0.5) * 8; }
    if (free(wx, wz)) {
      wellStone.push(cyl(1.5, 1.6, 1.3, wx, 0.65, wz)); hoop.push(cyl(1.55, 1.55, 0.18, wx, 1.32, wz));
      wood.push(cyl(0.12, 0.12, 3.0, wx - 1.2, 1.5, wz), cyl(0.12, 0.12, 3.0, wx + 1.2, 1.5, wz), this.boxG(0.22, 0.22, 2.7, wx, 3.0, wz), this.boxG(3.0, 0.32, 2.1, wx, 3.45, wz));
      blocks.push({ x0: wx - 2, x1: wx + 2, z0: wz - 2, z1: wz + 2 });
    }
    // scattered stores
    let placed = 0, guard = 0;
    while (placed < 20 && guard++ < 600) {
      const x = (Math.random() * 2 - 1) * (W - T - 2), z = (Math.random() * 2 - 1) * (D - T - 2);
      if (!free(x, z)) continue;
      const r = Math.random();
      if (r < 0.5) { const n2 = 1 + (Math.random() * 3 | 0); for (let k = 0; k < n2; k++) { const bx = x + (Math.random() - 0.5) * 1.8, bz = z + (Math.random() - 0.5) * 1.8; wood.push(cyl(0.5, 0.56, 1.25, bx, 0.62, bz)); hoop.push(cyl(0.58, 0.58, 0.16, bx, 0.9, bz), cyl(0.58, 0.58, 0.16, bx, 0.34, bz)); } }
      else if (r < 0.78) { wood.push(this.boxG(1.2, 1.1, 1.2, x, 0.55, z, Math.random() * 0.5)); if (Math.random() < 0.5) wood.push(this.boxG(0.9, 0.9, 0.9, x + 0.3, 1.5, z - 0.2, Math.random() * 0.6)); }
      else hay.push(new THREE.CylinderGeometry(0.8, 0.95, 0.95, 8).rotateZ(Math.PI / 2).translate(x, 0.55, z));
      blocks.push({ x0: x - 1.4, x1: x + 1.4, z0: z - 1.4, z1: z + 1.4 }); placed++;
    }
    const add = (geos: THREE.BufferGeometry[], mat: THREE.Material) => { if (geos.length) { const m = new THREE.Mesh(mergeGeometries(geos, false), mat); m.castShadow = m.receiveShadow = true; this.scene.add(m); } };
    add(hay, this.stone('#c9a743')); add(hoop, this.stone('#3a2a18'));
    const ws = this.stone('#cdbf9c'); ws.map = this.texStone; add(wellStone, ws);
    // heraldic banners on the keep's gate-facing wall (brand tie-in)
    if (keepSeg) {
      const kw = keepSeg.x1 - keepSeg.x0, faceZ = keepSeg.z1, red: THREE.BufferGeometry[] = [], blue: THREE.BufferGeometry[] = [], poles: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 2; i++) { const bx = kx + (i ? 1 : -1) * kw * 0.26; (i ? blue : red).push(new THREE.PlaneGeometry(1.7, 4.0).translate(bx, 6.2, faceZ + 0.25)); poles.push(cyl(0.09, 0.09, 5.0, bx, 6.2, faceZ + 0.25)); }
      wood.push(...poles);
      add(red, new THREE.MeshLambertMaterial({ color: '#b5332b', side: THREE.DoubleSide })); add(blue, new THREE.MeshLambertMaterial({ color: '#2f5a8c', side: THREE.DoubleSide }));
    }
    add(wood, this.stone('#6e4a2a')); // barrels + crates + well frame + banner poles — one mesh
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

  // ---- the mobile assault works: siege towers & the covered ram ----
  private workModels: { grp: THREE.Group; smoked: boolean }[] = [];
  private buildAssaultWorks() {
    const timber = this.stone('#77552f'), dark = this.stone('#54381e'), hide = this.stone('#6b4f33');
    for (const e of this.sim.assaultWorks) {
      const g = new THREE.Group();
      if (e.kind === 'tower') {
        const parts: THREE.BufferGeometry[] = [
          new THREE.BoxGeometry(3.4, 8.8, 3.6).translate(0, 4.4, 0),
          new THREE.BoxGeometry(4.0, 0.5, 4.2).translate(0, 8.9, 0),         // fighting top
        ];
        for (const sx of [-1.7, 1.7]) for (const k of [-1, 1]) parts.push(new THREE.BoxGeometry(0.5, 0.9, 0.5).translate(sx, 9.4, k * 1.6)); // crenels
        g.add(new THREE.Mesh(mergeGeometries(parts, false), timber));
        const plate = new THREE.Mesh(new THREE.BoxGeometry(3.6, 7.6, 0.3), hide); plate.position.set(0, 4.2, -1.9); g.add(plate); // hide-clad face
        for (const [wx, wz] of [[-1.6, -1.4], [1.6, -1.4], [-1.6, 1.4], [1.6, 1.4]] as const) {
          const w = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.4, 10).rotateZ(Math.PI / 2), dark); w.position.set(wx, 0.7, wz); g.add(w);
        }
      } else {
        const roofL = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.25, 5.4).rotateZ(0.5), hide); roofL.position.set(-1.05, 2.4, 0); g.add(roofL);
        const roofR = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.25, 5.4).rotateZ(-0.5), hide); roofR.position.set(1.05, 2.4, 0); g.add(roofR);
        for (const pz2 of [-2.2, 0, 2.2]) for (const px2 of [-1.6, 1.6]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.4, 0.35), timber); p.position.set(px2, 1.2, pz2); g.add(p); }
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 4.6, 8).rotateX(Math.PI / 2), dark); log.position.set(0, 1.5, 0); g.add(log);
        for (const [wx, wz] of [[-1.7, -1.9], [1.7, -1.9], [-1.7, 1.9], [1.7, 1.9]] as const) {
          const w = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.35, 10).rotateZ(Math.PI / 2), dark); w.position.set(wx, 0.6, wz); g.add(w);
        }
      }
      g.traverse(o => { o.castShadow = true; });
      g.position.set(e.x, 0, e.z);
      this.scene.add(g); this.workModels.push({ grp: g, smoked: false });
    }
  }
  private updateAssaultWorks() {
    for (let i = 0; i < this.workModels.length; i++) {
      const e = this.sim.assaultWorks[i], m = this.workModels[i]; if (!e) continue;
      m.grp.position.x = e.x; m.grp.position.z = e.z;
      m.grp.rotation.y = Math.atan2(-e.x, -e.z); // face the castle centre as it rolls
      if (e.state === 'dead') { // burned: keel over, smoulder once
        m.grp.rotation.z = Math.min(0.5, m.grp.rotation.z + 0.01);
        if (!m.smoked) { m.smoked = true; this.smokeSources.push({ x: e.x, y: 2, z: e.z, s: 2.4, rate: 0.5, dark: 0.7, t: 0 }); this.igniteFlash(e.x, e.z); }
      } else if (e.hp < e.maxhp * 0.45 && !m.smoked) { m.smoked = true; this.smokeSources.push({ x: e.x, y: 3, z: e.z, s: 1.6, rate: 0.4, dark: 0.6, t: 0 }); }
    }
  }
  private igniteFlash(x: number, z: number) { this.spawnDust(x, 2, z, 4, 3); for (let k = 0; k < 6; k++) this.spawnEmber(x, 2.5, z); }

  // ---- TIER 3 atmosphere: brazier fires + embers, impact shockwaves, a sun disc,
  // and banners rising over the host. All bloom-driven (HDR emissives). ----
  private buildAtmosphere() {
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    // brazier / fire-pot positions along the battlements (tower tops + gate flanks).
    // Each remembers its CASTLE segment so the whole pyre — bowl, flame, smoke —
    // falls with the wall instead of hovering over the breach.
    for (let s = 0; s < CASTLE.length; s++) {
      const b = CASTLE[s], cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      if (b.kind === 'tower' && Math.random() < 0.72) this.braziers.push({ x: cx, y: b.h + 1.4, z: cz, ph: Math.random() * 6.28, seg: s });
      else if (b.kind === 'gate' && b.h > 3) { this.braziers.push({ x: b.x0 + 2.5, y: b.h + 1.2, z: cz, ph: Math.random() * 6.28, seg: s }); this.braziers.push({ x: b.x1 - 2.5, y: b.h + 1.2, z: cz, ph: Math.random() * 6.28, seg: s }); }
    }
    const bowlMat = this.stone('#2a2320');
    for (const p of this.braziers) {
      const bowls: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(1.0, 0.6, 0.7, 8).translate(p.x, p.y - 0.4, p.z)];
      for (let k = 0; k < 3; k++) { const a = k / 3 * 6.28; bowls.push(new THREE.CylinderGeometry(0.09, 0.09, 1.5, 4).translate(p.x + Math.cos(a) * 0.5, p.y - 1.25, p.z + Math.sin(a) * 0.5)); }
      const bowl = new THREE.Mesh(mergeGeometries(bowls, false), bowlMat); this.scene.add(bowl);
      this.segVis[p.seg]?.extras.push(bowl); // crumble() hides a section's extras — the bowl goes down with it
      this.smokeSources.push({ x: p.x, y: p.y + 0.9, z: p.z, s: 1.1, rate: 0.2, dark: 0.5, t: Math.random(), seg: p.seg });
    }
    const fmat = new THREE.MeshBasicMaterial({ map: this.fireTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    fmat.color.setRGB(3.2, 2.0, 0.95);
    this.brazierMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.6, 3.4), fmat, Math.max(1, this.braziers.length));
    this.brazierMesh.frustumCulled = false; this.scene.add(this.brazierMesh);

    // embers (recycled pool)
    const emat = new THREE.MeshBasicMaterial({ map: this.fireTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    emat.color.setRGB(3.0, 1.4, 0.45);
    this.emberMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.34, 0.34), emat, 90);
    this.emberMesh.frustumCulled = false; this.scene.add(this.emberMesh);
    for (let i = 0; i < 90; i++) this.embers.push({ x: 0, y: -1000, z: 0, vy: 0, life: 0, max: 1 });

    // impact shockwave rings (fade via per-instance colour)
    const smat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.shockMesh = new THREE.InstancedMesh(new THREE.RingGeometry(0.62, 1.0, 32).rotateX(-Math.PI / 2), smat, 12);
    this.shockMesh.frustumCulled = false; this.scene.add(this.shockMesh);
    for (let i = 0; i < 12; i++) this.shocks.push({ x: 0, y: -1000, z: 0, life: 0, max: 1, scale: 1 });

    // a soft sun disc in the sky — blooms into an atmospheric flare
    const sc = document.createElement('canvas'); sc.width = sc.height = 128; const sx = sc.getContext('2d')!;
    const sg = sx.createRadialGradient(64, 64, 2, 64, 64, 64); sg.addColorStop(0, 'rgba(255,246,220,1)'); sg.addColorStop(0.3, 'rgba(255,222,155,0.55)'); sg.addColorStop(1, 'rgba(255,205,130,0)');
    sx.fillStyle = sg; sx.fillRect(0, 0, 128, 128);
    const stex = new THREE.CanvasTexture(sc); stex.colorSpace = THREE.SRGBColorSpace;
    const spmat = new THREE.SpriteMaterial({ map: stex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    spmat.color.setRGB(...this.todCfg.glow); // noon gold, dusk amber, night a cool moon
    this.sunGlow = new THREE.Sprite(spmat); this.sunGlow.scale.set(this.todCfg.glowScale, this.todCfg.glowScale, 1);
    this.sunGlow.position.copy(this.sun.position.clone().normalize().multiplyScalar(560));
    this.scene.add(this.sunGlow);

    // banners rising over the attacking host (perceived scale — standards above the
    // crowd). Muted campaign cloth, not the bright heraldry tint, so they read as
    // wind-worn banners and don't catch the bloom.
    for (let i = 0; i < 6; i++) {
      const bx = rnd(-LAYOUT.W * 0.42, LAYOUT.W * 0.42), bz = LAYOUT.D * 0.5 + rnd(30, 76);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 11, 6), this.stone('#5a3f22'));
      pole.position.set(bx, 5.5, bz); pole.castShadow = true; this.scene.add(pole);
      this.scene.add(this.makeBanner(bx + 0.18, 9.6, bz, 2.4, 1.5, '#7c2b22'));
    }

    if (this.weather === 'rain') { // driving rain: instanced streaks recycled through a volume around the camera target
      const rmat = new THREE.MeshBasicMaterial({ color: '#9fb4c8', transparent: true, opacity: 0.34, depthWrite: false });
      this.rainMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.05, 2.6), rmat, 420);
      this.rainMesh.frustumCulled = false; this.scene.add(this.rainMesh);
      for (let i = 0; i < 420; i++) this.rain.push({ x: rnd(-180, 180), y: rnd(0, 60), z: rnd(-150, 200), v: rnd(26, 40) });
    }

    // drifting battlefield haze — a handful of very large, very faint smoke sheets
    // riding a steady wind. This is what makes a still frame read as a LIVING field:
    // the air itself moves, thickening near the burning castle.
    const hc = document.createElement('canvas'); hc.width = hc.height = 64; const hx2 = hc.getContext('2d')!;
    const hg = hx2.createRadialGradient(32, 32, 3, 32, 32, 31);
    hg.addColorStop(0, 'rgba(214,204,186,0.5)'); hg.addColorStop(0.6, 'rgba(214,204,186,0.22)'); hg.addColorStop(1, 'rgba(214,204,186,0)');
    hx2.fillStyle = hg; hx2.fillRect(0, 0, 64, 64);
    const htex = new THREE.CanvasTexture(hc); htex.colorSpace = THREE.SRGBColorSpace;
    const hmat = new THREE.MeshBasicMaterial({ map: htex, transparent: true, opacity: this.tod === 'night' ? 0.1 : 0.16, depthWrite: false });
    hmat.color.set(this.tod === 'night' ? '#5a6580' : '#d9cfba');
    this.hazeMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), hmat, 22);
    this.hazeMesh.frustumCulled = false; this.hazeMesh.renderOrder = 3; this.scene.add(this.hazeMesh);
    for (let i = 0; i < 22; i++) this.haze.push({ x: rnd(-190, 190), y: rnd(2.5, 9), z: rnd(-150, 190), s: rnd(26, 52) });

    // company standards: a small pennant above each living bearer — the fights
    // read as COMPANIES with hearts, and you can see whose standard has fallen
    {
      const pc = document.createElement('canvas'); pc.width = 32; pc.height = 32; const px2 = pc.getContext('2d')!;
      px2.fillStyle = '#caa84a'; px2.fillRect(14, 2, 3, 30);                      // staff
      px2.fillStyle = '#fff'; px2.beginPath(); px2.moveTo(17, 3); px2.lineTo(31, 7); px2.lineTo(17, 12); px2.fill(); // swallowtail (tinted per instance)
      const ptex = new THREE.CanvasTexture(pc); ptex.colorSpace = THREE.SRGBColorSpace;
      const pmat = new THREE.MeshBasicMaterial({ map: ptex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
      this.pennantMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.0, 2.0), pmat, 320); // big double-ring sieges field >200 companies
      this.pennantMesh.frustumCulled = false; this.scene.add(this.pennantMesh);
    }

    // melee clash sparks — brief steel-on-steel glints where the lines meet
    const kmat = new THREE.MeshBasicMaterial({ map: this.fireTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    kmat.color.setRGB(2.5, 2.2, 1.5);
    this.sparkMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.5, 0.5), kmat, 48);
    this.sparkMesh.frustumCulled = false; this.scene.add(this.sparkMesh);
    for (let i = 0; i < 48; i++) this.sparks.push({ x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });

    // house fires (the town alight) — bigger flames than the braziers, capped
    const gmat = new THREE.MeshBasicMaterial({ map: this.fireTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    gmat.color.setRGB(3.0, 1.8, 0.8);
    this.flameMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(3.4, 4.6), gmat, 20);
    this.flameMesh.frustumCulled = false; this.scene.add(this.flameMesh);
  }

  private spawnEmber(x: number, y: number, z: number) {
    const e = this.embers[this.emberHead]; this.emberHead = (this.emberHead + 1) % this.embers.length;
    e.x = x + (Math.random() - 0.5) * 1.2; e.y = y; e.z = z + (Math.random() - 0.5) * 1.2;
    e.vy = 3 + Math.random() * 4; e.max = 1.1 + Math.random() * 1.2; e.life = e.max;
  }
  private spawnShock(x: number, z: number, scale: number) {
    const s = this.shocks[this.shockHead]; this.shockHead = (this.shockHead + 1) % this.shocks.length;
    s.x = x; s.z = z; s.max = 0.5; s.life = s.max; s.scale = scale;
  }

  private updateAtmosphere(dt: number) {
    if (this.brazierMesh) {
      for (let i = 0; i < this.braziers.length; i++) {
        const b = this.braziers[i];
        if ((this.segVis[b.seg]?.crumbling ?? 0) > 0 || CASTLE[b.seg]?.dead) { // its wall fell — the pyre went down with it
          this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001);
          this.dummy.updateMatrix(); this.brazierMesh.setMatrixAt(i, this.dummy.matrix); continue;
        }
        b.ph += dt * (6 + Math.random() * 2);
        const fl = 0.85 + Math.sin(b.ph) * 0.12 + Math.random() * 0.12;
        this.dummy.position.set(b.x, b.y + Math.sin(b.ph * 0.7) * 0.14, b.z); this.dummy.quaternion.copy(this.billboard);
        this.dummy.scale.set(fl, fl * 1.25, fl); this.dummy.updateMatrix(); this.brazierMesh.setMatrixAt(i, this.dummy.matrix);
        if (Math.random() < 0.14) this.spawnEmber(b.x, b.y + 0.7, b.z);
      }
      this.brazierMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.emberMesh) {
      for (let i = 0; i < this.embers.length; i++) {
        const e = this.embers[i];
        if (e.life > 0) { e.life -= dt; e.y += e.vy * dt; e.vy -= dt * 1.2; e.x += Math.sin(e.life * 7 + i) * dt * 0.8; const k = Math.max(0, e.life / e.max), s = 0.28 * k + 0.06; this.dummy.position.set(e.x, e.y, e.z); this.dummy.quaternion.copy(this.billboard); this.dummy.scale.set(s, s, s); }
        else { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); }
        this.dummy.updateMatrix(); this.emberMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.emberMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.shockMesh) {
      for (let i = 0; i < this.shocks.length; i++) {
        const s = this.shocks[i];
        if (s.life > 0) { s.life -= dt; const k = 1 - s.life / s.max, rad = (0.5 + k * 4.6) * s.scale; this.dummy.position.set(s.x, 0.4, s.z); this.dummy.quaternion.identity(); this.dummy.scale.set(rad, 1, rad); const b = (1 - k) * 2.3; this._col.setRGB(b, b * 0.9, b * 0.7); this.shockMesh.setColorAt(i, this._col); }
        else { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); }
        this.dummy.updateMatrix(); this.shockMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.shockMesh.instanceMatrix.needsUpdate = true; if (this.shockMesh.instanceColor) this.shockMesh.instanceColor.needsUpdate = true;
    }
    if (this.rainMesh) { // rain falls through the world volume and recycles
      for (let i = 0; i < this.rain.length; i++) {
        const p = this.rain[i];
        p.y -= p.v * dt; p.x += dt * 6; // slanted by the storm wind
        if (p.y < 0.2) { p.y = 55 + Math.random() * 10; p.x = this.camTarget.x + (Math.random() - 0.5) * 320; p.z = this.camTarget.z + (Math.random() - 0.5) * 300; }
        this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.billboard);
        this.dummy.updateMatrix(); this.rainMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.rainMesh.instanceMatrix.needsUpdate = true;
    }
    // ---- drifting haze: ride the wind, wrap at the field edge, thicken near fires ----
    if (this.hazeMesh) {
      const windK = this.weather === 'wind' ? 2.6 : 1;
      const wx = 2.1 * windK, wz = 0.8 * windK; // the prevailing wind
      for (let i = 0; i < this.haze.length; i++) {
        const p = this.haze[i];
        p.x += wx * dt; p.z += wz * dt; p.y += Math.sin(this.time * 0.4 + i * 2.1) * dt * 0.25;
        if (p.x > 220) { // respawn upwind — a third of the sheets seeded near a live fire so smoke pools where it should
          p.x = -220; p.z = Math.random() * 340 - 150; p.y = 2.5 + Math.random() * 7; p.s = 26 + Math.random() * 26;
          const src = this.smokeSources.length && Math.random() < 0.33 ? this.smokeSources[(Math.random() * this.smokeSources.length) | 0] : null;
          if (src) { p.x = src.x - 30 - Math.random() * 40; p.z = src.z + (Math.random() - 0.5) * 30; }
        }
        this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.billboard);
        this.dummy.scale.set(p.s, p.s * 0.55, 1); this.dummy.updateMatrix(); this.hazeMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.hazeMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.pennantMesh) { // pennants track their bearers; a fallen standard simply vanishes
      const sim = this.sim; let pi = 0;
      for (const u of sim.units) {
        if (pi >= 320) break;
        if (u.bearer < 0 || !sim.alive[u.bearer]) continue;
        const b = u.bearer;
        this.dummy.position.set(sim.px[b], sim.py[b] + 3.1 + Math.sin(this.time * 2 + b) * 0.1, sim.pz[b]);
        this.dummy.quaternion.copy(this.billboard); this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix(); this.pennantMesh.setMatrixAt(pi, this.dummy.matrix);
        this._col.copy(sim.fac[b] === 0 ? COL_ATTACK : COL_DEFEND).multiplyScalar(u.shaken ? 0.6 : 1);
        this.pennantMesh.setColorAt(pi, this._col); pi++;
      }
      for (let k = pi; k < 320; k++) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.pennantMesh.setMatrixAt(k, this.dummy.matrix); }
      this.pennantMesh.instanceMatrix.needsUpdate = true; if (this.pennantMesh.instanceColor) this.pennantMesh.instanceColor.needsUpdate = true;
    }
    // ---- melee clash sparks + the rolling clash centroid (auto-director POI) ----
    const clashes = this.sim.drainClashes();
    this.clashPoi.heat *= Math.exp(-dt / 3);
    for (let c = 0; c + 1 < clashes.length; c += 2) {
      const cx = clashes[c], cz = clashes[c + 1];
      this.clashPoi.heat = Math.min(1.5, this.clashPoi.heat + 0.04);
      this.clashPoi.x += (cx - this.clashPoi.x) * 0.08; this.clashPoi.z += (cz - this.clashPoi.z) * 0.08;
      if (Math.random() < 0.3) { // don't spark EVERY blow — glints, not a fireworks show
        const s = this.sparks[this.sparkHead]; this.sparkHead = (this.sparkHead + 1) % this.sparks.length;
        s.x = cx + (Math.random() - 0.5); s.y = 1.0 + Math.random() * 0.7; s.z = cz + (Math.random() - 0.5);
        s.vx = (Math.random() - 0.5) * 4; s.vy = 1.5 + Math.random() * 2.5; s.vz = (Math.random() - 0.5) * 4;
        s.max = 0.16 + Math.random() * 0.18; s.life = s.max;
      }
      if (Math.random() < 0.06) this.spawnDust(cx, 0.8, cz, 2.2, 1); // scuffed earth under the melee
    }
    if (this.sparkMesh) {
      for (let i = 0; i < this.sparks.length; i++) {
        const s = this.sparks[i];
        if (s.life > 0) { s.life -= dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vy -= 14 * dt; const k = Math.max(0, s.life / s.max), sc = 0.5 + 0.7 * k; this.dummy.position.set(s.x, s.y, s.z); this.dummy.quaternion.copy(this.billboard); this.dummy.scale.set(sc, sc, sc); }
        else { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); }
        this.dummy.updateMatrix(); this.sparkMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.sparkMesh.instanceMatrix.needsUpdate = true;
    }
    // ---- the town alight: flaming arrows that come down beside a house ignite it ----
    const lands = this.sim.drainFireLands();
    for (let c = 0; c + 1 < lands.length; c += 2) this.igniteHouse(lands[c], lands[c + 1], 9);
    // gatehouse oil: a scalding gout — steam, embers, a shock ring at the gate
    const pours = this.sim.drainOilPours();
    for (let c = 0; c + 1 < pours.length; c += 2) {
      this.spawnDust(pours[c], 5.5, pours[c + 1], 3.2, 4);
      this.spawnShock(pours[c], pours[c + 1], 0.8);
      for (let k = 0; k < 4; k++) this.spawnEmber(pours[c], 6, pours[c + 1]);
    }
    if (this.flameMesh) {
      // FIRE SPREADS: every so often a burning roof gifts its flame downwind
      // (east, with the prevailing wind — twice as eager in a gale, never in rain)
      if (this.weather !== 'rain') {
        for (const b of this.burning) {
          if (b.spreadT === undefined) b.spreadT = this.time + 7 + Math.random() * 5;
          if (this.time < b.spreadT || this.burning.length >= 8) continue;
          b.spreadT = this.time + 8 + Math.random() * 6;
          if (Math.random() > (this.weather === 'wind' ? 0.85 : 0.45)) continue;
          let best = -1, bd = 15 * 15;
          for (let h = 0; h < this.houses.length; h++) {
            const dx = this.houses[h].x - b.x, dz = this.houses[h].z - b.z;
            const d = dx * dx + dz * dz + (dx < 0 ? 60 : 0); // downwind (east) neighbours catch first
            if (d < bd) { bd = d; best = h; }
          }
          if (best >= 0) this.igniteHouse(this.houses[best].x, this.houses[best].z, 3);
        }
      }
      // slots 8..19 render the sim's burning-pitch patches (incendiary trebuchet ammo)
      const patches = this.sim.burnPatches;
      for (let i = 8; i < 20; i++) {
        const p = patches[i - 8];
        if (p && p.life > 0) {
          const fl = (0.7 + Math.sin(this.time * 6 + i) * 0.12) * Math.min(1, p.life / 1.5);
          this.dummy.position.set(p.x, 1.4, p.z); this.dummy.quaternion.copy(this.billboard);
          this.dummy.scale.set(fl, fl, fl); this.dummy.updateMatrix(); this.flameMesh.setMatrixAt(i, this.dummy.matrix);
          if (Math.random() < 0.25) this.spawnEmber(p.x + (Math.random() - 0.5) * 3, 1.2, p.z + (Math.random() - 0.5) * 3);
        } else { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.flameMesh.setMatrixAt(i, this.dummy.matrix); }
      }
      for (let i = 0; i < 8; i++) {
        const b = this.burning[i];
        if (b) {
          b.ph += dt * (5 + (i % 3));
          const fl = 0.9 + Math.sin(b.ph) * 0.14 + Math.random() * 0.1;
          this.dummy.position.set(b.x, b.h + 1.6 + Math.sin(b.ph * 0.6) * 0.2, b.z); this.dummy.quaternion.copy(this.billboard);
          this.dummy.scale.set(fl, fl * 1.3, fl); this.dummy.updateMatrix(); this.flameMesh.setMatrixAt(i, this.dummy.matrix);
          if (Math.random() < 0.2) this.spawnEmber(b.x, b.h + 2.2, b.z);
        } else { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.flameMesh.setMatrixAt(i, this.dummy.matrix); }
      }
      this.flameMesh.instanceMatrix.needsUpdate = true;
    }
    // ---- the victory beat: the garrison's banner falls, yours rises over the keep ----
    if (this.victT > 0) {
      this.victT = Math.max(0, this.victT - dt / 3.2);
      const k = 1 - this.victT;
      if (this.keepFlag) this.keepFlag.scale.y = Math.max(0.001, 1 - k * 2.4);            // theirs drops fast
      if (this.victNew) this.victNew.scale.y = Math.min(1, Math.max(0.001, (k - 0.4) / 0.45)); // yours climbs the pole
      if (Math.random() < 0.5) this.spawnEmber(this.keepTop.x + (Math.random() - 0.5) * 3, this.keepTop.y - 2, this.keepTop.z);
    }
  }

  // A flaming arrow (or a collapse) sets the nearest thatched house alight — capped
  // so the town smoulders dramatically without turning into a bonfire wall.
  private igniteHouse(x: number, z: number, radius: number) {
    if (this.weather === 'rain') return; // soaked thatch won't take
    if (this.burning.length >= 8) return;
    let best = -1, bd = radius * radius;
    for (let i = 0; i < this.houses.length; i++) {
      const h = this.houses[i], d = (h.x - x) * (h.x - x) + (h.z - z) * (h.z - z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return;
    const h = this.houses.splice(best, 1)[0]; // a house burns once
    this.burning.push({ ...h, ph: Math.random() * 6.28 });
    this.smokeSources.push({ x: h.x, y: h.h + 1.5, z: h.z, s: 2.6, rate: 0.55, dark: 0.72, t: Math.random() * 0.3 });
    this.spawnDust(h.x, h.h, h.z, 4, 3);
  }

  // The hero beat on victory — called by main when the day is won.
  heroVictory() {
    if (this.victT > 0 || !this.keepFlag) return;
    this.victT = 1;
    this.victNew = this.makeBanner(this.keepTop.x + 0.26, this.keepTop.y, this.keepTop.z, 4.2, 2.5, COL_ATTACK);
    this.victNew.scale.y = 0.001; this.scene.add(this.victNew);
    this.spawnShock(this.keepTop.x, this.keepTop.z, 2.0);
  }

  // Cinematic assault opening: start low behind the host, crane up and back to
  // wherever the player had framed the deploy. Any camera input cancels (introT=0).
  cinematicIntro() {
    this.introTo = { tx: this.camTarget.x, tz: this.camTarget.z, d: this.camDist, yaw: this.camYaw, pitch: this.camPitch };
    this.introFrom = { tx: LAYOUT.gate.x * 0.5, tz: LAYOUT.D * 0.5 + 58, d: 48, yaw: this.camYaw * 0.25, pitch: 0.34 };
    this.introT = 1;
  }

  // Did a wall/gate section come down within the last half-second? (drives the
  // decisive-moment slow-mo in main)
  hasFreshBreach(): boolean { return this.lastBreach.t > 0 && this.time - this.lastBreach.t < 0.5; }

  // During player idle, drift gently toward where the battle actually is — the
  // freshest breach first, else the thick of the melee. Cancelled by any input.
  autoDirect(dt: number) {
    if (this.introT > 0 || this.victT > 0) return;
    const poi = (this.time - this.lastBreach.t < 14) ? this.lastBreach
      : (this.clashPoi.heat > 0.25 ? this.clashPoi : null);
    if (!poi) return;
    const k = Math.min(1, dt * 0.35);
    this.camTarget.x += (poi.x - this.camTarget.x) * k * 0.5;
    this.camTarget.z += (poi.z + 8 - this.camTarget.z) * k * 0.5;
    this.camYaw += dt * 0.014; // the slow cinematic orbit of a director's crane
    this.clampTarget();
  }

  // Begin the collapse: debris + dust burst; the box sinks over ~0.7s (render()).
  private crumble(s: number) {
    const v = this.segVis[s]; if (!v || v.crumbling > 0) return;
    v.crumbling = 0.0001; v.mat.color.copy(this.rubbleMat.color);
    // a real collapse leaves a MOUND of fallen ashlar spilling from the breach
    const seg = CASTLE[s], sw = seg.x1 - seg.x0, sd = seg.z1 - seg.z0;
    this.spawnRubble(v.box.position.x, v.box.position.z, Math.max(sw, sd), v.h, sw >= sd);
    // Schedule ONE shadow-map refresh for just after the collapse settles. The
    // frozen map only needs re-baking once the rubble has stopped moving — doing
    // it per frame for 0.7s was re-rendering the whole scene depth ~40 times and
    // is exactly what stuttered the moment a gate fell. New collapses extend the
    // timer so a cluster of breaches coalesces into a single re-bake.
    this.shadowDirtyT = 0.85;
    for (const e of v.extras) e.visible = false;
    this.spawnDebris(v.box.position.x, v.h * 0.5, v.box.position.z, 16);
    this.spawnDust(v.box.position.x, v.h * 0.5, v.box.position.z, 9, 6);
    this.spawnShock(v.box.position.x, v.box.position.z, 2.4); this.shake(1.0); // the wall comes down
    this.lastBreach = { x: v.box.position.x, z: v.box.position.z, t: this.time }; // the auto-director looks here
    if (Math.random() < 0.6) this.igniteHouse(v.box.position.x, v.box.position.z, 16); // collapses scatter fire into the town
  }

  // A persistent pile of tumbled ashlar at a breach — center-heavy, spilling along
  // the wall's run, sharing the wall's stone material so it reads as the wall's own
  // fallen blocks (not generic scree).
  private rubbleStoneMat?: THREE.MeshLambertMaterial;
  private spawnRubble(x: number, z: number, wid: number, h: number, horiz: boolean) {
    if (!this.rubbleStoneMat) {
      const m = this.stone('#bcb096'); m.map = this.texStone; m.normalMap = this.texStoneN; m.normalScale.set(0.7, 0.7); m.vertexColors = true;
      this.rubbleStoneMat = m;
    }
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const geos: THREE.BufferGeometry[] = [];
    const along = Math.max(6, wid * 0.55), n = 12 + Math.floor(wid / 2);
    for (let i = 0; i < n; i++) {
      const t = rnd(-1, 1), dcen = Math.abs(t);
      const ox = horiz ? t * along : rnd(-4, 4), oz = horiz ? rnd(-4, 4) : t * along;
      const s = rnd(1.1, 3.0) * (1 - dcen * 0.28);
      const py = rnd(0.05, 0.4) + (1 - dcen) * h * 0.32 * Math.random(); // mounded toward the centre
      const g = new THREE.BoxGeometry(s * rnd(0.8, 1.3), s * rnd(0.5, 0.9), s * rnd(0.8, 1.3))
        .rotateX(rnd(-0.5, 0.5)).rotateZ(rnd(-0.5, 0.5)).rotateY(Math.random() * 3.14).translate(x + ox, py, z + oz);
      this.paint(g, new THREE.Color('#bcb096').multiplyScalar(rnd(0.58, 1.02)));
      geos.push(g);
    }
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), this.rubbleStoneMat);
    mesh.castShadow = mesh.receiveShadow = true; this.scene.add(mesh);
  }

  private buildSoldiers() {
    const col = new THREE.Color(), idn = new THREE.Matrix4();
    this.uObj.value.set(LAYOUT.gate.x, 0, 0); // the castle centre sprites orient toward
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
        shader.uniforms.uTime = this.uTime; shader.uniforms.uRight = this.uRight; shader.uniforms.uHalfH = { value: halfH }; shader.uniforms.uObj = this.uObj;
        shader.vertexShader = 'attribute vec3 iPos;\nattribute float iScale;\nattribute float iPhase;\nattribute float iState;\nattribute float iYaw;\nattribute float iFace;\n'
          + 'uniform float uTime;\nuniform vec3 uRight;\nuniform float uHalfH;\nuniform vec3 uObj;\nvarying float vFlip;\n'
          + shader.vertexShader.replace('#include <begin_vertex>', SOLDIER_VERT);
        // tint only the heraldry (green key) with the faction colour; keep the rest baked
        shader.fragmentShader = ('varying float vFlip;\n' + shader.fragmentShader)
          .replace('#include <color_fragment>', '')
          .replace('#include <map_fragment>', SOLDIER_FRAG);
      };
      mat.customProgramCacheKey = () => 'castleSoldier';
      const geo = new THREE.PlaneGeometry(SPRITE_W[t], SPRITE_H[t]);
      // The commissioned art doesn't all face the same way (heavy is drawn facing
      // left, the rest right). Mirror the odd ones by flipping their U so the whole
      // host reads as one formation facing the same direction.
      if (FLIP[t]) { const uv = geo.attributes.uv as THREE.BufferAttribute; for (let k = 0; k < uv.count; k++) uv.setX(k, 1 - uv.getX(k)); uv.needsUpdate = true; }
      const mesh = new THREE.InstancedMesh(geo, mat, total);
      mesh.frustumCulled = false;
      for (let k = 0; k < total; k++) mesh.setMatrixAt(k, idn); // identity -> shader supplies the transform
      mesh.instanceMatrix.needsUpdate = true;
      const iPos = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const iScale = new THREE.InstancedBufferAttribute(new Float32Array(total), 1);
      const iPhase = new THREE.InstancedBufferAttribute(new Float32Array(total), 1);
      const iState = new THREE.InstancedBufferAttribute(new Float32Array(total), 1).setUsage(THREE.DynamicDrawUsage);
      const iYaw = new THREE.InstancedBufferAttribute(new Float32Array(total), 1).setUsage(THREE.DynamicDrawUsage);
      const iFace = new THREE.InstancedBufferAttribute(new Float32Array(total), 1); // +1 attacker faces castle, -1 defender faces field
      geo.setAttribute('iPos', iPos); geo.setAttribute('iScale', iScale); geo.setAttribute('iPhase', iPhase);
      geo.setAttribute('iState', iState); geo.setAttribute('iYaw', iYaw); geo.setAttribute('iFace', iFace);
      for (let i = 0; i < this.sim.n; i++) {
        if (this.sim.typ[i] !== t) continue;
        const slot = this.sim.slot[i];
        const bse = this.sim.fac[i] === Faction.Attacker ? COL_ATTACK : COL_DEFEND;
        const br = 0.82 + jit(i, 2) * 0.32;
        col.setRGB(bse.r * br * (0.95 + jit(i, 3) * 0.1), bse.g * br, bse.b * br * (0.95 + jit(i, 4) * 0.1));
        mesh.setColorAt(slot, col);
        iScale.array[slot] = this.sscale[i]; iPhase.array[slot] = i * 1.7;
        iFace.array[slot] = this.sim.fac[i] === Faction.Attacker ? 1 : -1;
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
    this.fireTex = ftex;
    // HDR-bright (color > 1, toneMapped off) so flaming arrows punch through the bloom threshold and glow
    const fireMat = new THREE.MeshBasicMaterial({ map: ftex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    fireMat.color.setRGB(2.6, 1.7, 0.85);
    this.fireMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 1.6), fireMat, 450);
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
    const list = this.sim.ballistae;
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
    const col: number[] = []; const c = new THREE.Color(color), gold = new THREE.Color('#b8923e'); // muted old-gold so full sun never pushes it over the bloom threshold
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
    const t = this.time * (this.weather === 'wind' ? 3.6 : 2.4);
    for (const f of this.flags) {
      if (!f.mesh.visible) continue;
      const p = f.mesh.geometry.attributes.position, a = p.array as Float32Array, b = f.base;
      for (let i = 0; i < a.length; i += 3) {
        const lx = b[i]; // distance from the pole along the cloth
        a[i + 2] = Math.sin(t + lx * 1.5 + f.ph) * f.amp * (0.25 + lx * 0.13); // more flutter toward the fly
      }
      p.needsUpdate = true; // flat cloth normals suffice — per-flag-per-frame normal recompute was pure churn
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
    this.camera.position.copy(this.camTarget).add(this._v2.set(sy * cp, sp, cy * cp).multiplyScalar(this.camDist));
    this.camera.lookAt(this.camTarget);
    if (this.shakeAmt > 0.002) { // jolt the camera on impacts (scaled to zoom so it reads at any distance)
      const s = this.shakeAmt * this.camDist * 0.012;
      this.camera.position.x += (Math.random() - 0.5) * s; this.camera.position.y += (Math.random() - 0.5) * s; this.camera.position.z += (Math.random() - 0.5) * s;
    }
    if (this.camera.position.y < 1.1) this.camera.position.y = 1.1; // anywhere but underground
    const dir = this._v2.subVectors(this.camera.position, this.camTarget);
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
        if (v.prevHp - seg.hp > 28) { this.spawnShock(v.box.position.x, v.box.position.z, 1.3); this.shake(0.5); } // a trebuchet stone landed
        const ratio = Math.max(0, seg.hp / v.maxhp);
        v.mat.color.copy(v.base).lerp(this.dmgColor, 1 - ratio);
      }
      v.prevHp = seg.hp;
      if (v.crumbling > 0 && v.crumbling < 1) {
        v.crumbling = Math.min(1, v.crumbling + dt / 0.7);
        const e = v.crumbling, k = 1 - 0.84 * e;
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
    this.stepSmoke(dt);
  }

  // Smoke: fire sources emit puffs that rise, drift on the wind, swell, and dissolve
  // into the haze (colour lerps from soot toward the sky, faking an alpha fade).
  private _sootCol = new THREE.Color('#2a2620');
  private _smokeCol = new THREE.Color();
  private stepSmoke(dt: number) {
    if (!this.smokeMesh) return;
    const fog = this._fogCol ?? (this._fogCol = new THREE.Color(this.biomeCfg.fog)); const wind = 1.6;
    for (const src of this.smokeSources) {
      if (src.seg !== undefined && ((this.segVis[src.seg]?.crumbling ?? 0) > 0 || CASTLE[src.seg]?.dead)) continue; // its wall fell — the fire is out
      src.t -= dt;
      if (src.t <= 0) {
        src.t += src.rate;
        const p = this.smoke[this.smokeHead]; this.smokeHead = (this.smokeHead + 1) % this.smoke.length;
        p.x = src.x + (Math.random() - 0.5) * src.s * 0.35; p.z = src.z + (Math.random() - 0.5) * src.s * 0.35; p.y = src.y;
        p.s = src.s * (0.6 + Math.random() * 0.5); p.max = 4 + Math.random() * 3; p.life = p.max;
      }
    }
    let anyColor = false;
    for (let i = 0; i < this.smoke.length; i++) {
      const p = this.smoke[i];
      if (p.life <= 0) { this.dummy.position.set(0, -1000, 0); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.smokeMesh.setMatrixAt(i, this.dummy.matrix); continue; }
      p.life -= dt;
      const t = 1 - p.life / p.max;
      p.y += dt * (2.0 + t * 2.4); p.x += dt * wind * (0.5 + t); // rise + drift, faster with age
      const grow = 0.55 + t * 2.8, fade = t > 0.7 ? (1 - t) / 0.3 : Math.min(1, 0.55 + t * 4); // visible dark base from birth
      const sc = p.s * grow * Math.max(0.02, fade);
      this._smokeCol.copy(this._sootCol).lerp(fog, Math.min(0.66, t * 0.5)); this.smokeMesh.setColorAt(i, this._smokeCol); anyColor = true;
      this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.billboard); this.dummy.scale.set(sc, sc, sc); this.dummy.updateMatrix();
      this.smokeMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.smokeMesh.instanceMatrix.needsUpdate = true;
    if (anyColor && this.smokeMesh.instanceColor) this.smokeMesh.instanceColor.needsUpdate = true;
  }

  render(dt = 0.016) {
    const sim = this.sim;
    this.time += dt;
    this.shakeAmt *= Math.exp(-dt * 7); // camera-shake decay
    if (this.introT > 0) { // the assault-opening crane shot: low behind the host → the player's framing
      this.introT = Math.max(0, this.introT - dt / 3.4);
      const k = 1 - this.introT, s = k * k * (3 - 2 * k), f = this.introFrom, o = this.introTo;
      this.camTarget.x = f.tx + (o.tx - f.tx) * s; this.camTarget.z = f.tz + (o.tz - f.tz) * s;
      this.camDist = f.d + (o.d - f.d) * s; this.camYaw = f.yaw + (o.yaw - f.yaw) * s; this.camPitch = f.pitch + (o.pitch - f.pitch) * s;
    }
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
    this.updateAssaultWorks();
    this.updateAtmosphere(dt);

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
        if (this.corpse![i]) {             // a settled body: after ~22s the field reclaims it (sink away)
          const age = (this.corpseAge![i] += dt);
          if (age > 22 && age < 36) { ip[b3 + 1] = -(age - 22) * 0.055; posD[t] = true; }
          continue;
        }
        this.corpse![i] = 1; anyLive = true;
        this._col.setRGB(0.17, 0.16, 0.15); this.meshes[t].setColorAt(slot, this._col); this.colorDirty[t] = true; // grey out
        (this.iYawA[t].array as Float32Array)[slot] = jit(i, 6) * 6.283;
        ip[b3] = sim.px[i]; ip[b3 + 1] = 0; ip[b3 + 2] = sim.pz[i]; // y=0: the sink-away pass writes negatives from here
        ist[slot] = 2; posD[t] = true; this.iYawA[t].needsUpdate = true;
        if (shOn) sa[i * 16 + 13] = -1000; continue;
      }
      // a breaking company reads broken: desaturate + dim its men while they rout
      const routing = sim.units[sim.unit[i]].routing ? 1 : 0;
      if (routing !== this.routFlag![i]) {
        this.routFlag![i] = routing;
        const bse = sim.fac[i] === Faction.Attacker ? COL_ATTACK : COL_DEFEND, br = 0.82 + jit(i, 2) * 0.32;
        this._col.setRGB(bse.r * br * (0.95 + jit(i, 3) * 0.1), bse.g * br, bse.b * br * (0.95 + jit(i, 4) * 0.1));
        if (routing) { const l = (this._col.r + this._col.g + this._col.b) / 3; this._col.lerp(new THREE.Color(l, l, l), 0.62).multiplyScalar(0.78); }
        this.meshes[t].setColorAt(slot, this._col); this.colorDirty[t] = true;
      }
      if (routing && Math.random() < 0.002) this.spawnDust(sim.px[i], 0.5, sim.pz[i], 1.6, 1); // panicked heels kick dust
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

    let ac = 0, bc = 0, fc = 0; const up = this._up, v = this._v1;
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
    // draw exactly the live projectiles — instances beyond .count are never
    // rasterised, so no hide-fill and no full-capacity upload every frame
    this.projMesh.count = ac; this.boulderMesh.count = bc; this.fireMesh.count = fc;
    this.projMesh.instanceMatrix.needsUpdate = true; this.boulderMesh.instanceMatrix.needsUpdate = true; this.fireMesh.instanceMatrix.needsUpdate = true;

    this.updateCamera(); this.composer.render();
  }

  raycastGround(nx: number, ny: number): THREE.Vector3 | null {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const pt = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt) ? pt : null;
  }

  clampTarget() {
    this.camTarget.x = Math.max(WORLD.minX, Math.min(WORLD.maxX, this.camTarget.x));
    this.camTarget.z = Math.max(WORLD.minZ - 10, Math.min(WORLD.maxZ + 10, this.camTarget.z));
    // free-range camera: right down among the soldiers, out to a full theatre
    // view, and low enough to skim the grass — anywhere but underground
    // (updateCamera floors the eye at y=1.1).
    this.camDist = Math.max(11, Math.min(560, this.camDist)); // the broad theatre needs the longer pull-back
    this.camPitch = Math.max(0.07, Math.min(1.46, this.camPitch));
  }
}
