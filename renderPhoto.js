// Fonction unique de generation d'un rendu.
//
// Appelee par les trois chemins : passage initial du lot, "Enchainer" et
// "Refaire". Avant, cette logique etait dupliquee dans pipeline.js et
// uploadPipeline.js, ce qui faisait diverger le plancher de luminosite.
//
// Le plancher de luminosite automatique a ete retire : il corrigeait les
// photos de facon invisible et faisait doublon avec le curseur de luminosite
// des reglages manuels (voir adjust.js). La luminance reste MESUREE, pour
// l'affichage, mais plus jamais modifiee ici.

import sharp from 'sharp';
import { formatVitrine, measureLuminance } from './transforms.js';
import { newRender } from './store.js';

/**
 * @param {Buffer} sourceBuffer image d'entree (original ou rendu precedent)
 * @param {object} style        { label, prompt, model, type }
 * @param {string} from         'source' ou id du rendu d'origine
 * @returns {object} le rendu, avec .buffer (a deposer par l'appelant)
 */
export async function renderPhoto({ sourceBuffer, style, model, from, flora, floraProjectId }) {
  const render = newRender({
    promptLabel: style.label,
    promptText: style.prompt || null,
    model: style.type === 'recadrage' ? null : model || style.model || null,
    from,
    kind: style.type === 'recadrage' ? 'recadrage' : 'ai',
  });

  try {
    if (render.kind === 'recadrage') {
      render.buffer = await formatVitrine(sourceBuffer);
      render.ext = 'png';
      render.mimeType = 'image/png';
      render.status = 'ok';
      return render;
    }

    render.lumIn = await measureLuminance(sourceBuffer);

    const assetUrl = await flora.uploadImage(sourceBuffer, 'source.jpg', 'image/jpeg');
    const { url, cost } = await flora.edit(assetUrl, {
      prompt: style.prompt,
      model: render.model,
      projectId: floraProjectId,
    });

    // LE FICHIER ORIGINAL, PAS LA VERSION OPTIMISEE DU CDN.
    //
    // FLORA sert ses sorties via ImageKit.io, qui transcode automatiquement
    // selon l'en-tete Accept de la requete : la meme URL .png renvoyait un
    // JPEG de 272 Ko a notre fetch, et un WebP a un navigateur. Le PNG
    // original fait 1,8 Mo.
    //
    // tr=orig-true demande explicitement le fichier d'origine, sans aucune
    // transformation. C'est ce que fait "download the original" dans FLORA.
    const resp = await fetch(urlOriginale(url));
    if (!resp.ok) throw new Error(`Telechargement sortie FLORA echoue (${resp.status})`);
    const brut = Buffer.from(await resp.arrayBuffer());

    // Trace de ce que FLORA sert reellement. Le fichier livre est ensuite
    // strictement ces octets : si le format ne convient pas, c'est ici qu'il
    // faut regarder, pas dans notre traitement.
    console.log(
      `[flora] sortie : ${resp.headers.get('content-type') || 'type inconnu'}, ` +
        `${(brut.length / 1024).toFixed(0)} Ko, url ${String(url).slice(0, 160)}`,
    );

    render.cost = cost || 0;

    // Mesure seule, aucune correction : la sortie du modele est conservee
    // telle quelle, et c'est au CSM de l'ajuster avec les reglages s'il veut.
    render.lumAi = await measureLuminance(brut);

    // LES OCTETS DE FLORA SONT CONSERVES TELS QUELS.
    //
    // La version precedente les reencodait en JPEG qualite 90. FLORA renvoie
    // du PNG (sans perte) : ce reencodage degradait donc CHAQUE generation,
    // sans aucune raison. C'est la cause des photos qui paraissaient floues.
    //
    // On se contente de lire le format et les dimensions, pour pouvoir les
    // afficher et diagnostiquer d'ou vient une eventuelle perte.
    render.buffer = brut;
    try {
      const m = await sharp(brut).metadata();
      render.ext = (m.format === 'jpeg' ? 'jpg' : m.format) || 'png';
      render.mimeType = m.format === 'jpeg' ? 'image/jpeg' : `image/${m.format || 'png'}`;
      render.largeur = m.width || null;
      render.hauteur = m.height || null;
      render.poids = brut.length;
    } catch {
      render.ext = 'png';
      render.mimeType = 'image/png';
    }
    render.status = 'ok';
    return render;

  } catch (e) {
    render.status = 'error';
    render.error = String((e && e.message) || e);
    return render;
  }
}

// Ajoute le parametre ImageKit qui demande le fichier original.
// Sans effet sur une URL qui ne vient pas de leur CDN.
function urlOriginale(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('tr')) u.searchParams.set('tr', 'orig-true');
    return u.toString();
  } catch {
    return url;
  }
}

// Execute fn sur items avec au plus n en parallele.
export async function pMap(items, concurrency, fn) {
  const queue = items.slice();
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}
