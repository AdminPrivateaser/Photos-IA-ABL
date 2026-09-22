// Source unique des styles pour le serveur : styles cables en dur (recadrage)
// + prompts IA venant de Notion.
//
// Choix assume : PAS de repli sur une liste de prompts locale. Si Notion est
// injoignable, le menu ne contient que les styles locaux et l'UI affiche
// l'erreur. Servir silencieusement d'anciens prompts serait pire que servir
// un menu incomplet : le CSM livrerait des retouches obsoletes sans le savoir.

export function createStyleSource({ builtin, notion, notionPublic }) {
  // Priorite a l'API officielle. Le repli public n'est utilise que si aucune
  // connexion Notion n'est configuree : le jour ou NOTION_API_KEY arrive, la
  // bascule est automatique et il n'y a rien a modifier ici.
  const source = notion || notionPublic || null;
  const officiel = !!notion;
  const local = () =>
    Object.entries(builtin).map(([key, s]) => ({ key, label: s.label, source: 'local' }));

  async function listStyles() {
    if (!source) {
      return {
        styles: local(),
        notionConfigured: false,
        notionError:
          "Notion n'est pas configure (ni NOTION_API_KEY, ni NOTION_PUBLIC_PAGE). " +
          'Aucun prompt IA disponible.',
      };
    }
    try {
      const remote = await source.listStyles();
      return {
        styles: [...remote, ...local()],
        notionConfigured: true,
        notionSource: officiel ? 'api' : 'public',
        notionError:
          remote.length === 0
            ? 'Aucun prompt en statut "A implementer" dans Notion.'
            : null,
      };
    } catch (e) {
      console.error('[styles] Lecture Notion impossible :', (e && e.message) || e);
      return {
        styles: local(),
        notionConfigured: true,
        notionSource: officiel ? 'api' : 'public',
        notionError:
          (officiel
            ? 'Lecture des prompts Notion impossible : '
            : 'Lecture de la base Notion publiee impossible (verifie que la page est toujours publiee) : ') +
          ((e && e.message) || e),
      };
    }
  }

  async function getStyle(key) {
    if (builtin[key]) return builtin[key];
    if (!source) {
      throw new Error("Style inconnu : Notion n'est pas configure.");
    }
    return source.getStyle(key);
  }

  return { listStyles, getStyle };
}
