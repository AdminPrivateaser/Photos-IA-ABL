import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

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
} from './store.js';
import { createLinksService } from './links.js';
import { diagnostic as socialDiagnostic } from './social.js';
import { createBackends } from './assets.js';
import { createWorkplan } from './workplan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Railway sert derriere un proxy : sans ceci, Express croit etre en HTTP et
// les cookies Secure ne sont jamais acceptes, ce qui fait boucler la connexion.
app.set('trust proxy', 1);

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
const workplan = createWorkplan({ store, backends, flora, concurrency: config.concurrency });

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

app.get('/api/flora-models', async (req, res) => {
  try {
    res.json(await flora.listModels());
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

// --- Sessions ---------------------------------------------------------------
// styleKey est facultatif : sans lui on importe sans aucune generation.
app.post('/api/sessions', async (req, res) => {
  const { driveUrl, style: styleKey, model: modelKey, etab, destination } = req.body || {};
  if (!driveUrl) return res.status(400).json({ error: 'Lien du dossier Drive manquant.' });

  try {
    const style = styleKey ? await styleSource.getStyle(styleKey) : null;
    const session = await workplan.startSession({
      mode: 'drive',
      driveUrl,
      style,
      model: resolveModel(modelKey || defaultModelKey),
      etab: etab || null,
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
  const { previewId, ids, style: styleKey, model: modelKey, etab } = req.body || {};
  if (!previewId || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Aucun media selectionne.' });
  }
  // Établissement obligatoire : plus de repli en zip dans cette version.
  // Voir drive.findOrCreateEtabFolder pour la création automatique du
  // dossier "{ID} - {Nom}" quand il n'existe pas encore.
  const etabOk = etab && etab.id && etab.nom
    ? { id: String(etab.id).trim(), nom: String(etab.nom).trim(), folderId: etab.folderId || null }
    : null;
  if (!etabOk) {
    return res.status(400).json({ error: "Établissement manquant : indique un ID et un nom." });
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
      destination: 'etab',
      user: req.user.login,
    });
    res.json({ sessionId: session.id, imported: fichiers.length, erreurs });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Ajouter des médias à une session existante (liens) --------------------
// Complète la session en cours au lieu d'en ouvrir une nouvelle : répond au
// cas "j'ai oublié une photo" sans perdre les retouches déjà lancées.
app.post('/api/sessions/:id/links-media', async (req, res) => {
  const { previewId, ids } = req.body || {};
  if (!previewId || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Aucun média sélectionné.' });
  }
  try {
    const { fichiers, erreurs } = await links.download(previewId, ids);
    const session = await workplan.addMedia({ sessionId: req.params.id, files: fichiers });
    res.json({ sessionId: session.id, imported: fichiers.length, erreurs });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Établissement d'une session existante ---------------------------------
// Corriger ou renseigner l'établissement après coup, sans repartir de zéro.
app.post('/api/sessions/:id/etab', async (req, res) => {
  const { id: etabId, nom: etabNom, folderId } = req.body || {};
  if (!etabId || !etabNom) {
    return res.status(400).json({ error: 'ID et nom requis.' });
  }
  try {
    const session = await workplan.setEtab({
      sessionId: req.params.id,
      etab: { id: String(etabId).trim(), nom: String(etabNom).trim(), folderId: folderId || null },
    });
    res.json(publicSession(session));
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// --- Relire le dossier Drive de départ (mode 'drive') -----------------------
// Reprend les fichiers ajoutés dans le dossier Drive depuis le chargement de
// la session, sans dupliquer ceux déjà présents dans le plan.
app.post('/api/sessions/:id/refresh-drive', async (req, res) => {
  try {
    const avant = (await store.load(req.params.id))?.photos?.length || 0;
    const session = await workplan.refreshFromDrive({ sessionId: req.params.id });
    const ajoutees = (session.photos || []).length - avant;
    res.json({ ...publicSession(session), _nouvellesPhotos: ajoutees });
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
      .filter((p) => p && p.renders.length >= appConfig.maxRenderPerPhoto);
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
      style = { label: nom || 'Prompt libre', suffix: suffixe, prompt, type: 'ai', model: null };
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
// local, applique a la validation. Les formules sont dans adjust.js, importe
// aussi par le navigateur : l'apercu et l'image livree passent par le meme
// code, donc ils ne peuvent pas divergier.
app.post('/api/sessions/:id/adjust', async (req, res) => {
  const { photoIds, adjust } = req.body || {};
  if (!Array.isArray(photoIds) || photoIds.length === 0) {
    return res.status(400).json({ error: 'Aucune photo selectionnee.' });
  }
  try {
    await workplan.setAdjust({ sessionId: req.params.id, photoIds, adjust });
    res.json({ ok: true });
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

    // Meme regle que la validation : les retouches d'une lignee, ou son
    // original si elle n'en a aucune.
    const aEnvoyer = aLivrer(s).length;
    if (aEnvoyer === 0) return res.status(400).json({ error: 'Aucun media a valider.' });

    res.status(202).json({ ok: true, total: aEnvoyer });

    workplan.validate({ sessionId: req.params.id }).catch((e) => console.error('[validate]', msg(e)));
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
