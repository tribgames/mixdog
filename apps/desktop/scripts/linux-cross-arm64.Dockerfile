# The image .github/workflows/mixdogd-build.yml cross-builds the arm64 Linux programs in on an x86_64 machine: the
# manylinux_2_28 cross image (a glibc 2.28 arm64 sysroot, binutils and libgcc for the target) with a current C compiler in
# front of it. The base image's own compiler is GCC 7.5; the C code the programs carry (SQLite, zstd, ring, pcre2, libwebp)
# is compiled by clang against the same sysroot, and the base's GCC still drives the link.
FROM ghcr.io/rust-cross/manylinux_2_28-cross@sha256:ca53fa07ecf1c3e6408c51fbca64c036d9d29af832d3f8bb954910e89097f275
ARG LLVM=20
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gnupg \
	&& curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] https://apt.llvm.org/jammy/ llvm-toolchain-jammy-${LLVM} main" > /etc/apt/sources.list.d/llvm.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends clang-${LLVM} \
	&& rm -rf /var/lib/apt/lists/*
# The cc crate passes clang the target itself; the sysroot and the GCC installation (crt files, libgcc) are the base's.
ENV CC_aarch64_unknown_linux_gnu=clang-${LLVM} \
	CXX_aarch64_unknown_linux_gnu=clang++-${LLVM} \
	CFLAGS_aarch64_unknown_linux_gnu="--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot --gcc-toolchain=/usr/aarch64-unknown-linux-gnu" \
	CXXFLAGS_aarch64_unknown_linux_gnu="--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot --gcc-toolchain=/usr/aarch64-unknown-linux-gnu"
