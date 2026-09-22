// social.js — extraction des médias d'un lien public (Instagram, TikTok,
// Facebook, ou image en ligne) via gallery-dl et yt-dlp.
//
// Porté depuis l'outil de récupération sociale (CommonJS) sans changer la
// logique d'extraction, qui est empirique et fragile :
//
//  - l'ordre des deux moteurs dépend de la plateforme (voir isVideoFirst) ;
//  - les vidéos TikTok et Facebook ne sont PAS téléchargées depuis l'URL CDN
//    listée, mais re-résolues par yt-dlp sur l'URL du post au moment de
//    l'envoi, parce que ces URLs sont signées pour la session d'extraction et
//    renvoient 403 à froid ;
//  - trois chemins de téléchargement coexistent (fetch, curl avec Referer
//    forgé, yt-dlp) parce que le CDN Instagram refuse certaines requêtes Node.
//
// Ne pas "simplifier" ces branches sans les avoir testées sur les quatre
// sources : chacune existe à cause d'un échec constaté.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// gallery-dl est installé via pip (voir Dockerfile) et disponible sur le PATH.
const GALLERY_DL_CMD = process.env.GALLERY_DL_CMD || "gallery-dl";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v"]);
const IMAGE_URL_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const IG_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[\w-]+/i;
const TT_URL_RE =
  /^https?:\/\/((www|m)\.)?tiktok\.com\/(@[\w.-]+\/(video|photo)\/\d+|t\/[\w-]+)|^https?:\/\/vm\.tiktok\.com\/[\w-]+/i;
const FB_URL_RE =
  /^https?:\/\/((www|m|web)\.)?facebook\.com\/([\w.%-]+\/(videos|photos|posts|reels)\/|watch|reel\/|photo)|^https?:\/\/fb\.watch\//i;
// Hébergeurs d'images sans extension dans l'URL (photos Google, vignettes)
const DIRECT_IMAGE_HOSTS_RE =
  /^https?:\/\/(lh\d\.googleusercontent\.com|encrypted-tbn\d\.gstatic\.com)\//i;
const GSTATIC_THUMB_RE = /^https?:\/\/encrypted-tbn\d\.gstatic\.com\//i;

function urlExtension(url) {
  try {
    const p = new URL(url).pathname;
    return (p.split(".").pop() || "").toLowerCase();
  } catch {
    return "";
  }
}

function detectSource(url) {
  const u = (url || "").trim();
  if (IG_URL_RE.test(u)) return "instagram";
  if (TT_URL_RE.test(u)) return "tiktok";
  if (FB_URL_RE.test(u)) return "facebook";
  if (DIRECT_IMAGE_HOSTS_RE.test(u)) return "direct";
  const ext = urlExtension(u);
  if (/^https?:\/\//i.test(u) && (IMAGE_URL_EXT.has(ext) || VIDEO_EXT.has(ext)))
    return "direct";
  return null;
}

// Anciennement isInstagramPostUrl : le nom mentait, la fonction couvre les
// quatre sources.
function isSupportedUrl(url) {
  return detectSource(url) !== null;
}

// Cookies Instagram au format Netscape, depuis INSTAGRAM_COOKIES_TXT.
// Sert de repli quand Instagram oppose un mur de connexion à l'IP du serveur.
//
// Le fichier est écrit UNE SEULE FOIS au premier usage, en 0600, dans le
// répertoire temporaire. L'ancienne version le réécrivait à chaque appel.
//
// Attention : ce cookie contient un sessionid, c'est-à-dire un accès complet
// au compte Instagram. Il ne doit jamais être commité, journalisé, ni renvoyé
// dans une réponse HTTP.
let cookieFile = null;
let cookieChecked = false;

// Remet un cookies.txt collé à la main en forme Netscape stricte.
//
// Trois dégradations classiques, chacune suffisante pour que gallery-dl refuse
// le fichier avec un message obscur :
//   - les \n deviennent des \n littéraux en passant par certaines interfaces
//     de variables d'environnement ;
//   - les TABULATIONS deviennent des espaces au copier-coller depuis une vue
//     rendue, alors que le format exige des tabulations ;
//   - la ligne d'en-tête "# Netscape HTTP Cookie File" est perdue, et le
//     parseur Python la vérifie avant toute chose.
export function normaliserCookies(raw) {
  let texte = String(raw || '').replace(/\\n/g, '\n').replace(/\r/g, '');
  const lignes = [];

  for (const ligne of texte.split('\n')) {
    const l = ligne.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      lignes.push(l);
      continue;
    }
    // Un enregistrement Netscape a exactement 7 champs. Si la séparation par
    // espaces en donne 7, c'est un fichier dont les tabulations ont été
    // écrasées : on les rétablit. Sinon on laisse la ligne intacte, pour ne
    // pas casser une valeur qui contiendrait un espace.
    const champs = l.split(/\s+/);
    lignes.push(champs.length === 7 ? champs.join('\t') : l);
  }

  const entete = '# Netscape HTTP Cookie File';
  if (!lignes.some((l) => l.toLowerCase().includes('netscape http cookie file'))) {
    lignes.unshift(entete);
  }
  return lignes.join('\n') + '\n';
}

function cookieArgs() {
  if (!cookieChecked) {
    cookieChecked = true;
    const raw = process.env.INSTAGRAM_COOKIES_TXT;
    if (raw && raw.trim()) {
      try {
        const file = path.join(os.tmpdir(), 'ig_cookies.txt');
        fs.writeFileSync(file, normaliserCookies(raw), { mode: 0o600 });
        cookieFile = file;
        console.log('[social] Cookies Instagram chargés.');
      } catch (e) {
        console.warn('[social] Écriture du fichier de cookies impossible :', e.message);
      }
    }
  }
  return cookieFile ? ['--cookies', cookieFile] : [];
}

function runGalleryDl(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(
      GALLERY_DL_CMD,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          return reject(
            new Error(interpretGalleryDlError(stderr || err.message))
          );
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function interpretGalleryDlError(stderr) {
  const s = (stderr || "").toLowerCase();

  // Erreurs reseau et TLS d'abord : elles ne viennent pas de la plateforme et
  // ne doivent pas etre annoncees comme une limitation de debit. Le motif
  // "rate" attrapait autrefois des messages sans rapport.
  if (
    s.includes("certificate") ||
    s.includes("ssl") ||
    s.includes("tlsv1") ||
    s.includes("getaddrinfo") ||
    s.includes("connection refused") ||
    s.includes("timed out") ||
    s.includes("connectionerror") ||
    s.includes("proxy")
  ) {
    return (
      "Probleme reseau entre le serveur et la plateforme (TLS ou connexion). " +
      "Ce n'est pas un blocage du post : reessaie, et si ca persiste c'est la " +
      "configuration reseau de l'hebergement qu'il faut regarder."
    );
  }
  if (
    s.includes("login") || s.includes("authentication") || s.includes("401") ||
    s.includes("403") || s.includes("checkpoint") || s.includes("challenge")
  ) {
    // Distinction utile : cookies jamais renseignes, ou renseignes mais
    // devenus invalides. Un sessionid expire ou revoque est le cas le plus
    // frequent, et il est invisible sans ce message.
    cookieArgs(); // force le chargement pour savoir s'ils existent
    if (!cookieFile) {
      return (
        "Instagram demande une connexion. Aucun cookie n'est configure : " +
        "renseigne INSTAGRAM_COOKIES_TXT sur Railway."
      );
    }
    return (
      "Instagram refuse la session : le cookie INSTAGRAM_COOKIES_TXT est " +
      "expire ou a ete revoque. Un sessionid meurt a la deconnexion, au " +
      "changement de mot de passe, ou apres quelques semaines. Regenere-le " +
      "et remets-le dans Railway. Verifie avec /api/links/diag."
    );
  }
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests")) {
    return (
      "La plateforme limite les requetes venant du serveur (429). C'est le " +
      "comportement normal d'Instagram face a une IP d'hebergeur sans session : " +
      "renseigne INSTAGRAM_COOKIES_TXT avec un cookie valide, ou reessaie dans " +
      "quelques minutes."
    );
  }
  if (s.includes("404") || s.includes("not found") || s.includes("no results")) {
    return "Post introuvable. Vérifiez l'URL (le post existe-t-il toujours ?).";
  }
  return (
    "Impossible de recuperer ce post automatiquement. " +
    "Depose les fichiers a la main via l'entree \"Des fichiers a deposer\". " +
    "Detail technique : " +
    (stderr || "inconnu").slice(0, 300)
  );
}

/**
 * Parse la sortie JSON de `gallery-dl -j`.
 * Format : liste d'entrées [msgType, ...] ; msgType 2 = fichier : [2, url, metadata].
 * Retourne [{ index, type: "photo"|"video", url, thumb, ext, width, height }].
 */
function parseGalleryDlOutput(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Réponse illisible depuis Instagram. Réessayez ou utilisez le dépôt manuel."
    );
  }

  // Format gallery-dl -j : [msgType, ...].
  // msgType 2 = dossier [2, metadata] ; msgType 3 = fichier [3, url, metadata].
  // On ne garde que 3.
  // gallery-dl signale ses echecs DANS le JSON, avec un code de sortie 0 :
  //   [[-1, { error: "HttpError", message: "'429 Too Many Requests' for ..." }]]
  // Sans ce traitement, la vraie cause est avalee et l'utilisateur recoit un
  // "aucun media trouve" trompeur.
  const erreurs = [];
  for (const entry of data) {
    if (Array.isArray(entry) && entry[0] === -1) {
      const e = entry[1] || {};
      erreurs.push([e.error, e.message].filter(Boolean).join(' : '));
    }
  }
  if (erreurs.length) throw new Error(interpretGalleryDlError(erreurs.join(' | ')));

  const media = [];
  let enFile = 0;
  for (const entry of data) {
    if (Array.isArray(entry) && entry[0] === 6) { enFile++; continue; }
    if (!Array.isArray(entry) || entry[0] !== 3) continue;
    const url = entry[1];
    if (typeof url !== "string") continue;
    const meta = entry[2] || {};

    // gallery-dl délègue certaines vidéos à yt-dlp via une URL "ytdl:…"
    // (pas téléchargeable telle quelle : à résoudre après le parse).
    if (url.startsWith("ytdl:")) {
      media.push({
        index: media.length,
        type: "video",
        url,
        needsYtdl: true,
        thumb: meta.display_url || null,
        ext: "mp4",
        width: meta.width || null,
        height: meta.height || null,
      });
      continue;
    }

    const ext =
      (meta.extension || (url.split("?")[0].split(".").pop() || "")).toLowerCase();
    const type = VIDEO_EXT.has(ext) ? "video" : "photo";
    media.push({
      index: media.length,
      type,
      url,
      thumb: meta.display_url || (type === "photo" ? url : null),
      ext: ext || (type === "video" ? "mp4" : "jpg"),
      width: meta.width || null,
      height: meta.height || null,
    });
  }

  if (media.length === 0) {
    if (enFile > 0) {
      throw new Error(
        "Ce lien pointe vers un profil ou une collection, pas vers un post. " +
          "Ouvre le post precis et copie son URL."
      );
    }
    throw new Error(
      "Aucun media sur ce post. Soit il est prive ou restreint, soit Instagram " +
        "a repondu une page vide au serveur : dans ce cas c'est le cookie " +
        "INSTAGRAM_COOKIES_TXT qui manque ou a expire."
    );
  }
  return media;
}

/**
 * Résout une URL via yt-dlp et retourne un objet média vidéo
 * { type, url, thumb, ext, width, height }.
 * Utilisé en fallback Reel et pour résoudre les entrées "ytdl:" de gallery-dl.
 */
function runYtDlp(targetUrl, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const args = [
      "-j",
      "--no-download",
      "--user-agent",
      USER_AGENT,
      ...cookieArgs(),
      targetUrl.trim(),
    ];
    execFile(
      process.env.YT_DLP_CMD || "yt-dlp",
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          const info = JSON.parse(stdout.trim().split("\n")[0]);
          const fmt =
            (info.formats || [])
              .filter(
                (f) =>
                  f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none"
              )
              .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;
          const url = (fmt && fmt.url) || info.url;
          if (!url) return reject(new Error("yt-dlp: pas d'URL exploitable"));
          resolve({
            type: "video",
            url,
            thumb: info.thumbnail || null,
            ext: (fmt && fmt.ext) || "mp4",
            width: (fmt && fmt.width) || info.width || null,
            height: (fmt && fmt.height) || info.height || null,
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/**
 * Liste les médias d'un post Instagram (photos + vidéos), sans les télécharger.
 */
async function fetchPostMedia(postUrl) {
  const source = detectSource(postUrl);
  if (!source) {
    throw new Error(
      "URL non reconnue. Collez l'URL d'un post Instagram, TikTok ou Facebook, " +
        "ou l'adresse directe d'une image (clic droit → Copier l'adresse de l'image)."
    );
  }

  // URL directe d'image/vidéo : rien à extraire, l'URL est le média.
  if (source === "direct") {
    const ext = urlExtension(postUrl);
    const type = VIDEO_EXT.has(ext) ? "video" : "photo";
    return [
      {
        index: 0,
        type,
        url: postUrl.trim(),
        thumb: type === "photo" ? postUrl.trim() : null,
        ext: IMAGE_URL_EXT.has(ext) || VIDEO_EXT.has(ext)
          ? ext
          : type === "video" ? "mp4" : "jpg",
        width: null,
        height: null,
        warning: GSTATIC_THUMB_RE.test(postUrl)
          ? "miniature Google basse résolution — préférez l'image en grand format"
          : null,
      },
    ];
  }

  // --retries 0 : sur un 429, gallery-dl attend une minute avant de reessayer,
  // ce qui depassait notre delai de 60 s et transformait une cause claire en
  // timeout opaque. On echoue vite, on lit l'erreur, et on tente yt-dlp.
  const args = [
    "-j",
    "--retries",
    "0",
    "--user-agent",
    USER_AGENT,
    ...cookieArgs(),
    postUrl.trim(),
  ];

  // Vidéos TikTok et Facebook : yt-dlp est le plus fiable, on le tente en premier.
  // Carrousels photo et Instagram : gallery-dl en premier.
  const isVideoFirst =
    (source === "tiktok" && !/\/photo\//i.test(postUrl)) ||
    (source === "facebook" &&
      /\/videos\/|\/watch|\/reel\/|fb\.watch/i.test(postUrl));

  if (isVideoFirst) {
    try {
      const v = await runYtDlp(postUrl);
      return [{ index: 0, ...v }];
    } catch (e) {
      console.warn(`[${source}] yt-dlp a échoué, tentative gallery-dl…`, e.message);
      const { stdout } = await runGalleryDl(args);
      return parseGalleryDlOutput(stdout);
    }
  }

  let primaryError = null;
  try {
    const { stdout } = await runGalleryDl(args);
    const media = parseGalleryDlOutput(stdout);

    // Résoudre les vidéos déléguées "ytdl:…" en vraies URLs CDN.
    for (const m of media) {
      if (!m.needsYtdl) continue;
      const inner = m.url.slice(5); // retire le préfixe "ytdl:"
      const resolved = await runYtDlp(inner);
      m.url = resolved.url;
      m.ext = resolved.ext;
      m.thumb = m.thumb || resolved.thumb;
      m.width = m.width || resolved.width;
      m.height = m.height || resolved.height;
      delete m.needsYtdl;
    }
    return media;
  } catch (e) {
    primaryError = e;
  }

  // Fallback yt-dlp, surtout utile pour les Reels.
  try {
    console.warn("[instagram] gallery-dl a échoué, tentative yt-dlp…");
    const v = await runYtDlp(postUrl);
    return [{ index: 0, ...v }];
  } catch (e) {
    console.warn("[instagram] yt-dlp a aussi échoué :", e.message);
    throw primaryError;
  }
}

/** Télécharge un média (URL CDN Instagram) côté serveur. Retourne un Buffer. */
const BASE_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "*/*",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

function refererFor(url) {
  if (/cdninstagram\.com|fbcdn\.net|instagram\.com/i.test(url))
    return "https://www.instagram.com/";
  if (/tiktok/i.test(url)) return "https://www.tiktok.com/";
  return null;
}

function headersFor(url) {
  const ref = refererFor(url);
  return ref ? { ...BASE_HEADERS, Referer: ref } : { ...BASE_HEADERS };
}

function downloadViaCurl(url, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(
      os.tmpdir(),
      `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    const ref = refererFor(url);
    const args = [
      "-sSL",
      "--fail",
      "--max-time",
      String(Math.floor(timeoutMs / 1000)),
      "-A",
      USER_AGENT,
      ...(ref ? ["-H", `Referer: ${ref}`] : []),
      "-o",
      tmp,
      url,
    ];
    execFile("curl", args, { timeout: timeoutMs }, (err, _o, stderr) => {
      if (err) {
        fs.rm(tmp, { force: true }, () => {});
        return reject(new Error(`curl: ${(stderr || err.message).slice(0, 200)}`));
      }
      fs.readFile(tmp, (readErr, buf) => {
        fs.rm(tmp, { force: true }, () => {});
        if (readErr) return reject(readErr);
        resolve(buf);
      });
    });
  });
}

async function fetchOnce(url) {
  const res = await fetch(url, { headers: headersFor(url), redirect: "follow" });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.httpStatus = res.status;
    throw e;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Télécharge la vidéo d'un post via yt-dlp (URLs CDN TikTok/Facebook
 * inutilisables à froid : signature liée à la session). Retourne un Buffer.
 */
function downloadViaYtDlp(postUrl, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const base = path.join(
      os.tmpdir(),
      `yt_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    const args = [
      "--no-playlist",
      "--user-agent",
      USER_AGENT,
      ...cookieArgs(),
      "-o",
      `${base}.%(ext)s`,
      postUrl.trim(),
    ];
    execFile(
      process.env.YT_DLP_CMD || "yt-dlp",
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, _o, stderr) => {
        const dir = os.tmpdir();
        const prefix = path.basename(base);
        const found = fs
          .readdirSync(dir)
          .filter((f) => f.startsWith(prefix))
          .map((f) => path.join(dir, f));
        if (err && found.length === 0) {
          return reject(
            new Error(`yt-dlp: ${(stderr || err.message).slice(0, 200)}`)
          );
        }
        if (found.length === 0)
          return reject(new Error("yt-dlp: aucun fichier produit"));
        fs.readFile(found[0], (readErr, buf) => {
          for (const f of found) fs.rm(f, { force: true }, () => {});
          if (readErr) return reject(readErr);
          const ext = (found[0].split(".").pop() || "mp4").toLowerCase();
          resolve({ buffer: buf, ext });
        });
      }
    );
  });
}

async function downloadMedia(url, label = "média") {
  if (String(url).startsWith("ytdl:")) {
    // Ne devrait plus arriver : sélection issue d'une ancienne session.
    throw new Error(
      `Le ${label} vient d'une session obsolète. ` +
        "Relancez la récupération des posts puis renvoyez."
    );
  }
  // 1) fetch Node (2 tentatives), 2) fallback curl.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (e) {
      lastErr = e;
      const cause = (e.cause && (e.cause.code || e.cause.message)) || e.message;
      console.warn(`[download] tentative ${attempt} échouée (${label}) : ${cause}`);
      if (e.httpStatus === 403 || e.httpStatus === 410) break; // lien expiré, inutile d'insister
    }
  }
  try {
    console.warn(`[download] fallback curl (${label})…`);
    return await downloadViaCurl(url);
  } catch (curlErr) {
    const cause =
      (lastErr && lastErr.cause && (lastErr.cause.code || lastErr.cause.message)) ||
      (lastErr && lastErr.message) ||
      "inconnue";
    if (lastErr && (lastErr.httpStatus === 403 || lastErr.httpStatus === 410)) {
      throw new Error(
        `Téléchargement du ${label} refusé (lien expiré ou protégé). ` +
          "Relancez la récupération des posts puis renvoyez."
      );
    }
    throw new Error(
      `Téléchargement du ${label} impossible (cause : ${cause} ; ${curlErr.message}). ` +
        "Réessayez, ou utilisez le dépôt manuel."
    );
  }
}

// Diagnostic pour l'exploitation : les cookies sont-ils charges, et avec
// quelles versions des deux extracteurs ?
export function diagnostic() {
  cookieArgs(); // force l'ecriture du fichier si la variable est presente
  const brut = process.env.INSTAGRAM_COOKIES_TXT || '';
  const aSessionId = /(^|\s)sessionid\s/m.test(brut);
  return {
    cookiesConfigures: !!cookieFile,
    cookiesAvecSessionId: aSessionId,
    galleryDl: version(GALLERY_DL_CMD),
    ytDlp: version(process.env.YT_DLP_CMD || 'yt-dlp'),
  };
}

function version(cmd) {
  try {
    return execFileSync(cmd, ['--version'], { timeout: 8000 })
      .toString()
      .trim()
      .split('\n')[0];
  } catch (e) {
    return 'indisponible';
  }
}

export {
  fetchPostMedia,
  downloadMedia,
  downloadViaYtDlp,
  isSupportedUrl,
  detectSource,
  parseGalleryDlOutput,
  urlExtension,
  VIDEO_EXT,
};
