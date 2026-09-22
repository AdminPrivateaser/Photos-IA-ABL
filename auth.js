// Connexion par identifiant + mot de passe, compte unique partagé.
//
// Contexte : cet outil est utilisé par un prestataire externe (ABL) qui n'a
// pas d'adresse @joy.io / @privateaser.com, donc pas d'accès a la connexion
// Google restreinte par domaine (voir l'outil interne). Un seul compte suffit :
// pas de suivi individuel demande pour cet usage, la formation se fait en
// groupe.
//
// LA SESSION EST SANS ETAT (identique a l'ancienne version)
//
// Un cookie signe HMAC-SHA256 contient l'identifiant et une date d'expiration.
// Aucune table de sessions : un redeploiement Railway ne deconnecte personne.
//
// LE MOT DE PASSE N'EST JAMAIS STOCKE EN CLAIR
//
// APP_PASSWORD_HASH contient "sel:hash" (scrypt, hexadecimal), genere une
// fois avec hash-password.js. node:crypto suffit, pas de dependance npm
// (meme logique que l'ancienne authentification : eviter une dependance
// pour un besoin que la stdlib couvre deja).

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const COOKIE_SESSION = 'joy_session';
const DUREE_MS = 12 * 60 * 60 * 1000; // 12 h : une journee de travail

export function createAuth({ login, passwordHash, sessionSecret }) {
  const manquantes = [
    !login && 'APP_LOGIN',
    !passwordHash && 'APP_PASSWORD_HASH',
    !sessionSecret && 'SESSION_SECRET',
  ].filter(Boolean);
  if (manquantes.length) {
    // Le serveur refuse de demarrer plutot que de s'ouvrir sans
    // authentification correctement configuree.
    throw new Error(`Variables manquantes : ${manquantes.join(', ')}.`);
  }

  const loginAttendu = String(login).trim();
  const [selAttendu, hashAttendu] = String(passwordHash).split(':');
  if (!selAttendu || !hashAttendu) {
    throw new Error(
      'APP_PASSWORD_HASH malformee : attendu "sel:hash" (voir hash-password.js).',
    );
  }

  // --- Signature ------------------------------------------------------------
  const b64 = (buf) => Buffer.from(buf).toString('base64url');
  const signer = (s) => createHmac('sha256', sessionSecret).update(s).digest('base64url');

  function sceller(objet) {
    const corps = b64(JSON.stringify(objet));
    return `${corps}.${signer(corps)}`;
  }

  function ouvrir(valeur) {
    if (typeof valeur !== 'string' || !valeur.includes('.')) return null;
    const i = valeur.lastIndexOf('.');
    const corps = valeur.slice(0, i);
    const sig = valeur.slice(i + 1);
    const attendu = signer(corps);
    if (sig.length !== attendu.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
    try {
      return JSON.parse(Buffer.from(corps, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  // --- Verification du mot de passe -----------------------------------------
  // Comparaison a temps constant : le hash calcule et le hash attendu doivent
  // faire la meme longueur pour timingSafeEqual, scrypt produit toujours 64
  // octets ici donc c'est garanti tant que le sel n'a pas change de taille.
  function motDePasseValide(motDePasse) {
    try {
      const calcule = scryptSync(String(motDePasse || ''), selAttendu, 64).toString('hex');
      const a = Buffer.from(calcule, 'hex');
      const b = Buffer.from(hashAttendu, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  function identifiantValide(id) {
    // Comparaison a temps constant egalement : eviter qu'un identifiant de
    // longueur differente renvoie plus vite qu'un identifiant presque bon.
    const a = Buffer.from(String(id || ''));
    const b = Buffer.from(loginAttendu);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // --- Cookies (sans dependance) ---------------------------------------------
  function lireCookies(req) {
    const out = {};
    for (const bout of String(req.headers.cookie || '').split(';')) {
      const i = bout.indexOf('=');
      if (i < 0) continue;
      out[bout.slice(0, i).trim()] = decodeURIComponent(bout.slice(i + 1).trim());
    }
    return out;
  }

  function poserCookie(res, nom, valeur, maxAgeMs) {
    const bouts = [
      `${nom}=${encodeURIComponent(valeur)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Secure',
      `Max-Age=${Math.round(maxAgeMs / 1000)}`,
    ];
    ajouterCookie(res, bouts.join('; '));
  }

  function effacerCookie(res, nom) {
    ajouterCookie(res, `${nom}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
  }

  function ajouterCookie(res, valeur) {
    const actuel = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', actuel ? [].concat(actuel, valeur) : valeur);
  }

  // --- Etapes du flux ---------------------------------------------------------

  /** Affiche le formulaire de connexion. */
  function pageLogin(req, res) {
    res.type('html').send(pageConnexion(null));
  }

  /** Verifie identifiant + mot de passe, pose la session. */
  function traiterLogin(req, res) {
    const { login: id, password } = req.body || {};
    if (!identifiantValide(id) || !motDePasseValide(password)) {
      return refuser(res, 'Identifiant ou mot de passe incorrect.');
    }
    poserCookie(
      res,
      COOKIE_SESSION,
      sceller({ login: loginAttendu, exp: Date.now() + DUREE_MS }),
      DUREE_MS,
    );
    res.redirect('/');
  }

  function refuser(res, message) {
    res.status(403).type('html').send(pageConnexion(message));
  }

  // --- Middleware -------------------------------------------------------------

  /** Session courante, ou null. */
  function utilisateur(req) {
    const s = ouvrir(lireCookies(req)[COOKIE_SESSION]);
    if (!s || !s.login || !s.exp || s.exp < Date.now()) return null;
    if (s.login !== loginAttendu) return null; // APP_LOGIN change : sessions en cours invalidees
    return { login: s.login };
  }

  function requireAuth(req, res, next) {
    const u = utilisateur(req);
    if (u) {
      req.user = u;
      return next();
    }
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Session expirée.', login: '/auth/login' });
    }
    res.status(401).type('html').send(pageConnexion(null));
  }

  function deconnexion(req, res) {
    effacerCookie(res, COOKIE_SESSION);
    res.redirect('/');
  }

  function pageConnexion(message) {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connexion — Joy Contenus</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet" />
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f6f5fb; color:#15132b; font-family:'Inter',system-ui,sans-serif; padding:24px; }
  .box { background:#fff; border:1px solid #e7e5f1; border-radius:16px; padding:36px 32px;
    max-width:400px; width:100%; box-shadow:0 1px 2px rgba(21,19,43,.04); text-align:center; }
  .brand { font-family:'Space Grotesk',sans-serif; font-weight:700; color:#2d1eaf; font-size:15px;
    display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:22px; }
  .dot { width:10px; height:10px; border-radius:3px; background:#ff6b1a; }
  h1 { font-family:'Space Grotesk',sans-serif; font-size:21px; margin:0 0 8px; letter-spacing:-.02em; }
  p { color:#6b6880; font-size:14px; margin:0 0 24px; }
  label { display:block; text-align:left; font-weight:600; font-size:13px; margin:0 0 6px; }
  input { width:100%; padding:11px 13px; font-size:14px; font-family:inherit; border:1px solid #e7e5f1;
    border-radius:10px; margin-bottom:16px; box-sizing:border-box; }
  input:focus { outline:none; border-color:#2d1eaf; box-shadow:0 0 0 3px rgba(45,30,175,.10); }
  button { display:block; width:100%; padding:13px; background:#2d1eaf; color:#fff; border:0;
    text-decoration:none; border-radius:10px; font-weight:600; font-size:15px; cursor:pointer;
    font-family:inherit; }
  button:hover { background:#3226C0; }
  .err { background:#fdecea; border:1px solid #f6c9c5; color:#d4453b; border-radius:10px;
    padding:11px 13px; font-size:13px; margin-bottom:20px; text-align:left; }
</style></head><body>
  <div class="box">
    <div class="brand"><span class="dot"></span> Joy · Contenus</div>
    <h1>Connexion</h1>
    <p>Accès réservé.</p>
    ${message ? `<div class="err">${String(message).replace(/[<>&]/g, '')}</div>` : ''}
    <form method="POST" action="/auth/login">
      <label for="login">Identifiant</label>
      <input type="text" id="login" name="login" autocomplete="username" required autofocus />
      <label for="password">Mot de passe</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required />
      <button type="submit">Se connecter</button>
    </form>
  </div>
</body></html>`;
  }

  return { pageLogin, traiterLogin, deconnexion, requireAuth, utilisateur };
}
