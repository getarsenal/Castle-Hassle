// 100 real castles from England to the Holy Land, in campaign order (roughly the
// medieval pilgrim/crusader road west→east). [name, region, lat, lon].
export const REAL_CASTLES: [string, string, number, number][] = [
  // ---- England & Wales ----
  ['Caernarfon', 'Wales', 53.14, -4.28], ['Conwy', 'Wales', 53.28, -3.83], ['Harlech', 'Wales', 52.86, -4.11],
  ['Pembroke', 'Wales', 51.67, -4.91], ['Caerphilly', 'Wales', 51.58, -3.22], ['Chepstow', 'Wales', 51.61, -2.68],
  ['Ludlow', 'England', 52.37, -2.72], ['Warwick', 'England', 52.28, -1.59], ['Kenilworth', 'England', 52.35, -1.59],
  ['Windsor', 'England', 51.48, -0.60], ['Old Sarum', 'England', 51.09, -1.80], ['Corfe', 'England', 50.64, -2.06],
  ['Portchester', 'England', 50.84, -1.11], ['Arundel', 'England', 50.86, -0.55], ['Bodiam', 'England', 51.00, 0.54],
  ['Rochester', 'England', 51.39, 0.50], ['Dover', 'England', 51.13, 1.32],
  // ---- France ----
  ['Calais', 'France', 50.95, 1.86], ['Boulogne', 'France', 50.73, 1.61], ['Rouen', 'France', 49.44, 1.10],
  ['Caen', 'France', 49.18, -0.37], ['Falaise', 'France', 48.89, -0.20], ['Château Gaillard', 'France', 49.24, 1.40],
  ['Gisors', 'France', 49.28, 1.78], ['Pierrefonds', 'France', 49.35, 2.98], ['Coucy', 'France', 49.52, 3.41],
  ['Provins', 'France', 48.56, 3.30], ['Chinon', 'France', 47.17, 0.24], ['Angers', 'France', 47.47, -0.55],
  ['Saumur', 'France', 47.26, -0.08], ['Loches', 'France', 47.13, 1.00], ['Beynac', 'France', 44.84, 1.14],
  ['Carcassonne', 'France', 43.21, 2.36], ['Montségur', 'France', 42.88, 1.83], ['Avignon', 'France', 43.95, 4.81],
  ['Tarascon', 'France', 43.81, 4.66],
  // ---- The Empire (Low Countries, Rhine, Alps) ----
  ['Gravensteen', 'The Empire', 51.06, 3.72], ['Bouillon', 'The Empire', 49.79, 5.07], ['Vianden', 'The Empire', 49.93, 6.20],
  ['Cochem', 'The Empire', 50.14, 7.17], ['Eltz', 'The Empire', 50.21, 7.34], ['Marksburg', 'The Empire', 50.27, 7.66],
  ['Rheinstein', 'The Empire', 49.98, 7.86], ['Heidelberg', 'The Empire', 49.41, 8.71], ['Marburg', 'The Empire', 50.81, 8.77],
  ['Wartburg', 'The Empire', 50.97, 10.31], ['Würzburg', 'The Empire', 49.79, 9.92], ['Nürnberg', 'The Empire', 49.46, 11.08],
  ['Hohenzollern', 'The Empire', 48.32, 8.97], ['Salzburg', 'The Empire', 47.79, 13.05], ['Hohenwerfen', 'The Empire', 47.50, 13.19],
  // ---- Italy ----
  ['Sirmione', 'Italy', 45.46, 10.61], ['Verona', 'Italy', 45.44, 10.99], ['Milano', 'Italy', 45.47, 9.18],
  ['Ferrara', 'Italy', 44.84, 11.62], ['Soave', 'Italy', 45.42, 11.25], ['Torrechiara', 'Italy', 44.62, 10.29],
  ['Gradara', 'Italy', 43.94, 12.77], ['Assisi', 'Italy', 43.07, 12.62], ['Melfi', 'Italy', 40.99, 15.65],
  ['Castel del Monte', 'Italy', 41.08, 16.27], ['Trani', 'Italy', 41.28, 16.42], ['Otranto', 'Italy', 40.15, 18.49],
  // ---- The Balkans & Byzantium ----
  ['Klis', 'Byzantium', 43.56, 16.52], ['Ragusa', 'Byzantium', 42.64, 18.11], ['Kotor', 'Byzantium', 42.42, 18.77],
  ['Berat', 'Byzantium', 40.70, 19.94], ['Ohrid', 'Byzantium', 41.11, 20.79], ['Thessalonica', 'Byzantium', 40.64, 22.96],
  ['Acrocorinth', 'Byzantium', 37.89, 22.87], ['Mystras', 'Byzantium', 37.07, 22.37], ['Monemvasia', 'Byzantium', 36.69, 23.05],
  ['Nafplio', 'Byzantium', 37.57, 22.80], ['Athens', 'Byzantium', 37.97, 23.73], ['Rhodes', 'Byzantium', 36.44, 28.23],
  // ---- Anatolia ----
  ['Smyrna', 'Anatolia', 38.42, 27.14], ['Ephesus', 'Anatolia', 37.95, 27.37], ['Nicaea', 'Anatolia', 40.43, 29.72],
  ['Ankyra', 'Anatolia', 39.94, 32.86], ['Konya', 'Anatolia', 37.87, 32.49], ['Alanya', 'Anatolia', 36.54, 32.00],
  ['Mamure', 'Anatolia', 36.10, 32.83], ['Silifke', 'Anatolia', 36.38, 33.94], ['Tarsus', 'Anatolia', 36.92, 34.89],
  ['Sis', 'Anatolia', 37.45, 35.81], ['Antioch', 'Anatolia', 36.20, 36.16], ['Aleppo', 'Anatolia', 36.20, 37.16],
  // ---- The Holy Land ----
  ['Harim', 'The Holy Land', 36.21, 36.51], ['Margat', 'The Holy Land', 35.15, 35.95], ['Saladin', 'The Holy Land', 35.60, 36.06],
  ['Tortosa', 'The Holy Land', 34.89, 35.89], ['Krak des Chevaliers', 'The Holy Land', 34.76, 36.29], ['Tripoli', 'The Holy Land', 34.43, 35.85],
  ['Beaufort', 'The Holy Land', 33.32, 35.54], ['Montfort', 'The Holy Land', 33.05, 35.23], ['Acre', 'The Holy Land', 32.92, 35.07],
  ['Kerak', 'The Holy Land', 31.18, 35.70], ['Ascalon', 'The Holy Land', 31.66, 34.55], ['Jerusalem', 'The Holy Land', 31.78, 35.23],
];
