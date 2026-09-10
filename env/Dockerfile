# syntax=docker/dockerfile:1

# ---------- 构建阶段：装全编译工具链，prebuilt 下不到时可现场编译 ----------
FROM node:20-slim AS build

# better-sqlite3 优先下载预编译二进制；下载失败时用这些包从源码编译
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先用 lockfile 做可复现安装（不存在时回退到 package.json）
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# ---------- 运行阶段：只带产物和运行时库，镜像小且无编译器 ----------
FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/app.db \
    LOCK_TTL_MS=30000

# better-sqlite3 的原生模块运行时需要 libstdc++
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY server ./server
COPY public ./public
COPY package.json ./package.json

# SQLite 数据持久化到挂载卷（node 用户可写）
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
