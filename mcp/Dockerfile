FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY client.mjs server.mjs index.mjs ./
USER node
ENTRYPOINT ["node", "/app/index.mjs"]
