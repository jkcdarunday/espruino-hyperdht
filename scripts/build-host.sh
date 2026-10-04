#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
espr_dir="${ESPRUINO_DIR:-$project_dir/deps/espruino}"
hdht_dir="${HYPERDHT_DIR:-$project_dir/deps/hyperdht}"
python3 "$project_dir/scripts/configure.py" --host --espruino "$espr_dir" --hyperdht "$hdht_dir"
variant="native"
uv_args=()
uv_libs="-luv"
uv_includes=""
if [[ "${HYPERDHT_UV_SHIM:-0}" == 1 ]]; then
  variant="native-shim"
  cmake -S "$hdht_dir/components/libuv-esp32" -B "$project_dir/build/uv-shim" -DCMAKE_BUILD_TYPE=MinSizeRel
  cmake --build "$project_dir/build/uv-shim" --parallel 4
  uv_args=("-DUV_INCLUDE_DIR=$hdht_dir/components/libuv-esp32/include" "-DUV_LIBRARY=$project_dir/build/uv-shim/libuv.a")
  # Upstream CMake's desktop branch uses pkg-config unless explicit sodium is set.
  sodium_lib="${SODIUM_LIBRARY:-$(pkg-config --variable=libdir libsodium)/libsodium.a}"
  uv_args+=("-DSODIUM_LIBRARY=$sodium_lib" "-DSODIUM_INCLUDE_DIR=${SODIUM_INCLUDE_DIR:-$(pkg-config --variable=includedir libsodium)}")
  uv_libs="$project_dir/build/uv-shim/libuv.a"
  uv_includes="-I$hdht_dir/components/libuv-esp32/include"
fi
cmake -S "$hdht_dir" -B "$project_dir/build/$variant" -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DHYPERDHT_BUILD_TESTS=OFF -DHYPERDHT_EMBEDDED=ON -DHYPERDHT_SMALL_CLIENT=ON \
  -DCMAKE_C_FLAGS='-ffunction-sections -fdata-sections' \
  -DCMAKE_CXX_FLAGS='-ffunction-sections -fdata-sections' "$@" "${uv_args[@]}"
cmake --build "$project_dir/build/$variant" --parallel 4
if [[ "${HYPERDHT_MEMORY_AUDIT:-0}" == 1 ]]; then
  "${CXX:-c++}" -Os -c "$project_dir/test/memory/allocator.cpp" -o "$project_dir/build/memory-allocator.o"
  export HDHT_HOST_DEFINES="${HDHT_HOST_DEFINES:-} -DHDHT_MEMORY_AUDIT"
  audit_libs="$project_dir/build/memory-allocator.o -Wl,--wrap=malloc,--wrap=calloc,--wrap=realloc,--wrap=free"
  # Include sodium's internal allocations in the audit, not just its public calls.
  crypto_lib="${SODIUM_LIBRARY:-$(pkg-config --variable=libdir libsodium)/libsodium.a}"
else
  audit_libs=""
  crypto_lib="-lsodium"
fi
export HDHT_HOST_LIBS="${HDHT_HOST_LIBS:-$project_dir/build/$variant/libhyperdht.a $project_dir/build/$variant/libudx.a $uv_libs $crypto_lib $audit_libs -ldl -lrt}"
export HDHT_HOST_INCLUDES="$uv_includes ${HDHT_HOST_INCLUDES:-}"
# Switching libuv changes uv_loop_t's layout. Force the adapter to recompile.
touch "$espr_dir/libs/hyperdht/client.c"
make -C "$espr_dir" BOARD=LINUX_HYPERDHT RELEASE=1 SINGLETHREAD=1 -j4
mkdir -p "$project_dir/build"
cp "$espr_dir/bin/espruino" "$project_dir/build/espruino.new"
mv "$project_dir/build/espruino.new" "$project_dir/build/espruino"
# Link the behavioral query fixture against the same backend/adapter variant.
${CXX:-c++} -std=c++20 -Os -DHYPERDHT_EMBEDDED=1 -DHYPERDHT_SMALL_CLIENT=1 \
  -I"$hdht_dir/include" -I"$hdht_dir/deps/libudx/include" \
  $uv_includes "$project_dir/test/query-frontier.cpp" \
  $HDHT_HOST_LIBS -o "$project_dir/build/query-frontier"
