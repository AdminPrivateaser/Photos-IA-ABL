import sharp from 'sharp';
import { applyToPixels, isNeutral, luminanceMoyenne } from './adjust.js';

// Format vitrine : place l'image dans un canevas 1500x750, centree, fond
// transparent (PNG). fit 'contain' => l'image n'est JAMAIS rognee, elle est
// mise en boite aux lettres. Une photo en portrait produit donc de larges
// bandes transparentes, ce que l'interface doit montrer avant publication.
// Aucune IA, aucun appel reseau, cout zero.
//
// .rotate() sans argument applique l'orientation EXIF. Il manquait ici alors
// qu'il etait present dans l'outil de recuperation sociale : une photo prise
// au telephone en portrait sortait couchee.
export const VITRINE_W = 1500;
export const VITRINE_H = 750;

export async function formatVitrine(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(VITRINE_W, VITRINE_H, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// Ancien nom, conserve le temps de la transition.
export const recadrage = formatVitrine;

// --- Reglages colorimetriques manuels ---------------------------------------
//
// Passe par adjust.js, le MEME code que celui execute dans le navigateur pour
// l'apercu. Aucune fonction colorimetrique de sharp n'est utilisee ici, et
// c'est volontaire : les formules de sharp et celles des filtres CSS diffe-
// rent, donc melanger les deux ferait divergier l'image livree de l'apercu.
//
// Le plancher de luminosite automatique qui existait ici a ete retire : il
// faisait doublon avec le curseur de luminosite, et corrigeait les photos de
// facon invisible.
export async function appliquerReglages(buffer, adj, { sortieJpeg = false, qualite = 92 } = {}) {
  if (isNeutral(adj)) return buffer;

  const meta = await sharp(buffer).metadata();
  const { data, info } = await sharp(buffer)
    .rotate() // orientation EXIF avant tout traitement
    .raw()
    .toBuffer({ resolveWithObject: true });

  applyToPixels(data, adj, info.channels);

  const out = sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });

  // Le format d'ENTREE est conserve. Une sortie FLORA en PNG le reste, donc
  // regler la colorimetrie n'introduit aucune perte. Convertir en JPEG ici
  // aurait annule le gain obtenu en arretant de reencoder les generations.
  // sortieJpeg force le JPEG des ce passage : la livraison n'aura donc qu'UN
  // SEUL encodage, meme quand la source FLORA etait du PNG.
  if (sortieJpeg || meta.format === 'jpeg') {
    const jpg = await out.jpeg({ quality: qualite, chromaSubsampling: '4:4:4' }).toBuffer();
    return assurerJfif(jpg);
  }
  return out.png({ compressionLevel: 9 }).toBuffer();
}

// Luminance perçue moyenne d'une image encodee, sur 100.
//
// La reduction a 200 px AVANT le decodage n'est pas une optimisation, c'est
// une necessite. Sans elle, une photo de shooting 6000x4000 decode 69 Mo de
// pixels bruts par appel ; avec deux appels par photo et quatre photos en
// parallele, le conteneur depasse sa memoire et TOUTES les generations
// echouent. Une moyenne de luminance ne change pas a la reduction : mesure
// a 1 point pres sur les tests.
export async function measureLuminance(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(200, null, { withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return luminanceMoyenne(data, info.channels);
  } catch {
    return null;
  }
}
