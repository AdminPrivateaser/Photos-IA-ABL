// Styles cables en dur dans le code, hors Notion.
//
// Le recadrage n'est pas un prompt : c'est une transformation deterministe
// (sharp, canevas 1500x750 transparent, PNG), sans appel IA et sans cout.
// Il n'a donc pas sa place dans la base Notion "Prompts retouche photo",
// qui est reservee aux prompts IA et pilotee par le statut "A implementer".
//
// Ces styles sont TOUJOURS presents dans le menu, meme si Notion est
// injoignable. C'est voulu : ils ne dependent d'aucun service externe.

export const builtinStyles = {
  recadrage: {
    name: 'Recadrage 1500x750 (local, cout zero)', // usage interne / logs
    label: 'Recadrage', // libelle affiche dans le menu
    suffix: 'recadrage', // suffixe dossier Drive
    type: 'recadrage', // traite par transforms.recadrage(), pas par FLORA
    source: 'local',
  },
};
