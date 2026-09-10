# 多人协同大纲 —— 单镜像部署
# Node 20 + better-sqlite3（有官方 prebuilt 二进制，无需编译工具链）
FROM node:20-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/app.db \
    LOCK_TTL_MS=30000

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 再拷业务代码
COPY server ./server
COPY public ./public

# SQLite 数据持久化到挂载卷（node 用户可写）
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
