/* ═══════════════════════════════════════════════════════════════════════════
   HIVE PULSE — Scroll-driven 3D experience
   Stack: Three.js + GSAP ScrollTrigger (Vanilla JS, Vite)

   Pipeline:
     1. Renderer / scene / camera  (sRGB + ACES tone mapping)
     2. Cinematic studio lighting   (ambient + key + backlight rim)
     3. Environment map for reflections (RoomEnvironment — no HDRI file needed)
     4. GLTFLoader + LoadingManager (loads /public/model.glb, fades overlay at 100%)
     5. GSAP ScrollTrigger timeline (scrubbed → heavy, smooth, scroll-tracked)
     6. Debounced resize + RAF render loop
═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

// ── DOM refs ────────────────────────────────────────────────────────────────
const canvas     = document.getElementById('webgl')
const loaderEl   = document.getElementById('loader')
const loaderFill = document.getElementById('loaderFill')
const loaderPct  = document.getElementById('loaderPct')

// ── Sizes ─────────────────────────────────────────────────────────────────────
const sizes = { width: window.innerWidth, height: window.innerHeight }

// ── Scene ───────────────────────────────────────────────────────────────────
const scene = new THREE.Scene()

// ── Camera ──────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(38, sizes.width / sizes.height, 0.1, 100)
camera.position.set(0, 0, 6)
scene.add(camera)

// ── Renderer ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,                    // transparent so the dark CSS bg shows through
  powerPreference: 'high-performance',
})
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.outputColorSpace      = THREE.SRGBColorSpace      // correct color management
renderer.toneMapping           = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure   = 0.72                      // dialed down so the gold reads gold, not white
renderer.shadowMap.enabled     = false                     // no shadow casters in the comb — skip the pass

// ── Environment map (studio reflections, generated — no external file) ────────
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

// ── Hive brand palette ────────────────────────────────────────────────────────
const COL = { gold:0x918444, goldHi:0xC2B16A, rim:0x9FB2C0, frame:0x171B26, teal:0x2DD4BF }

// ── Cinematic studio lighting (tuned low so the gold doesn't blow out to white) ─
// Soft ambient — lifts the shadows so nothing is pure black
const ambient = new THREE.AmbientLight(0xffffff, 0.2)
scene.add(ambient)

// Directional KEY light (warm) — primary form-defining light
const keyLight = new THREE.DirectionalLight(0xfff2dd, 1.1)
keyLight.position.set(5, 6, 4)
scene.add(keyLight)

// Soft cool RIM light from behind — premium edge separation (neutral, not branded)
const backLight = new THREE.DirectionalLight(COL.rim, 0.8)
backLight.position.set(-4, 2, -6)
scene.add(backLight)

// Subtle gold fill from below-left — warmth bounce
const fillLight = new THREE.PointLight(COL.gold, 0.5, 25, 2)
fillLight.position.set(-4, -3, 3)
scene.add(fillLight)

// ── Post-processing: gentle bloom (the soft glow on the lit cells) ──────────────
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(sizes.width, sizes.height), 0.16, 0.5, 0.96)
composer.addPass(bloom)
composer.addPass(new OutputPass())

// ── Model group (we rotate/scale/move THIS, not the raw mesh) ────────────────
const modelGroup = new THREE.Group()
scene.add(modelGroup)
let model = null
let started = false   // guard: ensure the intro + scroll timeline build exactly ONCE
let pulse  = []       // [{mat, base, amp, speed, phase}] — animated emissive cells

// ── Shared geometry/material helpers for the honeycomb ───────────────────────
const frameMat = new THREE.MeshStandardMaterial({ color: COL.frame, metalness: 0.8, roughness: 0.45, envMapIntensity: 0.5 })
const edgeMat  = new THREE.LineBasicMaterial({ color: COL.teal, transparent: true, opacity: 0.16 })

function glowMat(color, baseI = 0.22) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: baseI, metalness: 0.15, roughness: 0.55, envMapIntensity: 0.4 })
}
function hexGeo(R, depth) {
  const s = new THREE.Shape()
  for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i, x = R * Math.cos(a), y = R * Math.sin(a); i ? s.lineTo(x, y) : s.moveTo(x, y) }
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.22, bevelSize: R * 0.10, bevelSegments: 4, curveSegments: 6 })
  g.center(); return g
}
const axial   = (q, r, R) => [R * 1.5 * q, R * Math.sqrt(3) * (r + q / 2)]
const hexDist = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2

// ─────────────────────────────────────────────────────────────────────────────
//  LOADING MANAGER  — drives the overlay, fades out only at 100%
// ─────────────────────────────────────────────────────────────────────────────
const loadingManager = new THREE.LoadingManager()

loadingManager.onProgress = (_url, loaded, total) => {
  const pct = Math.round((loaded / total) * 100)
  loaderFill.style.width = pct + '%'
  loaderPct.textContent  = pct + '%'
}

loadingManager.onLoad = () => {
  loaderFill.style.width = '100%'
  loaderPct.textContent  = '100%'
  // small beat so the user reads 100%, then fade
  gsap.to(loaderEl, {
    opacity: 0,
    duration: 0.8,
    delay: 0.3,
    onComplete: () => loaderEl.classList.add('hidden'),
  })
  introAnimation()
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOAD THE MODEL
//  ►►► SWAP IN YOUR ASSET HERE ◄◄◄
//  Drop your file at:  /public/model.glb   (Vite serves /public at the root)
//  If model.glb is missing, a tasteful procedural fallback loads instead so the
//  scene is never empty — delete the fallback once your real model is in place.
// ─────────────────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader(loadingManager)

gltfLoader.load(
  '/model.glb',
  // ── onLoad ──
  (gltf) => {
    model = gltf.scene
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
    fitAndCenter(model)        // normalize size + center pivot
    modelGroup.add(model)
  },
  undefined,
  // ── onError → procedural fallback (remove once real model.glb exists) ──
  (err) => {
    console.warn('[Hive Pulse] /model.glb not found — loading fallback geometry.', err)
    model = createFallbackModel()
    modelGroup.add(model)
    // LoadingManager.onLoad won't fire on an errored load, so dismiss the overlay here:
    loaderFill.style.width = '100%'
    loaderPct.textContent  = '100%'
    gsap.to(loaderEl, {
      opacity: 0, duration: 0.8, delay: 0.3,
      onComplete: () => loaderEl.classList.add('hidden'),
    })
    introAnimation()
  }
)

// ── Normalize an arbitrary GLTF so it sits centered at a consistent scale ─────
function fitAndCenter(obj) {
  const box = new THREE.Box3().setFromObject(obj)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  obj.position.sub(center)                       // center the pivot
  const maxDim = Math.max(size.x, size.y, size.z)
  const scale = 2.6 / maxDim                      // fit to ~2.6 world units
  obj.scale.setScalar(scale)
}

// ── Honeycomb Core — domed comb whose gold cells pulse outward from the centre ──
// A few brighter gold accents at the centre; the rest are dark metallic frame
// cells with a faint edge glow. Emissive is animated in the render loop (pulse[]).
function createFallbackModel() {
  const group = new THREE.Group()
  const N = 2, R = 0.46
  const glowKeys = new Set(['0,0','1,-1','-1,1','2,-1','-2,1','0,2','0,-2','1,1','-1,-1'])
  const hiKeys   = new Set(['0,0','2,-1','-2,1'])   // a few brighter gold accents

  for (let q = -N; q <= N; q++) for (let r = -N; r <= N; r++) {
    const d = hexDist(q, r); if (d > N) continue
    const [x, y] = axial(q, r, R)
    const depth = 0.52 - d * 0.10
    const geo = hexGeo(R * 0.93, depth)
    const key = q + ',' + r
    if (glowKeys.has(key)) {
      const c = hiKeys.has(key) ? COL.goldHi : COL.gold
      const m = glowMat(c, 0.22)
      const mesh = new THREE.Mesh(geo, m)
      mesh.position.set(x, y, -d * 0.05 + (0.52 - depth) / 2 + 0.04)
      group.add(mesh)
      pulse.push({ mat: m, base: 0.16, amp: 0.12, speed: 1.6, phase: d * 1.05 })
    } else {
      const mesh = new THREE.Mesh(geo, frameMat)
      mesh.position.set(x, y, -d * 0.06)
      group.add(mesh)
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat)
      e.position.copy(mesh.position); group.add(e)
    }
  }

  group.scale.setScalar(0.6)   // fit the comb in frame (camera at z=6, fov 38)
  group.rotation.x = -0.14     // dome tilt toward the camera
  return group
}

// ─────────────────────────────────────────────────────────────────────────────
//  GSAP — entrance + scroll-driven timeline
// ─────────────────────────────────────────────────────────────────────────────
function introAnimation() {
  if (started) return        // never let the fallback's onError + onLoad double-fire this
  started = true
  // soft "settle in" on load
  gsap.from(modelGroup.rotation, { y: -1.2, duration: 1.6, ease: 'power3.out' })
  gsap.from(modelGroup.scale,    { x: 0.6, y: 0.6, z: 0.6, duration: 1.6, ease: 'power3.out' })
  gsap.from(modelGroup.position, { y: -0.6, duration: 1.6, ease: 'power3.out' })

  buildScrollTimeline()
}

function buildScrollTimeline() {
  // Master timeline scrubbed to the WHOLE page scroll.
  // scrub: 1  → motion lags the scroll by ~1s of easing = "heavy", ultra-smooth,
  // perfectly tracks trackpad / wheel without feeling 1:1 stiff.
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: '#content',
      start: 'top top',
      end: 'bottom bottom',
      scrub: 1,
    },
  })

  // ── SECTION 1 → 2 : rotate 180° on Y, scale up as it enters frame ──────────
  tl.to(modelGroup.rotation, { y: Math.PI, ease: 'none' }, 0)             // 0 → 180°
    .to(modelGroup.scale,    { x: 1.25, y: 1.25, z: 1.25, ease: 'none' }, 0)
    .to(modelGroup.position, { x: 0, y: 0, ease: 'none' }, 0)

  // ── SECTION 2 → 3 : continue to 360°, shift to side-align with text ────────
  tl.to(modelGroup.rotation, { y: Math.PI * 2, ease: 'none' }, 0.5)       // 180° → 360°
    .to(modelGroup.position, { x: 1.6, y: 0.2, ease: 'none' }, 0.5)       // slide right
    .to(modelGroup.scale,    { x: 1.0, y: 1.0, z: 1.0, ease: 'none' }, 0.5)

  // ── SECTION 3 → 4 : recenter + slight overshoot for the finale ─────────────
  tl.to(modelGroup.rotation, { y: Math.PI * 2.5, ease: 'none' }, 1.0)
    .to(modelGroup.position, { x: 0, y: 0, ease: 'none' }, 1.0)
    .to(modelGroup.scale,    { x: 1.35, y: 1.35, z: 1.35, ease: 'none' }, 1.0)

  // Fade each text panel in/out as it crosses center (independent of the model tl)
  gsap.utils.toArray('.panel-text').forEach((el) => {
    gsap.fromTo(el,
      { autoAlpha: 0, y: 40 },
      {
        autoAlpha: 1, y: 0, ease: 'power2.out',
        scrollTrigger: { trigger: el.closest('.panel'), start: 'top 65%', end: 'bottom 35%', scrub: true },
      }
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cursor parallax — subtle lean toward the pointer (adds life, not distraction)
// ─────────────────────────────────────────────────────────────────────────────
const pointer = { x: 0, y: 0 }
window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / sizes.width  - 0.5) * 2
  pointer.y = (e.clientY / sizes.height - 0.5) * 2
})

// ─────────────────────────────────────────────────────────────────────────────
//  DEBOUNCED RESIZE
// ─────────────────────────────────────────────────────────────────────────────
function debounce(fn, wait = 150) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait) }
}

const onResize = debounce(() => {
  sizes.width  = window.innerWidth
  sizes.height = window.innerHeight
  camera.aspect = sizes.width / sizes.height
  camera.updateProjectionMatrix()
  renderer.setSize(sizes.width, sizes.height)
  composer.setSize(sizes.width, sizes.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  ScrollTrigger.refresh()
}, 150)

window.addEventListener('resize', onResize)

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER LOOP  (requestAnimationFrame via three's setAnimationLoop)
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock()

renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime()

  if (model) {
    // gentle idle bob + breathing even when not scrolling
    modelGroup.position.y += Math.sin(t * 0.6) * 0.0008

    // cursor parallax tilt — eased toward target so it feels weighty
    const targetRotX = pointer.y * 0.18
    const targetRotZ = -pointer.x * 0.08
    modelGroup.rotation.x += (targetRotX - modelGroup.rotation.x) * 0.04
    modelGroup.rotation.z += (targetRotZ - modelGroup.rotation.z) * 0.04
  }

  // pulse the gold cells outward from the centre
  for (const p of pulse) p.mat.emissiveIntensity = p.base + p.amp * 0.5 * (1 + Math.sin(t * p.speed + p.phase))

  composer.render()
})
