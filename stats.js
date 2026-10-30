// Statistiques d'une session pour le suivi (tracker.js) : d'ou viennent les
// fichiers, et quelles retouches ont ete utilisees, sur combien de photos.
//
// Une photo compte une fois par type de retouche, meme si elle a ete
// retouchee plusieurs fois avec le meme prompt.

import { isNeutral } from './adjust.js';

const RESEAUX = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', direct: 'image en ligne' };

// « Dossier Drive », « Shooting déposé », « Contenu gérant », « Lien Instagram », « Liens
// Instagram + TikTok »...
export function sourceSession(s) {
  if (s.mode === 'drive') return s.origine === 'shooting' ? 'Shooting déposé' : 'Dossier Drive';
  if (s.mode === 'upload') return 'Contenu gérant';
  if (s.mode !== 'links') return s.mode || '';
  const reseaux = new Set();
  for (const p of s.photos || []) {
    if (p.status === 'deleted' || p.origin) continue;
    const r = String(p.sourceName || '').split('_')[0].toLowerCase();
    if (RESEAUX[r]) reseaux.add(RESEAUX[r]);
  }
  const liste = [...reseaux];
  if (liste.length === 0) return 'Lien';
  return `${liste.length > 1 ? 'Liens' : 'Lien'} ${liste.join(' + ')}`;
}

/**
 * @param {object} s       plan de travail complet (avec promptText)
 * @param {Set}    catalogue noms des prompts du catalogue, ou null
 * @returns {{ retouches: Array<{nom, type, photos, texte?}>, textes: string[] }}
 *   type : 'IA' | 'Personnalisé' | 'Sans IA'
 */
export function retouchesSession(s, catalogue = null) {
  const parCle = new Map();
  const compter = (cle, info, photoId) => {
    if (!parCle.has(cle)) parCle.set(cle, { ...info, ids: new Set() });
    parCle.get(cle).ids.add(photoId);
  };

  for (const p of s.photos || []) {
    if (p.status === 'deleted' || p.kind === 'video') continue;
    for (const r of p.renders || []) {
      if (r.status !== 'ok') continue;
      if (r.kind === 'reglages') {
        compter('colorimetrie', { nom: 'Colorimétrie', type: 'Sans IA' }, p.id);
      } else if (r.kind === 'recadrage') {
        const auto = r.auto || (s.mode === 'links' && r.from === 'source' && p.renders[0] === r && !p.origin);
        compter(auto ? 'recadrage-auto' : 'recadrage',
          { nom: auto ? 'Recadrage (auto)' : 'Recadrage', type: 'Sans IA' }, p.id);
      } else {
        const libre = r.libre || r.promptLabel === 'Prompt libre'
          || (catalogue && catalogue.size > 0 && !catalogue.has(r.promptLabel));
        if (libre) {
          const texte = String(r.promptText || '').trim();
          compter(`libre:${texte || r.promptLabel}`,
            { nom: 'Prompt personnalisé', type: 'Personnalisé', texte }, p.id);
        } else {
          compter(`ia:${r.promptLabel}`, { nom: r.promptLabel || 'Prompt', type: 'IA' }, p.id);
        }
      }
    }
    // Anciennes sessions : reglages et format vitrine gardes sur la photo.
    if (!isNeutral(p.adjust)) compter('colorimetrie', { nom: 'Colorimétrie', type: 'Sans IA' }, p.id);
    if (p.format === 'vitrine') compter('recadrage', { nom: 'Recadrage', type: 'Sans IA' }, p.id);
  }

  const retouches = [...parCle.values()].map((x) => ({
    nom: x.nom, type: x.type, photos: x.ids.size, ...(x.texte !== undefined ? { texte: x.texte } : {}),
  }));
  // IA d'abord, puis personnalisés, puis sans IA ; les plus utilisées en tête.
  const ordre = { IA: 0, Personnalisé: 1, 'Sans IA': 2 };
  retouches.sort((a, b) => ordre[a.type] - ordre[b.type] || b.photos - a.photos || a.nom.localeCompare(b.nom));
  const textes = [...new Set(retouches.filter((x) => x.texte).map((x) => x.texte))];
  return { retouches, textes };
}

// Résumé d'une case : « Amélioration de la qualité ×12, Prompt personnalisé ×1, Recadrage ×3 ».
// Les prompts personnalisés sont regroupés : leurs textes vont dans la colonne voisine.
export function resumeRetouches(retouches) {
  const fusion = new Map();
  for (const r of retouches) fusion.set(r.nom, (fusion.get(r.nom) || 0) + r.photos);
  return [...fusion.entries()].map(([nom, n]) => `${nom} ×${n}`).join(', ');
}
