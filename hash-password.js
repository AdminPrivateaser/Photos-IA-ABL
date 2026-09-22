// Genere la valeur a mettre dans APP_PASSWORD_HASH.
//
// Usage :
//   node hash-password.js "le-mot-de-passe-choisi"
//
// Copie la ligne "sel:hash" affichee dans la variable d'environnement
// APP_PASSWORD_HASH (Railway). Le mot de passe en clair n'est jamais stocke,
// ni ici ni sur le serveur.

import { randomBytes, scryptSync } from 'node:crypto';

const motDePasse = process.argv[2];
if (!motDePasse) {
  console.error('Usage : node hash-password.js "mot-de-passe"');
  process.exit(1);
}

const sel = randomBytes(16).toString('hex');
const hash = scryptSync(motDePasse, sel, 64).toString('hex');

console.log('\nAPP_PASSWORD_HASH=' + sel + ':' + hash + '\n');
