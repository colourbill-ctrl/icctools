# syntax=docker/dockerfile:1
###############################################################
# icctools - validator service
#
# Stage 1: Build IccProfLib (static) from iccDEV source
# Stage 2: Build our iccprofiledump C++ tool against it
# Stage 3: Node.js runtime — only the binary + server needed
#
# Build context must be the parent directory (contains both
# iccdev/ and icctools/) so that iccdev/ can be COPYed in.
#
#   docker build -f icctools/validator/Dockerfile -t icctools-validator ..
###############################################################

# ── Stage 1: Build IccProfLib (static only, no tools/XML/JSON) ──────────────
FROM debian:bookworm AS iccproflib-builder
ENV DEBIAN_FRONTEND=noninteractive

# libxml2 / tiff / png / jpeg are required by iccDEV's top-level CMakeLists
# even when ENABLE_ICCXML and ENABLE_TOOLS are OFF (unconditional find_package).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    build-essential cmake make \
    libxml2-dev \
    libtiff-dev libjpeg-dev libpng-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

COPY iccdev/ /opt/iccdev/

RUN cd /opt/iccdev/Build \
 && cmake \
      -DCMAKE_BUILD_TYPE=Release \
      -DENABLE_SHARED_LIBS=OFF \
      -DENABLE_STATIC_LIBS=ON \
      -DENABLE_TOOLS=OFF \
      -DENABLE_WXWIDGETS=OFF \
      -DENABLE_ICCXML=OFF \
      -DENABLE_ICCJSON=OFF \
      Cmake \
 && make -j"$(nproc)" IccProfLib2-static \
 && echo "=== IccProfLib static library ===" \
 && ls -lh /opt/iccdev/Build/IccProfLib/libIccProfLib2-static.a


# ── Stage 2: Build iccprofiledump ────────────────────────────────────────────
FROM debian:bookworm AS tool-builder
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    build-essential cmake make \
    nlohmann-json3-dev \
 && rm -rf /var/lib/apt/lists/*

# IccProfLib headers + static lib from stage 1
COPY --from=iccproflib-builder /opt/iccdev/IccProfLib/          /opt/iccdev/IccProfLib/
COPY --from=iccproflib-builder /opt/iccdev/Build/IccProfLib/    /opt/iccdev/Build/IccProfLib/

# Our tool source
COPY icctools/validator-tool/ /build/

RUN cmake -S /build -B /build/out \
      -DCMAKE_BUILD_TYPE=Release \
      -DICCDEV_ROOT=/opt/iccdev \
 && cmake --build /build/out --parallel \
 && echo "=== Built binary ===" \
 && ls -lh /build/out/iccprofiledump


# ── Stage 3: Node.js runtime ─────────────────────────────────────────────────
FROM node:20-slim

# Copy the self-contained binary (statically linked against IccProfLib;
# only system libc/libstdc++ needed, which node:20-slim already provides).
COPY --from=tool-builder /build/out/iccprofiledump /usr/local/bin/iccprofiledump

WORKDIR /app
COPY icctools/validator/package.json ./
RUN npm install --omit=dev

COPY icctools/validator/server.js ./

ENV ICC_VALIDATOR_PATH=iccprofiledump
ENV VALIDATOR_PORT=3003
EXPOSE 3003

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://localhost:3003/health').then(r=>process.exit(r.ok?0:1))"

USER node
CMD ["node", "server.js"]
