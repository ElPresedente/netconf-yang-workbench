# Ubuntu 24.04 sets the supported glibc baseline to 2.39 (rather than the host's).
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential cmake pkg-config libpcre2-dev libxxhash-dev \
    python3 python3-dev python3-venv libffi-dev \
    libgtk-3-0t64 libnss3 libnspr4 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2t64 libsecret-1-0 libnotify4 \
    && rm -rf /var/lib/apt/lists/*
ARG LIBYANG_VERSION=6.4.13
RUN curl -fsSL "https://github.com/CESNET/libyang/archive/refs/tags/v${LIBYANG_VERSION}.tar.gz" -o /tmp/libyang.tar.gz \
    && mkdir /tmp/libyang && tar -xf /tmp/libyang.tar.gz -C /tmp/libyang --strip-components=1 \
    && cmake -S /tmp/libyang -B /tmp/libyang/build -DCMAKE_BUILD_TYPE=Release -DENABLE_TESTS=OFF \
    && cmake --build /tmp/libyang/build -j2 \
    && cmake --install /tmp/libyang/build && ldconfig
WORKDIR /src
COPY backend/pyproject.toml backend/pyproject.toml
COPY backend/netconf_backend backend/netconf_backend
RUN python3 -m venv /opt/backend-venv \
    && LIBYANG_EXTRA_CFLAGS="-D_GNU_SOURCE -include libyang/plugins.h" /opt/backend-venv/bin/pip install --no-cache-dir './backend[build]'
COPY packaging packaging
RUN /opt/backend-venv/bin/pyinstaller --noconfirm --distpath /bundle --workpath /tmp/pyinstaller packaging/backend.spec \
    && /bundle/netconf-backend/netconf-backend --self-test
ENTRYPOINT ["/opt/backend-venv/bin/python", "/src/packaging/export-bundle.py"]
