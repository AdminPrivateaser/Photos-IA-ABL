// Réglages colorimétriques manuels, sans IA.
//
// CE FICHIER EST IMPORTÉ PAR LE NAVIGATEUR **ET** PAR LE SERVEUR.
//
// C'est tout l'intérêt : l'aperçu que le CSM manipule et l'image finalement
// livrée passent par exactement le même code. La tentation était d'utiliser
// les filtres CSS pour l'aperçu (une ligne, 60 images par seconde) et sharp
// pour le rendu final. Mais leurs formules diffèrent : la saturation CSS
// applique une matrice de luminance normalisée, sharp travaille en LCh ; le
// contraste CSS est un affine autour de 0,5, sharp expose linear(a, b). Le
// résultat validé n'aurait pas été celui réglé, et un aperçu qui ment est
// pire que pas d'aperçu.
//
// Toutes les opérations sont PAR PIXEL, donc indépendantes de la résolution :
// régler sur une vignette de 700 px donne le même rendu sur l'image pleine.
//
// Pas de netteté dans cette version. Elle demande une convolution, dont la
// parité exacte entre sharp et un noyau JS n'est pas garantie. Mieux vaut
// quatre réglages fiables que cinq dont un dérive.

export const DEFAULTS = Object.freeze({
  brightness: 0, // -100 .. +100
  contrast: 0, // -100 .. +100
  saturation: 0, // -100 .. +100
  temperature: 0, // -100 (froid) .. +100 (chaud)
});

export const CHAMPS = Object.keys(DEFAULTS);

const borne = (v) => Math.max(-100, Math.min(100, Number(v) || 0));

/** Nettoie un objet de réglages venant du client : bornes et champs connus. */
export function normalize(adj) {
  const out = { ...DEFAULTS };
  if (adj && typeof adj === 'object') {
    for (const c of CHAMPS) if (c in adj) out[c] = borne(adj[c]);
  }
  return out;
}

/** Aucun réglage à appliquer : permet de court-circuiter tout le traitement. */
export function isNeutral(adj) {
  const a = normalize(adj);
  return CHAMPS.every((c) => a[c] === 0);
}

// Luminance perçue, Rec. 709. Sert à la saturation et à la mesure affichée.
export const LUM_R = 0.2126;
export const LUM_G = 0.7152;
export const LUM_B = 0.0722;

/**
 * Trois tables de correspondance de 256 entrées, une par canal.
 *
 * Luminosité, contraste et température sont des fonctions d'un seul canal :
 * on peut donc les précalculer une fois et lire la table pour chaque pixel.
 * Ordre d'application, figé : luminosité, puis contraste, puis température.
 */
export function buildLuts(adj) {
  const a = normalize(adj);
  const gainLum = 1 + a.brightness / 100; // -100 -> noir, +100 -> x2
  const gainCon = (100 + a.contrast) / 100; // -100 -> gris plat, +100 -> x2
  // La température pousse le rouge et retient le bleu, et inversement.
  // Le diviseur 300 borne l'effet à environ un tiers, au-delà l'image vire.
  const gainR = 1 + a.temperature / 300;
  const gainB = 1 - a.temperature / 300;

  const r = new Uint8Array(256);
  const g = new Uint8Array(256);
  const b = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    let v = i * gainLum;
    v = (v - 128) * gainCon + 128;
    r[i] = clamp255(v * gainR);
    g[i] = clamp255(v);
    b[i] = clamp255(v * gainB);
  }
  return { r, g, b, saturation: a.saturation };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v + 0.5) | 0;

/**
 * Applique les réglages sur place, sur un tableau d'octets entrelacés.
 *
 * @param {Uint8Array|Uint8ClampedArray} data pixels entrelacés
 * @param {object} adj réglages
 * @param {number} canaux 4 pour RGBA (canvas), 3 pour RGB (sharp brut)
 */
export function applyToPixels(data, adj, canaux = 4) {
  const { r: lutR, g: lutG, b: lutB, saturation } = buildLuts(adj);
  const gainSat = 1 + saturation / 100;
  const satActive = saturation !== 0;

  for (let i = 0; i < data.length; i += canaux) {
    let R = lutR[data[i]];
    let G = lutG[data[i + 1]];
    let B = lutB[data[i + 2]];

    // La saturation croise les canaux : elle vient donc après les tables.
    if (satActive) {
      const lum = LUM_R * R + LUM_G * G + LUM_B * B;
      R = clamp255(lum + (R - lum) * gainSat);
      G = clamp255(lum + (G - lum) * gainSat);
      B = clamp255(lum + (B - lum) * gainSat);
    }

    data[i] = R;
    data[i + 1] = G;
    data[i + 2] = B;
    // Le canal alpha, s'il existe, n'est jamais touché.
  }
  return data;
}

/** Luminance perçue moyenne, sur 100. Même métrique que l'affichage. */
export function luminanceMoyenne(data, canaux = 4) {
  let somme = 0;
  let n = 0;
  // Échantillonnage : un pixel sur 17 suffit pour une moyenne, et garde
  // l'appel instantané même sur une image pleine résolution.
  const pas = canaux * 17;
  for (let i = 0; i < data.length; i += pas) {
    somme += LUM_R * data[i] + LUM_G * data[i + 1] + LUM_B * data[i + 2];
    n++;
  }
  return n ? Math.round((somme / n / 255) * 100) : 0;
}

/** Suffixe de fichier lisible, pour distinguer une version réglée. */
export function suffixeReglages(adj) {
  const a = normalize(adj);
  const bouts = [];
  if (a.brightness) bouts.push('l' + (a.brightness > 0 ? '+' : '') + a.brightness);
  if (a.contrast) bouts.push('c' + (a.contrast > 0 ? '+' : '') + a.contrast);
  if (a.saturation) bouts.push('s' + (a.saturation > 0 ? '+' : '') + a.saturation);
  if (a.temperature) bouts.push('t' + (a.temperature > 0 ? '+' : '') + a.temperature);
  return bouts.join('');
}
