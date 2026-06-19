// Hand-authored map features (approximate lat/lon) to fill the campaign map:
// major rivers, mountain ranges, forests and circa-1200 realm frontiers — the
// High-Middle-Ages map, when castles stood in all these lands.

// rivers: lists of [lat, lon] waypoints, source → mouth
export const RIVERS: [number, number][][] = [
  [[51.7, -1.3], [51.5, -0.3], [51.46, 0.4], [51.5, 0.8]],                                   // Thames
  [[48.4, 4.2], [48.6, 2.9], [49.0, 1.5], [49.44, 0.2]],                                     // Seine
  [[47.6, 4.0], [47.3, 1.5], [47.4, 0.0], [47.2, -1.6]],                                      // Loire
  [[43.5, 0.5], [44.4, 0.2], [44.8, -0.5], [45.3, -0.9]],                                     // Garonne
  [[46.4, 6.2], [45.7, 4.8], [44.5, 4.7], [43.7, 4.6], [43.3, 4.8]],                          // Rhône
  [[46.5, 8.6], [47.6, 7.6], [48.6, 8.2], [49.5, 8.4], [50.4, 7.6], [51.4, 6.3], [51.9, 4.2]], // Rhine
  [[50.7, 14.2], [51.5, 12.3], [52.5, 11.6], [53.5, 10.0]],                                   // Elbe
  [[45.1, 7.4], [45.1, 9.2], [45.0, 11.0], [44.9, 12.3]],                                     // Po
  [[48.4, 10.0], [48.6, 13.4], [48.2, 16.4], [47.7, 18.1], [45.3, 19.8], [44.6, 22.5], [44.1, 27.0], [45.2, 29.6]], // Danube
  [[42.6, 12.1], [41.9, 12.5]],                                                              // Tiber
  [[31.5, 30.4], [29.0, 31.0], [27.2, 31.2], [25.7, 32.6]],                                  // Nile
  [[37.0, 38.3], [36.0, 38.2], [35.0, 40.4], [33.0, 44.4]],                                  // Euphrates
  [[37.3, 41.0], [35.5, 43.2], [33.2, 44.4]],                                                // Tigris
  [[33.2, 35.6], [32.0, 35.5], [31.5, 35.5]],                                                // Jordan
];

// mountain ranges: ridge polylines following the real chains, each with a peak
// height (world units, lowland ≈ 10, snowline ≈ 31) so the Alps are snow-capped
// giants while the British and Greek hills stay modest and green.
export interface Range { ridge: [number, number][]; h: number; }
export const RANGES: Range[] = [
  // ---- British uplands (modest, green/rocky — no permanent snow) ----
  { ridge: [[57.6, -5.3], [57.1, -4.4], [56.7, -3.7], [56.9, -3.0]], h: 15 },                // Scottish Highlands / Grampians
  { ridge: [[55.3, -4.2], [55.1, -3.1]], h: 9 },                                             // Southern Uplands
  { ridge: [[54.7, -2.5], [54.1, -2.2], [53.5, -1.9]], h: 10 },                              // Pennines
  { ridge: [[54.5, -3.2], [54.4, -3.0]], h: 11 },                                            // Lake District
  { ridge: [[53.10, -4.02], [52.96, -3.83]], h: 13 },                                        // Snowdonia (Wales)
  { ridge: [[52.5, -3.7], [52.2, -3.5]], h: 9 },                                             // Cambrian Mountains
  // ---- Iberia edge & Pyrenees ----
  { ridge: [[43.1, -5.6], [43.0, -4.0], [42.9, -2.8]], h: 17 },                              // Cantabrian Mountains
  { ridge: [[42.8, -1.5], [42.7, 0.6], [42.5, 2.4]], h: 26 },                                // Pyrenees (snow)
  // ---- France ----
  { ridge: [[45.6, 2.4], [44.9, 3.4], [44.6, 4.0]], h: 13 },                                 // Massif Central
  { ridge: [[46.3, 6.0], [47.1, 7.0]], h: 10 },                                              // Jura
  { ridge: [[47.9, 7.0], [48.5, 7.2]], h: 9 },                                               // Vosges
  // ---- Alps & Italy ----
  { ridge: [[44.1, 7.0], [45.2, 6.6], [46.0, 7.8], [46.5, 9.0], [46.9, 10.6], [47.1, 12.4], [47.4, 13.9]], h: 31 }, // Alps (snow)
  { ridge: [[44.5, 8.9], [43.9, 11.1], [43.0, 13.0], [42.0, 13.9], [40.8, 15.6], [39.9, 16.3]], h: 18 }, // Apennines
  // ---- Central & SE Europe ----
  { ridge: [[49.4, 18.8], [49.0, 21.0], [47.8, 23.6], [46.5, 25.0], [45.5, 24.2], [45.6, 22.5]], h: 19 }, // Carpathians
  { ridge: [[45.6, 14.5], [44.3, 16.2], [43.0, 17.7], [42.0, 19.2], [41.0, 20.2]], h: 17 },  // Dinaric Alps
  { ridge: [[43.1, 23.0], [42.7, 25.6]], h: 14 },                                            // Balkan Mountains
  { ridge: [[41.6, 24.0], [41.5, 25.3]], h: 12 },                                            // Rhodope
  { ridge: [[40.1, 21.0], [39.4, 21.3], [38.8, 21.8]], h: 17 },                              // Pindus
  // ---- Anatolia & the Levant ----
  { ridge: [[41.0, 35.0], [40.8, 38.0], [40.9, 40.5]], h: 18 },                              // Pontic Mountains
  { ridge: [[37.6, 29.8], [37.2, 32.0], [37.0, 34.0], [36.8, 35.9]], h: 23 },                // Taurus (snow on the heights)
  { ridge: [[34.6, 36.1], [33.9, 35.9], [33.3, 35.8]], h: 19 },                              // Lebanon / Anti-Lebanon
  // ---- N. Africa edge ----
  { ridge: [[34.0, -4.5], [33.7, 0.0], [34.6, 3.0]], h: 17 },                                // Atlas
];

// forest blobs: [lat, lon, radius-in-degrees]
export const FORESTS: [number, number, number][] = [
  [50.3, 5.2, 0.7], [48.4, 8.2, 0.7], [49.6, 13.6, 0.9], [51.8, 10.6, 0.7], [52.6, 13.4, 0.8],
  [48.8, 2.6, 0.5], [46.9, 4.4, 0.5], [44.2, 1.0, 0.5], [43.2, 24.5, 0.6], [41.8, 23.4, 0.6],
];

// circa-1200 frontiers (approximate) — drawn as faint dashed lines
export const BORDERS: [number, number][][] = [
  [[51.3, 3.6], [50.2, 4.9], [48.7, 5.6], [47.0, 5.8], [45.6, 4.9], [44.0, 4.8], [43.3, 4.6]], // Kingdom of France ↔ The Empire
  [[44.0, 7.2], [45.3, 6.8], [46.4, 8.0], [47.0, 10.2], [47.3, 12.6]],                          // The Empire ↔ Italy (the Alps)
  [[43.6, 11.5], [42.4, 13.0], [41.4, 13.8]],                                                   // Papal States frontier
  [[41.2, 14.6], [40.6, 16.2], [40.1, 18.2]],                                                   // Kingdom of Sicily frontier
  [[41.2, 28.5], [39.6, 30.0], [37.8, 29.6], [37.0, 28.6]],                                      // Byzantium ↔ Sultanate of Rûm
  [[36.4, 36.3], [35.0, 36.2], [33.4, 35.6], [31.7, 35.2]],                                      // Crusader Levant coast
];

// realm labels for the period (drawn big & faint)
export const REALMS: [string, number, number][] = [
  ['ENGLAND', 52.3, -1.5], ['KINGDOM OF FRANCE', 47.4, 2.2], ['THE EMPIRE', 50.2, 9.6],
  ['LOMBARDY', 45.2, 10.2], ['PAPAL STATES', 43.0, 12.6], ['KINGDOM OF SICILY', 40.6, 16.4],
  ['BYZANTINE EMPIRE', 38.6, 23.4], ['SULTANATE OF RÛM', 39.0, 33.5], ['OUTREMER', 33.6, 36.4],
  ['AYYUBID SULTANATE', 29.8, 31.2],
];
