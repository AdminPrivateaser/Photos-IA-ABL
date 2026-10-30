// Suivi des retouches dans un Google Sheet : une ligne par session.
//
// La ligne est creee au premier evenement (telechargement d'une photo ou
// validation), puis mise a jour a chaque evenement suivant. Le suivi ne
// bloque JAMAIS une livraison : toute erreur est journalisee, la session est
// marquee "a synchroniser", et un passage periodique rejoue l'envoi.
//
// L'etat du suivi vit dans un fichier a part (DATA_DIR/suivi/{id}.json), pas
// dans le plan de travail : le plan est reecrit en continu par workplan.js,
// et une ecriture concurrente depuis ici pourrait ecraser une generation.
//
// Ecriture via le compte de service Google deja utilise pour Drive (scope
// drive, accepte par l'API Sheets). Le Sheet doit etre partage en Editeur
// avec son adresse client_email.
//
// Colonnes (onglet principal : « CX », ou « ABL » pour l'outil ABL) :
//   A Session · B Etablissement · C Date · D Date de validation ·
//   E Nb de photos · F Retoucheur · G Statut · H Tarif · I ID session ·
//   J Source · K Retouches · L Prompt personnalisé
// La colonne I sert a retrouver la ligne meme si quelqu'un trie le tableau :
// elle ne doit pas bouger, d'ou les nouvelles colonnes APRES elle.
//
// Onglet de detail (« Détail retouches », « Détail retouches ABL ») : une
// ligne par retouche utilisee dans une session (prompt, recadrage,
// colorimetrie), avec son nombre de photos et l'outil (CX ou ABL).
// C'est la base des statistiques : un tableau croise dynamique dessus
// repond a « quel prompt est le plus utilise, par qui, sur quelle source ».

import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import { sourceSession, retouchesSession, resumeRetouches } from './stats.js';
import { aLivrer } from './store.js';

const REESSAI_MS = 10 * 60 * 1000;
const COL_ID = 'I';
const COL_FIN = 'L';
const ENTETES_NOUVELLES = ['Source', 'Retouches', 'Prompt personnalisé'];
const ENTETES_DETAIL = [
  'ID session', 'Date', 'Retoucheur', 'Etablissement', 'Source',
  'Retouche', 'Type', 'Nb de photos', 'Texte du prompt', 'Outil',
];
const ENTETES_PRINCIPAL = [
  'Session', 'Etablissement', 'Date', 'Date de validation', 'Nb de photos', 'Retoucheur',
  'Statut', 'Tarif $', 'ID session', 'Source', 'Retouches', 'Prompt personnalisé',
];
// Version du format des lignes : les sessions synchronisees avec une version
// plus ancienne sont reprises une fois au demarrage (remplissage des
// nouvelles colonnes et de l'onglet de detail).
const FORMAT = 3; // v22 : libelles « Contenu gérant », « Shooting déposé », « Recadrage (auto) »
const LIMITE_CASE = 45000; // une case Google Sheets accepte 50 000 caracteres

// Options propres a chaque outil :
//   outil        : 'CX' ou 'ABL', ecrit dans la colonne « Outil » du detail ;
//   onglet       : { nom, creer } — onglet principal. CX : « CX », a defaut le
//                  premier onglet ; ABL : « ABL », cree s'il n'existe pas ;
//   ongletDetail : onglet de detail de l'outil. Un par outil (« Détail
//                  retouches » pour CX, « Détail retouches ABL ») : les deux
//                  serveurs suppriment et reecrivent des lignes, un onglet
//                  partage risquerait d'effacer les lignes de l'autre ;
//   retoucheur   : (session) => texte de la colonne « Retoucheur » ;
//   importerValidees : suivre aussi les sessions validees jamais suivies
//                  (ABL, qui n'avait pas de suivi avant la v2.2).
export function createTracker({
  serviceAccountJson, spreadsheetId, dir, store, catalogue = null, _sheets = null,
  outil = 'CX', onglet: ongletVoulu = { nom: 'CX', creer: false },
  ongletDetail: ONGLET_DETAIL = 'Détail retouches',
  retoucheur = (s) => s.user || '', importerValidees = false,
}) {
  const actif = !!((serviceAccountJson || _sheets) && spreadsheetId);
  if (!actif) {
    console.warn('[suivi] SUIVI_SHEET_ID ou GOOGLE_SERVICE_ACCOUNT_JSON absente : suivi desactive.');
  }

  let sheets = _sheets; // _sheets : client factice pour les tests
  if (actif && !sheets) {
    const credentials =
      typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log(`[suivi] Google Sheet ${spreadsheetId}, compte ${credentials.client_email}`);
  }

  const suiviDir = path.join(dir, 'suivi');
  let pret = null;
  const ensureDir = () => (pret ||= fs.mkdir(suiviDir, { recursive: true }));
  const fichier = (id) => path.join(suiviDir, `${id}.json`);

  async function lireEtat(id) {
    await ensureDir();
    try {
      return JSON.parse(await fs.readFile(fichier(id), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async function ecrireEtat(id, etat) {
    await ensureDir();
    const tmp = fichier(id) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(etat), 'utf8');
    await fs.rename(tmp, fichier(id));
  }

  // Un evenement a la fois par session : deux telechargements simultanes ne
  // doivent pas creer deux lignes.
  const verrous = new Map();
  function enSerie(id, fn) {
    const suivant = (verrous.get(id) || Promise.resolve()).then(fn);
    verrous.set(id, suivant.catch(() => {}));
    return suivant;
  }

  // Nom du premier onglet, lu une fois : le renommer ne casse rien.
  let onglet = null;
  async function nomOnglet() {
    if (onglet) return onglet;
    const { data } = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    });
    const titres = (data.sheets || []).map((x) => x.properties.title);
    if (ongletVoulu && titres.includes(ongletVoulu.nom)) {
      onglet = ongletVoulu.nom;
    } else if (ongletVoulu && ongletVoulu.creer) {
      // Onglet de l'outil (ABL) cree a la premiere ecriture, avec ses en-tetes.
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: ongletVoulu.nom } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: plage(ongletVoulu.nom, 'A1'),
        valueInputOption: 'RAW',
        requestBody: { values: [ENTETES_PRINCIPAL] },
      });
      onglet = ongletVoulu.nom;
    } else {
      onglet = titres[0];
    }
    return onglet;
  }
  const plage = (o, r) => `'${o.replace(/'/g, "''")}'!${r}`;

  function titreSession(s) {
    const etab = nomEtablissement(s);
    const dossier = s.mode === 'drive' && s.source && s.source.folderName;
    return dossier && dossier !== etab ? `${etab} · ${dossier}` : etab;
  }

  // Un texte commencant par = + - @ serait interprete comme une formule.
  const texte = (v) => {
    const x = String(v ?? '');
    return /^[=+\-@]/.test(x) ? `'${x}` : x;
  };

  // Date lisible et reconnue comme date par Sheets (heure de Paris).
  function dateFr(iso) {
    if (!iso) return '';
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
    );
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
  }

  async function lireCatalogue() {
    if (!catalogue) return null;
    try { return await catalogue(); } catch { return null; }
  }

  function ligne(s, etat, stats) {
    return [
      texte(titreSession(s)),
      texte(nomEtablissement(s)),
      dateFr(etat.premierLe),
      dateFr(etat.valideeLe),
      etat.photos.length,
      texte(retoucheur(s)),
      etat.valideeLe ? 'Validée' : 'Téléchargée',
      Math.round((s.cost || 0) * 100) / 100,
      s.id,
      texte(stats.source),
      texte(resumeRetouches(stats.retouches)),
      texte(stats.textes.join(' | ').slice(0, LIMITE_CASE)),
    ];
  }

  // --- Onglet « Détail retouches » -----------------------------------------
  let detailId = null; // identifiant numerique de l'onglet
  async function ongletDetail() {
    if (detailId !== null) return detailId;
    const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const trouve = (data.sheets || []).find((x) => x.properties.title === ONGLET_DETAIL);
    if (trouve) {
      detailId = trouve.properties.sheetId;
      // Colonne « Outil » ajoutee en v22 : en-tete pose s'il manque.
      const { data: e } = await sheets.spreadsheets.values.get({ spreadsheetId, range: plage(ONGLET_DETAIL, 'J1') });
      if (!(e.values && e.values[0] && e.values[0][0])) {
        await sheets.spreadsheets.values.update({
          spreadsheetId, range: plage(ONGLET_DETAIL, 'J1'), valueInputOption: 'RAW', requestBody: { values: [['Outil']] },
        });
      }
      return detailId;
    }
    const rep = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ONGLET_DETAIL } } }] },
    });
    detailId = rep.data.replies[0].addSheet.properties.sheetId;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: plage(ONGLET_DETAIL, 'A1'),
      valueInputOption: 'RAW',
      requestBody: { values: [ENTETES_DETAIL] },
    });
    return detailId;
  }

  // Remplace les lignes de detail d'une session par les chiffres actuels.
  let fileDetail = Promise.resolve();
  async function synchroniserDetail(s, etat, stats) {
    const idOnglet = await ongletDetail();
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: plage(ONGLET_DETAIL, 'A:A'),
    });
    const lignes = [];
    (data.values || []).forEach((r, i) => { if (r[0] === s.id) lignes.push(i); });
    if (lignes.length) {
      // De bas en haut, pour que les indices restent valables.
      const requests = lignes.reverse().map((i) => ({
        deleteDimension: { range: { sheetId: idOnglet, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } },
      }));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    }
    if (stats.retouches.length === 0) return;
    const valeurs = stats.retouches.map((r) => [
      s.id,
      dateFr(etat.premierLe),
      texte(retoucheur(s)),
      texte(nomEtablissement(s)),
      texte(stats.source),
      texte(r.nom),
      r.type,
      r.photos,
      texte(String(r.texte || '').slice(0, LIMITE_CASE)),
      outil,
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: plage(ONGLET_DETAIL, 'A:J'),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: valeurs },
    });
  }

  async function synchroniser(s, etat) {
    const o = await nomOnglet();
    const cat = await lireCatalogue();
    const { retouches, textes } = retouchesSession(s, cat);
    const stats = { source: sourceSession(s), retouches, textes };
    // Ligne retrouvee par l'ID de session (colonne I), jamais par un numero
    // memorise : un tri manuel du tableau deplacerait les lignes.
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: plage(o, `${COL_ID}:${COL_ID}`),
    });
    const ids = (data.values || []).map((r) => r[0]);
    if (!ids[0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: plage(o, `${COL_ID}1`),
        valueInputOption: 'RAW',
        requestBody: { values: [['ID session']] },
      });
    }
    // En-tetes des colonnes J a L, poses une fois.
    if (!enTetesOk) {
      const { data: e } = await sheets.spreadsheets.values.get({ spreadsheetId, range: plage(o, `J1:${COL_FIN}1`) });
      const actuels = (e.values && e.values[0]) || [];
      if (ENTETES_NOUVELLES.some((t, i) => actuels[i] !== t)) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: plage(o, `J1:${COL_FIN}1`),
          valueInputOption: 'RAW',
          requestBody: { values: [ENTETES_NOUVELLES] },
        });
      }
      enTetesOk = true;
    }
    const index = ids.indexOf(s.id);
    const valeurs = { values: [ligne(s, etat, stats)] };
    if (index >= 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: plage(o, `A${index + 1}:${COL_FIN}${index + 1}`),
        valueInputOption: 'USER_ENTERED',
        requestBody: valeurs,
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: plage(o, `A:${COL_FIN}`),
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: valeurs,
      });
    }
    // Une seule mise a jour du detail a la fois : la suppression se fait par
    // numero de ligne, qu'une autre session pourrait decaler entre-temps.
    const suite = fileDetail.then(() => synchroniserDetail(s, etat, stats));
    fileDetail = suite.catch(() => {});
    await suite;
    etat.format = FORMAT;
  }
  let enTetesOk = false;

  // Message d'erreur exploitable : l'API Google enfouit la cause.
  function explication(e) {
    const m = String((e && e.message) || e);
    if (/has not been used|SERVICE_DISABLED|is disabled/i.test(m)) {
      return "API Google Sheets non activee sur le projet du compte de service : " + m;
    }
    if (/permission|403/i.test(m)) {
      return "Le Sheet n'est pas partage en Editeur avec le compte de service : " + m;
    }
    if (/not found|404/i.test(m)) return 'SUIVI_SHEET_ID introuvable : ' + m;
    return m;
  }

  // Coeur commun : fusionne les photos, met a jour l'etat local, puis le Sheet.
  function enregistrer(sessionId, { photoIds = [], validee = false }) {
    if (!actif) return Promise.resolve();
    return enSerie(sessionId, async () => {
      const s = await store.load(sessionId);
      if (!s) return;
      const maintenant = new Date().toISOString();
      const etat = (await lireEtat(sessionId)) || {
                photos: [],
        premierLe: maintenant,
        valideeLe: null,
        aSynchroniser: false,
      };
      etat.photos = [...new Set([...etat.photos, ...photoIds])];
      if (validee && !etat.valideeLe) etat.valideeLe = maintenant;

      // L'etat local est ecrit AVANT l'envoi : s'il echoue, le
      // passage periodique sait quoi renvoyer.
      etat.aSynchroniser = true;
      await ecrireEtat(sessionId, etat);
      try {
        await synchroniser(s, etat);
        etat.aSynchroniser = false;
        etat.erreur = null;
      } catch (e) {
        etat.erreur = explication(e);
        console.error(`[suivi] session ${sessionId} non synchronisee :`, etat.erreur);
      }
      await ecrireEtat(sessionId, etat);
    }).catch((e) => console.error('[suivi]', e.message || e));
  }

  // Rejoue les sessions restees en echec (Google indisponible, Sheet non partage).
  async function reessayer() {
    if (!actif) return;
    await ensureDir();
    for (const f of await fs.readdir(suiviDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      const etat = await lireEtat(id).catch(() => null);
      if (!etat || !etat.aSynchroniser) continue;
      await enSerie(id, async () => {
        const s = await store.load(id);
        const e2 = await lireEtat(id);
        if (!s || !e2 || !e2.aSynchroniser) return;
        try {
          await synchroniser(s, e2);
          e2.aSynchroniser = false;
          e2.erreur = null;
          console.log(`[suivi] session ${id} synchronisee au reessai`);
        } catch (e) {
          e2.erreur = explication(e);
        }
        await ecrireEtat(id, e2);
      }).catch(() => {});
    }
  }
  if (actif) setInterval(() => reessayer().catch(() => {}), REESSAI_MS).unref();

  // Remplissage unique des sessions deja suivies avec un format plus ancien
  // (colonnes J a L vides, absentes de l'onglet de detail). Lent expres :
  // une session toutes les 5 s, pour rester sous les quotas de l'API Sheets.
  async function rattraper() {
    if (!actif) return;
    await ensureDir();
    let n = 0;
    if (importerValidees) {
      // Sessions validees sans etat de suivi : on cree leur etat, puis la
      // boucle ci-dessous les ecrit dans le Sheet.
      for (const r of await store.list({ limit: 1000 }).catch(() => [])) {
        if (r.status !== 'validated' || (await lireEtat(r.id).catch(() => null))) continue;
        const s = await store.load(r.id).catch(() => null);
        if (!s) continue;
        await ecrireEtat(r.id, {
          photos: aLivrer(s).map((p) => p.id),
          premierLe: s.createdAt, valideeLe: s.updatedAt || s.createdAt, aSynchroniser: true, format: 1,
        });
      }
    }
    for (const f of await fs.readdir(suiviDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      const etat = await lireEtat(id).catch(() => null);
      if (!etat || (etat.format || 1) >= FORMAT) continue;
      const s = await store.load(id).catch(() => null);
      if (!s) continue; // historique efface (plus de 90 jours)
      await enSerie(id, async () => {
        const e2 = await lireEtat(id);
        if (!e2 || (e2.format || 1) >= FORMAT) return;
        try {
          await synchroniser(s, e2);
          e2.aSynchroniser = false;
          e2.erreur = null;
          n++;
        } catch (e) {
          e2.erreur = explication(e);
          console.warn(`[suivi] rattrapage ${id} :`, e2.erreur);
        }
        await ecrireEtat(id, e2);
      }).catch(() => {});
      await new Promise((ok) => setTimeout(ok, intervalleRattrapage));
    }
    if (n) console.log(`[suivi] rattrapage : ${n} session(s) completee(s) (source, retouches, detail)`);
  }
  const intervalleRattrapage = _sheets ? 0 : 5000;
  if (actif) setTimeout(() => rattraper().catch((e) => console.warn('[suivi] rattrapage :', e.message)), _sheets ? 0 : 20000).unref();

  return {
    actif,
    rattraper,
    // Telechargement d'une ou plusieurs photos (a l'unite ou zip).
    telechargement: (sessionId, photoIds) => enregistrer(sessionId, { photoIds }),
    // Validation terminee : photoIds = ce qui a reellement ete livre.
    validation: (sessionId, photoIds) => enregistrer(sessionId, { photoIds, validee: true }),
  };
}

// Nom saisi au depart ; repli sur l'etablissement Drive pour les sessions
// creees avant que la saisie ne devienne obligatoire.
export function nomEtablissement(s) {
  return (s.nomEtab || (s.etab && s.etab.nom) || 'Non renseigné').trim();
}
