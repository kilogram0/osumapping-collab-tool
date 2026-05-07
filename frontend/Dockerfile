# Multi-stage Dockerfile for osu-modding-frontend
# TODO: pin to digest before production (see security audit M6)

# --- Development target ---
FROM node:20.14-alpine AS dev

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm install

COPY --chown=node:node . .
USER node

EXPOSE 5173

CMD ["npm", "run", "dev"]

# --- Production target ---
FROM node:20.14-alpine AS builder

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm install

COPY --chown=node:node . .
USER node
RUN npm run build

FROM nginx:1.27-alpine AS prod

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
RUN chown -R nginx:nginx /usr/share/nginx/html
USER nginx

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
