#!/usr/bin/env bash
set -e

# Frame Framework Packaging Script
# Creates distribution archives for Frame Framework

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_ROOT/dist"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse arguments
VERSION="${1:-1.0.0}"
TARGET="${2:-$(rustc -vV | grep host | cut -d' ' -f2)}"
PLATFORM_NAME="${3:-}"

if [ -z "$PLATFORM_NAME" ]; then
	case "$TARGET" in
		x86_64-unknown-linux-gnu)
			PLATFORM_NAME="linux-x86_64"
			;;
		aarch64-unknown-linux-gnu)
			PLATFORM_NAME="linux-aarch64"
			;;
		x86_64-apple-darwin)
			PLATFORM_NAME="macos-x86_64"
			;;
		aarch64-apple-darwin)
			PLATFORM_NAME="macos-aarch64"
			;;
		x86_64-pc-windows-msvc)
			PLATFORM_NAME="windows-x86_64"
			;;
		*)
			PLATFORM_NAME="unknown"
			;;
	esac
fi

log_info "Frame Framework Packaging Script"
log_info "================================"
log_info "Version: $VERSION"
log_info "Target: $TARGET"
log_info "Platform: $PLATFORM_NAME"
echo ""

# Check if binaries exist
BINARY_PATH="target/$TARGET/release/frame"
if [ ! -f "$BINARY_PATH" ]; then
	log_error "Frame binary not found at $BINARY_PATH"
	log_error "Run ./scripts/build-all.sh --target=$TARGET first"
	exit 1
fi

# Create dist directory
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Create package directory structure
PACKAGE_DIR="$DIST_DIR/frame-$VERSION"
mkdir -p "$PACKAGE_DIR"/{bin,lib,templates,docs}

log_info "Creating package structure..."

# Copy binary
if [[ "$TARGET" == *"windows"* ]]; then
	cp "target/$TARGET/release/frame.exe" "$PACKAGE_DIR/bin/"
	chmod +x "$PACKAGE_DIR/bin/frame.exe"
else
	cp "$BINARY_PATH" "$PACKAGE_DIR/bin/"
	chmod +x "$PACKAGE_DIR/bin/frame"
fi

# Copy WASM runtime components (if they exist)
WASM_DIR="target/wasm32-unknown-unknown/release"
if [ -d "$WASM_DIR" ]; then
	log_info "Copying WASM runtime components..."
	find "$WASM_DIR" -name "*.wasm" -exec cp {} "$PACKAGE_DIR/lib/" \;
fi

# Create templates placeholder
cat > "$PACKAGE_DIR/templates/README.txt" << 'EOF'
Frame Framework Templates

Project templates will be added in future releases.

For now, use:
  frame new <project-name>

To create a new Frame project with default structure.
EOF

# Copy documentation
log_info "Copying documentation..."
cp "$PROJECT_ROOT/README.md" "$PACKAGE_DIR/docs/" || true
cp "$PROJECT_ROOT/LICENSE" "$PACKAGE_DIR/docs/" || true
cp "$PROJECT_ROOT/CHANGELOG.md" "$PACKAGE_DIR/docs/" || true
cp "$PROJECT_ROOT/INSTALL.md" "$PACKAGE_DIR/docs/" || true

# Create README for package
cat > "$PACKAGE_DIR/README.txt" << EOF
Frame Framework v$VERSION

Full-stack WebAssembly framework for Clean Language

## Installation

### Unix/Linux/macOS (system-wide):
  sudo mv bin/frame /usr/local/bin/

### Unix/Linux/macOS (user-only):
  mkdir -p ~/.local/bin
  mv bin/frame ~/.local/bin/
  # Add to PATH if needed:
  echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc
  source ~/.bashrc

### Windows:
  Move bin\\frame.exe to a directory in your PATH
  (e.g., C:\\Windows\\System32\\)

## Verify Installation

  frame --version

## Quick Start

  # Create new project
  frame new my-app

  # Navigate to project
  cd my-app

  # Start development server
  frame serve

## Documentation

- README: docs/README.md
- Installation Guide: docs/INSTALL.md
- Changelog: docs/CHANGELOG.md

## Links

- Repository: https://github.com/Ivan-Pasco/cleen-framework-old
- Clean Language: https://github.com/Ivan-Pasco/clean-language-compiler-old
- Issues: https://github.com/Ivan-Pasco/cleen-framework-old/issues

## License

MIT License - See docs/LICENSE for details
EOF

# Create archive
log_info "Creating archive..."

cd "$DIST_DIR"

if [[ "$PLATFORM_NAME" == *"windows"* ]]; then
	# Create ZIP for Windows
	ARCHIVE_NAME="frame-$PLATFORM_NAME.zip"
	if command -v zip &> /dev/null; then
		zip -r "$ARCHIVE_NAME" "frame-$VERSION"
	else
		log_warning "zip command not found. Using tar instead."
		tar -czf "frame-$PLATFORM_NAME.tar.gz" "frame-$VERSION"
		ARCHIVE_NAME="frame-$PLATFORM_NAME.tar.gz"
	fi
else
	# Create tar.gz for Unix-like systems
	ARCHIVE_NAME="frame-$PLATFORM_NAME.tar.gz"
	tar -czf "$ARCHIVE_NAME" "frame-$VERSION"
fi

log_success "Archive created: $DIST_DIR/$ARCHIVE_NAME"

# Generate checksum
log_info "Generating checksum..."
if command -v shasum &> /dev/null; then
	shasum -a 256 "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
elif command -v sha256sum &> /dev/null; then
	sha256sum "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
else
	log_warning "sha256sum/shasum not found. Skipping checksum generation."
fi

# Show package details
echo ""
log_success "Packaging complete!"
log_info "Package details:"
log_info "  Archive: $DIST_DIR/$ARCHIVE_NAME"
log_info "  Size: $(du -h "$ARCHIVE_NAME" | cut -f1)"
if [ -f "$ARCHIVE_NAME.sha256" ]; then
	log_info "  Checksum: $ARCHIVE_NAME.sha256"
	echo ""
	log_info "Checksum:"
	cat "$ARCHIVE_NAME.sha256"
fi

echo ""
log_info "To test installation:"
log_info "  cd $DIST_DIR"
log_info "  tar -xzf $ARCHIVE_NAME"  # or unzip for Windows
log_info "  cd frame-$VERSION"
log_info "  ./bin/frame --version"
