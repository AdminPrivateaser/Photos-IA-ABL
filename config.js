function env(key, fallback = undefined) {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    console.warn(`[config] Variable d'environnement manquante : ${key}`);
    return undefined;
  }
  return v;
}

export const config = {
  port: Number(env('PORT', '3000')),
  floraApiKey: env('FLORA_API_KEY'),
  floraWorkspaceId: env('FLORA_WORKSPACE_ID'),
  floraProjectId: env('FLORA_PROJECT_ID'),
  googleServiceAccountJson: env('GOOGLE_SERVICE_ACCOUNT_JSON'),
  concurrency: Number(env('CONCURRENCY', '4')),

  // Source des prompts IA. Ces deux variables manquaient : server.js testait
  // config.notionApiKey && config.notionStylesDbId, qui valaient toujours
  // undefined. Le pont Notion etait donc du code mort.
  notionApiKey: env('NOTION_API_KEY'),
  notionStylesDbId: env('NOTION_STYLES_DB_ID'),

  // Repli sans droits admin : lecture d'une base Notion PUBLIEE sur le web.
  // Utilise uniquement si NOTION_API_KEY est absente. Passe par l'API interne
  // notion.so/api/v3, non documentee et sans version epinglee.
  notionPublicPage: env('NOTION_PUBLIC_PAGE', ''),
};

// --- Ajouts plan de travail ---------------------------------------------------
export const appConfig = {
  // Connexion login/mot de passe, compte unique. Voir auth.js et hash-password.js.
  appLogin: process.env.APP_LOGIN,
  appPasswordHash: process.env.APP_PASSWORD_HASH,
  sessionSecret: process.env.SESSION_SECRET,
  dataDir: process.env.DATA_DIR || '/data',
  maxRenderPerPhoto: Number(process.env.MAX_RENDER_PER_PHOTO || '6'),
  maxSessionCost: Number(process.env.MAX_SESSION_COST || '0'), // 0 = pas de plafond
  // Drive parent contenant les dossiers etablissement "{ID} - {nom}".
  // Meme variable que celle utilisee par l'outil de recuperation sociale.
  parentFolderId: process.env.PARENT_FOLDER_ID,
};
