#!/usr/bin/env sh
# dsh-plugin-socket — macOS / Linux 一行安装
set -e
repo="https://github.com/ssszzz7/dsh-plugin-socket.git"
dest="${DSH_SOCKET_HOME:-$HOME/dsh-plugin-socket}"
bin="${DSH_SOCKET_BIN:-$HOME/.local/bin}"

command -v node >/dev/null 2>&1 || { echo "node not found, install Node.js 18+ first"; exit 1; }

if [ -d "$dest/.git" ]; then
  echo "[1/3] updating $dest"
  git -C "$dest" pull --ff-only
else
  echo "[1/3] cloning into $dest"
  git clone --depth 1 "$repo" "$dest"
fi

echo "[2/3] writing launcher into $bin"
mkdir -p "$bin"
printf '#!/usr/bin/env sh\nexec node "%s/bin/dsh-plugin.js" "$@"\n' "$dest" > "$bin/dsh-plugin"
chmod +x "$bin/dsh-plugin"

echo "[3/3] smoke test"
"$bin/dsh-plugin" --help | head -n 2
echo ""
echo "done. if $bin is not in PATH, add it:"
echo "  export PATH=\"$bin:\$PATH\""
