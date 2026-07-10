# syntax=docker/dockerfile:1
#
# Crate landing page — self-contained static image. Bakes the site + nginx
# config into a stock nginx:alpine so it can be pushed to a registry (GHCR)
# and pulled anywhere. For TrueNAS you can skip this and bind-mount the site
# folder instead (see DEPLOY.md); this image is the portable alternative.

FROM nginx:1.27-alpine

# Server block (keeps the base image's gzip + mime defaults).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static assets. .dockerignore keeps .DS_Store and the docker files out.
COPY index.html /usr/share/nginx/html/index.html
COPY screenshots /usr/share/nginx/html/screenshots

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
