FROM node:20-alpine

# Définition du répertoire de travail dans le conteneur
WORKDIR /app

# Copie des fichiers de configuration package.json et package-lock.json
COPY package*.json ./

# Installation des dépendances sans les paquets dev (si nécessaire)
RUN npm install

# Copie du reste des fichiers de l'application
COPY . .

# Mettre en évidence le port utilisé
EXPOSE 3978

# Commande par défaut au démarrage
CMD ["npm", "start"]
