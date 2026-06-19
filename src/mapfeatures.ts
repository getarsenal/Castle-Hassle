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

// mountain ranges: ridge polylines; the renderer studs peaks along them
export const RANGES: [number, number][][] = [
  [[57.2, -4.8], [56.8, -4.0]],                                                              // Scottish Highlands
  [[52.7, -3.9], [52.3, -3.6]],                                                              // Cambrian (Wales)
  [[42.8, -1.4], [42.7, 0.6], [42.5, 2.3]],                                                  // Pyrenees
  [[45.1, 5.2], [44.2, 3.0]],                                                                // Massif Central
  [[44.1, 7.0], [45.2, 6.6], [46.0, 7.8], [46.8, 10.0], [47.1, 12.4], [47.3, 14.3]],         // Alps
  [[44.5, 9.6], [43.3, 11.8], [42.0, 13.8], [40.3, 15.9]],                                   // Apennines
  [[49.4, 19.2], [48.0, 22.5], [46.0, 24.6], [45.4, 23.0]],                                  // Carpathians
  [[45.4, 14.6], [43.6, 16.9], [42.0, 19.3], [40.9, 20.3]],                                  // Dinaric Alps
  [[42.8, 23.0], [42.0, 25.2]],                                                              // Balkan / Rhodope
  [[40.0, 22.0], [39.9, 21.6]],                                                              // Pindus
  [[40.9, 34.0], [40.7, 37.5]],                                                              // Pontic
  [[37.7, 30.5], [37.1, 33.5], [36.9, 35.8]],                                                // Taurus
  [[34.4, 36.2], [33.4, 35.8]],                                                              // Lebanon
  [[34.0, -4.5], [33.7, 0.0], [34.6, 3.0]],                                                  // Atlas (N. Africa edge)
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
