// Orchestration du plan de travail.
//
// Principe central : RIEN n'est livre avant "Valider". Les rendus vivent chez
// le backend (dossier _travail en mode Drive, volume en mode glisser-deposer),
// et la validation les promeut : deplacement vers un nouveau dossier Drive, ou
// mise a disposition en zip.
//
// Attention : FLORA facture a la generation, pas a la validation. Un plan
// abandonne a deja coute. "Valider" controle ce qui est livre, pas la facture.

import {
  newPhoto, photoById, renderById, currentRender,
  nomShooting, nomAutre, extLivree, aLivrer,
} from './store.js';
import { renderPhoto, pMap } from './renderPhoto.js';
import { formatVitrine, appliquerReglages } from './transforms.js';
import { normalize as normalizeAdjust, isNeutral, CHAMPS as CHAMPS_ADJUST } from './adjust.js';

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  m4v: 'video/x-m4v',
};

export function createWorkplan({ store, backends, flora, concurrency = 4 }) {
  // --- Demarrage d'une session, quel que soit le mode ----------------------
  // mode 'drive'  : { driveUrl }
  // mode 'upload' : { files } (multer, en memoire)
  // style peut valoir null : on importe alors sans aucune generation. C'est le
  // cas normal pour un import social ou pour un simple passage au format
  // vitrine, et ca evite de depenser 30 generations a l'aveugle.
  async function startSession({ mode, driveUrl, files, style, model, etab, destination, user }) {
    const backend = backends[mode] || backends.drive;
    // Destination par defaut selon l'entree : un lien Drive livre a cote de
    // ses originaux, un import sans dossier de depart livre dans
    // l'etablissement si on en connait un, sinon en zip.
    const dest = destination || (mode === 'drive' ? 'source' : etab ? 'etab' : 'zip');
    const session = await store.create({
      mode,
      styleLabel: style ? style.label : null,
      etab,
      destination: dest,
      user,
    });

    const prep = await backend.prepare({ session, driveUrl, files });
    session.source = prep.source;
    session.workRef = prep.workRef;
    // L'etablissement fourni par l'appelant a la priorite sur celui deduit du
    // nom de dossier : le CSM peut corriger une detection erronee.
    session.etab = etab || prep.etab || null;

    session.photos = prep.photos.map((f) => {
      const ext = (f.sourceName.split('.').pop() || 'jpg').toLowerCase();
      const estVideo = VIDEO_EXT.has(ext) || String(f.mimeType || '').startsWith('video/');
      return newPhoto({
        sourceRef: f.sourceRef,
        sourceName: f.sourceName,
        mimeType: f.mimeType,
        base: f.sourceName.replace(/\.[^.]+$/, ''),
        ext,
        kind: estVideo ? 'video' : 'photo',
      });
    });

    if (session.photos.length === 0) {
      session.status = 'ready';
      session.message =
        mode === 'drive' ? 'Aucune photo trouvee dans ce dossier.' : 'Aucun media importe.';
      return store.save(session);
    }

    // Les videos ne passent jamais par une generation : elles sont pretes
    // des l'import.
    for (const p of session.photos) if (p.kind === 'video') p.status = 'ok';

    // Import sans retouche : rien n'est en attente, donc tout est pret. Sans
    // ce passage a 'ok', les photos restaient 'pending' et la validation les
    // considerait comme non livrables.
    if (!style) {
      for (const p of session.photos) p.status = 'ok';
      session.status = 'ready';
      return store.save(session);
    }

    await store.save(session);

    // Les videos ne passent pas par FLORA : elles traversent le plan.
    const cibles = session.photos.filter((p) => p.kind === 'photo').map((p) => p.id);
    if (cibles.length === 0) {
      session.status = 'ready';
      return store.save(session);
    }

    runBatch(session.id, { style, model, photoIds: cibles }).catch(async (e) => {
      const s = await store.load(session.id);
      if (!s) return;
      s.status = 'failed';
      s.error = msg(e);
      await store.save(s);
    });

    return session;
  }

  // --- Passage sur un ensemble de photos (initial ou relance) -------------
  async function runBatch(sessionId, { style, model, photoIds, from = 'source' }) {
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    const backend = backends.forSession(session);

    // Marque les photos visees : l'interface affiche un volet "en cours"
    // plutot que l'image precedente, qui laisserait croire au resultat.
    await withSession(sessionId, (s0) => {
      for (const id of photoIds) {
        const p = photoById(s0, id);
        if (p && p.status !== 'deleted') p.busy = true;
      }
      s0.status = 'running';
    });

    const floraProjectId =
      style.type === 'recadrage'
        ? null
        : await flora.createProject(`${session.source?.folderName || 'Session'}_${style.suffix}`);

    await pMap(photoIds, concurrency, async (photoId) => {
      // Rechargement a chaque photo : plusieurs relances peuvent se croiser.
      const s = await store.load(sessionId);
      const photo = photoById(s, photoId);
      if (!photo || photo.status === 'deleted') return;
      if (photo.kind === 'video') return; // FLORA est image-to-image

      let entree;
      let fromId = from;
      try {
        if (from === 'current') {
          // Soit la photo a deja un rendu, soit c'est une copie fraiche qui
          // herite du rendu de la photo dont elle vient.
          let courant = currentRender(photo);
          if (!courant && photo.inherit && photo.inherit.renderId) {
            const parent = photoById(s, photo.inherit.photoId);
            courant = parent ? renderById(parent, photo.inherit.renderId) : null;
          }
          if (courant && courant.workFileId) {
            entree = await backend.readWork(s, courant.workFileId);
            fromId = courant.id;
          } else {
            // Aucune retouche encore appliquee : "l'image actuelle" EST
            // l'original. Refuser ici etait absurde, on repli silencieusement.
            if (!photo.sourceRef) throw new Error('Photo sans original disponible.');
            entree = await backend.readSource(s, photo);
            fromId = 'source';
          }
        } else {
          if (!photo.sourceRef) throw new Error('Photo sans original disponible.');
          entree = await backend.readSource(s, photo);
          fromId = 'source';
        }
      } catch (e) {
        await withSession(sessionId, (s2) => {
          const p = photoById(s2, photoId);
          if (p) {
            p.status = 'error';
            p.error = msg(e);
            p.busy = false;
          }
        });
        return;
      }

      const render = await renderPhoto({
        sourceBuffer: entree,
        style,
        model,
        from: fromId,
        flora,
        floraProjectId,
      });

      if (render.status === 'ok') {
        try {
          render.workFileId = await backend.writeWork(s, {
            name: `${photo.base}_${render.id.slice(0, 8)}.${render.ext}`,
            mimeType: render.mimeType,
            buffer: render.buffer,
          });
        } catch (e) {
          render.status = 'error';
          render.error = 'Ecriture du rendu impossible : ' + msg(e);
        }
      }
      delete render.buffer;
      delete render.mimeType;

      await withSession(sessionId, (s2) => {
        const p = photoById(s2, photoId);
        if (!p) return;
        p.busy = false;
        p.renders.push(render);
        if (render.status === 'ok') {
          p.currentRenderId = render.id;
          p.status = 'ok';
          p.error = null;
        } else {
          p.status = 'error';
          p.error = render.error;
        }
        s2.cost = (s2.cost || 0) + (render.cost || 0);
      });
    });

    await withSession(sessionId, (s2) => {
      // Filet : une photo ignoree (supprimee en cours de route) ne doit pas
      // rester bloquee sur "en cours".
      for (const p of s2.photos || []) if (p.busy) p.busy = false;
      if (s2.status === 'running') s2.status = 'ready';
    });

    return store.load(sessionId);
  }

  // --- Relance : Enchainer / Refaire, duplication ou remplacement ---------
  //
  // from : 'current' (Enchainer, cumule les effets) | 'source' (Refaire)
  // mode : 'duplicate' (ajoute des photos au plan) | 'replace'
  async function rerun({ sessionId, photoIds, style, model, from, mode }) {
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (session.status === 'validated') throw new Error('Session deja validee.');

    let cibles = photoIds;

    if (mode === 'duplicate') {
      cibles = [];
      await withSession(sessionId, (s) => {
        for (const id of photoIds) {
          const src = photoById(s, id);
          if (!src || src.status === 'deleted') continue;

          const copie = newPhoto({
            sourceRef: src.sourceRef,
            sourceName: src.sourceName,
            mimeType: src.mimeType,
            base: src.base,
            origin: src.id,
          });
          // photo_03 -> photo_03_cocktail-fr
          copie.suffixes = [...src.suffixes, style.suffix];

          // Une duplication "en partant de l'image actuelle" herite du rendu
          // courant de l'originale comme point de depart, mais demarre SANS
          // historique ni image : le volet affiche "en cours" jusqu'a ce que
          // la generation aboutisse.
          if (from === 'current') {
            copie.inherit = { photoId: src.id, renderId: src.currentRenderId };
          }
          copie.busy = true;
          s.photos.push(copie);
          cibles.push(copie.id);
        }
      });
    }

    await runBatch(sessionId, { style, model, photoIds: cibles, from });
    return store.load(sessionId);
  }

  // Format de livraison, independant de la retouche. Ne s'applique pas aux
  // videos. C'est une transformation locale, gratuite, appliquee a la
  // validation : basculer ici ne declenche aucune generation.
  async function setFormat({ sessionId, photoIds, format }) {
    if (!['original', 'vitrine'].includes(format)) throw new Error('Format inconnu.');
    return withSession(sessionId, (s) => {
      for (const id of photoIds) {
        const p = photoById(s, id);
        if (!p || p.status === 'deleted') continue;
        if (p.kind === 'video') continue;
        p.format = format;
      }
    });
  }

  // Reglages colorimetriques d'une selection. Gratuit, local, applique a la
  // validation : rien n'est regenere, et les videos sont ignorees.
  async function setAdjust({ sessionId, photoIds, adjust }) {
    const propre = normalizeAdjust(adjust);
    return withSession(sessionId, (s) => {
      for (const id of photoIds) {
        const p = photoById(s, id);
        if (!p || p.status === 'deleted' || p.kind === 'video') continue;
        p.adjust = { ...propre };
      }
    });
  }

  async function removePhoto({ sessionId, photoId }) {
    return withSession(sessionId, (s) => {
      const p = photoById(s, photoId);
      if (!p) throw new Error('Photo introuvable dans ce plan.');
      p.status = 'deleted';
    });
  }

  // --- Compléter une session existante -------------------------------------
  // Répond au besoin "j'ai oublié une photo/un établissement" sans perdre la
  // session déjà créée (voir la navigation de l'écran Import).

  // Ajoute des médias déjà téléchargés (liens sociaux) à une session en
  // cours. Les nouvelles photos arrivent sans retouche ('ok', pas de style) :
  // le prestataire les sélectionne ensuite et choisit un prompt comme pour
  // n'importe quelle photo du plan.
  function newPhotoFromDescriptor(f) {
    const ext = (f.sourceName.split('.').pop() || 'jpg').toLowerCase();
    const estVideo = VIDEO_EXT.has(ext) || String(f.mimeType || '').startsWith('video/');
    const p = newPhoto({
      sourceRef: f.sourceRef,
      sourceName: f.sourceName,
      mimeType: f.mimeType,
      base: f.sourceName.replace(/\.[^.]+$/, ''),
      ext,
      kind: estVideo ? 'video' : 'photo',
    });
    p.status = 'ok'; // importee sans generation, comme un import initial sans style
    return p;
  }

  async function addMedia({ sessionId, files }) {
    if (!files || files.length === 0) throw new Error('Aucun média à ajouter.');
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (session.status === 'validated') throw new Error('Session déjà validée.');
    const backend = backends.forSession(session);
    if (!backend.addSource) {
      throw new Error("L'ajout de médias n'est pas disponible pour ce mode de session.");
    }
    const descripteurs = await backend.addSource(session, files);
    return withSession(sessionId, (s) => {
      for (const f of descripteurs) s.photos.push(newPhotoFromDescriptor(f));
      if (s.status === 'validated' || s.status === 'validating') return; // garde-fou
      s.status = 'ready';
    });
  }

  // Relit le dossier Drive de depart (mode 'drive') et ajoute au plan les
  // images qui n'y etaient pas encore lors du chargement initial.
  async function refreshFromDrive({ sessionId }) {
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (session.mode !== 'drive') throw new Error("Cette action n'existe que pour un import Drive.");
    if (session.status === 'validated') throw new Error('Session déjà validée.');
    const backend = backends.forSession(session);
    const connus = (session.photos || []).map((p) => p.sourceRef);
    const nouvelles = await backend.refreshSource(session, connus);
    if (nouvelles.length === 0) return session;
    return withSession(sessionId, (s) => {
      for (const f of nouvelles) s.photos.push(newPhotoFromDescriptor(f));
      if (s.status === 'validated' || s.status === 'validating') return;
      s.status = 'ready';
    });
  }

  // Renseigne ou corrige l'établissement d'une session existante. Utile
  // surtout en mode 'links', où l'établissement conditionne la destination ;
  // sans effet fonctionnel en mode 'drive' (destination toujours 'source'),
  // mais gardé accessible pour correction/affichage.
  async function setEtab({ sessionId, etab }) {
    if (!etab || !etab.id || !etab.nom) throw new Error('Établissement invalide.');
    return withSession(sessionId, (s) => {
      if (s.status === 'validated') throw new Error('Session déjà validée.');
      s.etab = { id: String(etab.id).trim(), nom: String(etab.nom).trim(), folderId: etab.folderId || null };
    });
  }

  // --- Validation ---------------------------------------------------------
  // Seule porte vers la livraison. Chaque element retenu est reconstruit ici
  // (rendu retenu, ou original si aucune retouche), le format vitrine est
  // applique en dernier, puis le backend depose.
  async function validate({ sessionId }) {
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (session.status === 'validated') return session;
    if (session.status === 'running') {
      throw new Error('Traitement en cours : attends la fin avant de valider.');
    }

    // Par lignee : les retouches si elles existent, l'original sinon.
    // Voir aLivrer() dans store.js.
    const retenues = aLivrer(session);
    if (retenues.length === 0) throw new Error('Aucun media a valider.');

    session.status = 'validating';
    session.validateProgress = { done: 0, total: retenues.length };
    await store.save(session);

    const backend = backends.forSession(session);
    let dest;
    try {
      dest = await backend.openDestination(session);
      const nomEtab = session.etab ? String(session.etab.nom).trim().replace(/[/\\]/g, '-') : '';
      let index = dest.startIndex || 1;
      const pris = new Set(dest.existingNames || []);
      let n = 0;

      for (const p of retenues) {
        // 1. Les octets a livrer : le rendu retenu, ou l'original si la photo
        //    n'a jamais ete retouchee (import simple).
        const r = currentRender(p);
        let buffer =
          r && r.workFileId
            ? await backend.readWork(session, r.workFileId)
            : await backend.readSource(session, p);

        // 2. Reglages colorimetriques, puis format vitrine, puis
        //    normalisation en JPEG. Cet ordre est fige : ajuster APRES le
        //    recadrage porterait sur une image deja en boite aux lettres.
        //
        //    UN SEUL ENCODAGE. Si des reglages s'appliquent, ils produisent
        //    directement le JPEG de livraison ; sinon la normalisation s'en
        //    charge, et ne fait rien du tout si la source est deja un JPEG
        //    conforme.
        // AUCUNE transformation par defaut.
        //
        // Le fichier livre est celui de FLORA, octet pour octet, avec son
        // format d'origine. C'est la seule version dont on ait la preuve
        // qu'elle est acceptee : c'est exactement le fichier obtenu avec
        // "download the original" depuis FLORA.
        //
        // Les deux seules exceptions sont des actions demandees explicitement
        // par l'utilisateur, et elles imposent un reencodage :
        //   - des reglages colorimetriques (le format d'entree est conserve) ;
        //   - le format vitrine, qui exige la transparence, donc du PNG.
        let ext = extLivree(p);
        if (p.kind === 'photo') {
          if (!isNeutral(p.adjust)) {
            buffer = await appliquerReglages(buffer, p.adjust);
          }
          if (p.format === 'vitrine') {
            buffer = await formatVitrine(buffer);
            ext = 'png';
          }
        }

        // 3. Le nom depend de la destination, pas de la source.
        //    Dossier etablissement -> numerotation a la suite.
        //    Sous-dossier de shooting ou zip -> nom source + suffixes.
        // Le nom porte l'extension du fichier reellement livre.
        let nom = dest.type === 'etab'
          ? nomAutre(p, nomEtab, index++, ext)
          : nomShooting(p, ext);
        // pris est amorce avec les fichiers deja presents dans le dossier :
        // une seconde validation ne doit rien ecraser.
        const racine = nom.replace(/\.[^.]+$/, '');
        let k = 2;
        while (pris.has(nom)) nom = `${racine}_${k++}.${ext}`;
        pris.add(nom);

        await backend.putFinal(session, dest, {
          name: nom,
          mimeType: MIME[ext] || 'application/octet-stream',
          buffer,
        });

        // Le nom final est enregistre DANS withSession, qui relit le plan sur
        // disque. L'ecrire sur l'objet charge en debut de validation ne servait
        // a rien : la sauvegarde finale repart d'une relecture, et la valeur
        // etait perdue. C'est ce qui vidait le zip.
        await withSession(sessionId, (s2) => {
          const q = photoById(s2, p.id);
          if (q) {
            q.finalName = nom;
            const rq = r ? renderById(q, r.id) : null;
            if (rq) rq.finalName = nom;
          }
          s2.validateProgress = { done: ++n, total: retenues.length };
        });
      }

      await backend.closeDestination(session, dest);

      const s3 = await store.load(sessionId);
      s3.delivery = dest.delivery;
      s3.destinationType = dest.type;
      s3.outputFolderName = dest.name;
      s3.outputFolderUrl = dest.url;
      s3.validatedCount = retenues.length;
      s3.validateProgress = { done: retenues.length, total: retenues.length };
      s3.status = 'validated';
      return store.save(s3);
    } catch (e) {
      const s2 = (await store.load(sessionId)) || session;
      s2.status = 'ready';
      s2.error = 'Validation echouee : ' + msg(e);
      await store.save(s2);
      throw e;
    }
  }

  // Lecture / modification / sauvegarde, serialisee par session : deux
  // relances concurrentes ne doivent pas ecraser leurs ecritures.
  const verrous = new Map();
  async function withSession(sessionId, fn) {
    const precedent = verrous.get(sessionId) || Promise.resolve();
    const suivant = precedent.then(async () => {
      const s = await store.load(sessionId);
      if (!s) throw new Error('Session introuvable.');
      await fn(s);
      return store.save(s);
    });
    verrous.set(
      sessionId,
      suivant.catch(() => {}),
    );
    return suivant;
  }

  return {
    startSession, runBatch, rerun, removePhoto,
    setFormat, setAdjust, validate, withSession,
    addMedia, refreshFromDrive, setEtab,
  };
}

const msg = (e) => String((e && e.message) || e);

function slug(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
