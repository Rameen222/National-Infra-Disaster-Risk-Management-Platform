# HANDOFF — Mardan watershed flood prototype (client)

This file is a handoff between two machines ("this PC" = dev machine with the
prototype; "other PC" = machine with the full/updated simulation GeoJSON that
already contains per-building **height**, **flood depth** and **% inundated**
per scenario).

---

## 1. What was done on THIS PC (current state)

### 1a. Mardan watershed buildings on the map (self-contained prototype layer)

- Data artifact (email-friendly):
  - `public/prototype/mardan/buildings_mardan_watershed_reduced.geojson.gz`
    (~16.4 MB gzipped, ~102 MB / **379,371 building features**).
    Properties were stripped to `height`, `id`, `name` for size.
  - `public/prototype/mardan/_reduce.mjs` — Node script that made it
    (rounded coords to 6 decimals, Douglas–Peucker ~2 m, gzip level 9).
  - `public/prototype/mardan/README.md` — how to regenerate/delete.
- Code (self-contained folder, deletable in one go):
  - `src/mardanPrototype/useMardanBuildings.js` — loads the `.gz`, adds
    Mapbox source `mardan-buildings-src` + layers
    `mardan-buildings-fill` / `mardan-buildings-line`, fits bounds,
    reports status. Loader is gzip-magic-byte aware so it works whether
    Vite/other server auto-decompresses (`Content-Encoding: gzip`) or not.
  - `src/mardanPrototype/MardanBuildingsToggle.jsx` + `.css` — sidebar control.
  - `src/mardanPrototype/index.js` — barrel exports.
- Integration edits (each labelled `// [mardan prototype]`):
  - `src/App.jsx` — `mardanShow` / `mardanStatus` state (~line 191).
  - `src/components/Sidebar/Sidebar.jsx` — "Prototype > Mardan Watershed
    Buildings" accordion toggle (~line 227).
  - `src/components/Map/MapContainer.jsx` — import (~line 8), hook call
    (~line 1041), Mardan layers added to `BUILDING_DBL_LAYERS` (~line 1063),
    double-click handler branches on `feat.layer.id` (~lines 1111-1114).

### 1b. Double-click → 3D interior viewer (BuildingFloodViewer)

Current (prototype) behaviour — **this is what the AIM replaces, see §3**:

1. Double-clicking a Mardan building opens the 3D flood interior viewer.
2. Because the shipped reduced GeoJSON has **no per-building use/vulnerability
   class**, the GLB is chosen by a click counter instead:
   - 1st double-click → `low_poly_house_interior.glb` (house)
   - 2nd double-click → `classroom.glb` (school) — then cycles back to house.
   - Implemented by `nextMardanBuildingType()` in
     `src/mardanPrototype/useMardanBuildings.js` (~line 21), used at
     `MapContainer.jsx:1111-1114`. Other (non-Mardan) buildings keep the old
     school-proximity picker.
3. Storey heights are assumed (no real data): school = **single storey 3 m**,
   house = **two storey 6 m** (`ASSUMED_BUILDING_HEIGHTS` in
   `src/components/FloodDamageViewer/BuildingFloodViewer.jsx`).
4. Flood depth when none is passed is estimated via
   `src/utils/floodDepth.js` → `estimateFloodDepth()`.
5. Water rendering (rewritten):
   - Water is now a **3D volume** (box) whose x/z footprint mirrors the
     normalised GLB bounding box → it stays **inside the building walls**.
   - Fill height = `(flood depth / building height) × model height`
     (`ModelWater` in `BuildingFloodViewer.jsx`).
   - GLB is vertically **centred** at the origin now (it used to sit on the
     bottom). Depth ruler "G" = floor and each "1 m" tick lines up where the
     water surface sits for a 1 m flood against the assumed storey height.
   - Removed the "Estimated repair cost / repair time" stats from the panel.

Verified on this PC: `npm.cmd run build` ✓, `npm.cmd test` (13) ✓, dev and
preview servers serve the `.gz` at 200 / 17,222,277 bytes ✓.

### 1c. School–building spatial join (enriched building GeoJSON)

Each building in `public/Data_2_final/buildings-impact/` (all 11 scenario
folders, 969 tiles each, **379,371 buildings total**) has been enriched with
three school-join columns:

| Column | Source | Format |
|---|---|---|
| `Sno` | school serial number | comma-separated if multiple schools |
| `Schoolname` | school name | comma-separated if multiple schools |
| `UCName` | union council name | comma-separated if multiple schools |
| `has_school` | binary flag | `1` if any school assigned, `0` otherwise |

**How the join was done:**

1. Schools cropped to the Kalpani watershed: **3,626** schools from
   `public/infra/schools.geojson` (all Pakistan).
2. **882 empty coordinate-only rows** (no Sno, no name, no UC) were identified
   in the source — these have blank values in all three join columns.
3. **507 schools** fell outside all building coverage (no building tile within
   range) — these were not joined to any building.
4. The remaining **3,119 covered schools** were assigned to buildings:
   - If a school point falls **inside** a building polygon → that building.
   - Otherwise → the **nearest** building centroid within the same tile.
   - Blank-data schools (no Sno) still get assigned — their join columns
     remain blank.

**Column values for buildings with no school nearby:** all three join columns
are empty strings (`""`). In the web dashboard these should display as `-`
(dash) to indicate "no data" rather than showing a blank.

**Verified:** independent cross-validation using a separate shapely-based
implementation on 15 random tiles (13,899 buildings) confirmed 0 mismatches
in the school→building assignment geometry. The `has_school` column is
consistent with `Sno != ""` across all 292,160 buildings in a 60-file random
sample.

> Windows note: PowerShell blocks `npm.ps1`, so use `npm.cmd` on this repo.

---

## 2. How to take this to the other PC (zip + email to self)

Preview of this handout zip (note: the reduced `.gz` building file and the
`public/prototype/mardan/` data pipeline are **not** included — Gmail blocks
the ~16 MB attachment, and the other PC already has the real full GeoJSON
with height / flood depth / % inundated):
```
mardan_handoff/
├── HANDOFF_MARDAN.md              (this file)
├── client/
│   ├── src/mardanPrototype/       (hook, toggle, barrel, css)
│   └── src/components/FloodDamageViewer/BuildingFloodViewer.jsx
│   └── src/utils/floodDepth.js
```

To rebuild the zip yourself later (PowerShell):
```powershell
$stage = "$env:TEMP\opencode\mardan_handoff"
New-Item -ItemType Directory -Force -Path $stage\client\src\mardanPrototype `
  | Out-Null
New-Item -ItemType Directory -Force -Path $stage\client\src\components\FloodDamageViewer `
  | Out-Null
New-Item -ItemType Directory -Force -Path $stage\client\src\utils `
  | Out-Null
Copy-Item HANDOFF_MARDAN.md $stage
Copy-Item src\mardanPrototype\* $stage\client\src\mardanPrototype\
Copy-Item src\components\FloodDamageViewer\BuildingFloodViewer.jsx $stage\client\src\components\FloodDamageViewer\
Copy-Item src\utils\floodDepth.js          $stage\client\src\utils\
Compress-Archive -Path $stage\* -DestinationPath "$PWD\mardan_handoff.zip" -Force
```
Small enough for Gmail. If you also need the reduced building data blob, send
`client/public/prototype/mardan/buildings_mardan_watershed_reduced.geojson.gz`
separately (e.g. Drive link) — it is the only big file and is not required on
the other PC, which already has the real full GeoJSON.

The other PC already needs the base app (it has the full sim layers + rich
building GeoJSON). The prototype lives in `client/`; deploy/run it there with
`npm.cmd run dev` (dev) or `npm.cmd run build` + serve.

---

## 3. Current state vs AIM (important)

| | This PC now (prototype) | AIM (other PC, real data) |
|---|---|---|
| Building class | none in data → alternating house/school by click counter | real attribute in GeoJSON (school/use/vulnerability class) |
| Building height | assumed 3 m / 6 m by model type | real `height` property from GeoJSON |
| Flood depth | estimated by `estimateFloodDepth()` | real `flood depth` per scenario from sim layers / GeoJSON |
| Water level in 3D | fill = (depth / assumed height) × model height | fill = **% inundated × interior height** (or depth attribute), scenario-driven |
| Model pick | `nextMardanBuildingType()` alternation | map building class → GLB (classroom GLB for school-like, else house GLB) |
| Scenario switching | viewer keeps using last estimated depth | per-scenario water (select scenario → %inundated changes → water rises/falls) |
| School data | none in data → click-counter alternates house/school GLB | `Sno`, `Schoolname`, `UCName`, `has_school` columns in building GeoJSON |

AIM in one line: when a building is double-clicked, read that building's real
properties from the rich GeoJSON **for the currently selected scenario** and
show the water level/volume accordingly — no click-counter alternation, no
assumed heights, no estimated depth. If `has_school == 1`, render as a
school; otherwise render as a house.

---

## 4. What the AI agent should do NEXT (on the other PC)

1. **Swap data URL to the rich file.**
   - `src/mardanPrototype/useMardanBuildings.js:30` — `MARDAN_GEODATA_URL`
     currently points to the reduced file. Point it at the full
     `buildings_mardan_watershed.geojson` (or per-scenario files) so
     properties (building `height`, `flood_depth`, `pct_inundated`, `use`/
     class) survive. Remove/keep the reducer if the file size is tolerable.
2. **Choose GLB by real attribute instead of click counter.**
   - In `src/components/Map/MapContainer.jsx:1111-1114` the handler branches:
     Mardan → `nextMardanBuildingType()`. Replace with a mapping from the
     building's real class/use attribute to `buildingType` (`'classroom'` vs
     `'house'`). Keep passing it through `onBuildingDoubleClick`.
   - Delete `nextMardanBuildingType` / the sequence from
     `src/mardanPrototype/useMardanBuildings.js` once unused.
3. **Use real height + flood data in the viewer.**
   - Drop `ASSUMED_BUILDING_HEIGHTS` in
     `src/components/FloodDamageViewer/BuildingFloodViewer.jsx`; pass the
     building's real `height` from the GeoJSON through the existing
     `buildingHeight` prop.
   - Pass the real **scenario flood depth** (`floodDepth` prop) from the
     clicked feature's attributes for the active scenario, and use
     **% inundated** to scale the water fill: e.g.
     `ModelWater` fill = `clamp(pctInundated/100, 0, 1) × model height`
     (optionally cross-checked against the depth attribute).
   - `estimateFloodDepth()` in `src/utils/floodDepth.js` becomes only a
     fallback when the attribute is missing.
4. **Fix the ruler for real heights.**
   - `DepthRuler` in `BuildingFloodViewer.jsx` divides the normalised model
     height by `buildingHeight`. With real heights it keeps working, but
     decide whether ticks should show `%inundated`-labelled levels or water
     depth metres — make the labels match the data source used.
5. **Update the toggle/foot text** in
   `src/mardanPrototype/MardanBuildingsToggle.jsx` and the viewer footnote to
   describe the real behaviour ("school/class vs house", actual % inundated).
6. **Scenario switching** — confirm the viewer re-renders with new depth/%
   when the user changes scenario on the map (App already re-passes
   `scenarioId`/`scenarioLabel`; thread the building's scenario attrs through
   `onBuildingDoubleClick`).
7. **Use `has_school` to pick GLB** — when `has_school == 1` on the clicked
   building, render `classroom.glb`; when `0`, render `low_poly_house_interior.glb`.
   This replaces the click-counter alternation entirely with real data.
   - If `has_school == 1`, pass the building's `Schoolname` (or `Sno` if
     name is blank) through to the viewer panel for display.
8. **Display school info in the viewer** — when a school building is
   double-clicked, show in the info panel:
   - **School name** (from `Schoolname` column) — if blank, show `-`
   - **Sno** (serial number) — if blank, show `-`
   - **UC** (union council from `UCName`) — if blank, show `-`
   These three columns exist on every building; blank values (from
   empty-data school records in the source) should render as `-`, never
   as blank.

Verification on the other PC: `npm.cmd run build`, `npm.cmd test`,
open dev server, toggle Mardan layer, double-click two different buildings
(school and non-school) and confirm each shows the right GLB and a water fill
that matches `%inundated` for the selected scenario.