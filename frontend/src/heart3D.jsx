import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function heartPoint(x, y, z, out) {
  const side = smooth(-0.6, 0.8, x);
  let px = x * 0.92 * (0.9 + 0.22 * side);
  let py = y * 1.12;
  let pz = z * (0.66 + 0.12 * smooth(-0.4, 0.4, z));

  const t = smooth(0.15, -1.0, y);
  const k = 1 - 0.5 * Math.pow(t, 1.4);
  px *= k;
  pz *= k;
  px += 0.38 * t * t;

  const tt = smooth(0.5, 1.0, y);
  py -= 0.18 * tt;
  py -= 0.1 * tt * Math.exp(-(x * x) / 0.05);

  const g =
    Math.exp(-((x - 0.16) ** 2) / 0.006) *
    smooth(0.0, 0.5, z) *
    smooth(-0.95, 0.2, y);
  pz -= 0.05 * g;

  const av = Math.exp(-((y - 0.38) ** 2) / 0.012);
  const kv = 1 - 0.045 * av;
  px *= kv;
  pz *= kv;

  const n = 1 + 0.012 * Math.sin(5 * x + 2 * y + 1) * Math.sin(4 * z + 1);
  return out.set(px * n, py * n, pz * n);
}

const surf = (az, el, r = 1.03) =>
  heartPoint(
    Math.cos(el) * Math.sin(az) * r,
    Math.sin(el) * r,
    Math.cos(el) * Math.cos(az) * r,
    new THREE.Vector3()
  );

function buildHeartGeometry() {
  let g = new THREE.SphereGeometry(1, 128, 96);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  const cTop = new THREE.Color("#c99a7a");
  const cMid = new THREE.Color("#8f3238");
  const cLow = new THREE.Color("#6e2230");

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    heartPoint(x, y, z, v);
    pos.setXYZ(i, v.x, v.y, v.z);

    c.copy(cLow).lerp(cMid, smooth(-0.9, 0.0, y)).lerp(cTop, smooth(0.35, 0.9, y));
    c.offsetHSL(0, 0, 0.06 * Math.sin(9 * x + 3 * y) * Math.sin(7 * z - 2 * y));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g = mergeVertices(g);
  g.computeVertexNormals();
  return g;
}

const STOPS = [
  [0.0, new THREE.Color("#2e9e45")],
  [0.4, new THREE.Color("#e6d02a")],
  [0.65, new THREE.Color("#f08a1c")],
  [1.0, new THREE.Color("#d32020")],
];
function riskColor(p) {
  const x = Math.min(1, Math.max(0, p || 0));
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1];
      const [b, cb] = STOPS[i];
      return ca.clone().lerp(cb, (x - a) / (b - a));
    }
  }
  return STOPS[STOPS.length - 1][1].clone();
}

const ART = {
  LAD: [[0.12, 0.75], [0.16, 0.35], [0.2, -0.1], [0.24, -0.6], [0.28, -1.0], [0.3, -1.3]],
  RCA: [[-0.2, 0.62], [-0.55, 0.4], [-1.0, 0.36], [-1.5, 0.3], [-2.0, 0.25], [-2.5, 0.2]],
  LCX: [[0.3, 0.62], [0.7, 0.42], [1.2, 0.38], [1.7, 0.34], [2.2, 0.3], [2.6, 0.25]],
};

const AORTA = [[-0.05, 0.7, 0.05], [-0.08, 1.1, 0.0], [0.05, 1.4, -0.1], [0.4, 1.5, -0.25], [0.7, 1.3, -0.4], [0.75, 0.9, -0.45]];
const PULM = [[0.2, 0.75, 0.4], [0.28, 1.0, 0.3], [0.42, 1.15, 0.15]];
const SVC = [[-0.62, 0.45, -0.1], [-0.65, 0.9, -0.12], [-0.62, 1.2, -0.12]];

function Vessel({ points, radius, color }) {
  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))),
    [points]
  );
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 60, radius, 20, false), [curve, radius]);
  const a = curve.getPoint(0).toArray();
  const b = curve.getPoint(1).toArray();
  const mat = <meshPhysicalMaterial color={color} roughness={0.45} clearcoat={0.3} />;
  return (
    <group>
      <mesh geometry={geo}>{mat}</mesh>
      <mesh position={a}>
        <sphereGeometry args={[radius, 20, 16]} />
        {mat}
      </mesh>
      <mesh position={b}>
        <sphereGeometry args={[radius, 20, 16]} />
        {mat}
      </mesh>
    </group>
  );
}

function Artery({ name, risk, selected, dim, onSelect, heartRef }) {
  const curve = useMemo(() => {
    const spline = new THREE.SplineCurve(ART[name].map(([a, e]) => new THREE.Vector2(a, e)));
    return new THREE.CatmullRomCurve3(spline.getPoints(80).map((p) => surf(p.x, p.y)));
  }, [name]);

  const radius = selected ? 0.04 : 0.032;
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 160, radius, 12, false), [curve, radius]);
  const hitGeo = useMemo(() => new THREE.TubeGeometry(curve, 60, 0.14, 6, false), [curve]);
  const color = useMemo(() => riskColor(risk), [risk]);
  const labelPos = useMemo(() => {
    if (name === "LAD") return [0, 0, 1.6];
    return curve.getPoint(0.55).multiplyScalar(1.12).toArray();
  }, [curve, name]);
  const mat = useRef();

  useFrame(({ clock }) => {
    if (!mat.current) return;
    const hot = risk >= 0.6 || selected;
    mat.current.emissiveIntensity = hot
      ? 0.35 + 0.25 * Math.sin(clock.getElapsedTime() * 3.2)
      : 0.12;
  });

  const click = (e) => {
    e.stopPropagation();
    onSelect && onSelect(name);
  };
  const over = (e) => {
    e.stopPropagation();
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    document.body.style.cursor = "auto";
  };

  return (
    <group>
      <mesh geometry={geo} onClick={click} onPointerOver={over} onPointerOut={out}>
        <meshPhysicalMaterial
          ref={mat}
          color={color}
          emissive={color}
          emissiveIntensity={0.12}
          roughness={0.35}
          clearcoat={0.6}
          transparent={dim}
          opacity={dim ? 0.55 : 1}
        />
      </mesh>
      <mesh geometry={hitGeo} onClick={click} onPointerOver={over} onPointerOut={out}>
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={labelPos} center zIndexRange={[10, 0]}>
        <div
          style={{
            background: name === "LAD" ? "red" : "rgba(10,14,25,0.85)",
            color: "#fff",
            padding: "2px 8px",
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 700,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            border: selected ? "1px solid #fff" : "1px solid rgba(255,255,255,0.25)",
          }}
        >
          {name} {Math.round((risk || 0) * 100)}%
        </div>
      </Html>
    </group>
  );
}

export default function Heart3D({
  risks = { LAD: 0, LCX: 0, RCA: 0 },
  selected = null,
  onSelect,
  heartbeat = true,
  scale = 1.4,
  atria = true,
}) {
  const group = useRef();
  const heartRef = useRef();
  const geometry = useMemo(buildHeartGeometry, []);

  useFrame(({ clock }) => {
    if (!group.current) return;
    let s = 1;
    if (heartbeat) {
      const t = (clock.getElapsedTime() * 1.2) % 1;
      const bump = (x, c, w) => Math.exp(-((x - c) ** 2) / (2 * w * w));
      s = 1 + 0.045 * bump(t, 0.12, 0.05) + 0.03 * bump(t, 0.32, 0.06);
    }
    group.current.scale.setScalar(scale * s);
  });

  const muscle = (
    <meshPhysicalMaterial color="#c4585a" roughness={0.5} clearcoat={0.4} clearcoatRoughness={0.35} />
  );

  return (
    <group ref={group} scale={scale}>
      <mesh ref={heartRef} geometry={geometry}>
        <meshPhysicalMaterial vertexColors roughness={0.7} clearcoat={0.15} clearcoatRoughness={0.35} />
      </mesh>

      {atria && (
        <>
          <mesh position={[-0.62, 0.52, -0.22]} scale={[0.38, 0.42, 0.36]}>
            <sphereGeometry args={[1, 40, 32]} />
            {muscle}
          </mesh>
          <mesh position={[0.6, 0.72, 0.25]} scale={[0.22, 0.25, 0.17]}>
            <sphereGeometry args={[1, 32, 24]} />
            {muscle}
          </mesh>
        </>
      )}

      <Vessel points={AORTA} radius={0.13} color="#a8423f" />
      <Vessel points={PULM} radius={0.11} color="#5b74b8" />
      <Vessel points={SVC} radius={0.1} color="#4a6fb0" />

      {["LAD", "LCX", "RCA"].map((n) => (
        <Artery
          key={n}
          name={n}
          risk={risks[n]}
          selected={selected === n}
          dim={!!selected && selected !== n}
          onSelect={onSelect}
          heartRef={heartRef}
        />
      ))}
    </group>
  );
}