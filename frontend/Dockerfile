# Multi-stage Dockerfile for osu-modding-frontend
# TODO: pin to digest before production (see security audit M6)

# --- Development target ---
FROM node:20.14-alpine AS dev

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm install
RUN chown -R node:node /app/node_modules

COPY --chown=node:node . .
USER node

EXPOSE 5173

CMD ["npm", "run", "dev"]

# --- Production target ---
FROM node:20.14-alpine AS builder

WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package*.json ./
RUN npm install
RUN chown -R node:node /app/node_modules

COPY --chown=node:node . .
USER node
RUN npm run build

FROM nginx:1.27-alpine AS prod

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp \
    && chown -R nginx:nginx /usr/share/nginx/html /tmp/nginx
USER nginx

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
