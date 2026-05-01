#!/usr/bin/env bash
# Build whisper.cpp with Metal support and copy whisper-cli into resources/bin/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache/whisper.cpp"
OUT_BIN="$ROOT/resources/bin/whisper-cli"

if [ -x "$OUT_BIN" ] && [ -x "$ROOT/resources/bin/whisper-server" ]; then
  echo "whisper-cli + whisper-server already built — skipping."
  echo "Delete them to force a rebuild."
  exit 0
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake not found. Install with: brew install cmake" >&2
  exit 1
fi

mkdir -p "$ROOT/resources/bin" "$(dirname "$CACHE")"

if [ ! -d "$CACHE" ]; then
  echo "Cloning whisper.cpp…"
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$CACHE"
else
  echo "Updating whisper.cpp…"
  (cd "$CACHE" && git pull --ff-only || true)
fi

echo "Building with Metal…"
cmake -S "$CACHE" -B "$CACHE/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build "$CACHE/build" -j --config Release --target whisper-cli whisper-server

# Locate the built binaries
for name in whisper-cli whisper-server; do
  BUILT=""
  for cand in \
      "$CACHE/build/bin/$name" \
      "$CACHE/build/$name" \
      "$CACHE/build/Release/$name"; do
    if [ -x "$cand" ]; then BUILT="$cand"; break; fi
  done
  if [ -z "$BUILT" ]; then
    echo "Built $name not found." >&2
    exit 1
  fi
  cp "$BUILT" "$ROOT/resources/bin/$name"
  chmod +x "$ROOT/resources/bin/$name"
  install_name_tool -add_rpath "@executable_path" "$ROOT/resources/bin/$name" 2>/dev/null || true
done

# Copy all dylibs (preserving symlinks) and metallib so the binary can find
# them via @rpath when run from resources/bin/.
while IFS= read -r lib; do
  cp -P "$lib" "$ROOT/resources/bin/"
done < <(find "$CACHE/build" -type f -name '*.dylib' -o -type l -name '*.dylib' -o -name '*.metallib')

# Re-point binary rpath to its own directory so it finds the dylibs there.
# Ignore "would duplicate path" — recent whisper.cpp already sets it.
install_name_tool -add_rpath "@executable_path" "$OUT_BIN" 2>/dev/null || true

echo "Done. whisper-cli installed at: $OUT_BIN"
