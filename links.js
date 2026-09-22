// Import depuis des liens : aperçu puis import de la sélection.
//
// Deux temps, et c'est volontaire :
//
//   1. /preview  liste les médias sans rien télécharger. Un post peut contenir
//      dix médias dont un seul intéresse le CSM ; télécharger les dix serait
//      du gaspillage de bande passante et de temps.
//   2. /import   télécharge uniquement la sélection et crée le plan de travail.
//
// Les vraies URLs de téléchargement ne sortent JAMAIS vers le navigateur.
// Elles restent dans un cache serveur, et le client ne manipule que des
// identifiants opaques. Deux raisons : ces URLs CDN sont signées et n'ont rien
// à faire dans un DOM, et surtout, accepter une URL de téléchargement fournie
// par le client transformerait l'endpoint en relais de requêtes arbitraires.

import { randomUUID } from 'node:crypto';
import { fetchPostMedia, downloadMedia, downloadViaYtDlp, detectSource } from './social.js';

const TTL_MS = 30 * 60 * 1000; // les URLs CDN expirent, inutile de garder plus
const MAX_LIENS = 10;

export function createLinksService() {
  // previewId -> { at, items: Map<itemId, item> }
  const cache = new Map();

  function purge() {
    const limite = Date.now() - TTL_MS;
    for (const [k, v] of cache) if (v.at < limite) cache.delete(k);
  }

  /**
   * Liste les médias de plusieurs liens. Un lien en échec n'empêche pas les
   * autres : le CSM voit ce qui a marché et l'erreur pour le reste.
   */
  async function preview(urls) {
    purge();
    const liens = [...new Set(urls.map((u) => String(u).trim()).filter(Boolean))].slice(0, MAX_LIENS);
    if (liens.length === 0) throw new Error('Aucun lien fourni.');

    const previewId = randomUUID();
    const items = new Map();
    const resultats = [];

    for (const url of liens) {
      const source = detectSource(url);
      if (!source) {
        resultats.push({
          postUrl: url,
          source: null,
          error:
            "Lien non reconnu. Colle l'URL d'un post Instagram, TikTok ou Facebook, " +
            "ou l'adresse directe d'une image.",
          media: [],
        });
        continue;
      }
      try {
        const media = await fetchPostMedia(url);
        const publics = media.map((m, i) => {
          const id = randomUUID();
          // Cote serveur : tout, y compris l'URL et le lien du post (necessaire
          // pour re-resoudre les videos TikTok/Facebook au telechargement).
          items.set(id, { ...m, postUrl: url, source, ordre: i });
          // Cote client : rien de sensible. thumb est une URL publique
          // d'affichage, deja utilisee par l'ancien outil.
          return {
            id,
            type: m.type,
            ext: m.ext,
            thumb: m.thumb || null,
            width: m.width || null,
            height: m.height || null,
            warning: m.warning || null,
          };
        });
        resultats.push({ postUrl: url, source, error: null, media: publics });
      } catch (e) {
        resultats.push({ postUrl: url, source, error: String((e && e.message) || e), media: [] });
      }
    }

    cache.set(previewId, { at: Date.now(), items });
    const total = resultats.reduce((n, r) => n + r.media.length, 0);
    if (total === 0) {
      const premier = resultats.find((r) => r.error);
      throw new Error(premier ? premier.error : 'Aucun média trouvé sur ces liens.');
    }
    return { previewId, resultats, total };
  }

  /**
   * Télécharge les médias sélectionnés et les renvoie au format attendu par le
   * backend de stockage : [{ originalname, mimetype, buffer }].
   */
  async function download(previewId, ids) {
    purge();
    const entree = cache.get(previewId);
    if (!entree) {
      throw new Error(
        "Cette sélection a expiré (30 minutes). Relance la récupération des liens.",
      );
    }
    const choisis = ids
      .map((id) => entree.items.get(id))
      .filter(Boolean)
      .sort((a, b) => a.ordre - b.ordre);
    if (choisis.length === 0) throw new Error('Aucun média sélectionné.');

    const fichiers = [];
    const erreurs = [];
    let n = 0;

    for (const m of choisis) {
      n++;
      const etiquette = `${m.type === 'video' ? 'vidéo' : 'photo'} ${n}`;
      try {
        let buffer;
        let ext = m.ext || (m.type === 'video' ? 'mp4' : 'jpg');

        // Les URLs CDN des vidéos TikTok et Facebook sont signées pour la
        // session d'extraction : on repasse par yt-dlp sur l'URL du post.
        const reResoudre =
          m.type === 'video' && (m.source === 'tiktok' || m.source === 'facebook');

        if (reResoudre) {
          const r = await downloadViaYtDlp(m.postUrl);
          buffer = r.buffer;
          ext = r.ext || ext;
        } else {
          buffer = await downloadMedia(m.url, etiquette);
        }

        fichiers.push({
          originalname: `${m.source}_${String(n).padStart(2, '0')}.${ext}`,
          mimetype: m.type === 'video' ? mimeVideo(ext) : mimeImage(ext),
          buffer,
        });
      } catch (e) {
        erreurs.push(`${etiquette} : ${String((e && e.message) || e)}`);
      }
    }

    if (fichiers.length === 0) {
      throw new Error('Aucun média téléchargé. ' + erreurs.join(' | '));
    }
    return { fichiers, erreurs };
  }

  return { preview, download };
}

const mimeImage = (ext) =>
  ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' })[
    String(ext).toLowerCase()
  ] || 'image/jpeg';

const mimeVideo = (ext) =>
  ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v' })[
    String(ext).toLowerCase()
  ] || 'video/mp4';
