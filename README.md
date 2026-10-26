# Joy · Contenus — outil de retouche photo (version ABL)

Version de l'outil de retouche photo destinée au prestataire ABL. On importe des contenus pour un établissement, on les retouche (prompts IA, colorimétrie, recadrage vitrine), et tout est rangé automatiquement dans le dossier Drive de l'établissement.

Cette version est construite sur le même code que l'outil CX (dépôt `photo-vitrine`). Seuls les réglages propres au prestataire diffèrent (voir « Différences avec l'outil CX »). Une correction faite dans l'outil CX peut donc être reportée ici telle quelle, fichier par fichier, sauf pour les fichiers listés dans cette section.

La version déployée s'affiche en haut à droite de l'outil (par exemple `v2-abl`).

---

## Différences avec l'outil CX

| | CX (interne) | ABL (prestataire) |
|---|---|---|
| Connexion | Google, comptes @joy.io / @privateaser.com | Identifiant + mot de passe, compte unique |
| Import | Dossier Drive, fichiers déposés, liens | Dossier Drive, liens (pas de dépôt de fichiers) |
| Prompts | Base Notion « Prompts retouche photo » | Base Notion dédiée, via `NOTION_PUBLIC_PAGE` |
| Modèle IA | Choix entre plusieurs modèles | Nano Banana Pro fixé, pas de sélecteur |
| Coût FLORA | Affiché | Masqué |
| « En partant de » / « et en » | Toujours visibles | Repliés dans « Réglages avancés » |
| Suivi Google Sheet | Oui (`tracker.js`, `stats.js`) | Non, traité autrement |

Fichiers propres à ABL, à ne pas écraser avec ceux de CX : `auth.js`, `hash-password.js`, `config.js`, `models.js`, `server.js` (connexion, pas de suivi, pas de dépôt de fichiers), `index.html` (mêmes différences côté interface), `README.md`.

---

## Utilisation

### 1. L'établissement (obligatoire)

Rien ne peut être importé sans établissement. On le cherche par **nom** ou par **ID** parmi les dossiers du grand dossier Drive des établissements (`PARENT_FOLDER_ID`), nommés `ID - Nom de l'établissement`.

S'il n'existe pas, l'outil propose de créer le dossier `ID - Nom`. La création est refusée si l'ID existe déjà : l'outil propose alors le dossier existant, pour éviter les doublons dus à une faute de frappe.

L'établissement peut être corrigé en cours de session, depuis le plan de travail.

### 2. Les deux façons d'importer

| Mode | Ce qu'on fait | Où vont les originaux |
|---|---|---|
| **Un dossier Drive** | On choisit le dossier du shooting dans la liste des sous-dossiers de l'établissement (ou on colle un lien en dépannage). | Ils y sont déjà, rien n'est copié. |
| **Des liens** | URL de posts Instagram, TikTok, Facebook, ou d'une image en ligne. Un post bloqué par la plateforme dans certains pays ne peut pas être récupéré. | `Social media`, dès l'import. Les photos sont **recadrées automatiquement** au format vitrine. |

Les vidéos ne se retouchent pas : elles sont seulement rangées avec les originaux.

Pour compléter une session :
- **Liens :** « + Ajouter un lien » récupère d'autres posts. Ils sont rangés dans `Social media` et recadrés.
- **Dossier Drive :** pas d'ajout possible. Le dossier du shooting n'est jamais modifié : l'outil n'y crée que `Retouche - <date>`.

### 3. Les retouches

Dans le plan de travail :

- **Prompts IA** (depuis la grille) : on sélectionne des photos, on choisit un prompt et on lance. Par défaut, on part de l'image actuelle en ajoutant une variante ; « Réglages avancés » permet de partir de la photo d'origine ou de remplacer l'image. Les prompts viennent de la base Notion dédiée et sont exécutés par FLORA avec Nano Banana Pro.
- **Recadrage** : format vitrine 1500×750, photo entière centrée avec des bords vides (PNG transparent). Sans IA, gratuit. Appliqué automatiquement aux photos récupérées par lien. Un prompt IA lancé sur une photo recadrée repart de l'image sous le recadrage, pour ne pas travailler sur une image réduite.
- **Colorimétrie** (bouton « régler » sur une photo) : luminosité, contraste, saturation, température. « Enregistrer les réglages » ou « Appliquer à la sélection » crée une vraie nouvelle image en pleine résolution, sans IA. Les réglages ne s'empilent pas : les modifier repart de l'image de départ. La vue de réglage ne propose pas de prompt, volontairement : on ferme les réglages pour lancer un prompt depuis la grille.

### Qualité des images

Les retouches IA sont demandées en **2K** à FLORA (`FLORA_RESOLUTION`, `2K` par défaut). Le fichier livré est l'original produit par FLORA, pas la version allégée de son CDN, et il n'est jamais recompressé. Les dimensions de chaque image générée sont écrites dans les journaux Railway (`[flora] dimensions : …`), ce qui permet de vérifier la résolution obtenue.

### 4. Télécharger et valider

- **Télécharger** une photo donne le fichier tel qu'on le voit à l'écran. Cette version est aussi rangée dans `Retouche - <date>` (voir ci-dessous) : une nouvelle version remplace la précédente au lieu de s'ajouter. La photo affiche alors « ☁ dans Retouche ».
- **Valider et ranger dans Retouche** remplit `Retouche - <date>` avec la version finale de toutes les photos et vidéos de la session, et retire ce qui n'est plus final (photo retirée du plan, ancienne version).

Une fois la session validée, **« ⬇ Télécharger le zip »** donne directement ces fichiers en un zip (`<Établissement> - Retouche - <date>.zip`), sans passer par le Drive. Le lien « ⬇ zip » est aussi disponible dans la liste des sessions.

« **Repartir des originaux pour retoucher** » ouvre une nouvelle session sur le dossier des originaux, jamais sur `Retouche - <date>`. Pour la même raison, les dossiers `Retouche - …` n'apparaissent pas dans la liste de choix du dossier.

---

## Rangement dans le Drive

Le code est dans `rangement.js`, identique à l'outil CX.

```
Établissements/                          ← PARENT_FOLDER_ID
└── 37824 - Barrel Pub/                  ← dossier établissement
    ├── Social media/                    ← originaux récupérés par lien (créé si absent)
    │   ├── instagram_Dcy4eVxN-EE_01.jpg
    │   ├── instagram_Dcy4eVxN-EE_02.mp4
    │   └── Retouche - 26 octobre 2026/
    │       ├── instagram_Dcy4eVxN-EE_01_recadrage.png   ← la photo, recadrée
    │       └── instagram_Dcy4eVxN-EE_02.mp4             ← la vidéo
    └── Shooting/                        ← mode « Un dossier Drive »
        ├── photo_01.jpg
        ├── photo_02.jpg
        └── Retouche - 26 octobre 2026/
            ├── photo_01_colorimetrie.jpg  ← photo retouchée : seulement sa retouche
            └── photo_02.jpg               ← photo non retouchée : son original
```

Règles :

- **`Retouche - <date>`** est toujours un sous-dossier **du dossier où se trouve l'original**. La date est celle de la retouche (téléchargement ou validation), à l'heure de Paris.
- Il contient **une seule version par photo, la version finale** : sa retouche si elle en a une, son original sinon. Les vidéos y sont copiées telles quelles. Si une photo a plusieurs variantes retouchées, chaque variante y figure.
- Une retouche est nommée `<nom de la photo>_<retouche>.<ext>`, par exemple `_recadrage`, `_colorimetrie` ou le nom du prompt. Un original garde son nom.
- `Social media` est retrouvé sans tenir compte des majuscules ni des accents. Les anciens dossiers de la v1 (`<Nom>_social media`, `<dossier>_retouches`) ne sont plus utilisés et ne sont pas touchés.
- **Pas de doublon :** une photo identique déjà présente dans le dossier est reconnue et n'est pas recopiée. Un fichier différent qui porte le même nom est renommé `_2`, `_3`…
- Un problème Drive ne bloque jamais un téléchargement : l'erreur s'affiche sur la photo, et la validation réessaie.

Le compte de service Google doit être **éditeur** sur le grand dossier des établissements, pour créer les dossiers et y déposer les fichiers.

---

## Déploiement

Railway construit l'image avec le `Dockerfile` : Node 22, plus Python pour `gallery-dl` et `yt-dlp` avec `curl-cffi` (import par liens, dont TikTok) et `ffmpeg` (assemblage image + son des vidéos).

Pour publier une nouvelle version :

1. Sur GitHub, à la racine du dépôt : « Add file » → « Upload files ».
2. Déposer les fichiers modifiés eux-mêmes, pas un dossier qui les contient.
3. « Commit changes ». Railway redéploie automatiquement.
4. Vérifier le numéro de version affiché en haut à droite de l'outil (constante `VERSION` dans `index.html`).

Un volume Railway doit être monté sur `DATA_DIR` (`/data` par défaut). Il contient les plans de travail et les fichiers des imports.

### Mot de passe du prestataire

Le mot de passe n'est jamais stocké en clair. Pour le définir ou le changer :

```
node hash-password.js "le-mot-de-passe-choisi"
```

Copier la valeur affichée dans la variable `APP_PASSWORD_HASH` sur Railway. Changer `APP_LOGIN` ou `SESSION_SECRET` déconnecte les sessions en cours.

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `APP_LOGIN` | Identifiant du compte prestataire. |
| `APP_PASSWORD_HASH` | Empreinte du mot de passe (voir ci-dessus). |
| `SESSION_SECRET` | Signature du cookie de connexion. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Clé du compte de service Google (Drive). |
| `PARENT_FOLDER_ID` | Grand dossier Drive des établissements. |
| `FLORA_API_KEY`, `FLORA_WORKSPACE_ID`, `FLORA_PROJECT_ID` | Retouches IA. |
| `FLORA_RESOLUTION` | Résolution des sorties IA (`2K` par défaut). |
| `NOTION_PUBLIC_PAGE` | Base Notion dédiée des prompts ABL, publiée sur le web. À défaut, `NOTION_API_KEY` + `NOTION_STYLES_DB_ID`. |
| `INSTAGRAM_COOKIES_TXT` | Cookies Instagram, pour les posts qui exigent une connexion. |
| `DATA_DIR` | Dossier du volume (`/data` par défaut). |
| `CONCURRENCY` | Retouches IA en parallèle (4 par défaut). |
| `MAX_RENDER_PER_PHOTO` | Nombre maximum de retouches IA par photo (6 par défaut). |
| `MAX_SESSION_COST` | Plafond de coût FLORA par session, 0 = pas de plafond. |

---

## Organisation du code

| Fichier | Rôle |
|---|---|
| `server.js` | Routes HTTP : connexion, établissements, import, retouches, réglages, téléchargement, zip, validation. |
| `index.html` | Toute l'interface (écran d'import, plan de travail, vue de réglage). |
| `workplan.js` | Orchestration d'une session : import, prompts, réglages, validation. |
| `rangement.js` | Rangement automatique dans le Drive (originaux et `Retouche - <date>`). |
| `store.js` | Sauvegarde des plans de travail (un JSON par session dans `DATA_DIR`). |
| `assets.js` | Stockage des fichiers pendant le travail (Drive `_travail` ou volume). |
| `drive.js` | Accès Google Drive (recherche d'établissement, dossiers, envoi de fichiers). |
| `renderPhoto.js`, `flora.js` | Exécution d'un prompt IA (en 2K), ou du recadrage. |
| `transforms.js`, `adjust.js` | Recadrage vitrine et colorimétrie. `adjust.js` est aussi utilisé par le navigateur pour l'aperçu, ce qui garantit un résultat identique. |
| `links.js`, `social.js` | Import par liens (`gallery-dl`, `yt-dlp`). |
| `notion.js`, `notionPublic.js`, `styleSource.js`, `builtinStyles.js` | Liste des prompts (Notion, plus le recadrage intégré). |
| `models.js` | Modèle IA (Nano Banana Pro uniquement). |
| `auth.js`, `hash-password.js`, `config.js` | Connexion par identifiant et mot de passe, et configuration. |

---

## Historique

- **v2 — alignement sur l'outil CX (v21.1).** Corrections : la colorimétrie ne fait plus échouer la validation sur les JPEG et crée une vraie nouvelle image, téléchargée et livrée ; vidéos Instagram récupérées avec le son ; vidéos TikTok fonctionnelles ; noms de fichiers accentués ; plus de fichiers en double. Images IA demandées en 2K. Nouveautés : établissement obligatoire dès l'étape 1 avec recherche par nom ou ID et création du dossier si besoin ; sélecteur de sous-dossiers en mode Drive ; rangement automatique (`Social media`, `Retouche - <date>` avec uniquement les versions finales) ; recadrage automatique des photos récupérées par lien ; bouton « Télécharger le zip » ; plus de prompt dans la vue de réglage ; plus d'ajout de fichiers dans un dossier de shooting.
- **v1 — outil ABL.** Première version, issue de l'outil CX v14 : connexion par identifiant et mot de passe, import par dossier Drive ou par liens, 5 prompts dédiés, Nano Banana Pro fixé, coût masqué, livraison dans `<dossier>_retouches` ou `<Nom>_social media`.
