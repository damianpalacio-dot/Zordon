// Real-time 3D Zordon: a sculpted head floating in an energy tube.
// Built from primitives so it ships without model files and runs offline.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const ALERT_COLORS = {
  green: new THREE.Color('#4fc3ff'),
  yellow: new THREE.Color('#ffb340'),
  red: new THREE.Color('#ff3b3b'),
};

// Head silhouette (radius, height) revolved around the vertical axis, smoothed with a spline.
// Tall dome, broad cheekbones, strong jaw — the classic floating-head proportions.
const PROFILE = [
  [0.0, -1.32], [0.3, -1.29], [0.5, -1.17], [0.62, -0.96], [0.69, -0.7], [0.74, -0.4],
  [0.79, -0.08], [0.81, 0.26], [0.82, 0.6], [0.8, 0.92], [0.72, 1.18], [0.56, 1.38],
  [0.34, 1.51], [0.13, 1.56], [0.0, 1.57],
];
const SX = 0.9; // narrower side to side
const SZ = 0.9; // depth front to back
const PROFILE_PTS = new THREE.SplineCurve(PROFILE.map(([r, y]) => new THREE.Vector2(r, y))).getPoints(120);

function radiusAt(y) {
  for (let i = 1; i < PROFILE_PTS.length; i++) {
    const a = PROFILE_PTS[i - 1];
    const b = PROFILE_PTS[i];
    if (y >= a.y && y <= b.y) return a.x + ((y - a.y) / (b.y - a.y || 1)) * (b.x - a.x);
  }
  return 0;
}

// Point on the (unsculpted) face surface at (x, y), pushed out by `lift`.
function onFace(x, y, lift = 0) {
  const r = radiusAt(y);
  const k = Math.min(0.98, Math.abs(x) / (r * SX));
  return new THREE.Vector3(x, y, r * SZ * Math.sqrt(1 - k * k) + lift);
}

// Facial sculpt: smooth bumps (+) and hollows (−) pushed along the surface normal.
// [cx, cy, sx, sy, amount]
const MOUTH_Y = -0.56;
const FEATURES = [
  [0, 0.44, 0.46, 0.085, 0.075], // brow ridge
  [0, 0.37, 0.07, 0.06, -0.025], // glabella
  [-0.26, 0.27, 0.15, 0.085, -0.085], [0.26, 0.27, 0.15, 0.085, -0.085], // eye sockets
  [-0.26, 0.19, 0.13, 0.05, 0.02], [0.26, 0.19, 0.13, 0.05, 0.02], // lower lids
  [0, 0.14, 0.055, 0.2, 0.055], // nose bridge
  [0, -0.1, 0.075, 0.15, 0.12], // nose
  [0, -0.24, 0.085, 0.07, 0.1], // nose tip
  [-0.1, -0.27, 0.06, 0.05, 0.05], [0.1, -0.27, 0.06, 0.05, 0.05], // nostril wings
  [0, -0.38, 0.06, 0.045, -0.02], // philtrum
  [-0.43, -0.02, 0.16, 0.1, 0.055], [0.43, -0.02, 0.16, 0.1, 0.055], // cheekbones
  [-0.38, -0.42, 0.13, 0.16, -0.035], [0.38, -0.42, 0.13, 0.16, -0.035], // cheek hollows
  [0, MOUTH_Y + 0.05, 0.2, 0.038, 0.06], // upper lip
  [0, MOUTH_Y, 0.21, 0.014, -0.06], // lip line
  [0, MOUTH_Y - 0.055, 0.18, 0.042, 0.065], // lower lip
  [0, -0.74, 0.15, 0.045, -0.025], // under-lip crease
  [0, -0.97, 0.24, 0.15, 0.07], // chin
  [-0.62, 0.58, 0.12, 0.22, -0.025], [0.62, 0.58, 0.12, 0.22, -0.025], // temples
];

function sculptHead() {
  const geo = new THREE.LatheGeometry(PROFILE_PTS, 180, Math.PI); // seam at the back of the head
  geo.scale(SX, 1, SZ);
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const open = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    const r = radiusAt(v.y) || 1e-3;
    const front = THREE.MathUtils.smoothstep(v.z / (r * SZ), 0.15, 0.7); // only sculpt the face side
    let d = 0;
    for (const [cx, cy, sx, sy, amt] of FEATURES) {
      d += amt * Math.exp(-(((v.x - cx) ** 2) / (sx * sx) + ((v.y - cy) ** 2) / (sy * sy)));
    }
    v.addScaledVector(n, d * front);
    pos.setXYZ(i, v.x, v.y, v.z);
    // Morph target: jaw and lower lip drop when he speaks.
    const jaw = front * THREE.MathUtils.smoothstep(MOUTH_Y - v.y, -0.005, 0.07) * Math.exp(-(v.x * v.x) / 0.16)
      * THREE.MathUtils.smoothstep(v.y, -1.3, -0.9);
    open[i * 3] = v.x;
    open[i * 3 + 1] = v.y - 0.085 * jaw;
    open[i * 3 + 2] = v.z - 0.03 * jaw;
  }
  geo.morphAttributes.position = [new THREE.Float32BufferAttribute(open, 3)];
  geo.computeVertexNormals();
  return geo;
}

const rimShader = (color) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uPower: { value: 1 } },
  vertexShader: `
    varying vec3 vNormal; varying vec3 vView; varying float vY;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      vY = position.y;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 uColor; uniform float uTime; uniform float uPower;
    varying vec3 vNormal; varying vec3 vView; varying float vY;
    void main() {
      float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.4);
      float scan = 0.82 + 0.18 * sin(vY * 140.0 - uTime * 6.0);
      gl_FragColor = vec4(uColor * rim * scan * 1.25 * uPower, rim * 0.8);
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

const tubeShader = (color) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uPower: { value: 1 } },
  vertexShader: `
    varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
    void main() {
      vUv = uv;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 uColor; uniform float uTime; uniform float uPower;
    varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
    void main() {
      float facing = abs(dot(vNormal, vView));
      float edge = pow(1.0 - facing, 1.6);
      float bands = 0.5 + 0.5 * sin(vUv.y * 38.0 - uTime * 3.2);
      float streaks = 0.5 + 0.5 * sin(vUv.x * 60.0 + uTime * 0.7 + sin(vUv.y * 9.0 + uTime));
      float fade = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
      float glow = (0.04 + edge * 0.75 + bands * 0.07 + streaks * 0.04) * fade * uPower;
      gl_FragColor = vec4(uColor * glow, glow * 0.5);
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  depthWrite: false,
});

function buildHead() {
  const head = new THREE.Group();
  const skin = new THREE.MeshPhysicalMaterial({
    color: '#9cc9ea',
    emissive: '#1a5590',
    emissiveIntensity: 0.3,
    roughness: 0.46,
    metalness: 0.05,
    clearcoat: 0.5,
    clearcoatRoughness: 0.4,
    sheen: 0.6,
    sheenColor: new THREE.Color('#8fd8ff'),
    transparent: true,
    opacity: 0.95,
  });
  const face = new THREE.Mesh(sculptHead(), skin);
  face.morphTargetInfluences = [0];
  head.add(face);
  head.userData.face = face;

  const blob = (sx, sy, sz, pos, mat) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), mat);
    m.scale.set(sx, sy, sz);
    m.position.copy(pos);
    head.add(m);
    return m;
  };

  // Mouth interior sits just behind the lips and shows when the jaw drops.
  blob(0.17, 0.045, 0.05, onFace(0, MOUTH_Y - 0.035, -0.06), new THREE.MeshBasicMaterial({ color: '#020810' }));

  // Deep-set, softly glowing eyes.
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#b9dcf2', emissive: '#2f7fbf', emissiveIntensity: 0.45, roughness: 0.25 });
  const irisMat = new THREE.MeshBasicMaterial({ color: '#2a78b8' });
  for (const s of [-1, 1]) {
    const c = onFace(s * 0.26, 0.265, -0.115);
    const eye = blob(0.08, 0.042, 0.05, c, eyeMat);
    const iris = blob(0.028, 0.028, 0.012, c.clone().add(new THREE.Vector3(0, 0, 0.044)), irisMat);
    head.userData[`eye${s}`] = [eye, iris];
    // Ears.
    blob(0.06, 0.22, 0.13, new THREE.Vector3(s * radiusAt(0.12) * SX * 0.98, 0.1, -0.02), skin);
  }

  // Holographic rim shell.
  const shell = new THREE.Mesh(face.geometry, rimShader(ALERT_COLORS.green));
  shell.morphTargetInfluences = face.morphTargetInfluences; // follows the jaw
  shell.scale.setScalar(1.025);
  head.add(shell);
  head.userData.shell = shell;
  return head;
}

function buildTube(color) {
  const group = new THREE.Group();
  const H = 6.4;
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, H, 96, 1, true), tubeShader(color));
  const core = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, H, 64, 1, true), tubeShader(color));
  core.material.uniforms.uPower.value = 0.3;
  group.add(tube, core);

  const metal = new THREE.MeshStandardMaterial({ color: '#6f7d8f', metalness: 0.9, roughness: 0.3 });
  const trim = new THREE.MeshStandardMaterial({ color: '#2a3442', metalness: 0.8, roughness: 0.45 });
  for (const y of [-H / 2, H / 2]) {
    const sign = Math.sign(y);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.09, 16, 96), metal);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 2.05, 0.45, 64), trim);
    cap.position.y = y + sign * 0.27;
    const lights = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.035, 8, 96),
      new THREE.MeshBasicMaterial({ color: color.clone() }));
    lights.rotation.x = Math.PI / 2;
    lights.position.y = y + sign * 0.27;
    group.add(ring, cap, lights);
    group.userData.lights = [...(group.userData.lights || []), lights];
  }

  // Rising energy motes.
  const N = 260;
  const pos = new Float32Array(N * 3);
  const speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.25 + Math.random() * 1.25;
    pos.set([Math.cos(a) * r, (Math.random() - 0.5) * H, Math.sin(a) * r], i * 3);
    speed[i] = 0.3 + Math.random() * 0.9;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const motes = new THREE.Points(geo, new THREE.PointsMaterial({
    color: color.clone(), size: 0.045, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  motes.userData = { speed, H };
  group.add(motes);
  Object.assign(group.userData, { tube, core, motes });
  return group;
}

export function createZordon(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    container.classList.add('zordon-fallback');
    return { setAlert() {}, animate() {}, speak: (t) => speakOnly(t), stop() { window.speechSynthesis?.cancel(); }, dispose() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#03060c');
  scene.fog = new THREE.Fog('#03060c', 9, 18);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0.25, 10.5);

  scene.add(new THREE.AmbientLight('#35506f', 0.35));
  const key = new THREE.DirectionalLight('#e8f6ff', 2.6);
  key.position.set(3, 3.5, 4);
  const fill = new THREE.PointLight('#4fc3ff', 6, 12);
  fill.position.set(-3, -0.5, 3);
  const under = new THREE.PointLight('#4fc3ff', 5, 8);
  under.position.set(0, -2.6, 1.8);
  scene.add(key, fill, under);

  let color = ALERT_COLORS.green.clone();
  const tube = buildTube(color);
  const head = buildHead();
  head.scale.setScalar(1.42);
  scene.add(tube, head);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 0.42);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    // Keep the whole tube in frame on narrow screens.
    camera.position.z = w / h < 0.8 ? 13 : 10.5;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const pointer = new THREE.Vector2();
  const onMove = (e) => {
    const r = container.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
  };
  window.addEventListener('pointermove', onMove);

  let speaking = false;
  let mouthTarget = 0;
  let alertLevel = 'green';

  const clock = new THREE.Timer();
  let nextBlink = 2;
  let raf;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!container.isConnected || document.hidden) return;
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsed();

    const alarm = alertLevel === 'red' ? 0.75 + 0.35 * Math.max(0, Math.sin(t * 5)) : 1;
    const power = (speaking ? 1.25 + 0.15 * Math.sin(t * 18) : 1) * alarm;
    for (const m of [tube.userData.tube, tube.userData.core, head.userData.shell]) {
      m.material.uniforms.uTime.value = t;
      m.material.uniforms.uColor.value.lerp(color, 0.05);
    }
    tube.userData.tube.material.uniforms.uPower.value = power;
    head.userData.shell.material.uniforms.uPower.value = power;
    for (const l of tube.userData.lights) l.material.color.lerp(color, 0.05);
    tube.userData.motes.material.color.lerp(color, 0.05);
    fill.color.lerp(color, 0.05);
    under.color.lerp(color, 0.05);

    const p = tube.userData.motes.geometry.attributes.position;
    const { speed, H } = tube.userData.motes.userData;
    for (let i = 0; i < speed.length; i++) {
      let y = p.getY(i) + speed[i] * dt * (speaking ? 2.2 : 1);
      if (y > H / 2) y = -H / 2;
      p.setY(i, y);
    }
    p.needsUpdate = true;

    // Float and gently follow the viewer.
    head.position.y = 0.05 + Math.sin(t * 0.8) * 0.07;
    head.rotation.y += (pointer.x * 0.35 + Math.sin(t * 0.3) * 0.06 - head.rotation.y) * 0.04;
    head.rotation.x += (-pointer.y * 0.12 - head.rotation.x) * 0.04;

    // Blink.
    nextBlink -= dt;
    const blink = nextBlink < 0.12 && nextBlink > 0 ? 1 : 0;
    if (nextBlink < 0) nextBlink = 2.5 + Math.random() * 4;
    for (const s of [-1, 1]) {
      for (const part of head.userData[`eye${s}`]) part.scale.y += ((blink ? 0.004 : part === head.userData[`eye${s}`][0] ? 0.042 : 0.028) - part.scale.y) * 0.5;
    }

    // Speech: the jaw follows a noisy envelope while talking.
    const target = speaking ? mouthTarget * (0.35 + 0.65 * Math.abs(Math.sin(t * 17) * Math.sin(t * 7.3))) : 0;
    const inf = head.userData.face.morphTargetInfluences;
    inf[0] += (target - inf[0]) * 0.35;
    bloom.strength = 0.5 + (speaking ? 0.2 : 0) + (alertLevel === 'red' ? 0.15 : 0);

    composer.render();
  };
  tick();

  return {
    setAlert(level) {
      alertLevel = ALERT_COLORS[level] ? level : 'green';
      color = ALERT_COLORS[alertLevel].clone();
    },
    speak(text, { onEnd } = {}) {
      speaking = true;
      mouthTarget = 1;
      const done = () => { speaking = false; mouthTarget = 0; onEnd?.(); };
      if (!speakOnly(text, {
        onBoundary: () => { mouthTarget = 0.7 + Math.random() * 0.3; },
        onEnd: done,
      })) {
        setTimeout(done, Math.min(12000, 60 * text.length));
      }
    },
    // Move the mouth while the computer's own voice is talking.
    animate(text) {
      speaking = true;
      mouthTarget = 1;
      clearTimeout(this._t);
      this._t = setTimeout(() => { speaking = false; mouthTarget = 0; }, Math.min(15000, 900 + 72 * text.length));
    },
    stop() {
      window.speechSynthesis?.cancel();
      speaking = false;
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function speakOnly(text, { onBoundary, onEnd } = {}) {
  if (!('speechSynthesis' in window)) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /daniel|george|arthur|male|david|google uk english male/i.test(v.name)) || voices.find((v) => v.lang?.startsWith('en')) || null;
  u.pitch = 0.55;
  u.rate = 0.88;
  if (onBoundary) u.onboundary = onBoundary;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
  return true;
}
