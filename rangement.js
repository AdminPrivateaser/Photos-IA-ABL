// Rangement automatique dans le Drive de l'etablissement.
//
// Regles (v17) :
//
//   Origine des originaux, ranges DES L'IMPORT :
//     - liens (reseaux sociaux) -> « Social media » de l'etablissement
//     - fichiers deposes        -> « Contenu gérant / 19 octobre 2026 »
//     - dossier Drive           -> deja dans le Drive, rien a faire
//   Les dossiers « Social media » et « Contenu gérant » sont retrouves sans
//   tenir compte des majuscules ni des accents, et crees s'ils manquent.
//
//   Versions finales, rangees au telechargement et a la validation :
//     sous-dossier « Retouche - 19 octobre 2026 » (date de la retouche) DU
//     DOSSIER OU SE TROUVE L'ORIGINAL. Il contient UNE version par photo,
//     celle a mettre sur le back-office : la retouche si la photo en a une,
//     l'original sinon, plus les videos. On le telecharge tel quel, sans tri.
//
// Toutes les operations Drive d'une session passent en file, une par une :
// deux telechargements rapides ne doivent pas creer deux dossiers du jour ni
// deux fois le meme fichier.

import { createHash } from 'node:crypto';
import { photoById, currentRender, aLivrer } from './store.js';

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const msg = (e) => String((e && e.message) || e);

export const NOM_SOCIAL = 'Social media';
export const NOM_GERANT = 'Contenu gérant';

const normaliser = (n) =>
  String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// « 19 octobre 2026 », a l'heure de Paris.
export function dateLongue(d = new Date()) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
}
export const nomDossierRetouche = (d = new Date()) => `Retouche - ${dateLongue(d)}`;

const slug = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Provenance d'une photo : 'social', 'gerant' ou 'drive'.
export function provenance(session, p) {
  if (p.provenance) return p.provenance;
  if (session.mode === 'links') return 'social';
  if (session.mode === 'upload') return 'gerant';
  return 'drive';
}

export function createRangement({ drive, store, backends, withSession }) {
  // --- File d'attente par session ----------------------------------------
  const files = new Map();
  function enFile(sessionId, fn) {
    const prec = files.get(sessionId) || Promise.resolve();
    const suivant = prec.then(fn);
    files.set(sessionId, suivant.catch(() => {}));
    return suivant;
  }

  // --- Dossiers, avec cache dans la session --------------------------------
  // Le cache evite de relister le Drive a chaque fichier. Il est relu a
  // chaque operation (la file garantit qu'il est a jour).
  async function dossier(sessionId, parentId, nom, { souple = false } = {}) {
    const s = await store.load(sessionId);
    const cle = `${parentId}|${normaliser(nom)}`;
    const cache = (s.rangement && s.rangement.dossiers) || {};
    if (cache[cle]) return cache[cle];

    let trouve = null;
    if (souple) {
      // « social media », « Social Media », « Contenu gerant »... mais pas
      // « Barrel Pub_social media », qui est un ancien dossier de livraison.
      const enfants = await drive.listSubfolders(parentId);
      trouve = enfants.find((f) => normaliser(f.name) === normaliser(nom)) || null;
    }
    if (!trouve) trouve = await drive.findOrCreateFolder(nom, parentId);
    const d = {
      id: trouve.id,
      name: trouve.name || nom,
      url: trouve.webViewLink || drive.folderUrl(trouve.id),
    };
    await withSession(sessionId, (s2) => {
      s2.rangement = s2.rangement || {};
      s2.rangement.dossiers = { ...(s2.rangement.dossiers || {}), [cle]: d };
    });
    return d;
  }

  // Noms deja pris dans un dossier. La premiere fois, on lit le Drive et on
  // garde le resultat en cache : avant, le cache ne gardait que les noms
  // ajoutes par la session, et oubliait ceux deja presents dans le dossier.
  // C'est ce qui donnait deux « DSC00011.JPG » dans le meme dossier.
  async function nomsDe(sessionId, folderId) {
    const s = await store.load(sessionId);
    const noms = s.rangement && s.rangement.noms && s.rangement.noms[folderId];
    if (noms) return new Set(noms);
    const lus = await drive.listNames(folderId).catch(() => []);
    await withSession(sessionId, (s2) => {
      s2.rangement = s2.rangement || {};
      s2.rangement.noms = { ...(s2.rangement.noms || {}), [folderId]: lus };
    });
    return new Set(lus);
  }

  // Empreintes (MD5) des fichiers d'un dossier, lues une fois par passage.
  // Sert a reconnaitre une photo deja rangee : la reimporter ne la recopie pas.
  async function empreintesDe(folderId, cache) {
    if (!cache.has(folderId)) {
      const fichiers = await drive.listFiles(folderId).catch(() => []);
      cache.set(folderId, new Map(fichiers.filter((f) => f.md5Checksum).map((f) => [f.md5Checksum, f])));
    }
    return cache.get(folderId);
  }
  async function memoriserNom(sessionId, folderId, nom) {
    await withSession(sessionId, (s2) => {
      s2.rangement = s2.rangement || {};
      const tous = (s2.rangement.noms = s2.rangement.noms || {});
      const set = new Set(tous[folderId] || []);
      set.add(nom);
      tous[folderId] = [...set];
    });
  }
  const libre = (noms, nom) => {
    if (!noms.has(nom)) return nom;
    const ext = nom.includes('.') ? nom.split('.').pop() : '';
    const racine = ext ? nom.slice(0, -(ext.length + 1)) : nom;
    let k = 2;
    while (noms.has(`${racine}_${k}${ext ? '.' + ext : ''}`)) k++;
    return `${racine}_${k}${ext ? '.' + ext : ''}`;
  };

  // Dossier d'arrivee des originaux selon la provenance.
  async function dossierOriginaux(sessionId, session, prov) {
    const etabId = session.etab && session.etab.folderId;
    if (!etabId) throw new Error("Aucun dossier Drive relie a l'etablissement.");
    if (prov === 'social') return dossier(sessionId, etabId, NOM_SOCIAL, { souple: true });
    const gerant = await dossier(sessionId, etabId, NOM_GERANT, { souple: true });
    const jour = await dossier(sessionId, gerant.id, dateLongue(new Date()));
    return { ...jour, name: `${gerant.name} / ${jour.name}` }; // nom affiche avec son chemin
  }

  // --- 1. Originaux, a l'import ------------------------------------------
  async function archiverMaintenant(sessionId, photoIds) {
    const s = await store.load(sessionId);
    if (!s) return;
    const backend = backends.forSession(s);
    const empreintes = new Map();
    for (const id of photoIds) {
      const p = photoById(s, id);
      if (!p || p.archive || p.status === 'deleted' || !p.sourceRef) continue;
      const prov = provenance(s, p);
      if (prov === 'drive') continue;
      // Une copie (variante) partage l'original de sa photo d'origine.
      if (p.origin) continue;
      try {
        const cible = await dossierOriginaux(sessionId, s, prov);
        const noms = await nomsDe(sessionId, cible.id);
        let archive;
        if (prov === 'social' && noms.has(p.sourceName)) {
          // Meme post deja recupere : le nom contient l'identifiant du post,
          // on ne cree pas de doublon.
          archive = { folderId: cible.id, folderName: cible.name, folderUrl: cible.url, name: p.sourceName, deja: true };
        } else {
          const buffer = await backend.readSource(s, p);
          const md5 = createHash('md5').update(buffer).digest('hex');
          const existant = (await empreintesDe(cible.id, empreintes)).get(md5);
          if (existant) {
            // Photo identique deja dans le dossier (meme fichier importe
            // deux fois) : on reutilise celle-ci au lieu de la recopier.
            archive = { folderId: cible.id, folderName: cible.name, folderUrl: cible.url, name: existant.name, fileId: existant.id, deja: true };
          } else {
            const nom = libre(noms, p.sourceName);
            const f = await drive.upload(nom, p.mimeType || MIME[p.ext] || 'application/octet-stream', buffer, cible.id);
            await memoriserNom(sessionId, cible.id, nom);
            empreintes.get(cible.id).set(md5, { id: f.id, name: nom });
            archive = { folderId: cible.id, folderName: cible.name, folderUrl: cible.url, name: nom, fileId: f.id };
          }
        }
        await withSession(sessionId, (s2) => {
          const q = photoById(s2, id);
          if (q) { q.archive = archive; q.archiveErreur = null; }
          s2.rangement = s2.rangement || {};
          s2.rangement.originaux = { name: cible.name, url: cible.url, id: cible.id };
        });
      } catch (e) {
        console.warn('[rangement] original', p.sourceName, msg(e));
        await withSession(sessionId, (s2) => {
          const q = photoById(s2, id);
          if (q) q.archiveErreur = msg(e);
        }).catch(() => {});
      }
    }
  }
  const archiver = (sessionId, photoIds) => enFile(sessionId, () => archiverMaintenant(sessionId, photoIds));

  // --- 2. Dossier « Retouche - <date> » : les versions FINALES ------------
  //
  // Ce dossier doit pouvoir etre telecharge tel quel pour le back-office.
  // Il contient donc, pour chaque photo, UNE SEULE version : sa retouche si
  // elle en a une, son original sinon (meme regle que aLivrer() dans
  // store.js), plus les videos. Jamais l'original d'une photo retouchee :
  // il est deja dans « Social media », « Contenu gérant / <date> » ou le
  // dossier du shooting.
  //
  // Un seul fichier par photo (p.rangeRetouche) : une nouvelle version
  // remplace la precedente, et passe dans le dossier du jour si la date a
  // change. Ce qui n'est plus final (photo retiree du plan, original dont
  // une variante a ete retouchee) est mis a la corbeille par nettoyer().

  // Dossier ou se trouve l'original d'une photo.
  async function dossierOriginal(sessionId, photoId) {
    let s = await store.load(sessionId);
    const p = photoById(s, photoId);
    if (provenance(s, p) === 'drive') {
      if (!s.source || !s.source.folderId) throw new Error('Aucun dossier Drive de depart.');
      return { id: s.source.folderId, name: s.source.folderName, fileId: p.sourceRef };
    }
    // Une variante partage l'original de sa photo d'origine.
    let racine = p;
    for (let g = 0; racine.origin && g < 50; g++) racine = photoById(s, racine.origin) || { ...racine, origin: null };
    if (!racine.archive) {
      await archiverMaintenant(sessionId, [racine.id]);
      s = await store.load(sessionId);
      racine = photoById(s, racine.id) || racine;
    }
    if (!racine.archive) throw new Error(racine.archiveErreur || 'Original non range dans le Drive.');
    return { id: racine.archive.folderId, name: racine.archive.folderName, fileId: racine.archive.fileId || null };
  }

  // fichier : { buffer, ext, label, estRetouche } produit par
  // workplan.fichierRetouche. Absent pour une video (copiee telle quelle).
  async function deposerMaintenant({ sessionId, photoId, cle, fichier }) {
    const s = await store.load(sessionId);
    const p = s && photoById(s, photoId);
    if (!p) throw new Error('Photo introuvable.');
    // Une photo qui n'est pas une version finale n'a rien a faire ici.
    if (!aLivrer(s).some((q) => q.id === p.id)) return null;

    const orig = await dossierOriginal(sessionId, photoId);
    const dossierRet = await dossier(sessionId, orig.id, nomDossierRetouche(new Date()));
    const deja = p.rangeRetouche || null;
    if (deja && deja.cle === cle && deja.folderId === dossierRet.id) {
      return { ...deja, folderName: dossierRet.name, folderUrl: dossierRet.url, inchange: true };
    }

    const noms = await nomsDe(sessionId, dossierRet.id);
    if (deja && deja.folderId === dossierRet.id) noms.delete(deja.name);
    const retouche = !!(fichier && fichier.estRetouche);
    const base = [p.base, ...(p.suffixes || [])].join('_');
    const nom = libre(noms, retouche
      ? `${base}_${slug(fichier.label) || 'retouche'}.${fichier.ext}`
      : (p.suffixes || []).length ? `${base}.${p.ext}` : p.sourceName);

    let fait = null;
    if (retouche && deja) {
      // Nouvelle version d'une photo deja rangee : meme fichier, contenu et
      // nom mis a jour, deplace dans le dossier du jour si besoin.
      try {
        if (deja.folderId !== dossierRet.id) {
          await drive.move(deja.fileId, { fromParentId: deja.folderId, toParentId: dossierRet.id });
        }
        await drive.updateContent(deja.fileId, {
          name: nom, mimeType: MIME[fichier.ext] || 'application/octet-stream', buffer: fichier.buffer,
        });
        fait = { fileId: deja.fileId, name: nom, folderId: dossierRet.id };
      } catch {
        fait = null; // supprime a la main entre-temps : on le recree
      }
    } else if (deja) {
      // Retour a l'original : l'ancienne retouche part a la corbeille.
      await drive.trash(deja.fileId).catch(() => {});
    }

    if (!fait) {
      // Fichier identique deja dans « Retouche » (photos importees deux
      // fois) : on le reutilise au lieu d'en deposer un second.
      let md5 = null;
      if (retouche) md5 = createHash('md5').update(fichier.buffer).digest('hex');
      else if (orig.fileId) {
        const src = (await drive.listFiles(orig.id).catch(() => [])).find((x) => x.id === orig.fileId);
        md5 = src ? src.md5Checksum : null;
      }
      const identique = md5 && (await empreintesDe(dossierRet.id, new Map())).get(md5);
      if (identique) fait = { fileId: identique.id, name: identique.name, folderId: dossierRet.id };
    }

    if (!fait) {
      let f;
      if (retouche) {
        f = await drive.upload(nom, MIME[fichier.ext] || 'application/octet-stream', fichier.buffer, dossierRet.id);
      } else if (orig.fileId) {
        // Original non retouche, ou video : copie cote Drive, sans transfert.
        f = await drive.copy(orig.fileId, { name: nom, parentId: dossierRet.id });
      } else {
        const buffer = await backends.forSession(s).readSource(s, p);
        f = await drive.upload(nom, p.mimeType || MIME[p.ext] || 'application/octet-stream', buffer, dossierRet.id);
      }
      fait = { fileId: f.id, name: nom, folderId: dossierRet.id };
    }
    await memoriserNom(sessionId, dossierRet.id, fait.name);

    await withSession(sessionId, (s2) => {
      s2.rangement = s2.rangement || {};
      s2.rangement.retouches = { name: `${orig.name || ''} / ${dossierRet.name}`.replace(/^ \/ /, ''), url: dossierRet.url };
      const q = photoById(s2, photoId);
      if (!q) return;
      q.rangeRetouche = { ...fait, cle, at: new Date().toISOString() };
      q.depotErreur = null;
    });
    return { ...fait, folderName: dossierRet.name, folderUrl: dossierRet.url };
  }
  const deposer = (args) => enFile(args.sessionId, () => deposerMaintenant(args));

  // Met a la corbeille ce qui n'est plus une version finale.
  async function nettoyerMaintenant(sessionId) {
    const s = await store.load(sessionId);
    const finales = new Set(aLivrer(s).map((p) => p.id));
    for (const p of s.photos || []) {
      if (!p.rangeRetouche || finales.has(p.id)) continue;
      await drive.trash(p.rangeRetouche.fileId).catch(() => {});
      await withSession(sessionId, (s2) => {
        const q = photoById(s2, p.id);
        if (q) q.rangeRetouche = null;
      });
    }
  }
  const nettoyer = (sessionId) => enFile(sessionId, () => nettoyerMaintenant(sessionId));

  return { archiver, deposer, nettoyer, provenance };
}

// Cle de version d'une photo, partagee avec l'interface (« ☁ dans Drive »).
export function cleVersion(p) {
  return `${p.currentRenderId || 'source'}|${JSON.stringify(p.adjust || {})}|${p.format || 'original'}`;
}
export { currentRender };
