// Persistance du plan de travail.
//
// Un fichier JSON par session, dans DATA_DIR (volume Railway). Le volume est
// obligatoire : le disque d'un conteneur Railway est ephemere, et sans lui un
// redeploiement en cours de session detruit le plan de travail.
//
// Aucune image ici, seulement des metadonnees et des references. Ou vivent les
// octets est decide par le backend (assets.js) : Drive ou volume.
//
// Ecriture atomique (fichier temporaire + rename) : un redemarrage au milieu
// d'une sauvegarde ne peut pas laisser un JSON tronque.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore({ dir }) {
  const plansDir = path.join(dir, 'plans');
  let ready = null;

  async function ensureDir() {
    if (!ready) ready = fs.mkdir(plansDir, { recursive: true });
    return ready;
  }

  const file = (id) => path.join(plansDir, `${id}.json`);

  async function save(session) {
    await ensureDir();
    session.updatedAt = new Date().toISOString();
    const tmp = file(session.id) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(session, null, 1), 'utf8');
    await fs.rename(tmp, file(session.id));
    return session;
  }

  async function load(id) {
    await ensureDir();
    try {
      return JSON.parse(await fs.readFile(file(id), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async function create({ mode, styleLabel, etab, destination, user }) {
    return save({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      // Adresse de la personne qui a lance la session. Toute l'equipe voit
      // toutes les sessions, regroupees par personne.
      user: user || null,
      mode, // 'drive' | 'upload' | 'links'
      // Etablissement : determine le dossier de destination.
      // Deduit du nom de dossier Drive "{ID} - {nom}" quand c'est possible,
      // saisi a la main sinon.
      etab: etab || null, // { id, nom }
      // Destination de la validation :
      //   'source' -> sous-dossier du dossier Drive de depart (shootings)
      //   'etab'   -> dossier "{nom}_social media" de l'etablissement
      //   'zip'    -> telechargement direct
      destination: destination || 'zip',
      source: null, // { folderId, folderName } renseigne par le backend
      workRef: null, // dossier _travail (Drive) ou 'work' (volume)
      styleLabel,
      status: 'running', // running | ready | validating | validated | failed
      cost: 0,
      error: null,
      delivery: null, // 'drive' | 'zip', renseigne a la validation
      outputFolderName: null,
      outputFolderUrl: null,
      photos: [],
    });
  }

  // Liste des sessions, la plus recente d'abord, sous forme de resumes.
  // Lit tous les plans : acceptable avec une rotation a 90 jours, a revoir
  // si le volume depasse le millier de fichiers.
  async function list({ limit = 200 } = {}) {
    await ensureDir();
    const out = [];
    for (const f of await fs.readdir(plansDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(plansDir, f), 'utf8'));
        const photos = (s.photos || []).filter((p) => p.status !== 'deleted');
        out.push({
          id: s.id,
          user: s.user || null,
          mode: s.mode,
          etab: s.etab || null,
          folderName: s.source ? s.source.folderName : null,
          styleLabel: s.styleLabel || null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt || s.createdAt,
          status: s.status,
          count: photos.length,
          videos: photos.filter((p) => p.kind === 'video').length,
          cost: s.cost || 0,
          destination: s.destination,
          delivery: s.delivery || null,
          outputFolderName: s.outputFolderName || null,
          outputFolderUrl: s.outputFolderUrl || null,
          validatedCount: s.validatedCount || 0,
          imagesPurgees: !!s.imagesPurgees,
        });
      } catch {
        // fichier illisible : ignore ici, signale par la purge
      }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out.slice(0, limit);
  }

  // Purge en DEUX temps, et c'est le point important : les images pesent, les
  // metadonnees non. Effacer les deux ensemble ferait disparaitre l'historique
  // au bout de deux semaines.
  //
  //   images (volume)  -> maxImageDays jours apres la fin de la session
  //   plan (metadata)  -> maxPlanDays jours, puis suppression definitive
  //
  // Au passage, le dossier _travail d'une session Drive ABANDONNEE est mis a
  // la corbeille : sans ca il reste indefiniment dans le dossier du client.
  async function purge({ maxImageDays = 14, maxPlanDays = 90, backends = null } = {}) {
    await ensureDir();
    const limiteImages = Date.now() - maxImageDays * 86400_000;
    const limitePlans = Date.now() - maxPlanDays * 86400_000;
    let images = 0;
    let plans = 0;
    let travaux = 0;

    for (const f of await fs.readdir(plansDir)) {
      if (!f.endsWith('.json')) continue;
      const chemin = path.join(plansDir, f);
      let s;
      try {
        s = JSON.parse(await fs.readFile(chemin, 'utf8'));
      } catch {
        continue;
      }
      const t = Date.parse(s.updatedAt || s.createdAt || 0);
      if (!t) continue;

      if (t < limitePlans) {
        if (backends) await backends.forSession(s).cleanup(s).catch(() => {});
        await fs.unlink(chemin).catch(() => {});
        plans++;
        continue;
      }

      if (t < limiteImages && !s.imagesPurgees) {
        const finie = ['validated', 'failed'].includes(s.status);
        if (backends) {
          await backends.forSession(s).cleanup(s).catch(() => {});
          // Session Drive abandonnee : le dossier de travail traine chez le
          // client, on le met a la corbeille (recuperable).
          if (!finie && s.mode === 'drive' && s.workRef) {
            const b = backends.forSession(s);
            if (b.trashWork) {
              await b.trashWork(s).then(() => travaux++).catch(() => {});
            }
          }
        }
        s.imagesPurgees = true;
        await save(s).catch(() => {});
        images++;
      }
    }
    if (images || plans || travaux) {
      console.log(
        `[store] purge : ${images} session(s) sans images, ${plans} plan(s) supprime(s)` +
          (travaux ? `, ${travaux} dossier(s) _travail a la corbeille` : ''),
      );
    }
  }

  return { create, load, save, list, purge };
}

// --- Structure du plan de travail -------------------------------------------

export function newPhoto({ sourceRef, sourceName, mimeType, base, ext, kind, origin = null }) {
  return {
    id: randomUUID(),
    // 'photo' : retouchable et formatable.
    // 'video' : traverse le plan sans transformation possible (FLORA est
    // image-to-image, et le format vitrine ne s'applique qu'aux images).
    kind: kind || 'photo',
    ext: (ext || 'jpg').toLowerCase(),
    // Format de livraison, independant de la retouche : on peut passer une
    // photo en nuit PUIS la preparer au format vitrine.
    format: 'original', // 'original' | 'vitrine'
    // Reglages colorimetriques manuels, appliques a la validation.
    // Voir adjust.js : meme code que l'apercu du navigateur.
    adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 },
    busy: false, // une generation est en cours pour cette photo
    // Point de depart herite lors d'une duplication "en partant de l'image
    // actuelle" : { photoId, renderId }. On ne recopie PAS l'historique du
    // parent, sinon la copie afficherait son image comme si c'etait deja le
    // resultat de la nouvelle generation.
    inherit: null,
    sourceRef, // id de fichier Drive, ou nom de fichier sur le volume
    sourceName,
    mimeType,
    base, // nom sans extension, ex. "photo_03"
    origin, // id de la photo dont celle-ci est une duplication
    suffixes: [], // ex. ["cocktail-fr"] -> photo_03_cocktail-fr.jpg
    renders: [],
    currentRenderId: null,
    status: 'pending', // pending | ok | error | deleted
    error: null,
  };
}

export function newRender({ promptLabel, promptText, model, from, kind }) {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    promptLabel,
    promptText, // prompt exact utilise, fige : Notion peut changer ensuite
    model,
    from, // 'source' | id du rendu dont il part
    kind, // 'ai' | 'recadrage'
    workFileId: null, // reference du rendu chez le backend
    ext: 'jpg',
    cost: 0,
    lumIn: null,
    lumAi: null,
    lumFinal: null,
    status: 'pending', // pending | ok | error
    error: null,
  };
}

export const photoById = (s, id) => (s.photos || []).find((p) => p.id === id);
export const renderById = (p, id) => (p.renders || []).find((r) => r.id === id);
export const currentRender = (p) => renderById(p, p.currentRenderId);
// Nom final quand le dossier de depart existe (shooting) ou en zip : le nom
// source porte de l'information
// (photo_03), et le suffixe de variante aussi (cocktail-fr). On les garde.
// L'extension est fournie par l'appelant : c'est celle du fichier REELLEMENT
// livre, apres normalisation. La deduire du rendu donnait un nom en .png pour
// un contenu JPEG.
export function nomShooting(p, ext) {
  return `${[p.base, ...(p.suffixes || [])].join('_')}.${ext || extLivree(p)}`;
}

// Nom final dans le dossier etablissement : les noms sources
// sont des empreintes de CDN sans signification, on numerote a la suite de ce
// qui existe deja dans le dossier.
export function nomAutre(p, nomEtab, index, ext) {
  return `${nomEtab}_social media_${String(index).padStart(2, '0')}.${ext || extLivree(p)}`;
}

// Extension du contenu reellement livre : celle du rendu retenu s'il y en a
// un, sinon celle du fichier source.
export function extLivree(p) {
  const r = currentRender(p);
  return (r && r.ext) || p.ext || 'jpg';
}

// Regroupe les photos par lignee : une photo dupliquee appartient a la
// lignee de son original. Sert a la livraison, qui raisonne par photo
// d'origine et non par version.
export function lignees(session) {
  const parId = new Map((session.photos || []).map((p) => [p.id, p]));
  const racine = (p) => {
    let c = p, g = 0;
    while (c.origin && parId.has(c.origin) && g++ < 50) c = parId.get(c.origin);
    return c;
  };
  const gr = new Map();
  for (const p of session.photos || []) {
    if (p.status === 'deleted') continue;
    const r = racine(p).id;
    if (!gr.has(r)) gr.set(r, []);
    gr.get(r).push(p);
  }
  return [...gr.values()];
}

/**
 * Ce qui part reellement a la livraison, lignee par lignee.
 *
 * Regle : des qu'une retouche existe dans la lignee, on ne livre QUE les
 * versions retouchees ; l'original ne part pas. Sans aucune retouche, on
 * livre l'original. Une video part toujours telle quelle.
 *
 *   photo_1 : original + retouche      -> la retouche seule
 *   photo_2 : original                 -> l'original
 *   photo_3 : original + 2 retouches   -> les deux retouches
 */
export function aLivrer(session) {
  const out = [];
  for (const versions of lignees(session)) {
    const videos = versions.filter((p) => p.kind === 'video' && p.sourceRef);
    out.push(...videos);

    const photos = versions.filter((p) => p.kind !== 'video');
    if (photos.length === 0) continue;

    const retouchees = photos.filter((p) => {
      const r = currentRender(p);
      return p.status !== 'error' && r && r.workFileId;
    });
    if (retouchees.length > 0) {
      out.push(...retouchees);
      continue;
    }
    // Aucune retouche exploitable dans cette lignee : on livre l'original.
    const original = photos.find((p) => !p.origin && p.sourceRef) || photos.find((p) => p.sourceRef);
    if (original && original.status !== 'error') out.push(original);
  }
  return out;
}

// Une photo est livrable si elle a un rendu retenu OU, faute de rendu, son
// original (import sans retouche). Une video est toujours livrable telle quelle.
export function livrable(p) {
  if (p.status === 'deleted') return false;
  if (p.kind === 'video') return !!p.sourceRef;
  const r = currentRender(p);
  if (r && r.workFileId) return true;
  return p.renders.length === 0 && !!p.sourceRef;
}

// Vue publique : les prompts complets ne partent pas au navigateur (jusqu'a
// 15 Ko par rendu), seulement leur libelle et un extrait.
export function publicSession(s) {
  return {
    ...s,
    photos: (s.photos || [])
      .filter((p) => p.status !== 'deleted')
      .map((p) => ({
        ...p,
        renders: p.renders.map((r) => ({
          ...r,
          promptText: undefined,
          promptExtrait: (r.promptText || '').slice(0, 160),
        })),
      })),
  };
}
