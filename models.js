// IA disponibles dans le menu deroulant de l'outil.
// default: true => preselectionnee. Nano Banana Pro est le defaut.
//
// IDs FLORA confirmes accessibles a ta cle (image-to-image, 1 image source).
// Pour changer de variante GPT, remplace simplement le model_id ci-dessous :
//   GPT Image      : i2i-openai-gpt-image-1
//   GPT Image 1.5  : i2i-openai-gpt-image-1-5
//   GPT Image 2    : i2i-gpt-image-2-i2i
// (La liste complete de ce que ta cle peut utiliser est sur /api/flora-models.)

// Un seul modèle dans cette version : le sélecteur est retiré de l'interface,
// tout passe par Nano Banana Pro. Les alias ci-dessous restent utiles pour
// interpréter la colonne "Modèle" de Notion, au cas où elle contiendrait une
// autre écriture du même modèle.
export const models = {
  'nano-pro': { label: 'Nano Banana Pro', model_id: 'i2i-gemini-3-pro', default: true },
};

export const defaultModelKey =
  Object.entries(models).find(([, m]) => m.default)?.[0] || Object.keys(models)[0];

// key (ex. "nano-pro") -> model_id FLORA. Renvoie null si inconnu.
export function resolveModel(key) {
  const m = models[key];
  return m ? m.model_id : null;
}

// --- Libelles humains -> model_id FLORA -------------------------------------
// La colonne "Modele" de Notion contient un libelle lisible ("Nano-Banana-Pro"),
// pas un model_id FLORA. Sans conversion, la valeur est inexploitable : elle
// serait passee telle quelle a l'API et provoquerait une erreur de generation.
// Ajouter ici toute nouvelle ecriture rencontree dans Notion.

const MODEL_ALIASES = {
  'nano banana pro': 'i2i-gemini-3-pro',
  'nano banana 2': 'i2i-gemini-3.1-flash-image',
  'nano banana': 'i2i-gemini-3.1-flash-image',
  'gemini 3 pro': 'i2i-gemini-3-pro',
  'gpt image 2': 'i2i-gpt-image-2-i2i',
  'gpt image': 'i2i-openai-gpt-image-1',
};

// Normalise "Nano-Banana-Pro", "nano_banana_pro", "Nano Banana  Pro"
// vers une meme cle "nano banana pro".
function normalize(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Convertit un libelle Notion en model_id FLORA.
 * - un model_id deja valide (commence par "i2i-") passe tel quel
 * - un libelle connu est converti
 * - sinon null (l'appelant retombe sur le modele choisi dans le menu)
 */
export function resolveModelLabel(raw) {
  const brut = String(raw || '').trim();
  if (!brut) return null;
  if (/^i2i-/i.test(brut)) return brut;

  const key = normalize(brut);
  if (MODEL_ALIASES[key]) return MODEL_ALIASES[key];

  // Repli : un libelle qui correspond a une entree du menu.
  const menu = Object.values(models).find((m) => normalize(m.label) === key);
  return menu ? menu.model_id : null;
}
