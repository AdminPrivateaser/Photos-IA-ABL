// Couche de stockage du plan de travail.
//
// Deux responsabilites separees :
//
// 1. OU vivent les octets pendant le travail
//    'drive'          -> originaux dans le dossier Drive, rendus dans _travail
//    'upload'/'links' -> tout sur le volume (DATA_DIR/sessions/<id>/)
//
// 2. OU va le resultat a la validation (session.destination)
//    'source' -> sous-dossier CREE DANS le dossier Drive de depart.
//                C'est le cas des shootings : le CSM colle un lien, le
//                resultat reste a cote de ses originaux.
//    'etab'   -> dossier "{nom}_social media" du dossier etablissement,
//                retrouve par recherche sur l'ID, cree s'il n'existe pas
//                encore ("{ID} - {Nom}"). Cas des liens sociaux, ou il n'y a
//                aucun dossier de depart. Obligatoire dans cette version :
//                pas de repli en zip.
//
// La livraison se fait en trois temps, pour que le nommage (qui doit savoir ce
// qui existe deja dans le dossier cible) reste dans workplan.js :
//   openDestination -> putFinal (n fois) -> closeDestination

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DOSSIER_TRAVAIL = '_travail';
const safeNom = (n) => String(n || '').trim().replace(/[/\\]/g, '-');

// --- Resolution des destinations Drive -------------------------------------
function destinationsDrive({ drive, parentFolderId }) {
  // Sous-dossier du dossier de depart. findOrCreate : une seconde validation
  // sur le meme dossier reutilise le sous-dossier au lieu d'en creer un autre.
  async function ouvrirSource(session) {
    if (!session.source || !session.source.folderId) {
      throw new Error('Aucun dossier Drive de depart pour cette session.');
    }
    const nom = `${safeNom(session.source.folderName)}_retouches`;
    const dossier = await drive.findOrCreateFolder(nom, session.source.folderId);
    const { next, names } = await drive.nextFileIndex(dossier.id);
    return {
      type: 'source',
      ref: dossier.id,
      name: nom,
      url: dossier.webViewLink || drive.folderUrl(dossier.id),
      startIndex: next,
      existingNames: names,
      delivery: 'drive',
    };
  }

  // Dossier etablissement, puis sous-dossier "{nom}_social media".
  // Le dossier etablissement est retrouve par son ID, ou cree s'il manque.
  async function ouvrirEtab(session) {
    if (!session.etab) throw new Error('Aucun etablissement selectionne.');
    if (!parentFolderId) {
      throw new Error('PARENT_FOLDER_ID absente : impossible de localiser les etablissements.');
    }
    const nomEtab = safeNom(session.etab.nom);
    const etabFolder = session.etab.folderId
      ? { id: session.etab.folderId }
      : await drive.findOrCreateEtabFolder(session.etab, parentFolderId);

    const nom = `${nomEtab}_social media`;
    const dossier = await drive.findOrCreateFolder(nom, etabFolder.id);
    const { next, names } = await drive.nextFileIndex(dossier.id);
    return {
      type: 'etab',
      ref: dossier.id,
      name: nom,
      url: dossier.webViewLink || drive.folderUrl(dossier.id),
      startIndex: next,
      existingNames: names,
      delivery: 'drive',
    };
  }

  async function putFinal(session, dest, { name, mimeType, buffer }) {
    const f = await drive.upload(name, mimeType, buffer, dest.ref);
    return f.id;
  }

  // Corbeille et non suppression definitive : en cas d'erreur, les rendus
  // restent recuperables.
  async function nettoyerTravail(session) {
    if (!session.workRef || session.mode !== 'drive') return;
    await drive
      .trash(session.workRef)
      .catch((e) => console.warn('[drive] Nettoyage de _travail impossible :', e.message));
  }

  return { ouvrirSource, ouvrirEtab, putFinal, nettoyerTravail };
}

// --- Backend Drive (source = dossier Drive) --------------------------------
export function createDriveBackend({ drive, parentFolderId }) {
  const d = destinationsDrive({ drive, parentFolderId });

  return {
    mode: 'drive',

    async prepare({ driveUrl }) {
      const folderId = drive.folderIdFromUrl(driveUrl);
      const folder = await drive.getFolder(folderId);
      const images = await drive.listImages(folderId);
      // L'etablissement est deduit pour information (affichage), mais la
      // destination par defaut reste le sous-dossier du dossier de depart.
      const detecte = await drive.detecterEtab(folderId).catch(() => null);

      if (images.length === 0) {
        return {
          source: { folderId, folderName: folder.name },
          etab: detecte ? { ...detecte.etab, folderId: detecte.etabFolderId } : null,
          workRef: null,
          photos: [],
        };
      }
      const travail = await drive.findOrCreateFolder(DOSSIER_TRAVAIL, folderId);
      return {
        source: { folderId, folderName: folder.name },
        etab: detecte ? { ...detecte.etab, folderId: detecte.etabFolderId } : null,
        workRef: travail.id,
        photos: images.map((img) => ({
          sourceRef: img.id,
          sourceName: img.name,
          mimeType: img.mimeType,
        })),
      };
    },

    readSource: (session, photo) => drive.download(photo.sourceRef),
    readWork: (session, ref) => drive.download(ref),

    // Relit le dossier Drive de depart et renvoie les images qui n'y etaient
    // pas encore : reponse a "j'ai ajoute des photos dans le dossier apres
    // avoir lance la session".
    async refreshSource(session, dejaConnus) {
      if (!session.source || !session.source.folderId) {
        throw new Error('Aucun dossier Drive de départ pour cette session.');
      }
      const images = await drive.listImages(session.source.folderId);
      const connus = new Set(dejaConnus);
      return images
        .filter((img) => !connus.has(img.id))
        .map((img) => ({ sourceRef: img.id, sourceName: img.name, mimeType: img.mimeType }));
    },

    async writeWork(session, { name, mimeType, buffer }) {
      const f = await drive.upload(name, mimeType, buffer, session.workRef);
      return f.id;
    },

    async openDestination(session) {
      if (session.destination === 'etab') return d.ouvrirEtab(session);
      return d.ouvrirSource(session);
    },
    putFinal: d.putFinal,
    closeDestination: (session) => d.nettoyerTravail(session),
    cleanup: async () => {},
    // Utilise par la purge : un dossier _travail de session abandonnee ne doit
    // pas rester indefiniment dans le dossier du client. Corbeille, donc
    // recuperable.
    trashWork: (session) => d.nettoyerTravail({ ...session, mode: 'drive' }),
  };
}

// --- Backend local : glisser-deposer et liens ------------------------------
export function createLocalBackend({ dir, drive, parentFolderId }) {
  const d = destinationsDrive({ drive, parentFolderId });
  const base = (sessionId) => path.join(dir, 'sessions', sessionId);
  const p = (sessionId, kind, ref) => path.join(base(sessionId), kind, ref);

  async function write(sessionId, kind, ref, buffer) {
    const f = p(sessionId, kind, ref);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, buffer);
    return ref;
  }

  return {
    mode: 'upload',

    // files : [{ originalname, mimetype, buffer }] — multer, ou medias
    // telecharges depuis des liens sociaux.
    async prepare({ session, files }) {
      const photos = [];
      for (const f of files) {
        const ext = (path.extname(f.originalname) || '.jpg').toLowerCase();
        const ref = randomUUID() + ext;
        await write(session.id, 'source', ref, f.buffer);
        photos.push({ sourceRef: ref, sourceName: f.originalname, mimeType: f.mimetype });
      }
      return { source: { folderName: 'Import' }, etab: null, workRef: 'work', photos };
    },

    readSource: (session, photo) => fs.readFile(p(session.id, 'source', photo.sourceRef)),
    readWork: (session, ref) => fs.readFile(p(session.id, 'work', ref)),

    // Ajoute des médias à une session déjà démarrée (liens sociaux) : même
    // écriture que prepare(), mais sur une session existante, pour compléter
    // un import au lieu d'en ouvrir un nouveau.
    async addSource(session, files) {
      const photos = [];
      for (const f of files) {
        const ext = (path.extname(f.originalname) || '.jpg').toLowerCase();
        const ref = randomUUID() + ext;
        await write(session.id, 'source', ref, f.buffer);
        photos.push({ sourceRef: ref, sourceName: f.originalname, mimeType: f.mimetype });
      }
      return photos;
    },

    async writeWork(session, { name, buffer }) {
      const ref = randomUUID() + path.extname(name);
      await write(session.id, 'work', ref, buffer);
      return ref;
    },

    // Pas de dossier de depart : l'etablissement est obligatoire dans cette
    // version (plus de repli en zip). server.js le verifie deja avant de
    // creer la session ; cette erreur ne devrait donc jamais se produire en
    // usage normal, elle protege juste contre un appel direct a l'API.
    async openDestination(session) {
      if (session.destination === 'etab' && session.etab) return d.ouvrirEtab(session);
      throw new Error('Aucun établissement sélectionné pour cette session.');
    },

    async putFinal(session, dest, item) {
      return d.putFinal(session, dest, item);
    },

    async closeDestination() {},

    // Supprime tout le dossier de la session (originaux, rendus, livrables).
    async cleanup(session) {
      await fs.rm(base(session.id), { recursive: true, force: true });
    },
  };
}

export function createBackends({ drive, dir, parentFolderId }) {
  const drv = createDriveBackend({ drive, parentFolderId });
  const loc = createLocalBackend({ dir, drive, parentFolderId });
  return {
    drive: drv,
    upload: loc,
    links: loc,
    forSession: (session) => (session.mode === 'drive' ? drv : loc),
  };
}
