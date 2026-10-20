FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && VITE_SAME_ORIGIN=true pnpm build
RUN pnpm --filter pomelo-chat-server deploy --legacy --prod /runtime
RUN cp -r server/dist /runtime/dist

FROM node:24-bookworm-slim AS server
ENV NODE_ENV=production PORT=3000 TZ=Asia/Shanghai UPLOAD_ROOT=/data/uploads
WORKDIR /app
COPY --from=build /runtime /app
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/chat/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

FROM nginx:1.28-alpine AS web
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
