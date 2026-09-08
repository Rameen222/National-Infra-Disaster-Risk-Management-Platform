import React, { useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import useDrag from '../../hooks/useDrag';
import {
  estimateFloodDepth,
  damageTier,
} from '../../utils/floodDepth';
import '../Encroachment/EncroachmentModal.css';
import './BuildingFloodViewer.css';

const HOUSE_MODEL = '/models/low_poly_house_interior.glb';
const CLASSROOM_MODEL = '/models/classroom.glb';

// Prototype assumption: the classroom GLB is a single-storey building (3 m),
// the house GLB is a two-storey building (6 m). The flood volume shown inside
// the model is scaled to depth / building height and confined to the footprint.
const ASSUMED_BUILDING_HEIGHTS = { classroom: 3, house: 6 };

// Both models are normalised to this height in scene units. The depth ruler
// divides it by the assumed building height so each "1 m" tick lands exactly
// where the water surface sits for a 1 m flood.
const INTERIOR_HEIGHT_UNITS = 4.4;

// 3D water volume. Its x/z footprint mirrors the (normalised) model bounding
// box so the water never spills outside the building walls, and its height is
// depth / buildingHeight of the total interior height.
function ModelWater({ metrics, targetDepth, buildingHeight }) {
  const meshRef = useRef(null);
  const clockRef = useRef(0);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    clockRef.current += delta;

    const ratio = Math.min(1, Math.max(0.02, targetDepth / buildingHeight));
    const targetFill = ratio * metrics.height;

    const next = THREE.MathUtils.lerp(mesh.scale.y, targetFill, Math.min(1, delta * 2.2));
    mesh.scale.y = next;
    mesh.position.y = metrics.floorY + next / 2;

    if (mesh.material) {
      mesh.material.opacity = Math.max(0.38, 0.52 + Math.sin(clockRef.current * 1.4) * 0.05);
    }
  });

  return (
    <mesh ref={meshRef} position={[0, metrics.floorY, 0]}>
      <boxGeometry args={[Math.max(0.3, metrics.width * 0.96), 1, Math.max(0.3, metrics.depth * 0.96)]} />
      <meshStandardMaterial
        color="#1e88e5"
        transparent
        opacity={0.52}
        roughness={0.2}
        metalness={0.1}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// Reference line at "ground / first-floor" so the viewer can read the depth.
function DepthRuler({ buildingHeight }) {
  const floorY = -INTERIOR_HEIGHT_UNITS / 2;
  const unitPerMetre = INTERIOR_HEIGHT_UNITS / buildingHeight;
  const ticks = [];
  for (let m = 0; m <= buildingHeight; m++) {
    const y = floorY + m * unitPerMetre;
    ticks.push(
      <React.Fragment key={m}>
        <mesh position={[0, y + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.2 - Math.min(0.5, m * 0.05), 2.3, 48]} />
          <meshBasicMaterial color={m === 0 ? '#fbbf24' : '#64748b'} transparent opacity={0.5} depthWrite={false} />
        </mesh>
        <Html position={[2.45, y + 0.05, 0]} center distanceFactor={6} style={{ pointerEvents: 'none' }}>
          <span className="bfv-ruler-tick">{m === 0 ? 'G' : `${m}m`}</span>
        </Html>
      </React.Fragment>,
    );
  }
  return <group>{ticks}</group>;
}

function Model({ modelPath, targetDepth, buildingHeight }) {
  const { scene } = useGLTF(modelPath);
  const { cloned, metrics } = useMemo(() => {
    const copy = scene.clone(true);
    // Center the model over the water and clamp its height so the natural
    // model scale stays usable inside the fixed viewer viewport.
    const box = new THREE.Box3().setFromObject(copy);
    const size = box.getSize(new THREE.Vector3());
    const targetHeight = INTERIOR_HEIGHT_UNITS;
    const scale = size.y > 0 ? targetHeight / size.y : 1;
    copy.scale.multiplyScalar(scale);
    box.setFromObject(copy);
    const size2 = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    copy.position.x -= center.x;
    copy.position.z -= center.z;
    copy.position.y -= center.y; // center the model vertically at the origin
    return {
      cloned: copy,
      metrics: { width: size2.x, depth: size2.z, height: size2.y, floorY: -size2.y / 2 },
    };
  }, [scene]);

  return (
    <group>
      <primitive object={cloned} />
      <ModelWater metrics={metrics} targetDepth={targetDepth} buildingHeight={buildingHeight} />
    </group>
  );
}

function ModelScene({ modelPath, floodDepth, buildingHeight }) {
  return (
    <group>
      <Model modelPath={modelPath} targetDepth={floodDepth} buildingHeight={buildingHeight} />
      <DepthRuler buildingHeight={buildingHeight} />
    </group>
  );
}

export default function BuildingFloodViewer({
  buildingType = 'house',
  buildingName,
  district,
  scenarioId,
  scenarioLabel,
  buildingHeight = 3,
  floodDepth,
  onClose,
}) {
  // Allow explicit scenario-driven depth to override the fallback estimate.
  const computed = useMemo(
    () =>
      estimateFloodDepth({
        buildingHeight,
        scenarioId,
        randomSeed: 0.55,
      }),
    [buildingHeight, scenarioId],
  );
  const depth = floodDepth != null ? floodDepth : computed.depth;
  const tier = damageTier(depth);
  const buildingHeightM =
    buildingType === 'classroom'
      ? ASSUMED_BUILDING_HEIGHTS.classroom
      : ASSUMED_BUILDING_HEIGHTS.house;
  const storeyLabel = buildingHeightM >= 6 ? 'two-storey' : 'single-storey';
  const [modelPath] = useState(buildingType === 'classroom' ? CLASSROOM_MODEL : HOUSE_MODEL);
  const [minimized, setMinimized] = useState(false);

  const initialX = typeof window !== 'undefined' ? Math.max(24, window.innerWidth - 620) : 0;
  const initialY = typeof window !== 'undefined' ? Math.max(24, window.innerHeight - 780) : 0;
  const { pos, onMouseDown } = useDrag(initialX, initialY);

  if (!modelPath) return null;

  const modalClass = `enc-modal bfv-modal${minimized ? ' enc-modal--minimized' : ''}`;
  const positionStyle = { left: pos.x, top: pos.y };

  return ReactDOM.createPortal(
    <div className={modalClass} style={positionStyle} onClick={(e) => e.stopPropagation()}>
      <div className="enc-streak enc-streak--1" />
      <div className="enc-streak enc-streak--2" />

      <div className="enc-header" onMouseDown={onMouseDown} style={{ cursor: 'grab' }}>
        <div className="enc-header-left">
          <span className="enc-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 21v-2m0-8V9m0 5a3 3 0 013 3v2a3 3 0 01-6 0v-2a3 3 0 013-3zm-2-8h4l-1-3h-2l-1 3z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 -1)" />
            </svg>
          </span>
          <div className="enc-header-text">
            <span className="enc-badge">Flood Interior Viewer</span>
            <span className="enc-district">
              {buildingType === 'classroom' ? 'School / Classroom' : 'Residence'} · {buildingName || district || 'Building'}
            </span>
          </div>
        </div>
        <div className="enc-header-actions">
          {!minimized && (
            <button
              className="enc-iconbtn"
              onClick={(e) => { e.stopPropagation(); setMinimized((m) => !m); }}
              aria-label={minimized ? 'Restore' : 'Minimize'}
              title={minimized ? 'Restore' : 'Minimize'}
            >
              {minimized ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 7l3 3 3-3M3 3l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" transform="rotate(180 6 6)" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              )}
            </button>
          )}
          <button className="enc-close" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="enc-body bfv-body">
        <div className="bfv-stage">
          <Canvas
            camera={{ position: [4.6, 3.4, 5.6], fov: 45, near: 0.1, far: 100 }}
            shadows
            gl={{ antialias: true, alpha: true }}
            dpr={[1, 2]}
          >
            <ambientLight intensity={0.55} />
            <directionalLight position={[5, 8, 5]} intensity={1.1} castShadow />
            <directionalLight position={[-4, 3, -5]} intensity={0.35} />
            <ModelScene modelPath={modelPath} floodDepth={depth} buildingHeight={buildingHeightM} />
            <OrbitControls
              makeDefault
              enablePan={false}
              minDistance={1.6}
              maxDistance={14}
              minPolarAngle={0.25}
              maxPolarAngle={Math.PI / 2.05}
              autoRotate
              autoRotateSpeed={0.8}
            />
          </Canvas>
        </div>

        <div className="bfv-info">
          <div className="bfv-info-summary">
            <div className="bfv-depth-badge">{depth.toFixed(2)} m</div>
            <div className="bfv-depth-lbl">
              Water inside interior
              <span className="bfv-depth-scenario">{scenarioLabel || computed.label}</span>
            </div>
            <div className="bfv-depth-bar">
              <div className="bfv-depth-fill" style={{ width: `${Math.min(100, (depth / buildingHeightM) * 100)}%` }} />
            </div>
          </div>

          <div className="bfv-tier">
            <div className="bfv-tier-title">{tier.label}</div>
            <ul className="bfv-tier-items">
              {tier.items.map((item) => (
                <li key={item} className="bfv-tier-item">{item}</li>
              ))}
            </ul>
          </div>

          <div className="enc-grid bfv-grid">
            <div className="enc-stat enc-stat--safe">
              <div className="enc-stat-val">{buildingHeightM} m</div>
              <div className="enc-stat-lbl">{storeyLabel} height</div>
            </div>
          </div>

          <div className="enc-foot bfv-foot">
            Prototype interior damage preview. Water volume is confined to the
            building footprint and scaled to flood depth vs building height
            (school 3 m single storey · house 6 m two storey) — current
            interior depth {depth.toFixed(2)} m. Switch scenarios on the map to
            see the water rise or fall in real time. Drag to orbit · scroll to zoom.
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}