// Lecture des prompts depuis une base Notion PUBLIEE sur le web.
//
// Pourquoi ce module existe : creer une connexion Notion (API officielle)
// demande des droits admin sur l'espace de travail joystaff, que nous n'avons
// pas. Une page publiee est lisible sans authentification.
//
// CE QU'IL FAUT SAVOIR AVANT DE TOUCHER A CE FICHIER
//
// 1. Il appelle notion.so/api/v3, l'API interne du client web de Notion. Elle
//    n'est pas documentee, n'a pas de version epinglee, et peut changer sans
//    preavis. Le jour ou elle change, le menu des prompts se vide sans que
//    personne n'ait rien modifie cote Joy. C'est le prix de ce contournement.
// 2. Les prompts sont publiquement accessibles a qui a le lien de la page.
// 3. Ce module expose EXACTEMENT la meme interface que notion.js
//    (listStyles / getStyle). Le jour ou une connexion Notion est creee,
//    il suffit de definir NOTION_API_KEY : styleSource.js reprend l'API
//    officielle et ce fichier devient inutile. Ne pas l'entrelacer avec
//    le reste, c'est ce qui rend la bascule triviale.
//
// Robustesse : les identifiants internes (espace, collection, vue) sont
// decouverts au demarrage plutot que codes en dur, et les proprietes sont
// resolues par leur NOM dans le schema, pas par leur cle opaque. Une colonne
// renommee dans Notion casse la lecture ; une colonne deplacee non.

import { resolveModelLabel } from './models.js';

const BASE = 'https://www.notion.so/api/v3';
const ETAT_PUBLIE = 'A implémenter';
const TTL_CACHE_MS = 30_000;

const PROP = {
  nom: 'Nom',
  suffixe: 'Suffixe',
  prompt: 'Prompt',
  modele: 'Modèle',
  etat: 'Etat version',
};

export function createNotionPublicSource({ pageUrl, pageId, viewId }) {
  const page = uuid(pageId || extraireId(pageUrl));
  const vue = viewId ? uuid(viewId) : extraireVue(pageUrl);
  if (!page) throw new Error('NOTION_PUBLIC_PAGE identifiant de page illisible.');

  let contexte = null; // { spaceId, collectionId, viewId }
  let cache = null; // { at, lignes }

  async function api(chemin, corps) {
    // Sans User-Agent de navigateur, la protection anti-bot de Notion repond
    // 403 alors que la meme requete passe depuis un navigateur ou curl.
    const r = await fetch(`${BASE}/${chemin}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'Notion-Client-Version': '23.13.0.ize',
      },
      body: JSON.stringify(corps),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`notion.so/${chemin} -> ${r.status} ${txt.slice(0, 160)}`);
    }
    return r.json();
  }

  // Decouvre spaceId / collectionId / viewId depuis la page publiee.
  async function decouvrir() {
    if (contexte) return contexte;

    const d = await api('loadPageChunk', {
      pageId: page,
      limit: 30,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false,
    });

    const blocs = d?.recordMap?.block || {};
    const bloc = deballer(blocs[page]);
    if (!bloc) {
      throw new Error(
        "Page introuvable. Verifie qu'elle est bien publiee sur le web " +
          "(Partager > Publier), sinon Notion refuse la lecture anonyme.",
      );
    }

    const spaceId = bloc.space_id;
    // Base en pleine page : le bloc EST la collection. Base inline : on prend
    // la premiere collection_view rencontree dans les enfants.
    let collectionId = bloc.collection_id;
    let vues = bloc.view_ids || [];

    if (!collectionId) {
      for (const id of bloc.content || []) {
        const enfant = deballer(blocs[id]);
        if (enfant?.collection_id) {
          collectionId = enfant.collection_id;
          vues = enfant.view_ids || [];
          break;
        }
      }
    }
    if (!collectionId) throw new Error('Aucune base de donnees trouvee sur cette page.');

    const viewChoisie = vue && vues.includes(vue) ? vue : vues[0];
    if (!viewChoisie) throw new Error('Aucune vue disponible sur cette base.');

    contexte = { spaceId, collectionId, viewId: viewChoisie };
    return contexte;
  }

  // Recupere toutes les lignes, paginees, avec un cache court : la galerie et
  // le menu peuvent demander le catalogue plusieurs fois par minute.
  async function lignes() {
    if (cache && Date.now() - cache.at < TTL_CACHE_MS) return cache.lignes;

    const { spaceId, collectionId, viewId: vId } = await decouvrir();
    const out = [];
    let schema = null;
    let cursor = { stack: [] };

    for (let page_ = 0; page_ < 20; page_++) {
      const d = await api('queryCollection', {
        source: { type: 'collection', id: collectionId, spaceId },
        collectionView: { id: vId, spaceId },
        loader: {
          type: 'reducer',
          reducers: {
            collection_group_results: { type: 'results', limit: 100, loadContentCover: false },
          },
          searchQuery: '',
          userTimeZone: 'Europe/Paris',
        },
      });

      schema = schema || deballer(d?.recordMap?.collection?.[collectionId])?.schema;
      const blocs = d?.recordMap?.block || {};
      const ids = d?.result?.reducerResults?.collection_group_results?.blockIds || [];
      for (const id of ids) {
        const b = deballer(blocs[id]);
        if (b) out.push(b);
      }

      const suite = d?.result?.reducerResults?.collection_group_results?.hasMore;
      if (!suite) break;
      cursor = d?.result?.reducerResults?.collection_group_results?.cursor || cursor;
      if (!cursor?.stack?.length) break;
    }

    if (!schema) throw new Error('Schema de la base illisible.');

    // Cles opaques -> noms de colonnes. C'est ce qui rend le module resistant
    // a une reorganisation de la base.
    const parNom = {};
    for (const [cle, def] of Object.entries(schema)) parNom[def.name] = cle;

    const lignesLues = out.map((bloc) => lireLigne(bloc, parNom));
    cache = { at: Date.now(), lignes: lignesLues };
    return lignesLues;
  }

  async function listStyles() {
    const tous = await lignes();
    const styles = [];
    const vus = new Set();

    for (const l of tous) {
      if (l.etat !== ETAT_PUBLIE) continue;
      if (!l.label) {
        console.warn(`[notion-public] Ligne ignoree (ni Suffixe ni Nom) : ${l.key}`);
        continue;
      }
      if (!l.prompt) {
        console.warn(`[notion-public] Ligne ignoree (Prompt vide) : "${l.label}"`);
        continue;
      }
      if (vus.has(l.suffix)) {
        console.warn(`[notion-public] Suffixe en doublon ignore : "${l.label}"`);
        continue;
      }
      vus.add(l.suffix);
      styles.push({ key: l.key, label: l.label, source: 'notion-public' });
    }

    styles.sort((a, b) => a.label.localeCompare(b.label, 'fr'));
    return styles;
  }

  async function getStyle(key) {
    // Cache contourne : un CSM peut lancer une session juste apres avoir
    // corrige un prompt, il doit avoir la derniere version.
    cache = null;
    const l = (await lignes()).find((x) => x.key === key);
    if (!l) throw new Error('Prompt introuvable. Recharge la page pour rafraichir le menu.');
    if (l.etat !== ETAT_PUBLIE) {
      throw new Error(
        `Ce prompt n'est plus en "${ETAT_PUBLIE}" dans Notion (statut : ${l.etat || 'aucun'}). ` +
          'Recharge la page.',
      );
    }
    if (!l.prompt) throw new Error("Ce prompt n'a pas de contenu dans Notion.");
    return l;
  }

  function lireLigne(bloc, parNom) {
    const props = bloc.properties || {};
    const txt = (nomColonne) => richText(props[parNom[nomColonne]]);

    const nom = txt(PROP.nom).trim();
    const suffixe = txt(PROP.suffixe).trim();
    const label = suffixe || nom;
    const modeleBrut = txt(PROP.modele).trim();
    const model = resolveModelLabel(modeleBrut);
    if (modeleBrut && !model) {
      console.warn(`[notion-public] Modele non reconnu pour "${label}" : "${modeleBrut}".`);
    }

    return {
      key: bloc.id,
      name: nom,
      label,
      suffix: slug(label),
      prompt: txt(PROP.prompt).trim(),
      model,
      type: 'ai',
      etat: txt(PROP.etat).trim(),
      source: 'notion-public',
    };
  }

  return { listStyles, getStyle };
}

// Les enregistrements de l'API v3 sont enveloppes, et l'enveloppe a change
// selon les versions : { value: {...} } ou { value: { value: {...}, role } }.
// On deballe jusqu'a trouver l'objet qui porte les donnees.
function deballer(enr) {
  let v = enr?.value;
  if (v && typeof v === 'object' && 'value' in v && !('id' in v)) v = v.value;
  return v || null;
}

// Les valeurs de propriete de l'API v3 sont des tableaux de segments :
// [["texte"], ["gras", [["b"]]]]. On ne garde que le texte.
function richText(valeur) {
  if (!Array.isArray(valeur)) return '';
  return valeur.map((seg) => (Array.isArray(seg) ? String(seg[0] ?? '') : '')).join('');
}

function extraireId(url) {
  if (!url) return null;
  const m = String(url).match(/([0-9a-f]{32})/i) || String(url).match(/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function extraireVue(url) {
  if (!url) return null;
  const m = String(url).match(/[?&]v=([0-9a-f]{32})/i);
  return m ? uuid(m[1]) : null;
}

function uuid(s) {
  if (!s) return null;
  const brut = String(s).replace(/-/g, '');
  if (brut.length !== 32) return String(s);
  return `${brut.slice(0, 8)}-${brut.slice(8, 12)}-${brut.slice(12, 16)}-${brut.slice(16, 20)}-${brut.slice(20)}`;
}

function slug(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
