// Orchestration du plan de travail.
//
// Une session = un etablissement + des photos/videos importees d'une seule
// facon (dossier Drive, fichiers deposes, liens sociaux).
//
// Ce qui va dans le Drive, et quand (le detail est dans rangement.js) :
//   - a l'import : les originaux des liens (« Social media ») et des
//     fichiers deposes (« Contenu gérant / <date> ») ;
//   - au telechargement d'une photo retouchee, et a la validation : la
//     retouche, dans « Retouche - <date> » sous le dossier de l'original.
// Les rendus intermediaires vivent chez le backend (_travail en mode Drive,
// volume DATA_DIR sinon) tant qu'ils ne sont pas ranges.
//
// Attention : FLORA facture a la generation, pas a la validation. Un plan
// abandonne a deja coute. "Valider" controle ce qui est livre, pas la facture.

import {
  newPhoto, photoById, renderById, currentRender,
  nomShooting, nomAutre, extLivree, aLivrer, newRender,
} from './store.js';
import { renderPhoto, pMap } from './renderPhoto.js';
import { formatVitrine, appliquerReglages } from './transforms.js';
import { normalize as normalizeAdjust, isNeutral, CHAMPS as CHAMPS_ADJUST } from './adjust.js';
import sharp from 'sharp';
import { createRangement, cleVersion } from './rangement.js';
import { builtinStyles } from './builtinStyles.js';

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
export const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  m4v: 'video/x-m4v',
};

export function createWorkplan({ store, backends, flora, drive = null, concurrency = 4 }) {
  const rangement = drive ? createRangement({ drive, store, backends, withSession }) : null;
  // Range les originaux d'un import (liens, fichiers deposes) en tache de
  // fond : un souci Drive ne doit pas bloquer l'ouverture du plan.
  function archiverEnFond(session, ids) {
    if (!rangement || session.mode === 'drive' || ids.length === 0) return;
    rangement.archiver(session.id, ids).catch((e) => console.warn('[rangement]', msg(e)));
  }

  // --- Demarrage d'une session, quel que soit le mode ----------------------
  // mode 'drive'  : { driveUrl }
  // mode 'upload' : { files } (multer, en memoire)
  // style peut valoir null : on importe alors sans aucune generation. C'est le
  // cas normal pour un import social ou pour un simple passage au format
  // vitrine, et ca evite de depenser 30 generations a l'aveugle.
  async function startSession({ mode, driveUrl, files, style, model, etab, nomEtab, destination, user }) {
    const backend = backends[mode] || backends.drive;
    // Photos recuperees sur les reseaux : recadrage vitrine automatique
    // (1500x750, photo entiere, bords vides), sans IA ni cout.
    if (mode === 'links' && !style) style = { ...builtinStyles.recadrage, auto: true };
    // Destination par defaut selon l'entree : un lien Drive livre a cote de
    // ses originaux, un import sans dossier de depart livre dans
    // l'etablissement si on en connait un, sinon en zip.
    const dest = destination || (mode === 'drive' ? 'source' : etab ? 'etab' : 'zip');
    const session = await store.create({
      mode,
      styleLabel: style ? style.label : null,
      etab,
      nomEtab,
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
      const sv = await store.save(session);
      archiverEnFond(session, session.photos.map((p) => p.id));
      return sv;
    }

    await store.save(session);
    archiverEnFond(session, session.photos.map((p) => p.id));

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
          // Un recadrage vitrine n'est pas une base pour l'IA : elle
          // travaillerait sur une image reduite entouree de bords vides. On
          // repart de l'image qui est sous le recadrage.
          while (courant && courant.kind === 'recadrage' && style.type !== 'recadrage') {
            const dessous = courant.from && courant.from !== 'source' ? renderById(photo, courant.from) : null;
            courant = dessous;
            if (!dessous) break;
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
      // Pour les statistiques du suivi : prompt ecrit a la main, recadrage
      // automatique des photos recuperees par lien.
      if (style.libre) render.libre = true;
      if (style.auto) render.auto = true;

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

  // --- Reglages colorimetriques : creation d'une vraie nouvelle image -----
  //
  // Avant, les reglages etaient seulement memorises sur la photo et appliques
  // a la validation. Le bouton "telecharger" renvoyait donc l'image SANS les
  // reglages, en particulier sur un original jamais retouche.
  //
  // Maintenant, enregistrer des reglages produit un rendu de type
  // 'reglages', cuit en pleine resolution, sans IA ni cout. Il devient
  // l'image retenue : c'est lui qui est telecharge, depose et livre.
  //
  // Les reglages ne s'empilent pas : un rendu 'reglages' garde la reference
  // de l'image dont il part (r.from) et ses valeurs (r.adjust). Les modifier
  // repart de cette meme base, comme dans RawTherapee ou Lightroom. Remettre
  // tout a zero revient a la base.

  // Image de depart des reglages pour une photo : le rendu retenu, ou celui
  // dont part le rendu 'reglages' retenu, ou l'original.
  function baseReglages(p) {
    const cur = currentRender(p);
    if (cur && cur.kind === 'reglages') {
      return cur.from && cur.from !== 'source' ? renderById(p, cur.from) || null : null;
    }
    return cur && cur.workFileId ? cur : null;
  }

  async function setAdjust({ sessionId, photoIds, adjust }) {
    const propre = normalizeAdjust(adjust);
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (session.status === 'validated') throw new Error('Session deja validee.');
    if (session.status === 'validating') throw new Error('Validation en cours.');

    const cibles = photoIds.filter((id) => {
      const p = photoById(session, id);
      return p && p.status !== 'deleted' && p.kind !== 'video' && !p.busy;
    });
    if (cibles.length === 0) throw new Error('Aucune photo a regler (videos et photos en cours exclues).');

    // Remise a zero : aucune image a produire, on revient a la base.
    if (isNeutral(propre)) {
      await withSession(sessionId, (s) => {
        for (const id of cibles) {
          const p = photoById(s, id);
          if (!p) continue;
          p.adjust = { ...propre }; // efface aussi d'anciens reglages en attente
          const cur = currentRender(p);
          if (cur && cur.kind === 'reglages') {
            const base = baseReglages(p);
            p.currentRenderId = base ? base.id : null;
          }
        }
      });
      return { queued: 0 };
    }

    await withSession(sessionId, (s) => {
      for (const id of cibles) {
        const p = photoById(s, id);
        if (p) p.busy = true;
      }
      s.status = 'running';
    });

    // En arriere-plan : une photo de shooting pleine resolution prend une
    // a deux secondes, un lot de trente ne doit pas tenir une requete HTTP.
    traiterReglages(sessionId, cibles, propre).catch((e) =>
      console.error('[reglages]', msg(e)));
    return { queued: cibles.length };
  }

  async function traiterReglages(sessionId, photoIds, adj) {
    // Une photo a la fois : le decodage brut d'une image 6000x4000 occupe
    // 70 Mo, plusieurs en parallele feraient tomber le conteneur.
    for (const photoId of photoIds) {
      const s = await store.load(sessionId);
      const p = s && photoById(s, photoId);
      if (!p || p.status === 'deleted') continue;
      const backend = backends.forSession(s);
      const base = baseReglages(p);

      const render = newRender({
        promptLabel: 'Colorimétrie',
        promptText: null,
        model: null,
        from: base ? base.id : 'source',
        kind: 'reglages',
      });
      render.adjust = { ...adj };

      try {
        const entree = base
          ? await backend.readWork(s, base.workFileId)
          : await backend.readSource(s, p);
        const sortie = await appliquerReglages(entree, adj);
        const m = await sharp(sortie).metadata();
        render.ext = m.format === 'jpeg' ? 'jpg' : m.format || 'png';
        render.largeur = m.width || null;
        render.hauteur = m.height || null;
        render.poids = sortie.length;
        render.workFileId = await backend.writeWork(s, {
          name: `${p.base}_reglages_${render.id.slice(0, 8)}.${render.ext}`,
          mimeType: MIME[render.ext] || 'application/octet-stream',
          buffer: sortie,
        });
        render.status = 'ok';
      } catch (e) {
        render.status = 'error';
        render.error = 'Réglages impossibles : ' + msg(e);
      }

      await withSession(sessionId, (s2) => {
        const q = photoById(s2, photoId);
        if (!q) return;
        q.busy = false;
        if (render.status === 'ok') {
          q.renders.push(render);
          q.currentRenderId = render.id;
          // Les reglages sont maintenant DANS l'image : ne pas les
          // reappliquer a la validation.
          q.adjust = normalizeAdjust(null);
          q.status = 'ok';
          q.error = null;
          q.reglagesErreur = null;
        } else {
          // Echec : la photo garde son image precedente ; l'erreur est
          // gardee sur la photo pour que l'interface l'affiche.
          q.reglagesErreur = render.error;
          console.warn(`[reglages] ${q.base} : ${render.error}`);
        }
      });
    }

    await withSession(sessionId, (s2) => {
      if (s2.status === 'running' && !(s2.photos || []).some((p) => p.busy)) s2.status = 'ready';
    });
  }

  // --- Fichier d'une version, tel qu'on le voit -------------------------
  // Rendu retenu (ou original), puis anciens reglages encore en attente,
  // puis format vitrine. Sert au telechargement, au rangement et a la
  // validation : les trois produisent le meme fichier.
  async function fichierRetouche(session, p) {
    const backend = backends.forSession(session);
    const r = currentRender(p);
    let buffer = r && r.workFileId
      ? await backend.readWork(session, r.workFileId)
      : await backend.readSource(session, p);
    let ext = extLivree(p);
    const etiquettes = r && r.workFileId ? [r.promptLabel] : [];
    if (p.kind === 'photo' && !isNeutral(p.adjust)) {
      buffer = await appliquerReglages(buffer, p.adjust);
      const m = await sharp(buffer).metadata();
      ext = m.format === 'jpeg' ? 'jpg' : m.format || ext;
      etiquettes.push('Colorimétrie');
    }
    if (p.kind === 'photo' && p.format === 'vitrine') {
      buffer = await formatVitrine(buffer);
      ext = 'png';
      etiquettes.push('Recadrage');
    }
    return { buffer, ext, label: etiquettes.join(' '), estRetouche: etiquettes.length > 0 };
  }

  // Range la version finale d'une photo dans « Retouche - date » : sa
  // retouche, ou son original si elle n'en a pas (voir rangement.js).
  async function deposer({ sessionId, photoId, fichier }) {
    if (!rangement) throw new Error('Drive non configure.');
    const s = await store.load(sessionId);
    const p = s && photoById(s, photoId);
    if (!p) throw new Error('Photo introuvable.');
    const f = p.kind === 'video' ? null : fichier || (await fichierRetouche(s, p));
    return rangement.deposer({ sessionId, photoId, cle: cleVersion(p), fichier: f });
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

  // Ajoute des médias déjà téléchargés/glissés à une session en cours. Les
  // nouvelles photos arrivent sans retouche ('ok', pas de style) : on les
  // sélectionne ensuite et on choisit un prompt comme pour n'importe quelle
  // photo du plan.
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

  async function addMedia({ sessionId, files, provenance = null }) {
    if (!files || files.length === 0) throw new Error('Aucun média à ajouter.');
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (session.status === 'validated') throw new Error('Session déjà validée.');
    const backend = backends.forSession(session);
    if (!backend.addSource) {
      throw new Error("L'ajout de médias n'est pas disponible pour ce mode de session.");
    }
    const descripteurs = await backend.addSource(session, files);
    const prov = session.mode === 'drive' ? 'drive' : provenance;
    const nouvelles = descripteurs.map((f) => {
      const p = newPhotoFromDescriptor(f);
      if (prov) p.provenance = prov;
      return p;
    });
    const sv = await withSession(sessionId, (s) => {
      for (const p of nouvelles) s.photos.push(p);
      if (s.status === 'validated' || s.status === 'validating') return; // garde-fou
      s.status = 'ready';
    });
    archiverEnFond(session, nouvelles.map((p) => p.id));
    // Photos recuperees sur les reseaux : meme recadrage automatique qu'a
    // l'import initial.
    const aRecadrer = nouvelles.filter((p) => p.kind === 'photo').map((p) => p.id);
    if ((prov || (session.mode === 'links' ? 'social' : null)) === 'social' && aRecadrer.length) {
      await withSession(sessionId, (s) => { s.status = 'running'; });
      runBatch(sessionId, { style: { ...builtinStyles.recadrage, auto: true }, photoIds: aRecadrer })
        .catch((e) => console.warn('[recadrage]', msg(e)));
    }
    return sv;
  }

  // Renseigne ou corrige l'établissement d'une session existante. Utile
  // surtout quand la destination reste a definir (etab vs zip) ; sans effet
  // sur le mode 'drive' avec destination 'source', mais gardé accessible
  // pour correction/affichage.
  async function setEtab({ sessionId, etab }) {
    if (!etab || !etab.id || !etab.nom) throw new Error('Établissement invalide.');
    return withSession(sessionId, (s) => {
      if (s.status === 'validated') throw new Error('Session déjà validée.');
      s.etab = { id: String(etab.id).trim(), nom: String(etab.nom).trim(), folderId: etab.folderId || null };
      // Le nom suivi (titre, Google Sheet) suit l'etablissement corrige.
      s.nomEtab = s.etab.nom;
    });
  }

  // --- Validation ---------------------------------------------------------
  // Remplit « Retouche - date » (sous le dossier de l'original) avec la
  // version finale de chaque photo : sa retouche, ou son original si elle
  // n'a pas ete retouchee, plus les videos. Ce qui n'est plus final part a
  // la corbeille. Le dossier se telecharge alors tel quel pour le
  // back-office.
  async function validate({ sessionId }) {
    const session = await store.load(sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (session.status === 'validated') return session;
    if (session.status === 'running') {
      throw new Error('Traitement en cours : attends la fin avant de valider.');
    }
    if (!rangement) throw new Error('Drive non configure.');

    const photos = (session.photos || []).filter((p) => p.status !== 'deleted');
    const retouchees = aLivrer(session); // versions finales (nom garde pour le reste du code)
    if (retouchees.length === 0) throw new Error('Aucun media a ranger.');

    session.status = 'validating';
    session.validateProgress = { done: 0, total: retouchees.length };
    await store.save(session);

    try {
      // Filet : un original pas encore range (import ancien, erreur Drive
      // passagere) l'est maintenant.
      if (session.mode !== 'drive') {
        await rangement.archiver(sessionId, photos.filter((p) => !p.archive).map((p) => p.id));
      }

      let n = 0;
      let dernier = null;
      for (const p of retouchees) {
        const s = await store.load(sessionId);
        const q = photoById(s, p.id);
        const f = q.kind === 'video' ? null : await fichierRetouche(s, q);
        dernier = await rangement.deposer({ sessionId, photoId: p.id, cle: cleVersion(q), fichier: f });
        await withSession(sessionId, (s2) => {
          const q2 = photoById(s2, p.id);
          if (q2) q2.finalName = dernier.name;
          s2.validateProgress = { done: ++n, total: retouchees.length };
        });
      }

      await rangement.nettoyer(sessionId);

      // Mode Drive : les rendus intermediaires (_travail) partent a la corbeille.
      // (relu : le dossier _travail a pu etre cree apres le debut de la validation)
      const sFin = await store.load(sessionId);
      await backends.forSession(sFin).closeDestination(sFin).catch(() => {});

      const s3 = await store.load(sessionId);
      const ranges = s3.rangement || {};
      s3.delivery = 'drive';
      s3.destinationType = 'retouche';
      s3.outputFolderName = dernier ? dernier.folderName : (ranges.originaux || {}).name || null;
      s3.outputFolderUrl = dernier ? dernier.folderUrl : (ranges.originaux || {}).url || null;
      s3.validatedCount = retouchees.length;
      s3.validateProgress = { done: retouchees.length, total: retouchees.length };
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
    addMedia, setEtab, deposer, fichierRetouche,
  };
}

const msg = (e) => String((e && e.message) || e);

// AAAA-MM-JJ a l'heure de Paris : une session ouverte a 0h30 est du jour.
function dateParis(iso) {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function slug(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
