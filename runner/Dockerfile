FROM node:20-bookworm AS base

ARG PYTHON_VERSION=""
ARG POWERSHELL_VERSION=""

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        apt-transport-https \
        ca-certificates \
        curl \
        gnupg2 \
        less \
        tar \
        unzip \
        wget; \
    if [ -n "$PYTHON_VERSION" ]; then \
        apt-get install -y --no-install-recommends python${PYTHON_VERSION}; \
        if apt-cache show python${PYTHON_VERSION}-venv > /dev/null 2>&1; then \
            apt-get install -y --no-install-recommends python${PYTHON_VERSION}-venv; \
        fi; \
        if apt-cache show python${PYTHON_VERSION}-distutils > /dev/null 2>&1; then \
            apt-get install -y --no-install-recommends python${PYTHON_VERSION}-distutils; \
        fi; \
        update-alternatives --install /usr/bin/python3 python3 /usr/bin/python${PYTHON_VERSION} 1; \
    else \
        apt-get install -y --no-install-recommends \
            python3 \
            python3-distutils \
            python3-pip \
            python3-venv; \
    fi; \
    if [ -z "$POWERSHELL_VERSION" ]; then \
        wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb; \
        dpkg -i packages-microsoft-prod.deb; \
        rm packages-microsoft-prod.deb; \
        apt-get update; \
        apt-get install -y --no-install-recommends powershell; \
    else \
        apt-get install -y --no-install-recommends \
            libc6 \
            libgcc-s1 \
            libgssapi-krb5-2 \
            libicu72 \
            libstdc++6 \
            zlib1g; \
        POWERSHELL_TGZ="powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz"; \
        curl -sSL "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/${POWERSHELL_TGZ}" -o /tmp/${POWERSHELL_TGZ}; \
        mkdir -p /opt/microsoft/powershell/${POWERSHELL_VERSION}; \
        tar -xf /tmp/${POWERSHELL_TGZ} -C /opt/microsoft/powershell/${POWERSHELL_VERSION}; \
        ln -sf /opt/microsoft/powershell/${POWERSHELL_VERSION}/pwsh /usr/bin/pwsh; \
        rm /tmp/${POWERSHELL_TGZ}; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY runner ./runner

RUN mkdir -p /app/state /app/scripts /app/script_workdir

ENV NODE_ENV=production \
    AUTOMN_RUNNER_VERSION=1

EXPOSE 3030

CMD ["node", "runner/service.js"]
