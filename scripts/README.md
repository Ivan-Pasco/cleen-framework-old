# Frame Framework Build Scripts

This directory contains build and packaging scripts for Frame Framework.

## Scripts Overview

### `build-all.sh` (Unix/Linux/macOS)

Comprehensive build script that compiles Frame CLI and WASM runtime components.

**Usage:**
```bash
# Basic build (release mode)
./scripts/build-all.sh

# Debug build
./scripts/build-all.sh --debug

# Build for specific target
./scripts/build-all.sh --target x86_64-unknown-linux-gnu

# Build only CLI
./scripts/build-all.sh --cli-only

# Build only WASM components
./scripts/build-all.sh --wasm-only

# Verbose output
./scripts/build-all.sh --verbose

# Show help
./scripts/build-all.sh --help
```

**Features:**
- Builds Frame CLI binary
- Compiles WASM runtime components
- Optimizes WASM with `wasm-opt` (if available)
- Creates build manifest
- Cross-platform support

### `build-all.ps1` (Windows PowerShell)

Windows equivalent of `build-all.sh`.

**Usage:**
```powershell
# Basic build (release mode)
.\scripts\build-all.ps1

# Debug build
.\scripts\build-all.ps1 -Debug

# Build for specific target
.\scripts\build-all.ps1 -Target x86_64-pc-windows-msvc

# Build only CLI
.\scripts\build-all.ps1 -CliOnly

# Build only WASM components
.\scripts\build-all.ps1 -WasmOnly

# Verbose output
.\scripts\build-all.ps1 -Verbose

# Show help
.\scripts\build-all.ps1 -Help
```

### `package.sh` (Unix/Linux/macOS)

Creates distribution archives for Frame Framework releases.

**Usage:**
```bash
# Create package for current platform
./scripts/package.sh

# Create package with specific version
./scripts/package.sh 1.0.0

# Create package for specific target
./scripts/package.sh 1.0.0 x86_64-apple-darwin

# Create package with custom platform name
./scripts/package.sh 1.0.0 x86_64-apple-darwin macos-x86_64
```

**Output:**
- Creates `dist/` directory
- Packages Frame CLI binary
- Includes WASM runtime components
- Adds documentation (README, LICENSE, CHANGELOG)
- Generates SHA256 checksum
- Creates `.tar.gz` (Unix) or `.zip` (Windows) archive

**Package Structure:**
```
frame-1.0.0/
├── bin/
│   └── frame              # CLI binary
├── lib/
│   └── *.wasm             # Runtime WASM modules
├── templates/
│   └── README.txt         # Template placeholder
├── docs/
│   ├── README.md
│   ├── LICENSE
│   ├── CHANGELOG.md
│   └── INSTALL.md
└── README.txt             # Installation instructions
```

## Common Workflows

### Development Build

```bash
# Quick development build (debug mode)
./scripts/build-all.sh --debug

# Run Frame CLI
./target/debug/frame --version
```

### Release Build

```bash
# Full release build with optimizations
./scripts/build-all.sh

# Test the release binary
./target/release/frame --version
```

### Create Distribution Package

```bash
# Build for release
./scripts/build-all.sh

# Create distribution package
./scripts/package.sh 1.0.0

# Test installation from package
cd dist
tar -xzf frame-linux-x86_64.tar.gz
cd frame-1.0.0
./bin/frame --version
```

### Cross-Compilation Example

```bash
# Install cross-compilation toolchain (macOS example)
rustup target add aarch64-apple-darwin

# Build for ARM64 macOS
./scripts/build-all.sh --target aarch64-apple-darwin

# Package for ARM64 macOS
./scripts/package.sh 1.0.0 aarch64-apple-darwin macos-aarch64
```

### CI/CD Integration

These scripts are used by GitHub Actions workflows (`.github/workflows/release.yml`) for automated releases.

**Manual release test:**
```bash
# Simulate CI build process
for target in \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu \
  x86_64-apple-darwin \
  aarch64-apple-darwin
do
  ./scripts/build-all.sh --target $target
  ./scripts/package.sh 1.0.0 $target
done
```

## Prerequisites

### Required

- **Rust** 1.70 or higher (`rustup`, `cargo`)
- **Git** (for cloning and version management)

### Optional

- **wasm-opt** (from binaryen) - For WASM optimization
  - macOS: `brew install binaryen`
  - Ubuntu/Debian: `apt-get install binaryen`
  - Arch: `pacman -S binaryen`

- **Cross-compilation tools** (for building non-native targets)
  - Linux ARM64: `apt-get install gcc-aarch64-linux-gnu`
  - Windows from Linux: `apt-get install mingw-w64`

## Build Artifacts

### CLI Binary

**Location:** `target/<target>/release/frame[.exe]`

**Purpose:** Main Frame Framework CLI tool

**Size:** ~5-10 MB (release mode with optimization)

### WASM Runtime Components

**Location:** `target/wasm32-unknown-unknown/release/*.wasm`

**Components:**
- `host_bridge.wasm` - Host Bridge runtime module

**Size:** ~50-200 KB per module (after optimization)

### Build Manifest

**Location:** `build/manifest.json`

**Content:**
```json
{
  "version": "1.0.0",
  "build_type": "release",
  "target": "x86_64-apple-darwin",
  "built_at": "2025-01-15T12:34:56Z",
  "components": {
    "cli": {
      "path": "target/x86_64-apple-darwin/release/frame",
      "type": "binary"
    },
    "runtime": {
      "host_bridge": {
        "path": "target/wasm32-unknown-unknown/release/host_bridge.wasm",
        "type": "wasm"
      }
    }
  }
}
```

## Troubleshooting

### "Cargo not found"

**Problem:** Rust toolchain not installed

**Solution:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### "wasm32-unknown-unknown target not found"

**Problem:** WASM target not installed

**Solution:**
```bash
rustup target add wasm32-unknown-unknown
```

### "Cross-compilation failed"

**Problem:** Target toolchain or linker not available

**Solutions:**
```bash
# Install target
rustup target add <target-triple>

# Install cross-compilation tools (Linux example)
sudo apt-get install gcc-aarch64-linux-gnu  # For ARM64

# Or use cross tool
cargo install cross
cross build --target <target-triple>
```

### "Permission denied" (Unix/Linux)

**Problem:** Script not executable

**Solution:**
```bash
chmod +x scripts/*.sh
```

### WASM optimization fails

**Problem:** `wasm-opt` not found

**Solution:** Install binaryen (optional, optimization will be skipped)
```bash
# macOS
brew install binaryen

# Ubuntu/Debian
sudo apt-get install binaryen
```

## Performance Optimization

### Release Mode Features

- **LTO (Link-Time Optimization)**: Enabled in `Cargo.toml`
- **Code Generation Units**: Set to 1 for better optimization
- **Optimization Level**: `opt-level = 3`
- **WASM Optimization**: Uses `wasm-opt -Oz` for size reduction

### Build Time Optimization

- **Incremental Compilation**: Enabled for development builds
- **Parallel Compilation**: Uses all available CPU cores
- **Caching**: cargo caches dependencies automatically

**Tip:** Use `sccache` to cache compilation artifacts across builds:
```bash
cargo install sccache
export RUSTC_WRAPPER=sccache
./scripts/build-all.sh
```

## Contributing

When adding new build scripts:

1. Follow existing naming conventions
2. Add comprehensive help text (`--help`)
3. Include error handling and validation
4. Document in this README
5. Test on all supported platforms
6. Update CI/CD workflows if needed

## Support

For build issues:
- Check [GitHub Issues](https://github.com/Ivan-Pasco/cleen-framework-old/issues)
- Review [INSTALL.md](../INSTALL.md) for installation help
- Consult [CONTRIBUTING.md](../documents/CONTRIBUTING.md) for development guidelines
