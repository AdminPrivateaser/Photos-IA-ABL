// Couche de stockage du plan de travail.
//
// Deux responsabilites separees :
//
// 1. OU vivent les octets pendant le travail
//    'drive'          -> originaux dans le dossier Drive, rendus dans _travail
//    'upload'/'links' -> tout sur le volume (DATA_DIR/sessions/<id>/)
//
// 2. Depuis la v17, le rangement dans le Drive (originaux a l'import,
//    retouches dans « Retouche - <date> ») est fait par rangement.js.
//    openDestination / putFinal ne servent plus qu'aux anciennes sessions
//    (livraison « _retouches », « {nom}_social media » ou zip) ; seul
//    closeDestination est encore appele a la validation, pour mettre le
//    dossier _travail a la corbeille en mode Drive.

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

    // Depose un media glisse dans l'app DIRECTEMENT dans le dossier Drive de
    // depart de la session, puis le traite comme n'importe quelle photo du
    // dossier : le fichier existe reellement dans le Drive du CSM, pas
    // seulement dans la session, les deux restent donc toujours synchronises.
    // Reponse a "j'ai oublie une photo/l'etablissement" sans perdre la
    // session deja creee.
    async addSource(session, files) {
      if (!session.source || !session.source.folderId) {
        throw new Error('Aucun dossier Drive de départ pour cette session.');
      }
      const photos = [];
      for (const f of files) {
        const uploade = await drive.upload(f.originalname, f.mimetype, f.buffer, session.source.folderId);
        photos.push({ sourceRef: uploade.id, sourceName: f.originalname, mimeType: f.mimetype });
      }
      return photos;
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
        // f.lire : fichier extrait d'un zip a la demande (voir shooting.js).
        await write(session.id, 'source', ref, f.buffer || (await f.lire()));
        photos.push({ sourceRef: ref, sourceName: f.originalname, mimeType: f.mimetype });
      }
      return { source: { folderName: 'Import' }, etab: null, workRef: 'work', photos };
    },

    readSource: (session, photo) => fs.readFile(p(session.id, 'source', photo.sourceRef)),
    readWork: (session, ref) => fs.readFile(p(session.id, 'work', ref)),

    // Ajoute des médias à une session déjà démarrée (glisser-déposer, liens
    // sociaux) : même écriture que prepare(), mais sur une session
    // existante, pour compléter un import au lieu d'en ouvrir un nouveau.
    async addSource(session, files) {
      const photos = [];
      for (const f of files) {
        const ext = (path.extname(f.originalname) || '.jpg').toLowerCase();
        const ref = randomUUID() + ext;
        // f.lire : fichier extrait d'un zip a la demande (voir shooting.js).
        await write(session.id, 'source', ref, f.buffer || (await f.lire()));
        photos.push({ sourceRef: ref, sourceName: f.originalname, mimeType: f.mimetype });
      }
      return photos;
    },

    async writeWork(session, { name, buffer }) {
      const ref = randomUUID() + path.extname(name);
      await write(session.id, 'work', ref, buffer);
      return ref;
    },

    // Pas de dossier de depart : soit l'etablissement, soit le zip.
    async openDestination(session) {
      if (session.destination === 'etab' && session.etab) return d.ouvrirEtab(session);
      return {
        type: 'zip',
        ref: 'final',
        name: 'Retouches',
        url: null,
        startIndex: 1,
        existingNames: [],
        delivery: 'zip',
      };
    },

    async putFinal(session, dest, item) {
      if (dest.delivery === 'drive') return d.putFinal(session, dest, item);
      // Zip : le fichier est ecrit sous son nom final, l'endpoint de
      // telechargement se contente de lire ce dossier.
      await write(session.id, 'final', item.name, item.buffer);
      return item.name;
    },

    async closeDestination() {},

    // Supprime tout le dossier de la session (originaux, rendus, livrables).
    async cleanup(session) {
      await fs.rm(base(session.id), { recursive: true, force: true });
    },

    listFinal: async (session) => {
      try {
        return await fs.readdir(path.join(base(session.id), 'final'));
      } catch {
        return [];
      }
    },
    readFinal: (session, name) => fs.readFile(p(session.id, 'final', name)),
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
