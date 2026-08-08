# version-extractor HTTP API
# Playwright 官方镜像自带 Node + Chromium 及其系统依赖
# 另装 Python + Trafilatura（changelog 正文清洗）
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Python + Trafilatura（changelog 正文清洗）；noble 为 PEP 668 需要 --break-system-packages
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages trafilatura

# 先复制依赖清单，利用 Docker 缓存层
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

ENV PORT=3000
ENV BENCH_CACHE_DIR=/app/.http-cache
# Playwright noble 镜像锁 Node 22，node:sqlite 需要 --experimental-sqlite flag
ENV NODE_OPTIONS=--experimental-sqlite
EXPOSE 3000

# 浏览器常驻服务，无需 closeBrowser
CMD ["npx", "tsx", "src/server.ts"]
