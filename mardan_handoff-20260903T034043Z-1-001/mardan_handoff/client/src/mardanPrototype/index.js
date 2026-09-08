// Mardan watershed buildings prototype — barrel export.
//
// To remove the prototype later:
//   1. delete this folder (src/mardanPrototype)
//   2. delete public/prototype/mardan
//   3. remove the small integration edits in MapContainer.jsx, Sidebar.jsx
//      and App.jsx (each is marked with an `[mardan prototype]` comment)

export { default as MardanBuildingsToggle } from './MardanBuildingsToggle';
export {
  useMardanBuildings,
  MARDAN_BUILDING_LAYER_IDS,
  nextMardanBuildingType,
  resetMardanBuildingType,
} from './useMardanBuildings';