import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { type Grid, idx } from './voxelize';

// blocks float this high above the ground grid
const LIFT = 3;

export interface PreviewOptions {
  color: string;
  cutaway: boolean;
  player: boolean;
}

export class Preview {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private controls: OrbitControls;
  private geometry = new THREE.BoxGeometry(1, 1, 1);
  private material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private mesh: THREE.InstancedMesh;
  private ground: THREE.GridHelper | null = null;
  private groundSize = 0;
  private player: THREE.Group;
  private fitted = false;
  private lastFit: Grid | null = null;
  // refit on resize until the user moves the camera
  private userMoved = false;

  constructor(private container: HTMLElement) {
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('start', () => (this.userMoved = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.6, 1, 0.35);
    this.scene.add(sun);

    this.mesh = this.makeMesh(1024);
    this.player = makePlayer();
    this.scene.add(this.player);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color);
  }

  private makeMesh(capacity: number) {
    const m = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    m.count = 0;
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
    if (this.lastFit && !this.userMoved) this.fit(this.lastFit);
  }

  update(g: Grid, o: PreviewOptions) {
    const { sx, sy, sz, data } = g;
    const cut = o.cutaway ? Math.floor(sz / 2) : sz;
    const on = (i: number, j: number, k: number) =>
      i >= 0 && j >= 0 && k >= 0 && i < sx && j < sy && k < cut && data[idx(g, i, j, k)] === 1;

    const cells: number[] = [];
    for (let k = 0; k < cut; k++)
      for (let j = 0; j < sy; j++)
        for (let i = 0; i < sx; i++) {
          if (!on(i, j, k)) continue;
          if (on(i + 1, j, k) && on(i - 1, j, k) && on(i, j + 1, k) && on(i, j - 1, k) && on(i, j, k + 1) && on(i, j, k - 1))
            continue;
          cells.push(i, j, k);
        }

    const count = cells.length / 3;
    if (count > this.mesh.instanceMatrix.count) {
      this.scene.remove(this.mesh);
      this.mesh.dispose();
      let cap = this.mesh.instanceMatrix.count;
      while (cap < count) cap *= 2;
      this.mesh = this.makeMesh(cap);
    }

    const base = new THREE.Color(o.color);
    const c = new THREE.Color();
    const m = new THREE.Matrix4();
    for (let n = 0; n < count; n++) {
      const i = cells[n * 3], j = cells[n * 3 + 1], k = cells[n * 3 + 2];
      m.makeTranslation(i - sx / 2 + 0.5, j + LIFT + 0.5, k - sz / 2 + 0.5);
      this.mesh.setMatrixAt(n, m);
      const jitter = 1 + (hash(i, j, k) - 0.5) * 0.08;
      c.copy(base).multiplyScalar(jitter);
      this.mesh.setColorAt(n, c);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    const size = Math.ceil(Math.max(sx, sz) / 2) * 2 + 16;
    if (size !== this.groundSize) {
      if (this.ground) {
        this.scene.remove(this.ground);
        this.ground.dispose();
      }
      this.ground = new THREE.GridHelper(size, size, 0x777777, 0x444444);
      (this.ground.material as THREE.Material).transparent = true;
      (this.ground.material as THREE.Material).opacity = 0.35;
      this.scene.add(this.ground);
      this.groundSize = size;
    }

    this.player.visible = o.player;
    this.player.position.set(-sx / 2 - 3, 0, 0);

    if (!this.fitted) this.fit(g);
  }

  fit(g: Grid) {
    this.fitted = true;
    this.lastFit = g;
    this.userMoved = false;
    const target = new THREE.Vector3(0, LIFT + g.sy / 2, 0);
    const r = Math.hypot(g.sx, g.sy, g.sz) * 0.5 + 2;
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * 0.95;
    const dir = new THREE.Vector3(0.55, 0.35, 0.75).normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.update();
  }
}

function hash(i: number, j: number, k: number) {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// 0.6 x 1.8 block player silhouette for scale
function makePlayer() {
  const g = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0xc69c7a });
  const shirt = new THREE.MeshLambertMaterial({ color: 0x2f8f9d });
  const legs = new THREE.MeshLambertMaterial({ color: 0x3b3f8f });
  const box = (w: number, h: number, d: number, mat: THREE.Material, y: number) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    b.position.y = y;
    g.add(b);
  };
  box(0.5, 0.75, 0.3, legs, 0.375);
  box(0.5, 0.6, 0.3, shirt, 1.05);
  box(0.45, 0.45, 0.45, skin, 1.575);
  return g;
}
