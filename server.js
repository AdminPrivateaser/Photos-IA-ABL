import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');

import { config, appConfig } from './config.js';
import { createAuth } from './auth.js';
import { builtinStyles } from './builtinStyles.js';
import { models, defaultModelKey, resolveModel } from './models.js';
import { createFlora } from './flora.js';
import { createDrive } from './drive.js';
import { createNotionSource } from './notion.js';
import { createNotionPublicSource } from './notionPublic.js';
import { createStyleSource } from './styleSource.js';
import {
  createStore, publicSession, photoById, renderById, currentRender, aLivrer,
  nomShooting, extLivree,
} from './store.js';
import { appliquerReglages } from './transforms.js';
import { isNeutral } from './adjust.js';
import { createLinksService } from './links.js';
import { diagnostic as socialDiagnostic } from './social.js';
import { createBackends } from './assets.js';
import { createWorkplan, MIME } from './workplan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Railway sert derriere un proxy : sans ceci, Express croit etre en HTTP et
// les cookies Secure ne sont jamais acceptes, ce qui fait boucler la connexion.
app.set('trust proxy', 1);

// Version ABL : connexion par identifiant + mot de passe, compte unique du
// prestataire (voir auth.js et hash-password.js).
const auth = createAuth({
  login: appConfig.appLogin,
  passwordHash: appConfig.appPasswordHash,
  sessionSecret: appConfig.sessionSecret,
});

// Les routes de connexion sont AVANT le middleware : elles doivent rester
// accessibles sans session. Le formulaire de login poste en
// x-www-form-urlencoded classique (pas de JS necessaire pour se connecter).
app.use('/auth/login', express.urlencoded({ extended: false }));
app.get('/auth/login', (req, res) => auth.pageLogin(req, res));
app.post('/auth/login', (req, res) => auth.traiterLogin(req, res));
app.get('/auth/logout', (req, res) => auth.deconnexion(req, res));

app.use(auth.requireAuth);
app.use(express.json());
app.use(express.static(__dirname));

// Identite courante, pour l'affichage dans l'interface.
app.get('/api/me', (req, res) => res.json({ login: req.user.login }));

const flora = createFlora({
  apiKey: config.floraApiKey,
  workspaceId: config.floraWorkspaceId,
  projectId: config.floraProjectId,
});
const drive = createDrive({ serviceAccountJson: config.googleServiceAccountJson });
const store = createStore({ dir: appConfig.dataDir });
const backends = createBackends({ drive, dir: appConfig.dataDir, parentFolderId: appConfig.parentFolderId });
const workplan = createWorkplan({ store, backends, flora, drive, concurrency: config.concurrency });
// Pas de suivi Google Sheet dans la version ABL : il est traite autrement.

// Etablissement choisi au demarrage : OBLIGATOIRE pour toute nouvelle
// session, quel que soit le mode, et toujours relie a son dossier Drive
// "{ID} - {nom}". C'est ce qui garantit une trace rangee de tout ce qui est
// genere. Le nom alimente aussi le suivi (Google Sheet). Renvoie null si
// l'un des trois elements manque.
function lireEtab(id, nom, folderId) {
  const i = String(id || '').trim();
  const n = String(nom || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const f = String(folderId || '').trim();
  return i && n && f ? { id: i, nom: n, folderId: f } : null;
}
const ERR_ETAB = "Choisis ou crée l'établissement avant d'importer.";

// 30 Mo par fichier, 60 fichiers : le glisser-deposer garde les octets en

// Source des prompts. Priorite a l'API officielle ; a defaut, lecture de la
// base publiee sur le web (voir notionPublic.js pour les limites).
const notionSource =
  config.notionApiKey && config.notionStylesDbId
    ? createNotionSource({ notionApiKey: config.notionApiKey, databaseId: config.notionStylesDbId })
    : null;

let notionPublicSource = null;
if (!notionSource && config.notionPublicPage) {
  try {
    notionPublicSource = createNotionPublicSource({ pageUrl: config.notionPublicPage });
    console.warn(
      '[styles] Lecture de la base Notion PUBLIEE (API interne notion.so/api/v3). ' +
        'Definis NOTION_API_KEY + NOTION_STYLES_DB_ID pour basculer sur l\'API officielle.',
    );
  } catch (e) {
    console.error('[styles] NOTION_PUBLIC_PAGE invalide :', e.message);
  }
}
if (!notionSource && !notionPublicSource) {
  console.warn('[styles] Aucune source Notion configuree : aucun prompt IA.');
}

const links = createLinksService();

const styleSource = createStyleSource({
  builtin: builtinStyles,
  notion: notionSource,
  notionPublic: notionPublicSource,
});

const msg = (e) => String((e && e.message) || e);

// Images effacees a 14 jours, metadonnees conservees 90 jours : l'historique
// des sessions survit sans que le volume se remplisse.
store
  .purge({ maxImageDays: 14, maxPlanDays: 90, backends })
  .catch((e) => console.warn('[store] purge:', e.message));

// --- Catalogues -------------------------------------------------------------
app.get('/api/styles', async (req, res) => {
  try {
    res.json(await styleSource.listStyles());
  } catch (e) {
    res.status(500).json({ error: 'Lecture des styles impossible : ' + msg(e) });
  }
});

app.get('/api/models', (req, res) => {
  res.json(Object.entries(models).map(([key, m]) => ({ key, label: m.label, default: !!m.default })));
});

// Diagnostic : modeles accessibles a la cle, AVEC les parametres que chacun
// accepte. C'est ici qu'on lit le nom exact du parametre de resolution et ses
// valeurs autorisees, plutot que de le deviner.
app.get('/api/flora-models', async (req, res) => {
  try {
    const rep = await flora.listModels();
    const modeles = (rep.models || rep || []).map((m) => ({
      model_id: m.model_id,
      name: m.name,
      type: m.type,
      params: (m.params || []).map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        default: p.default,
        options: (p.options || []).map((o) => o.value),
      })),
    }));
    res.json({ resolutionDemandee: process.env.FLORA_RESOLUTION || '2K', modeles });
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

// --- Etablissements --------------------------------------------------------
// Recherche par ID ou par nom sous PARENT_FOLDER_ID. Utilise quand il n'y a
// aucun lien Drive de depart : liens sociaux et glisser-deposer.
app.get('/api/etabs', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  if (!appConfig.parentFolderId) {
    return res.status(400).json({ error: 'PARENT_FOLDER_ID absente sur le serveur.' });
  }
  try {
    const results = await drive.searchEtabFolders(q, appConfig.parentFolderId);
    res.json({ results: results.slice(0, 15) });
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

// Creation d'un dossier etablissement "{ID} - {nom}" sous PARENT_FOLDER_ID,
// quand la recherche n'a rien trouve. Refusee si l'ID existe deja : une
// faute de frappe sur le nom ne doit pas creer un doublon.
app.post('/api/etabs', async (req, res) => {
  const id = String((req.body || {}).id || '').trim();
  const nom = String((req.body || {}).nom || '').trim().replace(/\s+/g, ' ');
  if (!/^\d{2,}$/.test(id)) return res.status(400).json({ error: "L'ID doit être un nombre (au moins 2 chiffres)." });
  if (!/[A-Za-z\u00C0-\u024F]/.test(nom)) return res.status(400).json({ error: "Renseigne le nom de l'établissement." });
  if (/[\/\\]/.test(nom)) return res.status(400).json({ error: 'Le nom ne peut pas contenir de / ou de \\.' });
  if (!appConfig.parentFolderId) {
    return res.status(400).json({ error: 'PARENT_FOLDER_ID absente sur le serveur.' });
  }
  try {
    const existe = await drive.findEtabById(id, appConfig.parentFolderId);
    if (existe) {
      return res.status(409).json({
        error: `L'ID ${id} existe déjà : « ${existe.name} ». Sélectionne-le plutôt que d'en créer un nouveau.`,
        existant: existe,
      });
    }
    const dossier = await drive.createFolder(`${id} - ${nom}`, appConfig.parentFolderId);
    console.log(`[etabs] dossier cree : ${dossier.name} par ${req.user.login}`);
    res.json({ folderId: dossier.id, name: dossier.name, etab: { id, nom } });
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

// Contenu d'un dossier pour le selecteur de l'ecran Import : ses
// sous-dossiers et le nombre de photos qu'il contient directement.
app.get('/api/folders/:id', async (req, res) => {
  try {
    const [dossier, enfants, images] = await Promise.all([
      drive.getFolder(req.params.id),
      drive.listSubfolders(req.params.id),
      drive.listImages(req.params.id),
    ]);
    res.json({
      folder: { id: dossier.id, name: dossier.name },
      children: enfants
        // On part toujours des originaux : les dossiers produits par l'outil
        // (_travail, anciens _retouches, « Retouche - <date> ») sont masques.
        .filter((f) => !/^_(travail|retouches)$/i.test(f.name) && !/_retouches$/i.test(f.name)
          && !/^retouche\s*-\s/i.test(f.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
        .map((f) => ({ id: f.id, name: f.name })),
      images: images.length,
    });
  } catch (e) {
    res.status(400).json({ error: 'Dossier inaccessible : ' + msg(e) });
  }
});


// --- Sessions ---------------------------------------------------------------
// styleKey est facultatif : sans lui on importe sans aucune generation.
app.post('/api/sessions', async (req, res) => {
  const { style: styleKey, model: modelKey, etab: e, destination, folderId } = req.body || {};
  const etab = lireEtab(e && e.id, e && e.nom, e && e.folderId);
  if (!etab) return res.status(400).json({ error: ERR_ETAB });
  // Dossier choisi dans le selecteur, ou lien colle en depannage.
  const driveUrl = folderId
    ? drive.folderUrl(String(folderId).trim())
    : String((req.body || {}).driveUrl || '').trim();
  if (!driveUrl) return res.status(400).json({ error: 'Choisis le dossier Drive du shooting.' });
  const nomEtab = etab.nom;

  try {
    const style = styleKey ? await styleSource.getStyle(styleKey) : null;
    const session = await workplan.startSession({
      mode: 'drive',
      driveUrl,
      style,
      model: resolveModel(modelKey || defaultModelKey),
      etab,
      nomEtab,
      destination: destination || 'source',
      user: req.user.login,
    });
    res.json({ sessionId: session.id });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Import depuis des liens ------------------------------------------------
// Deux temps : apercu sans telechargement, puis import de la selection.
// Les URLs de telechargement restent cote serveur (voir links.js).
// Diagnostic de l'import par liens : cookies charges ? extracteurs presents ?
// Repond a la question "pourquoi Instagram refuse" sans fouiller les logs.
// Ne renvoie jamais le contenu du cookie, seulement s'il est present.
app.get('/api/links/diag', (req, res) => {
  try {
    res.json(socialDiagnostic());
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

app.post('/api/links/preview', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Aucun lien fourni.' });
  }
  try {
    res.json(await links.preview(urls));
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

app.post('/api/links/import', async (req, res) => {
  const { previewId, ids, style: styleKey, model: modelKey, etab: e } = req.body || {};
  const etabOk = lireEtab(e && e.id, e && e.nom, e && e.folderId);
  if (!etabOk) return res.status(400).json({ error: ERR_ETAB });
  const nomEtab = etabOk.nom;
  if (!previewId || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Aucun media selectionne.' });
  }
  try {
    const { fichiers, erreurs } = await links.download(previewId, ids);
    const style = styleKey ? await styleSource.getStyle(styleKey) : null;

    const session = await workplan.startSession({
      mode: 'links',
      files: fichiers,
      style,
      model: resolveModel(modelKey || defaultModelKey),
      etab: etabOk,
      nomEtab,
      destination: 'etab',
      user: req.user.login,
    });
    res.json({ sessionId: session.id, imported: fichiers.length, erreurs });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// ouvrir une nouvelle, une fois d'autres médias prévisualisés.
app.post('/api/sessions/:id/links-media', async (req, res) => {
  const { previewId, ids } = req.body || {};
  if (!previewId || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Aucun média sélectionné.' });
  }
  try {
    const { fichiers, erreurs } = await links.download(previewId, ids);
    const session = await workplan.addMedia({ sessionId: req.params.id, files: fichiers, provenance: 'social' });
    res.json({ sessionId: session.id, imported: fichiers.length, erreurs });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// Renseigner ou corriger l'établissement d'une session déjà créée.
app.post('/api/sessions/:id/etab', async (req, res) => {
  const { id: etabId, nom: etabNom, folderId } = req.body || {};
  const etab = lireEtab(etabId, etabNom, folderId);
  if (!etab) return res.status(400).json({ error: ERR_ETAB });
  try {
    const session = await workplan.setEtab({ sessionId: req.params.id, etab });
    res.json(publicSession(session));
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// Toutes les sessions de l'equipe, la plus recente d'abord. Le regroupement
// par personne se fait cote interface.
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await store.list({ limit: 200 });
    res.json({ sessions, me: req.user.login });
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  const s = await store.load(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  res.json(publicSession(s));
});

// --- Relance : Enchainer / Refaire, duplication ou remplacement ------------
app.post('/api/sessions/:id/rerun', async (req, res) => {
  const { photoIds, style: styleKey, model: modelKey, from, mode, prompt, promptLabel } =
    req.body || {};

  if (!Array.isArray(photoIds) || photoIds.length === 0) {
    return res.status(400).json({ error: 'Aucune photo selectionnee.' });
  }
  if (!['current', 'source'].includes(from)) {
    return res
      .status(400)
      .json({ error: "from doit valoir 'current' (Enchainer) ou 'source' (Refaire)." });
  }
  if (!['duplicate', 'replace'].includes(mode)) {
    return res.status(400).json({ error: "mode doit valoir 'duplicate' ou 'replace'." });
  }
  if (!prompt && !styleKey) {
    return res.status(400).json({ error: 'Prompt manquant.' });
  }

  try {
    const session = await store.load(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session introuvable.' });
    if (session.status === 'validated') {
      return res.status(400).json({ error: 'Session deja validee.' });
    }

    // Garde-fou cout : FLORA facture a la generation, pas a la validation.
    const trop = photoIds
      .map((id) => photoById(session, id))
      // Les rendus 'reglages' sont gratuits : ils ne comptent pas.
      .filter((p) => p && p.renders.filter((r) => r.kind !== 'reglages').length >= appConfig.maxRenderPerPhoto);
    if (trop.length) {
      return res.status(429).json({
        error:
          `${trop.length} photo(s) ont deja ${appConfig.maxRenderPerPhoto} generations. ` +
          "Repars d'un nouveau lot plutot que de continuer a iterer.",
      });
    }
    if (appConfig.maxSessionCost > 0 && (session.cost || 0) >= appConfig.maxSessionCost) {
      return res.status(429).json({
        error: `Plafond de cout atteint pour cette session (${appConfig.maxSessionCost} $).`,
      });
    }

    // Prompt libre saisi dans l'outil, ou prompt du catalogue.
    // promptLabel sert de nom de variante et de suffixe de fichier : sans lui,
    // trois essais libres sur la meme photo donneraient trois "photo_01_libre".
    let style;
    if (prompt) {
      const nom = String(promptLabel || '').trim();
      const suffixe = slug(nom) || 'libre';
      style = { label: nom || 'Prompt libre', suffix: suffixe, prompt, type: 'ai', model: null, libre: true };
    } else {
      style = await styleSource.getStyle(styleKey);
    }

    res.json({ ok: true, queued: photoIds.length });

    workplan
      .rerun({
        sessionId: req.params.id,
        photoIds,
        style,
        model: resolveModel(modelKey || defaultModelKey),
        from,
        mode,
      })
      .catch((e) => console.error('[rerun]', msg(e)));
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: msg(e) });
  }
});

// --- Suppression d'une photo du plan ---------------------------------------
app.delete('/api/sessions/:id/photos/:photoId', async (req, res) => {
  try {
    await workplan.removePhoto({ sessionId: req.params.id, photoId: req.params.photoId });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Choix du rendu retenu parmi l'historique d'une photo -----------------
app.post('/api/sessions/:id/photos/:photoId/retain', async (req, res) => {
  const { renderId } = req.body || {};
  try {
    await workplan.withSession(req.params.id, (s) => {
      const p = photoById(s, req.params.photoId);
      if (!p) throw new Error('Photo introuvable.');
      const r = renderById(p, renderId);
      if (!r || r.status !== 'ok') throw new Error('Rendu introuvable ou en echec.');
      p.currentRenderId = r.id;
      p.status = 'ok';
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Validation : ecriture dans Drive -------------------------------------
// Reponse immediate : deplacer 30 fichiers dans Drive prend une trentaine de
// secondes. L'interface suit l'avancement par son sondage (status
// 'validating' + validateProgress) au lieu d'attendre sur une requete longue.
// --- Format de livraison ---------------------------------------------------
// Original ou vitrine 1500x750, par selection. Transformation locale, gratuite,
// appliquee au moment de la validation : basculer ici ne declenche aucune
// generation et n'affecte pas les videos.
app.post('/api/sessions/:id/format', async (req, res) => {
  const { photoIds, format } = req.body || {};
  if (!Array.isArray(photoIds) || photoIds.length === 0) {
    return res.status(400).json({ error: 'Aucune photo selectionnee.' });
  }
  try {
    await workplan.setFormat({ sessionId: req.params.id, photoIds, format });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Reglages colorimetriques ----------------------------------------------
// Luminosite, contraste, saturation, temperature, de -100 a +100. Gratuit,
// sans IA. Enregistrer cree une NOUVELLE IMAGE (rendu 'reglages') en pleine
// resolution, qui devient l'image retenue : telechargee, deposee et livree.
// Le traitement tourne en arriere-plan ; l'interface suit par son sondage.
// Les formules sont dans adjust.js, importe aussi par le navigateur :
// l'apercu et l'image produite passent par le meme code.
app.post('/api/sessions/:id/adjust', async (req, res) => {
  const { photoIds, adjust } = req.body || {};
  if (!Array.isArray(photoIds) || photoIds.length === 0) {
    return res.status(400).json({ error: 'Aucune photo selectionnee.' });
  }
  try {
    const r = await workplan.setAdjust({ sessionId: req.params.id, photoIds, adjust });
    res.json({ ok: true, queued: r.queued });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Validation : ecriture dans la destination -----------------------------
app.post('/api/sessions/:id/validate', async (req, res) => {
  try {
    const s = await store.load(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session introuvable.' });
    if (s.status === 'validated') return res.json({ ok: true, deja: true });
    if (s.status === 'validating') return res.json({ ok: true, enCours: true });
    if (s.status === 'running') {
      return res.status(400).json({ error: 'Traitement en cours : attends la fin avant de valider.' });
    }

    // « Retouche - date » recoit la version finale de chaque photo : sa
    // retouche, ou son original si elle n'en a pas, plus les videos.
    const aEnvoyer = aLivrer(s).length;
    if (aEnvoyer === 0) return res.status(400).json({ error: 'Aucun media a ranger.' });

    res.status(202).json({ ok: true, total: aEnvoyer });

    workplan
      .validate({ sessionId: req.params.id })
      .catch((e) => console.error('[validate]', msg(e)));
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: msg(e) });
  }
});

// --- Proxy images ---------------------------------------------------------
// Les fichiers Drive d'un service account ne sont pas accessibles
// publiquement : thumbnailLink ne fonctionne pas. On telecharge et on
// redimensionne cote serveur, avec un cache LRU borne pour ne pas
// retelecharger la meme vignette a chaque rafraichissement de la galerie.

const CACHE_MAX = 60 * 1024 * 1024;
const cache = new Map();
let cacheSize = 0;

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  cache.delete(key);
  cache.set(key, v); // remet en tete (LRU)
  return v;
}

function cacheSet(key, buf) {
  if (buf.length > CACHE_MAX / 4) return;
  cache.set(key, buf);
  cacheSize += buf.length;
  while (cacheSize > CACHE_MAX && cache.size > 1) {
    const [k, v] = cache.entries().next().value;
    cache.delete(k);
    cacheSize -= v.length;
  }
}

// Trois tailles seulement, et c'est volontaire : chaque taille occupe une
// entree de cache, un parametre libre le ferait exploser.
//   240 -> vignette de grille
//   700 -> vue de detail et aperçu des reglages
//   full -> original, pour un telechargement
const TAILLES = new Set([240, 700]);

function tailleDemandee(req) {
  if (req.query.full === '1') return null;
  const w = parseInt(req.query.w, 10);
  return TAILLES.has(w) ? w : 700;
}

// Le cache garde l'image DEJA redimensionnee, pas les octets bruts : sinon la
// meme source occuperait une entree par taille demandee.
async function serveImage(res, cle, lireSource, largeur) {
  let buf = cacheGet(cle);
  if (!buf) {
    const brut = await lireSource();
    buf = largeur
      ? await sharp(brut)
          .resize(largeur, null, { withoutEnlargement: true })
          .jpeg({ quality: largeur <= 240 ? 74 : 88 })
          .toBuffer()
      : brut;
    cacheSet(cle, buf);
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buf);
}

app.get('/api/sessions/:id/photos/:photoId/source', async (req, res) => {
  try {
    const s = await store.load(req.params.id);
    const p = s && photoById(s, req.params.photoId);
    if (!p || !p.sourceRef) return res.status(404).send('Original introuvable.');
    // sharp ne sait pas lire une video : l'interface affiche une tuile sans
    // faire de requete d'image pour ces elements.
    if (p.kind === 'video') return res.status(415).send('Aperçu indisponible pour une vidéo.');
    const backend = backends.forSession(s);
    const w = tailleDemandee(req);
    await serveImage(res, `src:${s.id}:${p.sourceRef}:${w || 'full'}`, () => backend.readSource(s, p), w);
  } catch (e) {
    res.status(500).send(msg(e));
  }
});

app.get('/api/sessions/:id/photos/:photoId/render/:renderId', async (req, res) => {
  try {
    const s = await store.load(req.params.id);
    const p = s && photoById(s, req.params.photoId);
    const r = p && renderById(p, req.params.renderId);
    if (!r || !r.workFileId) return res.status(404).send('Rendu introuvable.');
    const backend = backends.forSession(s);
    const w = tailleDemandee(req);
    await serveImage(res, `wrk:${s.id}:${r.workFileId}:${w || 'full'}`, () => backend.readWork(s, r.workFileId), w);
  } catch (e) {
    res.status(500).send(msg(e));
  }
});

// --- Telechargement d'une seule photo, sans passer par Valider -------------
// Sert le fichier reellement livre pour cette photo (le rendu retenu s'il y
// en a un, sinon l'original), TEL QUEL — pas de recompression JPEG comme
// pour les vignettes, pour ne pas degrader un rendu deja compresse une fois
// par FLORA. C'est aussi la ou on corrige un defaut de longue date : la
// route de vignette (serveImage) annonce toujours "image/jpeg", meme quand
// le fichier reel est un PNG ; ici le type et le nom de fichier suivent
// l'extension reelle du rendu retenu.
app.get('/api/sessions/:id/photos/:photoId/download', async (req, res) => {
  try {
    const s = await store.load(req.params.id);
    const p = s && photoById(s, req.params.photoId);
    if (!p) return res.status(404).send('Photo introuvable.');
    if (p.kind === 'video') return res.status(415).send('Cette action ne concerne que les images.');

    // Le fichier tel qu'on le voit : rendu retenu, reglages, format.
    const fichier = await workplan.fichierRetouche(s, p);
    const { buffer, ext } = fichier;
    const nomFichier = nomShooting(p, ext);
    // Deux formes dans l'en-tete : une ASCII de repli, et la forme encodee
    // (RFC 5987) que les navigateurs modernes preferent, pour ne pas casser
    // le telechargement si le nom contient un accent.
    const nomAscii = nomFichier.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    res.set('Content-Type', MIME[ext] || 'application/octet-stream');
    res.set(
      'Content-Disposition',
      `attachment; filename="${nomAscii}"; filename*=UTF-8''${encodeURIComponent(nomFichier)}`,
    );
    res.send(buffer);

    // Rangement automatique APRES l'envoi : un souci Drive ne doit jamais
    // bloquer le telechargement. La version telechargee, si c'est la version
    // finale de la photo, part dans « Retouche - date » (sous le dossier de
    // l'original). Le resultat, ou l'erreur, est garde sur la photo.
    workplan
      .deposer({ sessionId: s.id, photoId: p.id, fichier })
      .then((f) => f && !f.inchange && console.log(`[rangement] ${f.name} -> ${f.folderName}`))
      .catch(async (e) => {
        console.warn('[rangement] echec :', msg(e));
        await workplan.withSession(s.id, (s2) => {
          const q = photoById(s2, p.id);
          if (q) q.depotErreur = msg(e);
        }).catch(() => {});
      });
  } catch (e) {
    if (!res.headersSent) res.status(500).send(msg(e));
  }
});

// --- Zip des versions finales --------------------------------------------
// Un clic apres la validation : les fichiers que la session a ranges dans
// « Retouche - <date> », lus dans le Drive (le zip est donc toujours
// identique a ce qui est range), sans passer par le Drive a la main.
// Seuls les fichiers de CETTE session : un dossier du jour partage par
// plusieurs sessions ne melange pas leurs fichiers.
app.get('/api/sessions/:id/zip', async (req, res) => {
  const s = await store.load(req.params.id);
  if (!s) return res.status(404).send('Session introuvable.');

  // Sessions validees avant la v18 : ancien zip local.
  if (s.delivery === 'zip') return zipAncien(req, res, s);

  const finales = new Set(aLivrer(s).map((p) => p.id));
  const fichiers = (s.photos || [])
    .filter((p) => p.status !== 'deleted' && finales.has(p.id) && p.rangeRetouche && p.rangeRetouche.fileId)
    .map((p) => ({ fileId: p.rangeRetouche.fileId, name: p.rangeRetouche.name }));
  if (fichiers.length === 0) {
    return res.status(404).send('Aucun fichier rangé pour cette session : valide-la d\'abord.');
  }

  const etab = s.etab && s.etab.nom ? `${s.etab.nom} - ` : '';
  const dossier = (s.rangement && s.rangement.retouches && s.rangement.retouches.name || 'Retouche')
    .split(' / ').pop();
  const nomZip = `${etab}${dossier}.zip`.replace(/[/\\:*?"<>|]/g, '-');
  const nomAscii = nomZip.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${nomAscii}"; filename*=UTF-8''${encodeURIComponent(nomZip)}`);

  // Photos et videos sont deja compressees : on les range sans recompresser,
  // ce qui rend le zip presque immediat.
  const archive = archiver('zip', { store: true });
  archive.on('warning', (e) => console.warn('[zip]', e.message));
  archive.on('error', (e) => {
    console.error('[zip]', e.message);
    res.destroy();
  });
  archive.pipe(res);
  const pris = new Set();
  for (const f of fichiers) {
    let nom = f.name;
    for (let k = 2; pris.has(nom); k++) nom = f.name.replace(/(\.[^.]+)?$/, `_${k}$1`);
    pris.add(nom);
    try {
      const flux = await drive.downloadStream(f.fileId);
      await new Promise((ok, ko) => {
        flux.on('end', ok);
        flux.on('error', ko);
        archive.append(flux, { name: nom });
      });
    } catch (e) {
      console.warn('[zip] fichier ignore :', nom, msg(e));
    }
  }
  archive.finalize();
});

async function zipAncien(req, res, s) {
  if (s.status !== 'validated') return res.status(400).send('Session non validee.');
  const backend = backends.forSession(s);
  const noms = (await backend.listFinal(s)) || [];
  if (noms.length === 0) return res.status(404).send('Aucun fichier a telecharger.');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${s.outputFolderName || 'retouches'}.zip"`);
  const archive = archiver('zip', { store: true });
  archive.on('error', (e) => { console.error('[zip]', e.message); res.destroy(); });
  archive.pipe(res);
  for (const nom of noms) {
    try {
      archive.append(await backend.readFinal(s, nom), { name: nom });
    } catch (e) {
      console.warn('[zip] fichier ignore :', nom, e.message);
    }
  }
  archive.finalize();
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

app.listen(config.port, () => {
  console.log(`Joy Retouche en ecoute sur le port ${config.port}`);
  console.log(`[store] Plans de travail dans ${appConfig.dataDir}`);
});
