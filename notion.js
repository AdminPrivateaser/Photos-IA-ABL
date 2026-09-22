// Source des prompts IA depuis la base Notion "Prompts retouche photo".
//
// REGLE UNIQUE : une ligne apparait dans le menu si et seulement si
// "Etat version" = "A implementer". La colonne "Actif" n'est plus lue.
//
// Mapping des colonnes vers l'outil :
//   Suffixe       -> libelle affiche au CSM ET base du nom de dossier Drive
//   Prompt        -> instruction envoyee au modele
//   Nom           -> usage interne uniquement (versionnement : "Jour => nuit v9")
//   Modele        -> libelle humain, converti en model_id FLORA (voir models.js)
//   Etat version  -> filtre d'affichage
//   Type / Actif  -> non lus (le recadrage est cable en dur, cf builtinStyles.js)

import { resolveModelLabel } from './models.js';

const NOTION_VERSION = '2022-06-28';

const PROP = {
  nom: 'Nom',
  suffixe: 'Suffixe',
  prompt: 'Prompt',
  modele: 'Modèle',
  etat: 'Etat version',
};

const ETAT_PUBLIE = 'A implémenter';

export function createNotionSource({ notionApiKey, databaseId }) {
  async function api(pathname, options = {}) {
    const r = await fetch(`https://api.notion.com/v1${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${notionApiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Notion ${pathname} -> ${r.status} ${body.slice(0, 200)}`);
    }
    return r.json();
  }

  // Lit une propriete Notion en texte, tous types confondus.
  function text(prop) {
    if (!prop) return '';
    if (Array.isArray(prop.title)) return prop.title.map((t) => t.plain_text).join('');
    if (Array.isArray(prop.rich_text)) return prop.rich_text.map((t) => t.plain_text).join('');
    if (prop.select) return prop.select.name || '';
    if (prop.status) return prop.status.name || '';
    return '';
  }

  function toStyle(page) {
    const p = page.properties || {};
    const nom = text(p[PROP.nom]).trim();
    const suffixe = text(p[PROP.suffixe]).trim();

    // Le libelle du menu est le Suffixe. Repli sur Nom si Suffixe est vide,
    // pour ne jamais afficher une entree sans nom.
    const label = suffixe || nom;

    // Le suffixe technique (dossier Drive, projet FLORA) est slugifie :
    // "Ambiance bar" affiche a l'ecran -> "ambiance-bar" dans Drive.
    const suffix = slug(label);

    const modeleBrut = text(p[PROP.modele]).trim();
    const model = resolveModelLabel(modeleBrut);
    if (modeleBrut && !model) {
      console.warn(
        `[notion] Modele non reconnu pour "${label}" : "${modeleBrut}". ` +
          `Le modele choisi dans le menu de l'outil sera utilise.`,
      );
    }

    return {
      key: page.id,
      name: nom, // interne : versionnement, logs
      label, // affiche
      suffix, // technique
      prompt: text(p[PROP.prompt]).trim(),
      model, // model_id FLORA, ou null
      type: 'ai', // Notion ne sert que des prompts IA
      etat: text(p[PROP.etat]).trim(),
      source: 'notion',
    };
  }

  // Menu : uniquement les lignes en "A implementer", triees par suffixe.
  async function listStyles() {
    const styles = [];
    const vus = new Set();
    let cursor;

    do {
      const res = await api(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          filter: { property: PROP.etat, status: { equals: ETAT_PUBLIE } },
          sorts: [{ property: PROP.suffixe, direction: 'ascending' }],
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });

      for (const page of res.results) {
        const s = toStyle(page);
        if (!s.label) {
          console.warn(`[notion] Ligne ignoree (ni Suffixe ni Nom) : ${page.id}`);
          continue;
        }
        if (!s.prompt) {
          console.warn(`[notion] Ligne ignoree (Prompt vide) : "${s.label}"`);
          continue;
        }
        // Deux lignes qui slugifient pareil ecriraient dans le meme dossier
        // Drive. On garde la premiere et on signale.
        if (vus.has(s.suffix)) {
          console.warn(
            `[notion] Suffixe en doublon ignore : "${s.label}" (deja pris : ${s.suffix})`,
          );
          continue;
        }
        vus.add(s.suffix);
        styles.push({ key: s.key, label: s.label, source: 'notion' });
      }

      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    return styles;
  }

  // Lancement de session : on relit la page pour avoir le prompt a jour,
  // et on verifie que le statut n'a pas change depuis le chargement du menu.
  async function getStyle(pageId) {
    const page = await api(`/pages/${pageId}`);
    const s = toStyle(page);

    if (s.etat !== ETAT_PUBLIE) {
      throw new Error(
        `Ce prompt n'est plus en "${ETAT_PUBLIE}" dans Notion (statut actuel : ` +
          `${s.etat || 'aucun'}). Recharge la page pour rafraichir le menu.`,
      );
    }
    if (!s.prompt) {
      throw new Error("Ce prompt n'a pas de contenu renseigne dans Notion.");
    }
    return s;
  }

  return { listStyles, getStyle };
}

function slug(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
