# Score Studio — piano audio/MIDI -> editable score. CPU-only image (linux/amd64).
#   docker build -t score-studio:1.1.0 .
# DuET (code + weights) and Transkun are downloaded during the build; nothing model-related lives in the repo.

# ---------------------------------------------------------------- web UI
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/index.html web/tsconfig.json web/vite.config.mjs ./
COPY web/scripts ./scripts
COPY web/public ./public
COPY web/src ./src
RUN npm run build

# ---------------------------------------------------------------- backend
FROM python:3.12-slim-bookworm
LABEL org.opencontainers.image.title="Score Studio" \
      org.opencontainers.image.description="Piano audio/MIDI to an editable score (Transkun v2 + DuET), with MCP for AI agents" \
      org.opencontainers.image.version="1.1.0" \
      org.opencontainers.image.licenses="MIT code; DuET weights CC BY-NC 4.0 (non-commercial)"

ARG TORCH_VERSION=2.11.0
ARG DUET_REVISION=27e1ed4d66c5e36fdc656517317ffeb65e6fc58e
ARG DUET_COMMIT=6ac226b28206512eadd15be49579f04e00550759

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# CPU wheels: the CUDA build would add several GB. (GPU users: run natively, see README.)
RUN pip install torch==${TORCH_VERSION} torchaudio==${TORCH_VERSION} --index-url https://download.pytorch.org/whl/cpu

WORKDIR /app
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install "duet-score @ https://github.com/wei-zeng98/DuET/archive/${DUET_COMMIT}.tar.gz" \
    && pip install --no-deps transkun==2.0.1 \
    && pip install -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt

# Bake the pinned DuET release into the image so the container never needs Hugging Face at runtime.
ENV HF_HOME=/opt/hf
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('Wayne42/DuET', revision='${DUET_REVISION}')" \
    && chmod -R a+rX /opt/hf

COPY backend /app/backend
COPY --from=web /web/dist /app/web/dist
COPY docker/entrypoint.sh /usr/local/bin/score-studio-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/score-studio-entrypoint \
    && chmod 755 /usr/local/bin/score-studio-entrypoint \
    && chmod -R a+rX /app \
    && python -m compileall -q /app/backend \
    && mkdir -p /data /exports

ENV PORT=19287 \
    SCORE_STUDIO_DATA=/data \
    SCORE_STUDIO_IMPORT=/import \
    SCORE_STUDIO_EXPORT=/exports \
    SCORE_STUDIO_DOCKER=1 \
    SCORE_STUDIO_PERF_PRESET=balanced \
    SCORE_STUDIO_DUET_REVISION=${DUET_REVISION} \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    MPLCONFIGDIR=/tmp/mpl \
    XDG_CACHE_HOME=/tmp/cache \
    TORCHINDUCTOR_CACHE_DIR=/tmp/cache/torchinductor \
    USER=scorestudio \
    LOGNAME=scorestudio \
    PYTHONIOENCODING=utf-8 \
    PUID=1000 \
    PGID=1000

VOLUME ["/data", "/exports"]
EXPOSE 19287
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["python", "-c", "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','19287'), timeout=4).status == 200 else 1)"]
ENTRYPOINT ["tini", "--", "score-studio-entrypoint"]
