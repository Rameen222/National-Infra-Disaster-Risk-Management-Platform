import React from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceDot,
  PieChart, Pie, Cell,
} from 'recharts';
import './FloodSimulation3DPage.css';

const DATA_BASE = '/data/flood-mardan';
const TERRAIN_BASE = `${DATA_BASE}/terrain3d`;

// Scene-unit scale: 1 unit = 50m real-world, so the ~82km x 78km AOI
// becomes a ~1650 x 1560 unit scene — small enough for sane camera
// near/far planes, still large enough to orbit around naturally.
const WORLD_SCALE = 1 / 50;
// Real elevation differences (277-2742m) look nearly flat at true scale
// once compressed by WORLD_SCALE — a disclosed vertical exaggeration
// (common, standard practice in terrain visualization) makes the
// mountains around the Mardan plain actually read as mountains.
const VERTICAL_EXAGGERATION = 2.5;
// Flood depths (0.03-15.6m) are tiny next to the terrain's own 2465m
// elevation range — reusing VERTICAL_EXAGGERATION made the water surface's
// rise above terrain nearly imperceptible regardless of scenario, which is
// why the flooding looked static/wrong rather than "off" data. A much
// larger, separate exaggeration on depth alone (still disclosed, still
// preserving real relative differences between cells/scenarios) makes a
// few metres of water actually read as a visible rise.
const WATER_DEPTH_EXAGGERATION = 60;

const HEIGHT_STOPS = [
  { height: 0, color: '#2196F3', label: '0–3 m' },
  { height: 3, color: '#4CAF50', label: '3–6 m' },
  { height: 6, color: '#FFEB3B', label: '6–10 m' },
  { height: 10, color: '#FF9800', label: '10–15 m' },
  { height: 15, color: '#F44336', label: '15–25 m' },
  { height: 25, color: '#9C27B0', label: '25+ m' },
];

const LULC_COLORS = ['#D4A657', '#2E7D32', '#8BC34A', '#AFB42B', '#78909C', '#BCAAA4', '#4FC3F7', '#B0BEC5'];

const PRECIP_VALUES = [50, 100, 150, 200];
const SPEED_OPTIONS = [
  { label: '0.5×', ms: 900 },
  { label: '1×', ms: 450 },
  { label: '2×', ms: 220 },
  { label: '4×', ms: 100 },
];

const rgba = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;

// Building footprints only load within this radius (scene units) of the
// domain center for this first pass — a full viewport-culled paging system
// like the 2D page's would be the natural next step, scoped out here to
// keep this build achievable in one session.
const BUILDING_LOAD_RADIUS = 220;

function utmToScene(x, y, bounds) {
  const cx = (bounds[0] + bounds[2]) / 2;
  const cy = (bounds[1] + bounds[3]) / 2;
  return [(x - cx) * WORLD_SCALE, (y - cy) * WORLD_SCALE];
}

// Builds a rows x cols grid mesh from a flat heightmap array. Row 0 of the
// heightmap is the SOUTH edge (matches the raw SFINCS x/y convention, no
// flip applied during export) — increasing row -> increasing scene Z here,
// kept consistent with how utmToScene handles the Y axis.
function buildGridGeometry(rows, cols, heights, cellSize) {
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      positions[idx * 3] = (c - cols / 2) * cellSize;
      positions[idx * 3 + 1] = heights ? heights[idx] : 0;
      positions[idx * 3 + 2] = (r - rows / 2) * cellSize;
      uvs[idx * 2] = c / (cols - 1);
      uvs[idx * 2 + 1] = 1 - r / (rows - 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geo;
}

function setFullGridIndex(geo, rows, cols) {
  const indices = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = r * cols + c + 1, cc = (r + 1) * cols + c, d = (r + 1) * cols + c + 1;
      indices.push(a, cc, b, b, cc, d);
    }
  }
  geo.setIndex(indices);
  geo.computeVertexNormals();
}

export default function FloodSimulation3DPage() {
  const containerRef = React.useRef(null);
  const threeRef = React.useRef(null); // { scene, camera, renderer, controls, terrainMesh, waterMesh, riverLine, districtLine, buildingsGroup }
  const metaRef = React.useRef(null);
  const heightsRef = React.useRef(null);
  const sfincsManifestRef = React.useRef(null); // reused from the 2D pipeline for LULC/soil (same source data, not 3D-specific)
  const depthCacheRef = React.useRef(new Map()); // "scenario/file" -> Float32Array

  const [leftMinimized, setLeftMinimized] = React.useState(false);
  const [rightMinimized, setRightMinimized] = React.useState(false);
  const [layers, setLayers] = React.useState({
    terrain: true, water: true, river: true, districts: true, buildings: true,
  });
  const [status, setStatus] = React.useState('Building terrain mesh…');
  const [ready, setReady] = React.useState(false);
  const [precipitation, setPrecipitation] = React.useState(100);
  const [frameIdx, setFrameIdx] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [speedMs, setSpeedMs] = React.useState(SPEED_OPTIONS[1].ms);
  const playTimerRef = React.useRef(null);

  const currentScenario = React.useCallback(() => {
    const meta = metaRef.current;
    if (!meta) return null;
    return meta.scenarios.find((s) => s.mm === precipitation) || null;
  }, [precipitation]);

  // ── One-time scene setup ──────────────────────────────────────────────
  React.useEffect(() => {
    const container = containerRef.current;
    const scene = new THREE.Scene();
    // A daylight sky instead of the app's dark UI-chrome navy — that color
    // makes sense for panels, not for an outdoor terrain backdrop, and was
    // reading as part of why the scene felt dim.
    scene.background = new THREE.Color('#8fc4e8');
    scene.fog = new THREE.FogExp2('#bcd9ee', 0.00035);

    // Aspect ratio is provisional — the ResizeObserver below fixes it up
    // the instant real layout dimensions are available. A synchronous
    // clientWidth/clientHeight read here can legitimately be 0 (seen in
    // practice under React 18 StrictMode's mount→unmount→remount cycle,
    // which fires before the container has necessarily been laid out),
    // silently producing a 0x0 canvas that never gets fixed since a plain
    // window 'resize' listener never fires unless the window itself
    // resizes.
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
    camera.position.set(0, 500, 700);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    // Neither of these was set before, which under Three.js's physically-
    // based lighting model (standard since ~r155) left the scene reading
    // dim even with reasonable-looking light intensities — ACES Filmic
    // is the standard "looks like a real photo, not blown out" tone
    // curve, and needs an explicit exposure to actually brighten things.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.4;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 50;
    controls.maxDistance = 3000;

    const ambient = new THREE.HemisphereLight('#dceeff', '#6b5f45', 1.6);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight('#fff4e0', 3.2);
    sun.position.set(600, 900, 400);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -900; sun.shadow.camera.right = 900;
    sun.shadow.camera.top = 900; sun.shadow.camera.bottom = -900;
    sun.shadow.camera.far = 3000;
    scene.add(sun);

    threeRef.current = { scene, camera, renderer, controls, sun };

    let frameId;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // ResizeObserver instead of a window 'resize' listener — it fires once
    // immediately with the container's real dimensions as soon as it's
    // observed (fixing the possible 0x0 initial size above) and again on
    // any subsequent size change, including ones a window resize event
    // would never catch (e.g. a sidebar collapsing/expanding).
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  // ── Load terrain heightmap + textures, build terrain + water meshes ──
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [meta, heightBuf, demTex, hillshadeTex, sfincsManifest] = await Promise.all([
        fetch(`${TERRAIN_BASE}/meta.json`).then((r) => r.json()),
        fetch(`${TERRAIN_BASE}/heightmap.bin`).then((r) => r.arrayBuffer()),
        loadTexture(`${DATA_BASE}/sfincs/terrain_dem.png`),
        loadTexture(`${DATA_BASE}/sfincs/terrain_hillshade.png`),
        fetch(`${DATA_BASE}/sfincs/manifest.json`).then((r) => r.json()),
      ]);
      if (cancelled) return;
      metaRef.current = meta;
      sfincsManifestRef.current = sfincsManifest;

      const { rows, cols, cellSizeM, elevationRange } = meta;
      const rawHeights = new Float32Array(heightBuf);
      const heights = new Float32Array(rows * cols);
      for (let i = 0; i < heights.length; i++) {
        heights[i] = (rawHeights[i] - elevationRange[0]) * WORLD_SCALE * VERTICAL_EXAGGERATION;
      }
      heightsRef.current = heights;

      const cellSize = cellSizeM * WORLD_SCALE;
      const terrainGeo = buildGridGeometry(rows, cols, heights, cellSize);
      setFullGridIndex(terrainGeo, rows, cols);

      // Combine the earthy DEM tint with the hillshade relief into one
      // canvas texture — same two source images the 2D page uses as
      // separate raster layers, composited here since a single mesh only
      // needs one material map.
      const canvas = document.createElement('canvas');
      canvas.width = demTex.image.width;
      canvas.height = demTex.image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(demTex.image, 0, 0);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(hillshadeTex.image, 0, 0);
      ctx.globalAlpha = 1;
      const combinedTexture = new THREE.CanvasTexture(canvas);
      combinedTexture.colorSpace = THREE.SRGBColorSpace;

      const terrainMat = new THREE.MeshStandardMaterial({ map: combinedTexture, roughness: 0.95, metalness: 0 });
      const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
      terrainMesh.receiveShadow = true;
      terrainMesh.castShadow = true;
      threeRef.current.scene.add(terrainMesh);
      threeRef.current.terrainMesh = terrainMesh;

      // Water surface — a real raised mesh (terrain height + local depth),
      // not a flat image drape, so it actually looks like standing water
      // sitting on the terrain rather than a painted-on texture. Starts
      // empty; the frame effect below fills it in per scenario/timestep.
      const waterGeo = buildGridGeometry(rows, cols, heights, cellSize);
      // Preallocated once at worst-case size (every quad flooded) so the
      // per-frame update below only overwrites values in place and calls
      // setDrawRange, instead of allocating + re-uploading a whole new
      // index buffer every frame — that per-frame reallocation was making
      // playback stutter, especially at higher speeds.
      const maxIndices = (rows - 1) * (cols - 1) * 6;
      waterGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(maxIndices), 1));
      waterGeo.setDrawRange(0, 0);
      // Per-vertex RGBA, not a flat color — otherwise every wet cell renders
      // the same fully-opaque blue regardless of depth, which made
      // widespread-but-shallow sheet flow (very normal for a rainfall-
      // runoff model — cropland sheds a thin film almost everywhere during
      // a storm) look like the whole terrain was flooded. Colored+faded by
      // depth the same way the 2D page's DEPTH_STOPS ramp does, so shallow
      // areas stay faint/transparent and the real depth (the river channel)
      // reads as the darker, more opaque water.
      waterGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rows * cols * 4), 4));
      const waterMat = new THREE.MeshStandardMaterial({
        vertexColors: true, transparent: true, roughness: 0.15, metalness: 0.1,
      });
      const waterMesh = new THREE.Mesh(waterGeo, waterMat);
      waterMesh.visible = false;
      threeRef.current.scene.add(waterMesh);
      threeRef.current.waterMesh = waterMesh;
      threeRef.current.waterRows = rows;
      threeRef.current.waterCols = cols;
      threeRef.current.cellSize = cellSize;
      threeRef.current.utmBounds = meta.utmBounds;

      const controls = threeRef.current.controls;
      const spanX = cols * cellSize;
      controls.target.set(0, 0, 0);
      threeRef.current.camera.position.set(spanX * 0.35, spanX * 0.5, spanX * 0.6);
      controls.update();

      setStatus('Terrain ready');
      setReady(true);

      // River + district boundary + buildings load after the terrain so
      // the mesh appears first.
      loadVectorOverlays(meta.utmBounds);
    })();
    return () => { cancelled = true; };
  }, []);

  const loadVectorOverlays = async (utmBounds) => {
    const scene = threeRef.current.scene;

    // Kalpani river — reproject its lon/lat line to scene space via the
    // same UTM-based centering the terrain uses. The river file is in
    // WGS84, so we approximate UTM43N with a local equirectangular
    // projection good enough at this scale (~1km max error over the AOI,
    // negligible next to the 150m terrain cell size).
    const riverGeoJSON = await fetch(`${DATA_BASE}/kalpani.geojson`).then((r) => r.json());
    const riverGroup = new THREE.Group();
    const heights = heightsRef.current;
    const meta = metaRef.current;
    riverGeoJSON.features.forEach((f) => {
      const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
      lines.forEach((line) => {
        const pts = line.map(([lon, lat]) => {
          const [sx, sz] = lonLatToScene(lon, lat, utmBounds);
          return new THREE.Vector3(sx, sampleHeight(sx, sz, heights, meta) + 1.5, sz);
        });
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const line3d = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#38bdf8', linewidth: 2 }));
        riverGroup.add(line3d);
      });
    });
    scene.add(riverGroup);
    threeRef.current.riverGroup = riverGroup;

    // Mardan district boundary, same source as the 2D page.
    const districtsGeoJSON = await fetch(`${DATA_BASE}/districts_context.geojson`).then((r) => r.json());
    const districtGroup = new THREE.Group();
    const mardan = districtsGeoJSON.features.find((f) => f.properties.name === 'Mardan');
    if (mardan) {
      const polys = mardan.geometry.type === 'MultiPolygon' ? mardan.geometry.coordinates : [mardan.geometry.coordinates];
      polys.forEach((poly) => {
        poly.forEach((ring) => {
          const pts = ring.map(([lon, lat]) => {
            const [sx, sz] = lonLatToScene(lon, lat, utmBounds);
            return new THREE.Vector3(sx, sampleHeight(sx, sz, heights, meta) + 1, sz);
          });
          const geo = new THREE.BufferGeometry().setFromPoints(pts);
          districtGroup.add(new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: '#F0B429' })));
        });
      });
    }
    scene.add(districtGroup);
    threeRef.current.districtGroup = districtGroup;

    // Buildings — reuses the 2D page's pre-chunked footprint grid. Loads
    // only cells near the domain center (see BUILDING_LOAD_RADIUS) rather
    // than the full viewport-paged system the 2D page uses.
    const buildingsManifest = await fetch(`${DATA_BASE}/buildings-grid/manifest.json`).then((r) => r.json());
    const nearCells = buildingsManifest.cells.filter((c) => {
      const cx = (c.bounds[0] + c.bounds[2]) / 2;
      const cy = (c.bounds[1] + c.bounds[3]) / 2;
      const utmCenterX = (utmBounds[0] + utmBounds[2]) / 2;
      const utmCenterY = (utmBounds[1] + utmBounds[3]) / 2;
      // cell bounds are lon/lat; rough-filter by scene distance after conversion
      const [sx, sz] = lonLatToScene(cx, cy, utmBounds);
      return Math.hypot(sx, sz) < BUILDING_LOAD_RADIUS;
    });

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const boxMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    const buildingFeatures = [];
    await Promise.all(nearCells.map(async (c) => {
      const gj = await fetch(`${DATA_BASE}/buildings-grid/${c.file}`).then((r) => r.json());
      buildingFeatures.push(...gj.features);
    }));

    const inst = new THREE.InstancedMesh(boxGeo, boxMat, buildingFeatures.length);
    inst.castShadow = true;
    const dummy = new THREE.Object3D();
    const colorArr = new Float32Array(buildingFeatures.length * 3);
    buildingFeatures.forEach((f, i) => {
      const ring = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      ring.forEach(([lon, lat]) => {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      });
      const [sx0, sz0] = lonLatToScene(minLon, minLat, utmBounds);
      const [sx1, sz1] = lonLatToScene(maxLon, maxLat, utmBounds);
      const cx = (sx0 + sx1) / 2, cz = (sz0 + sz1) / 2;
      const w = Math.max(Math.abs(sx1 - sx0), 0.6);
      const d = Math.max(Math.abs(sz1 - sz0), 0.6);
      const h = Math.max((f.properties.height || 3) * WORLD_SCALE * VERTICAL_EXAGGERATION, 0.5);
      const baseY = sampleHeight(cx, cz, heights, meta);
      dummy.position.set(cx, baseY + h / 2, cz);
      dummy.scale.set(w, h, d);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const color = buildingColorForHeight(f.properties.height || 3);
      colorArr[i * 3] = color.r; colorArr[i * 3 + 1] = color.g; colorArr[i * 3 + 2] = color.b;
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceColor = new THREE.InstancedBufferAttribute(colorArr, 3);
    scene.add(inst);
    threeRef.current.buildingsMesh = inst;
    applyLayerVisibility();
  };

  // ── Push the current scenario/frame's depth grid onto the water mesh ─
  React.useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const scenario = currentScenario();
      const three = threeRef.current;
      if (!scenario || !three?.waterMesh) return;
      const frame = scenario.frames[frameIdx] || scenario.frames[scenario.frames.length - 1];
      const cacheKey = frame.file;
      let depth = depthCacheRef.current.get(cacheKey);
      if (!depth) {
        const buf = await fetch(`${TERRAIN_BASE}/${frame.file}`).then((r) => r.arrayBuffer());
        if (cancelled) return;
        depth = new Float32Array(buf);
        depthCacheRef.current.set(cacheKey, depth);
      }
      if (cancelled) return;

      const { waterMesh, waterRows: rows, waterCols: cols } = three;
      const heights = heightsRef.current;
      const depthStops = sfincsManifestRef.current?.depthStops;
      const pos = waterMesh.geometry.attributes.position;
      const colorAttr = waterMesh.geometry.attributes.color;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const d = depth[idx] > 0.03 ? depth[idx] : 0;
          pos.setY(idx, heights[idx] + d * WORLD_SCALE * WATER_DEPTH_EXAGGERATION);
          const [cr, cg, cb, ca] = depthToRGBA(d, depthStops);
          colorAttr.setXYZW(idx, cr / 255, cg / 255, cb / 255, ca / 255);
        }
      }
      pos.needsUpdate = true;
      colorAttr.needsUpdate = true;

      const indexAttr = waterMesh.geometry.index;
      const indexArr = indexAttr.array;
      let count = 0;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = r * cols + c, b = r * cols + c + 1, cc = (r + 1) * cols + c, d2 = (r + 1) * cols + c + 1;
          if (depth[a] > 0.03 || depth[b] > 0.03 || depth[cc] > 0.03 || depth[d2] > 0.03) {
            indexArr[count++] = a; indexArr[count++] = cc; indexArr[count++] = b;
            indexArr[count++] = b; indexArr[count++] = cc; indexArr[count++] = d2;
          }
        }
      }
      indexAttr.needsUpdate = true;
      waterMesh.geometry.setDrawRange(0, count);
      waterMesh.geometry.computeVertexNormals();
      waterMesh.visible = layers.water && count > 0;
    })();
    return () => { cancelled = true; };
  }, [ready, precipitation, frameIdx, currentScenario, layers.water]);

  // ── Playback ───────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!playing) { clearInterval(playTimerRef.current); return; }
    playTimerRef.current = setInterval(() => {
      setFrameIdx((i) => {
        const scenario = currentScenario();
        const last = (scenario?.frames.length || 1) - 1;
        if (i >= last) { setPlaying(false); return last; }
        return i + 1;
      });
    }, speedMs);
    return () => clearInterval(playTimerRef.current);
  }, [playing, speedMs, currentScenario]);

  const selectPrecipitation = (mm) => {
    setPrecipitation(mm);
    setFrameIdx(0);
    setPlaying(false);
  };

  const toggleLayer = (key) => setLayers((l) => ({ ...l, [key]: !l[key] }));

  const applyLayerVisibility = React.useCallback(() => {
    const three = threeRef.current;
    if (!three) return;
    if (three.terrainMesh) three.terrainMesh.visible = layers.terrain;
    if (three.waterMesh) three.waterMesh.visible = layers.water;
    if (three.riverGroup) three.riverGroup.visible = layers.river;
    if (three.districtGroup) three.districtGroup.visible = layers.districts;
    if (three.buildingsMesh) three.buildingsMesh.visible = layers.buildings;
  }, [layers]);

  React.useEffect(() => { applyLayerVisibility(); }, [applyLayerVisibility]);

  return (
    <div className="fs3d-page">
      <div ref={containerRef} className="fs3d-map" />

      <div className={`fs3d-sidebar fs3d-sidebar--left${leftMinimized ? ' fs3d-sidebar--minimized' : ''}`}>
        <div className="fs3d-sidebar-header">
          {!leftMinimized && <span className="fs3d-sidebar-title">Study Area (3D)</span>}
          <button className="fs3d-sidebar-toggle" onClick={() => setLeftMinimized((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              {leftMinimized
                ? <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        </div>
        {!leftMinimized && (
          <div className="fs3d-sidebar-body">
            <div className="fs3d-status">
              <span className={`fs3d-status-dot${ready ? ' fs3d-status-dot--ready' : ''}`} />
              {ready ? 'Terrain in view' : status}
            </div>

            <div className="fs3d-sidebar-section">
              <div className="fs3d-sidebar-section-title">Layers</div>
              <label className="fs3d-layer-row">
                <input type="checkbox" checked={layers.terrain} onChange={() => toggleLayer('terrain')} />
                <span className="fs3d-layer-swatch" style={{ background: '#8a9a5b' }} />
                Terrain
              </label>
              <label className="fs3d-layer-row">
                <input type="checkbox" checked={layers.water} onChange={() => toggleLayer('water')} />
                <span className="fs3d-layer-swatch" style={{ background: '#2E7DBF' }} />
                Flood water surface
              </label>
              <label className="fs3d-layer-row">
                <input type="checkbox" checked={layers.river} onChange={() => toggleLayer('river')} />
                <span className="fs3d-layer-swatch" style={{ background: '#38bdf8' }} />
                Kalpani River
              </label>
              <label className="fs3d-layer-row">
                <input type="checkbox" checked={layers.districts} onChange={() => toggleLayer('districts')} />
                <span className="fs3d-layer-swatch" style={{ background: '#F0B429' }} />
                District boundary
              </label>
              <label className="fs3d-layer-row">
                <input type="checkbox" checked={layers.buildings} onChange={() => toggleLayer('buildings')} />
                <span className="fs3d-layer-swatch" style={{ background: '#2dd4bf' }} />
                Buildings (near city center)
              </label>
            </div>

            <div className="fs3d-sidebar-section">
              <div className="fs3d-sidebar-section-title">Buildings legend</div>
              <div className="fs3d-legend">
                {HEIGHT_STOPS.map((s) => (
                  <div key={s.label} className="fs3d-legend-row">
                    <span className="fs3d-legend-swatch" style={{ background: s.color }} />
                    {s.label}
                  </div>
                ))}
              </div>
            </div>

            {sfincsManifestRef.current?.lulc && (
              <div className="fs3d-sidebar-section">
                <div className="fs3d-sidebar-section-title">Land cover</div>
                <div className="fs3d-lulc">
                  <ResponsiveContainer width={92} height={92}>
                    <PieChart>
                      <Pie
                        data={sfincsManifestRef.current.lulc}
                        dataKey="pct"
                        nameKey="class"
                        innerRadius={22}
                        outerRadius={44}
                        strokeWidth={1}
                        stroke="var(--bg-elevated)"
                        isAnimationActive={false}
                      >
                        {sfincsManifestRef.current.lulc.map((entry, i) => (
                          <Cell key={entry.class} fill={LULC_COLORS[i % LULC_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v, n) => [`${v}%`, n]} contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-accent)', borderRadius: 6, fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="fs3d-lulc-list">
                    {sfincsManifestRef.current.lulc.map((entry, i) => (
                      <div key={entry.class} className="fs3d-legend-row">
                        <span className="fs3d-legend-swatch" style={{ background: LULC_COLORS[i % LULC_COLORS.length] }} />
                        {entry.class} <b>{entry.pct}%</b>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {sfincsManifestRef.current?.soil && (
              <div className="fs3d-sidebar-section">
                <div className="fs3d-sidebar-section-title">Dominant soil</div>
                <div className="fs3d-soil-headline">{sfincsManifestRef.current.soil.dominant}</div>
              </div>
            )}

            <div className="fs3d-sidebar-hint">
              Drag to orbit, scroll to zoom. Terrain relief is exaggerated {VERTICAL_EXAGGERATION}× and flood depth {WATER_DEPTH_EXAGGERATION}× for visibility (depths are only a few metres against a 2,400m+ elevation range) — real ratios are preserved within each, just stretched.
            </div>
          </div>
        )}
      </div>

      <div className={`fs3d-sidebar fs3d-sidebar--right${rightMinimized ? ' fs3d-sidebar--minimized' : ''}`}>
        <div className="fs3d-sidebar-header">
          {!rightMinimized && <span className="fs3d-sidebar-title">Flood Scenario</span>}
          <button className="fs3d-sidebar-toggle" onClick={() => setRightMinimized((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              {rightMinimized
                ? <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        </div>
        {!rightMinimized && currentScenario() && (
          <div className="fs3d-sidebar-body">
            <div className="fs3d-sidebar-section">
              <div className="fs3d-sidebar-section-title">
                Precipitation scenario
                <span className="fs3d-sidebar-section-count">{precipitation}mm / 24h</span>
              </div>
              <input
                type="range"
                className="fs3d-precip-slider"
                min={0} max={PRECIP_VALUES.length - 1} step={1}
                value={PRECIP_VALUES.indexOf(precipitation)}
                onChange={(e) => selectPrecipitation(PRECIP_VALUES[Number(e.target.value)])}
              />
              <div className="fs3d-precip-ticks">
                {PRECIP_VALUES.map((v) => (
                  <span key={v} className={v === precipitation ? 'fs3d-precip-tick--active' : ''}>{v}</span>
                ))}
              </div>

              <div className="fs3d-precip-controls">
                <button className="fs3d-precip-btn" onClick={() => setPlaying((p) => !p)}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button className="fs3d-precip-btn" onClick={() => { setFrameIdx(0); setPlaying(true); }}>
                  Replay
                </button>
              </div>

              <div className="fs3d-speed-row">
                <span className="fs3d-speed-label">Speed</span>
                {SPEED_OPTIONS.map((opt) => (
                  <button
                    key={opt.label}
                    className={`fs3d-speed-btn${speedMs === opt.ms ? ' fs3d-speed-btn--active' : ''}`}
                    onClick={() => setSpeedMs(opt.ms)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="fs3d-precip-readout">
                <span>Frame {frameIdx + 1}/{currentScenario().frames.length}</span>
                <span>Depth now: {(currentScenario().frames[frameIdx]?.maxDepth ?? 0).toFixed(2)} m</span>
              </div>

              {sfincsManifestRef.current?.scenarios && (
                <div className="fs3d-hydrograph">
                  <ResponsiveContainer width="100%" height={90}>
                    <AreaChart
                      data={sfincsManifestRef.current.scenarios.find((s) => s.mm === precipitation)?.frames || []}
                      margin={{ top: 6, right: 6, bottom: 0, left: -28 }}
                    >
                      <XAxis dataKey="elapsedHours" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} tickFormatter={(v) => `${v}h`} axisLine={{ stroke: 'rgba(255,255,255,0.12)' }} tickLine={false} />
                      <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={34} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v) => [`${v.toFixed(2)} m`, 'Depth']} labelFormatter={(v) => `T+${v}h`} contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-accent)', borderRadius: 6, fontSize: 11 }} />
                      <Area type="monotone" dataKey="maxDepth" stroke="#42A5F5" fill="rgba(66, 165, 245, 0.25)" strokeWidth={1.5} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Link to="/flood-simulation" className="fs3d-back-to-2d">← Back to 2D version</Link>
    </div>
  );
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

function lonLatToScene(lon, lat, utmBounds) {
  // Local equirectangular approximation, not a true UTM reprojection —
  // fine at this scale (~1km worst-case error over an ~80km AOI, well
  // under the 150m terrain cell size) and avoids pulling in a projection
  // library for a small vector overlay.
  const metersPerDegLon = 111320 * Math.cos((34.3 * Math.PI) / 180);
  const metersPerDegLat = 110540;
  const cx = (utmBounds[0] + utmBounds[2]) / 2;
  const cy = (utmBounds[1] + utmBounds[3]) / 2;
  // Reference lon/lat at the domain center, approximated from the known
  // AOI (71.66-72.54 lon, 33.97-34.65 lat).
  const refLon = 72.10, refLat = 34.31;
  const x = cx + (lon - refLon) * metersPerDegLon;
  const y = cy + (lat - refLat) * metersPerDegLat;
  return [(x - cx) * WORLD_SCALE, (y - cy) * WORLD_SCALE];
}

function sampleHeight(sx, sz, heights, meta) {
  if (!heights || !meta) return 0;
  const { rows, cols, cellSizeM } = meta;
  const cellSize = cellSizeM * WORLD_SCALE;
  const c = Math.round(sx / cellSize + cols / 2);
  const r = Math.round(sz / cellSize + rows / 2);
  if (r < 0 || r >= rows || c < 0 || c >= cols) return 0;
  return heights[r * cols + c];
}

function buildingColorForHeight(h) {
  const stop = [...HEIGHT_STOPS].reverse().find((s) => h >= s.height) || HEIGHT_STOPS[0];
  return new THREE.Color(stop.color);
}

// Mirrors depth_to_rgba() in scripts/process_sfincs_mardan.py — same
// piecewise-linear ramp, driven by the same depthStops the 2D page reads
// from manifest.json, so a given depth reads as the same color/opacity in
// both versions. depthStops entries are {depth, rgba: [r,g,b,a]} with
// a implicitly starting from a fully-transparent (0,0,0,0) origin at
// depth 0, same as the Python version.
function depthToRGBA(depth, depthStops) {
  if (!depthStops || depth <= 0) return [0, 0, 0, 0];
  const stops = [{ depth: 0, rgba: [depthStops[0].rgba[0], depthStops[0].rgba[1], depthStops[0].rgba[2], 0] }, ...depthStops];
  for (let i = 0; i < stops.length - 1; i++) {
    const s0 = stops[i], s1 = stops[i + 1];
    if (depth >= s0.depth && depth < s1.depth) {
      const t = (depth - s0.depth) / (s1.depth - s0.depth);
      return [0, 1, 2, 3].map((k) => s0.rgba[k] + (s1.rgba[k] - s0.rgba[k]) * t);
    }
  }
  return stops[stops.length - 1].rgba;
}
