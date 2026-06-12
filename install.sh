#!/bin/sh
# vidEdit installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/dikmri/vidEdit/main/install.sh | sh

set -e

API_URL="https://api.github.com/repos/dikmri/vidEdit/releases/latest"

echo "Fetching latest release info..."
release_json=$(curl -fsSL -H "User-Agent: vidEdit-installer" "$API_URL")

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
    # macOS: download universal .app.tar.gz
    download_url=$(echo "$release_json" | grep -o '"browser_download_url": "[^"]*\.app\.tar\.gz"' | head -1 | cut -d'"' -f4)

    if [ -z "$download_url" ]; then
        echo "Error: Could not find .app.tar.gz in the latest release." >&2
        exit 1
    fi

    tmp_file="/tmp/vidEdit.app.tar.gz"
    echo "Downloading vidEdit for macOS..."
    curl -fsSL -o "$tmp_file" "$download_url"

    echo "Installing to /Applications..."
    tar -xzf "$tmp_file" -C /Applications/
    rm -f "$tmp_file"

    echo "vidEdit has been installed to /Applications."
    echo "Note: FFmpeg is required but not bundled. Install with:"
    echo "  brew install ffmpeg"

elif [ "$OS" = "Linux" ]; then
    # Linux: download .AppImage
    download_url=$(echo "$release_json" | grep -o '"browser_download_url": "[^"]*\.AppImage"' | head -1 | cut -d'"' -f4)

    if [ -z "$download_url" ]; then
        echo "Error: Could not find .AppImage in the latest release." >&2
        exit 1
    fi

    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"

    echo "Downloading vidEdit AppImage for Linux..."
    curl -fsSL -o "$install_dir/videdit" "$download_url"
    chmod +x "$install_dir/videdit"

    # Create .desktop entry
    desktop_dir="$HOME/.local/share/applications"
    mkdir -p "$desktop_dir"
    cat > "$desktop_dir/videdit.desktop" << EOF
[Desktop Entry]
Name=vidEdit
Comment=Lightweight video editor
Exec=$install_dir/videdit
Icon=videdit
Terminal=false
Type=Application
Categories=AudioVideo;Video;
EOF

    echo "vidEdit has been installed to $install_dir/videdit"
    echo "Make sure $install_dir is in your PATH."
    echo "Note: FFmpeg is required but not bundled. Install with:"
    echo "  sudo apt install ffmpeg   # Debian/Ubuntu"
    echo "  sudo dnf install ffmpeg   # Fedora"

else
    echo "Unsupported OS: $OS" >&2
    exit 1
fi
