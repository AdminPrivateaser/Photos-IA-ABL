// Import d'un nouveau shooting (version ABL).
//
// ABL telecharge le zip du shooting depuis Shoootin et le depose dans
// l'outil. L'outil :
//   1. decompresse le zip (ou prend les photos deposees telles quelles) ;
//   2. trouve le mois du shooting d'apres la date de prise de vue des photos
//      (EXIF), a defaut le mois en cours ;
//   3. range le tout dans « Shooting / Octobre 2026 » du dossier de
//      l'etablissement : « Shooting » est retrouve (majuscules et accents
//      ignores) ou cree, le dossier du mois aussi ;
//   4. y envoie les photos, sans recopier celles qui y sont deja ;
//   5. ouvre la session de retouche sur ce dossier, comme en mode Drive.
//
// Un shooting HD peut depasser 1 Go : le zip est ecrit sur le volume, lu
// fichier par fichier, et le travail tourne en tache de fond. L'interface
// suit l'avancement via GET /api/shootings/:id.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import yauzl from 'yauzl';

const IMAGES = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff']);
const VIDEOS = new Set(['mp4', 'mov', 'm4v', 'webm']);
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
  heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
};
const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août',
  'Septembre', 'Octobre', 'Novembre', 'Décembre'];

export const NOM_SHOOTING = 'Shooting';
const normaliser = (n) =>
  String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const ext = (nom) => (String(nom).split('.').pop() || '').toLowerCase();
// Fichiers parasites des zips faits sur Mac ou Windows.
const parasite = (chemin) =>
  /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(chemin) || /(^|\/)\._/.test(chemin);

// « Octobre 2026 », a l'heure de Paris.
export function nomMois(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', month: 'numeric', year: 'numeric',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${MOIS[Number(p.month) - 1]} ${p.year}`;
}

// Date de prise de vue lue dans les EXIF : on cherche la premiere date au
// format EXIF « AAAA:MM:JJ HH:MM:SS » dans le debut du fichier, ou elles se
// trouvent toujours. Pas besoin de bibliotheque : DateTimeOriginal et
// DateTime partagent ce format.
export function dateExif(buffer) {
  const debut = buffer.subarray(0, Math.min(buffer.length, 256 * 1024)).toString('latin1');
  const m = debut.match(/((?:19|20)\d\d):(0[1-9]|1[0-2]):([0-2]\d|3[01]) [0-2]\d:[0-5]\d:[0-5]\d/);
  return m ? { annee: Number(m[1]), mois: Number(m[2]) } : null;
}

// Mois le plus frequent parmi les dates trouvees, sinon le mois en cours.
function moisDuShooting(dates) {
  const compte = new Map();
  for (const d of dates) {
    if (!d) continue;
    const cle = `${d.annee}-${d.mois}`;
    compte.set(cle, (compte.get(cle) || 0) + 1);
  }
  if (compte.size === 0) return { nom: nomMois(), source: 'date du jour' };
  const [cle] = [...compte.entries()].sort((a, b) => b[1] - a[1])[0];
  const [a, m] = cle.split('-').map(Number);
  return { nom: `${MOIS[m - 1]} ${a}`, source: 'date des photos' };
}

// Liste les fichiers medias d'un zip, sans les extraire.
function ouvrirZip(chemin) {
  return new Promise((ok, ko) => {
    yauzl.open(chemin, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return ko(new Error('Zip illisible : ' + err.message));
      const entrees = [];
      zip.on('entry', (e) => {
        const nom = e.fileName;
        if (!/\/$/.test(nom) && !parasite(nom) && (IMAGES.has(ext(nom)) || VIDEOS.has(ext(nom)))) entrees.push(e);
        zip.readEntry();
      });
      zip.on('end', () => ok({ zip, entrees }));
      zip.on('error', (e) => ko(new Error('Zip illisible : ' + e.message)));
      zip.readEntry();
    });
  });
}

function lireEntree(zip, entree) {
  return new Promise((ok, ko) => {
    zip.openReadStream(entree, (err, flux) => {
      if (err) return ko(err);
      const morceaux = [];
      flux.on('data', (c) => morceaux.push(c));
      flux.on('end', () => ok(Buffer.concat(morceaux)));
      flux.on('error', ko);
    });
  });
}

export function createShootings({ drive, workplan, dir }) {
  const travaux = new Map(); // id -> etat de l'import, lu par l'interface
  const tmp = path.join(dir, 'shootings');
  // Un envoi interrompu (redemarrage, fermeture de l'onglet) laisse son zip
  // sur le volume : on fait le menage au demarrage.
  fs.readdir(tmp).then(async (noms) => {
    for (const n of noms) {
      const f = path.join(tmp, n);
      const st = await fs.stat(f).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 86400_000) await fs.rm(f, { force: true }).catch(() => {});
    }
  }).catch(() => {});

  // fichiers : [{ path (sur le volume), originalname }] — un zip, ou des photos.
  async function demarrer({ fichiers, etab, user, resolveModel }) {
    const id = randomUUID();
    const etat = {
      id, status: 'running', etape: 'Lecture des fichiers…', total: 0, done: 0,
      dossier: null, dossierUrl: null, sessionId: null, error: null, ignores: 0, deja: 0,
    };
    travaux.set(id, etat);
    traiter(etat, { fichiers, etab, user, resolveModel })
      .catch((e) => { etat.status = 'error'; etat.error = String((e && e.message) || e); })
      .finally(async () => {
        for (const f of fichiers) await fs.rm(f.path, { force: true }).catch(() => {});
        // On garde l'etat une heure, le temps que l'interface le lise.
        setTimeout(() => travaux.delete(id), 3600_000).unref();
      });
    return etat;
  }

  async function traiter(etat, { fichiers, etab, user, resolveModel }) {
    // 1. Inventaire : chaque media est une fonction qui rend ses octets, pour
    //    ne jamais charger tout le shooting en memoire d'un coup.
    const medias = [];
    const zips = [];
    for (const f of fichiers) {
      if (ext(f.originalname) === 'zip') {
        const { zip, entrees } = await ouvrirZip(f.path);
        zips.push(zip);
        for (const e of entrees) {
          medias.push({ nom: path.basename(e.fileName), lire: () => lireEntree(zip, e) });
        }
      } else if (IMAGES.has(ext(f.originalname)) || VIDEOS.has(ext(f.originalname))) {
        medias.push({ nom: path.basename(f.originalname), lire: () => fs.readFile(f.path) });
      } else {
        etat.ignores++;
      }
    }
    try {
      if (medias.length === 0) throw new Error('Aucune photo ni vidéo trouvée dans ce que tu as déposé.');
      medias.sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { numeric: true }));
      etat.total = medias.length;

      // 2. Mois du shooting, d'apres les 15 premieres photos.
      etat.etape = 'Lecture de la date du shooting…';
      const dates = [];
      for (const m of medias.filter((x) => IMAGES.has(ext(x.nom))).slice(0, 15)) {
        dates.push(dateExif(await m.lire()));
      }
      const mois = moisDuShooting(dates);

      // 3. « Shooting / <mois> » dans l'etablissement, crees s'ils manquent.
      etat.etape = `Création du dossier « Shooting / ${mois.nom} »…`;
      const enfants = await drive.listSubfolders(etab.folderId);
      const shooting = enfants.find((f) => normaliser(f.name) === 'shooting')
        || await drive.findOrCreateFolder(NOM_SHOOTING, etab.folderId);
      const dossier = await drive.findOrCreateFolder(mois.nom, shooting.id);
      etat.dossier = `${shooting.name || NOM_SHOOTING} / ${mois.nom}`;
      etat.dossierSource = mois.source;
      etat.dossierId = dossier.id;
      etat.dossierUrl = dossier.webViewLink || drive.folderUrl(dossier.id);

      // 4. Envoi, sans recopier une photo deja presente (meme empreinte).
      const existants = await drive.listFiles(dossier.id).catch(() => []);
      const empreintes = new Set(existants.map((f) => f.md5Checksum).filter(Boolean));
      const noms = new Set(existants.map((f) => f.name));
      etat.etape = 'Envoi des photos dans Drive…';
      for (const m of medias) {
        const buffer = await m.lire();
        const md5 = createHash('md5').update(buffer).digest('hex');
        if (empreintes.has(md5)) {
          etat.deja++;
        } else {
          let nom = m.nom;
          for (let k = 2; noms.has(nom); k++) nom = m.nom.replace(/(\.[^.]+)?$/, `_${k}$1`);
          await drive.upload(nom, MIME[ext(nom)] || 'application/octet-stream', buffer, dossier.id);
          noms.add(nom);
          empreintes.add(md5);
        }
        etat.done++;
      }
    } finally {
      for (const z of zips) try { z.close(); } catch {}
    }

    // 5. Session de retouche sur ce dossier, comme en mode « Un dossier Drive ».
    etat.etape = 'Ouverture de la session…';
    const session = await workplan.startSession({
      mode: 'drive',
      driveUrl: drive.folderUrl(etat.dossierId),
      style: null,
      model: resolveModel(),
      etab,
      nomEtab: etab.nom,
      destination: 'source',
      user,
    });
    etat.sessionId = session.id;
    etat.status = 'done';
    etat.etape = 'Terminé';
  }

  return { demarrer, etat: (id) => travaux.get(id) || null, dossierTemp: tmp };
}
