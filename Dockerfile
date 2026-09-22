# Joy Contenus — Node 22 + gallery-dl + yt-dlp
#
# Ce Dockerfile est OBLIGATOIRE : gallery-dl et yt-dlp sont des programmes
# Python, et le détecteur automatique de Railway (Railpack) ne voit qu'un
# projet Node grâce à package.json. Il n'installerait jamais Python, et
# l'import par liens échouerait au premier appel.
#
# Railway prend automatiquement ce fichier à la place de Railpack dès qu'il le
# trouve à la racine du dépôt.

FROM node:22-slim

# gallery-dl s'installe via pip (les releases GitHub n'ont plus de binaire
# standalone). ffmpeg est nécessaire à yt-dlp pour fusionner les pistes vidéo
# et audio quand la plateforme les sert séparément, ce qui est le cas courant.
# curl sert au chemin de téléchargement de repli quand le CDN Instagram refuse
# les requêtes de Node.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip curl ffmpeg \
    && pip3 install --no-cache-dir --break-system-packages gallery-dl yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Les dépendances d'abord : cette couche est mise en cache tant que
# package.json et package-lock.json ne changent pas.
#
# npm ci exige un package-lock.json présent dans le dépôt et cohérent avec
# package.json. Le repli sur npm install évite un échec de build si le lockfile
# manque, mais il ne devrait pas servir : un build reproductible passe par le
# lockfile, et son absence est une anomalie à corriger dans le dépôt.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund     || (echo ">>> package-lock.json absent ou desynchronise, repli sur npm install"         && npm install --omit=dev --no-audit --no-fund)

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
