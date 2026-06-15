# --- Stage 1: build the SPA ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# --- Stage 2: serve static files via nginx ---
FROM nginx:alpine
# SPA site config (static + SPA fallback only, no /api proxy here)
COPY nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
