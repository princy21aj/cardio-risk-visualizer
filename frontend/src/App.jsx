import { Component, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";

const API = "http://127.0.0.1:8000";
const TOTAL_FEATURES = 56;
const VESSELS = ["LAD", "LCX", "RCA"];
const heat = (p) => new THREE.Color().setHSL((1 - p) * 0.33, 1, 0.5);
const pct = (p) => (p > 0.99 ? "99%+" : Math.round(p * 100) + "%");

const FIELDS = [
  ["Age", "num"], ["Sex", "sex"], ["BP", "num"], ["PR", "num"], ["FBS", "num"],
  ["TG", "num"], ["LDL", "num"], ["HDL", "num"], ["EF-TTE", "num"],
  ["Region RWMA", "num"], ["Typical Chest Pain", "yn"], ["St Depression", "yn"],
  ["Tinversion", "yn"], ["DM", "yn"], ["HTN", "yn"],
];

/* ---------- Heart geometry (schematic, low-poly) ---------- */
function heartPoint(x, y, z) {
  let px = x * 1.15, py = y * 1.35, pz = z * 0.95;
  if (y < 0) { const k = 1 + 0.55 * y; px *= k; pz *= k; px += 0.28 * y * y; }
  if (z < 0) pz *= 0.8;
  if (y > 0) py -= 0.22 * y * Math.exp(-(x * x) / 0.12);
  return [px, py, pz];
}
const sph = (u, v) => [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)];
const P = (u, v) => heartPoint(...sph(u, v));

function surfacePoint(u, v, offset) {
  const e = 0.001, p = P(u, v);
  const a = P(u + e, v).map((x, i) => x - P(u - e, v)[i]);
  const b = P(u, v + e).map((x, i) => x - P(u, v - e)[i]);
  let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = Math.hypot(...n) || 1;
  n = n.map((x) => x / len);
  const s = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] < 0 ? -1 : 1;
  return new THREE.Vector3(p[0] + s * n[0] * offset, p[1] + s * n[1] * offset, p[2] + s * n[2] * offset);
}

const VESSEL_UV = {
  LAD: [[1.45, 0.8], [1.3, 1.2], [1.25, 1.8], [1.35, 2.4], [1.45, 2.9]],
  LCX: [[1.35, 0.85], [0.9, 1.0], [0.5, 1.15], [0.1, 1.3], [-0.4, 1.4]],
  RCA: [[1.8, 0.85], [2.3, 1.1], [2.8, 1.4], [3.3, 1.7], [3.7, 2.0]],
};
const LABEL_AT = { LAD: 0.45, LCX: 0.3, RCA: 0.35 };

function vesselPoints(name) {
  const c = VESSEL_UV[name], N = 40, out = [];
  for (let i = 0; i <= N; i++) {
    const f = (i / N) * (c.length - 1);
    const k = Math.min(Math.floor(f), c.length - 2);
    const t = f - k;
    out.push(surfacePoint(c[k][0] + (c[k + 1][0] - c[k][0]) * t,
                          c[k][1] + (c[k + 1][1] - c[k][1]) * t, 0.015));
  }
  return out;
}

const AORTA = [[0.15, 0.9, 0.05], [0.2, 1.6, 0.0], [0.1, 2.1, -0.05], [-0.3, 2.4, -0.1], [-0.75, 2.3, -0.2]];
const PULMONARY = [[-0.3, 0.9, 0.4], [-0.4, 1.5, 0.45], [-0.75, 1.85, 0.4]];
const VENA_CAVA = [[-0.7, 0.8, 0.0], [-0.72, 1.6, -0.05], [-0.7, 2.1, -0.05]];

function Tube({ points, radius, color }) {
  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))),
    [points]
  );
  return (
    <mesh>
      <tubeGeometry args={[curve, 40, radius, 12, false]} />
      <meshStandardMaterial color={color} roughness={0.5} />
    </mesh>
  );
}

function HeartBody() {
  const geo = useMemo(() => {
    const g = new THREE.SphereGeometry(1, 48, 48);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const top = new THREE.Color("#e6c9bb");
    const mid = new THREE.Color("#d2a898");
    const low = new THREE.Color("#b88b7c");
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const [px, py, pz] = heartPoint(x, y, z);
      pos.setXYZ(i, px, py, pz);
      if (y > 0.45) c.copy(mid).lerp(top, Math.min(1, (y - 0.45) / 0.4));
      else c.copy(low).lerp(mid, Math.max(0, (y + 1) / 1.45));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, []);
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial vertexColors roughness={0.55} metalness={0.05} />
    </mesh>
  );
}

function Vessel({ name, prob, selected, onSelect }) {
  const mat = useRef();
  const { curve, label } = useMemo(() => {
    const pts = vesselPoints(name);
    return {
      curve: new THREE.CatmullRomCurve3(pts),
      label: pts[Math.floor(pts.length * LABEL_AT[name])],
    };
  }, [name]);
  const color = heat(prob);

  useFrame(({ clock }) => {
    if (!mat.current) return;
    const base = selected ? 0.6 : 0.15;
    mat.current.emissiveIntensity =
      prob > 0.7 ? base + 0.35 * (0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 4)) : base;
  });

  return (
    <group>
      <mesh
        onClick={(e) => { e.stopPropagation(); onSelect(name); }}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "auto")}
      >
        <tubeGeometry args={[curve, 80, selected ? 0.09 : 0.06, 10, false]} />
        <meshStandardMaterial ref={mat} color={color} emissive={color} roughness={0.4} />
      </mesh>
      <Html position={label} center style={{ pointerEvents: "none" }}>
        <div style={{ transform: "translate(22px,-16px)",
                      background: selected ? "#111" : "rgba(0,0,0,0.65)",
                      border: selected ? "1px solid #fff" : "none", color: "#fff",
                      fontSize: selected ? 13 : 11, fontWeight: selected ? 700 : 400,
                      padding: "1px 6px", borderRadius: 8, whiteSpace: "nowrap" }}>
          {name} {pct(prob)}
        </div>
      </Html>
    </group>
  );
}

function HeartScene({ r, sel, setSel, beat }) {
  const ref = useRef();
  useFrame(({ clock }) => {
    const b = beat ? Math.pow(Math.max(0, Math.sin(clock.getElapsedTime() * 4)), 6) : 0;
    if (ref.current) ref.current.scale.setScalar(1 + 0.02 * b);
  });
  return (
    <group ref={ref} position={[0, -0.2, 0]}>
      <HeartBody />
      <Tube points={AORTA} radius={0.14} color="#c27a74" />
      <Tube points={PULMONARY} radius={0.17} color="#5b6fb0" />
      <Tube points={VENA_CAVA} radius={0.14} color="#5566a8" />
      {r && VESSELS.map((v) => (
        <Vessel key={v} name={v} prob={r[v].probability}
                selected={sel === v} onSelect={setSel} />
      ))}
    </group>
  );
}

/* ---------- Patient form ---------- */
function PatientForm({ onSubmit }) {
  const [v, setV] = useState({});
  const set = (k, x) => setV((p) => ({ ...p, [k]: x }));
  const submit = () => {
    if (!v.Age || v.Sex === undefined || v.Sex === "") {
      alert("Age and Sex are required");
      return;
    }
    const body = {};
    Object.entries(v).forEach(([k, x]) => { if (x !== "") body[k] = Number(x); });
    onSubmit(body);
  };
  return (
    <div style={{ marginTop: 8 }}>
      {FIELDS.map(([k, t]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between",
                              margin: "4px 0", fontSize: 13 }}>
          <span>{k}</span>
          {t === "num" ? (
            <input type="number" style={{ width: 90 }} onChange={(e) => set(k, e.target.value)} />
          ) : (
            <select style={{ width: 90 }} onChange={(e) => set(k, e.target.value)}>
              <option value="">–</option>
              {t === "sex" ? (
                <><option value="1">Male</option><option value="0">Female</option></>
              ) : (
                <><option value="1">Yes</option><option value="0">No</option></>
              )}
            </select>
          )}
        </div>
      ))}
      <button onClick={submit} style={{ marginTop: 8 }}>Predict</button>
    </div>
  );
}

/* ---------- Model performance ---------- */
function Performance() {
  const [m, setM] = useState(null);
  useEffect(() => {
    fetch(`${API}/metrics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.rows) setM(d); })
      .catch(() => {});
  }, []);
  const f = (x) => x[0].toFixed(2);
  const th = { textAlign: "left", padding: "2px 4px" };
  return (
    <details style={{ marginTop: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Model performance &amp; limitations
      </summary>
      {m ? (
        <>
          <p style={{ fontSize: 12, color: "#555" }}>
            {m.validation}, {m.n_patients} patients. Cross-validated means.
          </p>
          <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr><th style={th}>Target</th><th style={th}>AUC</th><th style={th}>Recall</th>
                  <th style={th}>Prec.</th><th style={th}>F1</th><th style={th}>Acc.</th></tr>
            </thead>
            <tbody>
              {m.rows.map((x) => (
                <tr key={x.target}>
                  <td style={th}><b>{x.target}</b></td>
                  <td style={th}>{f(x.roc_auc)}</td><td style={th}>{f(x.recall)}</td>
                  <td style={th}>{f(x.precision)}</td><td style={th}>{f(x.f1)}</td>
                  <td style={th}>{f(x.accuracy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p style={{ fontSize: 12 }}>Metrics not available.</p>
      )}
      <ul style={{ fontSize: 12, color: "#444", paddingLeft: 18 }}>
        <li>Trained on 303 patients from one dataset; performance elsewhere is unknown.</li>
        <li>LCX and RCA predictions are much weaker than CAD and LAD.</li>
        <li>Vessel-level mapping on a schematic heart, not a patient scan.</li>
        <li>Explanations show how the model reasoned, not medical causes.</li>
        <li>Example patients come from the training data, so their risks look optimistic.</li>
        <li>LAD, LCX, RCA and Cath are excluded from inputs to prevent target leakage.</li>
      </ul>
    </details>
  );
}

/* ---------- Error boundary: shows the error instead of a white page ---------- */
class ErrorBoundary extends Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui" }}>
          <h3>Something went wrong</h3>
          <pre style={{ whiteSpace: "pre-wrap", color: "crimson" }}>
            {String(this.state.err)}
          </pre>
          <p>Check that the backend is running, then press F5.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ---------- App ---------- */
const btn = {
  background: "rgba(255,255,255,0.12)", color: "#fff",
  border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6,
  padding: "3px 8px", fontSize: 12, cursor: "pointer", marginLeft: 6,
};

function AppInner() {
  const [demo, setDemo] = useState({});
  const [data, setData] = useState(null);
  const [sel, setSel] = useState("LAD");
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [beat, setBeat] = useState(true);
  const ctrl = useRef();

  const predict = (patient) => {
    setFormOpen(false);
    setError("");
    fetch(`${API}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patient),
    })
      .then((r) => r.json())
      .then((d) => (d.results ? setData(d) : setError("Prediction failed.")))
      .catch(() => setError("Prediction failed."));
  };

  useEffect(() => {
    fetch(`${API}/demo-patients`)
      .then((r) => r.json())
      .then((d) => { setDemo(d); if (d.medium) predict(d.medium); })
      .catch(() => setError("Cannot reach the API. Is uvicorn running?"));
  }, []);

  const view = (x, y, z) => {
    const c = ctrl.current;
    if (c) { c.object.position.set(x, y, z); c.update(); }
  };

  const r = data?.results;
  const entered = data ? TOTAL_FEATURES - data.assumed_defaults.length : 0;

  return (
    <div style={{ fontFamily: "system-ui" }}>
      <div style={{ display: "flex", height: "calc(100vh - 44px)" }}>
        {/* 3D view */}
        <div style={{ flex: 1, position: "relative",
                      background: "radial-gradient(circle at 50% 40%, #1d2733, #0b0f14)" }}>
          <Canvas camera={{ position: [0, 0.5, 6], fov: 40 }} dpr={[1, 1.5]}>
            <ambientLight intensity={0.55} />
            <directionalLight position={[3, 4, 5]} intensity={1.1} />
            <directionalLight position={[-4, -2, -3]} intensity={0.45} />
            <HeartScene r={r} sel={sel} setSel={setSel} beat={beat} />
            <OrbitControls ref={ctrl} enablePan={false} target={[0, 0.4, 0]}
                           minDistance={4} maxDistance={12}
                           autoRotate={rotate} autoRotateSpeed={1.5} />
          </Canvas>

          <div style={{ position: "absolute", left: 16, top: 12, color: "#9fb0c3", fontSize: 12 }}>
            Drag: rotate · Scroll: zoom · Click an artery to inspect
          </div>

          <div style={{ position: "absolute", right: 12, top: 8, color: "#fff", fontSize: 12 }}>
            <button style={btn} onClick={() => view(0, 0.5, 6)}>Front</button>
            <button style={btn} onClick={() => view(0, 0.5, -6)}>Back</button>
            <button style={btn} onClick={() => view(6, 0.5, 0)}>Left side</button>
            <button style={btn} onClick={() => view(-6, 0.5, 0)}>Right side</button>
            <label style={{ marginLeft: 10 }}>
              <input type="checkbox" checked={rotate}
                     onChange={(e) => setRotate(e.target.checked)} /> Auto-rotate
            </label>
            <label style={{ marginLeft: 10 }}>
              <input type="checkbox" checked={beat}
                     onChange={(e) => setBeat(e.target.checked)} /> Heartbeat
            </label>
          </div>

          {!r && !error && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
                          justifyContent: "center", color: "#9fb0c3", pointerEvents: "none" }}>
              Loading example patient…
            </div>
          )}

          {r && (
            <div style={{ position: "absolute", right: 16, bottom: 16, width: 210,
                          color: "#fff", fontSize: 12, background: "rgba(0,0,0,0.6)",
                          padding: 10, borderRadius: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{sel}: {pct(r[sel].probability)}</div>
              <div style={{ opacity: 0.8 }}>
                {r[sel].probability > 0.66 ? "High predicted risk"
                  : r[sel].probability > 0.33 ? "Moderate predicted risk"
                  : "Low predicted risk"}
              </div>
              {r[sel].lower_confidence && (
                <div style={{ color: "#ffb74d" }}>Lower model confidence for this vessel</div>
              )}
            </div>
          )}

          <div style={{ position: "absolute", left: 16, bottom: 16, color: "#fff", fontSize: 12 }}>
            <div style={{ width: 160, height: 10, borderRadius: 5,
              background: "linear-gradient(to right, hsl(119,100%,50%), hsl(60,100%,50%), hsl(0,100%,50%))" }} />
            <div style={{ display: "flex", justifyContent: "space-between", width: 160 }}>
              <span>Low risk</span><span>High risk</span>
            </div>
            <div style={{ opacity: 0.7, marginTop: 4 }}>
              Artery color = predicted stenosis probability
            </div>
            <div style={{ opacity: 0.5, marginTop: 2 }}>
              Schematic heart: vessel-level mapping only
            </div>
          </div>
        </div>

        {/* Dashboard panel */}
        <div style={{ width: 380, padding: 16, overflowY: "auto" }}>
          <h3>Choose an example patient</h3>
          {Object.keys(demo).map((k) => (
            <button key={k} onClick={() => predict(demo[k])}
                    style={{ marginRight: 8 }}>{k}</button>
          ))}
          {error && <p style={{ color: "crimson" }}>{error}</p>}

          <details open={formOpen} onToggle={(e) => setFormOpen(e.target.open)}
                   style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Or enter a patient</summary>
            <PatientForm onSubmit={predict} />
          </details>

          {r && (<>
            <h3 style={{ position: "sticky", top: 0, background: "#fff", margin: 0, padding: "8px 0", zIndex: 2 }}>
              Overall CAD: {pct(r.CAD.probability)}
            </h3>

            {data.assumed_defaults.length > 0 && (
              <div style={{ fontSize: 12, padding: 8, borderRadius: 6, margin: "8px 0",
                            background: entered < 20 ? "#fdecea" : "#f1f1f1",
                            color: entered < 20 ? "#8a1c1c" : "#555" }}>
                {entered < 20 && "⚠️ Results unreliable: "}
                Only {entered} of {TOTAL_FEATURES} values were entered. The rest were assumed.
              </div>
            )}

            {VESSELS.map((v) => (
              <div key={v} onClick={() => setSel(v)}
                   style={{ cursor: "pointer", margin: "8px 0", padding: 8, borderRadius: 6,
                            border: sel === v ? "2px solid #333" : "1px solid #ccc" }}>
                <b>{v}</b>: {pct(r[v].probability)}
                {r[v].lower_confidence && (
                  <span style={{ color: "#b36b00", marginLeft: 8 }}>lower confidence</span>
                )}
                <div style={{ height: 8, background: "#eee", borderRadius: 4, marginTop: 4 }}>
                  <div style={{ width: `${r[v].probability * 100}%`, height: 8, borderRadius: 4,
                                background: "#" + heat(r[v].probability).getHexString() }} />
                </div>
              </div>
            ))}

            <h4>Why {sel}?</h4>
            <p>{r[sel].explanation}</p>
            {(() => {
              const mx = Math.max(...r[sel].contributions.map((c) => Math.abs(c.shap)));
              return r[sel].contributions.map((c) => (
                <div key={c.feature} style={{ display: "flex", alignItems: "center", fontSize: 12, margin: "3px 0" }}>
                  <div style={{ width: 140 }}>{c.label}</div>
                  <div style={{ flex: 1, height: 8, background: "#eee", borderRadius: 4 }}>
                    <div style={{ height: 8, borderRadius: 4, width: `${(Math.abs(c.shap) / mx) * 100}%`,
                                  background: c.shap > 0 ? "#d32f2f" : "#1976d2" }} />
                  </div>
                  <div style={{ width: 54, textAlign: "right", color: c.shap > 0 ? "#b00020" : "#0b5cad" }}>
                    {c.shap > 0 ? "+" : ""}{c.shap.toFixed(3)}
                  </div>
                </div>
              ));
            })()}
            <div style={{ fontSize: 11, color: "#666" }}>Red raises the risk, blue lowers it.</div>
          </>)}

          <Performance />
        </div>
      </div>

      {/* Safety disclaimer */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 44,
                    background: "#fff3cd", display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: 13, textAlign: "center" }}>
        ⚠️ Decision support / educational use only. Not a substitute for formal diagnostic imaging.
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}