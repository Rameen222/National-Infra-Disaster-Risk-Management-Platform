// Incident record shape (documented here so the UI has a stable contract
// once a real data source/API is connected — nothing below is fabricated,
// entries are added only when real reports are supplied):
//
// {
//   id: string,
//   title: string,
//   province: string,
//   district: string,
//   tehsil: string | null,
//   date: string,               // ISO yyyy-mm-dd
//   disasterType: string,
//   thumbnailUrl: string | null,
//   shortDescription: string,
//   fullDescription: string,
//   reportSource: string,       // verbatim, as supplied in the source report
//   buildingsAffected: number | null,
//   roadDamageKm: number | null,
//   hospitalsAffected: number | null,
//   casualties: number | null,
//   injuries: number | null,
// }

export const INCIDENT_RECORDS = [
  {
    id: 'incident-001',
    title: 'Residential Room Collapse — Navi Kalay, Prang Ghar',
    province: 'KPK',
    district: 'Mohmand',
    tehsil: 'Prang Ghar',
    date: '2026-08-02',
    disasterType: 'Flood / Rain Damage',
    thumbnailUrl: '/incident-records/images/incident_001.jpeg',
    shortDescription: 'One residential room collapsed due to heavy rainfall. No loss of life or injuries reported.',
    fullDescription: 'It is reported that today, one residential room owned by Muhammad Riaz s/o _, r/o Navi Kalay, Tehsil Prang Ghar, District Mohmand collapsed due to heavy rainfall in the area. Fortunately, no loss of life or injuries were reported.',
    reportSource: 'Naib Tehsildar, Prang Ghar\nBajaur district pl',
    buildingsAffected: 1,
    roadDamageKm: null,
    hospitalsAffected: null,
    casualties: 0,
    injuries: 0,
  },
];

export function findIncidentById(id) {
  return INCIDENT_RECORDS.find((r) => r.id === id) || null;
}
