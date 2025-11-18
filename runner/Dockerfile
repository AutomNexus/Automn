FROM node:20-bookworm AS base

ARG PYTHON_VERSION=""
ARG POWERSHELL_VERSION=""

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    install_pwsh_tarball() { \
        local version="$1"; \
        local suffix="$2"; \
        local archive="powershell-${version}-${suffix}.tar.gz"; \
        if curl -fsSLo "/tmp/${archive}" "https://github.com/PowerShell/PowerShell/releases/download/v${version}/${archive}"; then \
            mkdir -p "/opt/microsoft/powershell/${version}"; \
            tar -xf "/tmp/${archive}" -C "/opt/microsoft/powershell/${version}"; \
            ln -sf "/opt/microsoft/powershell/${version}/pwsh" /usr/bin/pwsh; \
            rm "/tmp/${archive}"; \
            return 0; \
        fi; \
        return 1; \
    }; \
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
    DEFAULT_PWSH_VERSION="7.4.2"; \
    case "$arch" in \
        amd64) \
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
                install_pwsh_tarball "$POWERSHELL_VERSION" "linux-x64"; \
            fi; \
            ;; \
        arm64|armhf) \
            apt-get install -y --no-install-recommends \
                libc6 \
                libgcc-s1 \
                libgssapi-krb5-2 \
                libicu72 \
                libstdc++6 \
                zlib1g; \
            PWSH_VERSION="${POWERSHELL_VERSION:-${DEFAULT_PWSH_VERSION}}"; \
            if [ "$arch" = "arm64" ]; then \
                PWSH_SUFFIX="linux-arm64"; \
            else \
                PWSH_SUFFIX="linux-arm32"; \
            fi; \
            if ! install_pwsh_tarball "$PWSH_VERSION" "$PWSH_SUFFIX"; then \
                echo "PowerShell ${PWSH_VERSION} not available for ${arch}; skipping installation"; \
            fi; \
            ;; \
        *) \
            echo "PowerShell is not supported on architecture ${arch}; skipping installation"; \
            ;; \
    esac; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY runner ./runner

RUN mkdir -p /app/state /app/scripts /app/script_workdir

ENV NODE_ENV=production \
    AUTOMN_RUNNER_VERSION=0.2.01

EXPOSE 3030

CMD ["node", "runner/service.js"]
