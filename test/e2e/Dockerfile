# One machine of a team: Node, git, Pi, and pi-lattice installed into Pi from the packed
# package, the way a person gets it. The server and each person's machine are containers of
# this image, each with its own filesystem, home, keys and network address.
FROM node:24-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates procps \
	&& rm -rf /var/lib/apt/lists/*

# No model, no network at start, nothing reported: the tests bring a scripted model.
ENV PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 TERM=xterm-256color LANG=C.UTF-8

ARG PI_VERSION
RUN npm install --global --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}"

# What Pi provides is left out, as Pi leaves it out when it installs an npm source.
COPY pi-lattice.tgz /tmp/pi-lattice.tgz
RUN npm install --global --no-audit --no-fund --legacy-peer-deps /tmp/pi-lattice.tgz

# Where the team's repositories are cloned from: a volume every machine mounts, as a git remote they all reach.
RUN mkdir -p /srv/git && chown node:node /srv/git

USER node
WORKDIR /home/node
RUN pi install "$(npm root --global)/pi-lattice" \
	&& git config --global init.defaultBranch main \
	&& git config --global user.email "$(whoami)@example.com" \
	&& git config --global user.name "$(whoami)" \
	&& git config --global --add safe.directory '*'

CMD ["sleep", "infinity"]
