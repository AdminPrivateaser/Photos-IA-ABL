import { google } from 'googleapis';
import { Readable } from 'node:stream';

export function createDrive({ serviceAccountJson }) {
  const credentials =
    typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const FOLDER = 'application/vnd.google-apps.folder';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Extrait l'ID de dossier depuis un lien Drive (.../folders/ID ou ...?id=ID)
  function folderIdFromUrl(url) {
    const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (!m) throw new Error("Lien Drive invalide : identifiant du dossier introuvable.");
    return m[1];
  }

  async function getFolder(folderId) {
    const { data } = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,parents,driveId',
      supportsAllDrives: true,
    });
    return data;
  }

  async function listImages(folderId) {
    const files = [];
    let pageToken;
    do {
      const { data } = await drive.files.list({
        q: `'${esc(folderId)}' in parents and mimeType contains 'image/' and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType)',
        pageSize: 1000,
        orderBy: 'name',
        corpora: 'allDrives',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      });
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
    return files;
  }

  async function createFolder(name, parentId) {
    const { data } = await drive.files.create({
      requestBody: { name, mimeType: FOLDER, parents: [parentId] },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });
    return data;
  }

  // Cherche un dossier par nom dans un parent, le cree s'il n'existe pas.
  // Utilise pour _travail : une session reprise ne doit pas creer un doublon.
  async function findOrCreateFolder(name, parentId) {
    const { data } = await drive.files.list({
      q:
        `'${esc(parentId)}' in parents and mimeType='${FOLDER}' ` +
        `and name='${esc(name)}' and trashed=false`,
      fields: 'files(id,name,webViewLink)',
      pageSize: 1,
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (data.files && data.files[0]) return { ...data.files[0], created: false };
    const cree = await createFolder(name, parentId);
    return { ...cree, created: true };
  }

  async function download(fileId) {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data);
  }

  async function upload(name, mimeType, buffer, parentId) {
    const { data } = await drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id,name',
      supportsAllDrives: true,
    });
    return data;
  }

  // Deplace un fichier d'un dossier vers un autre, avec renommage optionnel.
  // Sert a la validation : _travail -> dossier de sortie, sous le nom final.
  async function move(fileId, { fromParentId, toParentId, name }) {
    const { data } = await drive.files.update({
      fileId,
      addParents: toParentId,
      removeParents: fromParentId,
      requestBody: name ? { name } : {},
      fields: 'id,name',
      supportsAllDrives: true,
    });
    return data;
  }

  async function remove(fileId) {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  }

  // Corbeille plutot que suppression definitive : le nettoyage de _travail
  // apres validation doit etre recuperable en cas d'erreur.
  async function trash(fileId) {
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
  }

  // --- Convention des dossiers etablissement -------------------------------
  // Un dossier etablissement se nomme "{ID} - {nom}". On sait donc deduire
  // l'etablissement d'un lien Drive, sans le demander au CSM.
  // Reconnaissance d'un dossier etablissement.
  //
  // L'ancienne version exigeait strictement "{ID} - {nom}" avec l'ID en tete.
  // Un dossier "Le Comptoir - 12345" ou "Le Comptoir (12345)" n'etait pas
  // reconnu. On accepte maintenant les trois ecritures courantes, et dans
  // tous les cas le nom doit contenir au moins une lettre, sinon un dossier
  // "1500-750" passerait pour l'etablissement 1500 nomme "750".
  const A_UNE_LETTRE = /[A-Za-z\u00C0-\u024F]/;

  const FORMES = [
    /^\s*(\d{2,})\s*[-–—_]\s*(.+?)\s*$/, // 12345 - Le Comptoir
    /^\s*(.+?)\s*[-–—_]\s*(\d{2,})\s*$/, // Le Comptoir - 12345
    /^\s*(.+?)\s*[([]\s*(\d{2,})\s*[)\]]\s*$/, // Le Comptoir (12345)
  ];

  function parseEtab(nom) {
    const brut = String(nom || '').trim();
    if (!brut) return null;

    for (const [i, re] of FORMES.entries()) {
      const m = brut.match(re);
      if (!m) continue;
      // La premiere forme met l'ID en 1, les deux autres en 2.
      const id = i === 0 ? m[1] : m[2];
      const libelle = (i === 0 ? m[2] : m[1]).trim();
      if (A_UNE_LETTRE.test(libelle)) return { id, nom: libelle };
    }

    // Pas de regle attrape-tout au-dela de ces trois formes : un dossier de
    // shooting nomme "Fevrier 2026" serait pris pour l'etablissement 2026.
    return null;
  }

  // Cherche l'etablissement sur le dossier lui-meme, puis sur son parent.
  // Renvoie { etab, etabFolderId } ou null si la convention n'est pas suivie.
  async function detecterEtab(folderId) {
    const dossier = await getFolder(folderId);
    const direct = parseEtab(dossier.name);
    if (direct) return { etab: direct, etabFolderId: dossier.id };

    const parentId = (dossier.parents || [])[0];
    if (!parentId) return null;
    try {
      const parent = await getFolder(parentId);
      const p = parseEtab(parent.name);
      if (p) return { etab: p, etabFolderId: parent.id };
    } catch {
      // dossier parent inaccessible au compte de service
    }
    return null;
  }

  // Dossier etablissement dans le Drive parent, cree si absent.
  // Match strict : le nom commence par l'ID suivi d'un tiret.
  async function findOrCreateEtabFolder({ id, nom }, parentId) {
    const idStr = String(id).trim();
    const { data } = await drive.files.list({
      q:
        `'${esc(parentId)}' in parents and mimeType='${FOLDER}' ` +
        `and trashed=false and name contains '${esc(idStr)}'`,
      fields: 'files(id,name,webViewLink)',
      pageSize: 100,
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const debut = new RegExp('^' + idStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-');
    const trouve = (data.files || []).find(
      (f) => debut.test(f.name.trim()) || f.name.trim() === idStr,
    );
    if (trouve) return { ...trouve, created: false };
    const cree = await createFolder(`${idStr} - ${String(nom).trim()}`, parentId);
    return { ...cree, created: true };
  }

  // Recherche de dossiers etablissement sous le parent, par ID ou par nom.
  // Sert au cas ou il n'y a aucun lien Drive de depart (liens sociaux,
  // glisser-deposer) : le CSM tape "12345" ou "Comptoir" et choisit.
  async function searchEtabFolders(query, parentId) {
    const q = String(query || '').trim();
    if (!q || !parentId) return [];
    const { data } = await drive.files.list({
      q:
        `'${esc(parentId)}' in parents and mimeType='${FOLDER}' ` +
        `and trashed=false and name contains '${esc(q)}'`,
      fields: 'files(id,name,webViewLink)',
      pageSize: 20,
      orderBy: 'name',
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return (data.files || [])
      .map((f) => ({ folderId: f.id, name: f.name, etab: parseEtab(f.name) }))
      .filter((x) => x.etab);
  }

  // Noms de fichiers deja presents dans un dossier. Deux usages : ne pas
  // ecraser un fichier lors d'une seconde validation, et calculer le prochain
  // index de numerotation.
  async function listNames(folderId) {
    const noms = [];
    let pageToken;
    do {
      const { data } = await drive.files.list({
        q: `'${esc(folderId)}' in parents and trashed=false`,
        fields: 'nextPageToken, files(name)',
        pageSize: 1000,
        corpora: 'allDrives',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      });
      noms.push(...(data.files || []).map((f) => f.name));
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
    return noms;
  }

  // Prochain index de nommage dans un dossier : reprend a la suite des
  // fichiers "..._NN.ext" existants, pour ne pas ecraser ni recommencer a 1.
  async function nextFileIndex(folderId) {
    const noms = await listNames(folderId);
    let max = 0;
    for (const n of noms) {
      const m = n.match(/_(\d+)\.[a-z0-9]+$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return { next: max + 1, names: noms };
  }

  const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;

  return {
    folderIdFromUrl,
    getFolder,
    parseEtab,
    detecterEtab,
    findOrCreateEtabFolder,
    searchEtabFolders,
    listNames,
    nextFileIndex,
    listImages,
    createFolder,
    findOrCreateFolder,
    download,
    upload,
    move,
    remove,
    trash,
    folderUrl,
  };
}
