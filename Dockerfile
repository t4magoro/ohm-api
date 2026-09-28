FROM node:24-slim
# clang + lld compile C++ to WebAssembly; g++ runs the native C++ test with sanitizers.
# Debian's lld sometimes ships only "wasm-ld-<version>", so add the plain name if it's missing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates clang lld g++ \
 && rm -rf /var/lib/apt/lists/* \
 && (command -v wasm-ld || ln -s "$(ls /usr/bin/wasm-ld-* | sort -V | tail -n 1)" /usr/bin/wasm-ld)
WORKDIR /app