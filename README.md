# kuf

Dual-pane file manager built with Tauri 2.0 + SolidJS.

![version](https://img.shields.io/badge/version-0.1.0-blue)

## Requirements

- **Node.js** >= 18
- **Rust** >= 1.70 (install via [rustup](https://rustup.rs))
- **System WebView** (ships with the OS on all platforms)

### Platform-specific

| Platform | Additional requirements |
|----------|------------------------|
| macOS    | Xcode Command Line Tools (`xcode-select --install`) |
| Windows  | [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |
| Linux    | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` |

<details>
<summary>Linux dependency install commands</summary>

```bash
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel

# Arch
sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg
```
</details>

## Getting Started

```bash
# Install frontend dependencies
npm install

# Start dev server (hot reload)
npx tauri dev
```

## Build

```bash
npx tauri build
```

| Platform | Output |
|----------|--------|
| macOS    | `src-tauri/target/release/bundle/macos/kuf.app` |
| Windows  | `src-tauri/target/release/bundle/msi/kuf_0.1.0_x64_en-US.msi` |
| Linux    | `src-tauri/target/release/bundle/deb/kuf_0.1.0_amd64.deb` |

## Type Check

```bash
# TypeScript
npx tsc --noEmit

# Rust
cargo check --manifest-path src-tauri/Cargo.toml
```

## Project Structure

```
kuf/
├── src/                  # SolidJS frontend
│   ├── components/       # UI components
│   ├── app.tsx           # Root component
│   ├── app.css           # Styles
│   ├── state.ts          # State management & keybinds
│   └── types.ts          # TypeScript types
├── src-tauri/            # Rust backend
│   ├── src/
│   │   ├── lib.rs        # Tauri commands (file ops)
│   │   └── config.rs     # Settings & keybind persistence
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

## Key Bindings

| Key         | Action            |
|-------------|-------------------|
| Enter       | Preview / Open dir|
| Backspace   | Parent directory  |
| Tab         | Switch pane       |
| F2          | Rename            |
| F5          | Copy              |
| F6          | Move              |
| F7          | New folder        |
| F8 / Delete | Delete            |
| Space       | Toggle select     |
| Ctrl+A      | Select all        |
| Ctrl+R      | Refresh           |
| Ctrl+D      | Add bookmark      |
| Alt+←/→     | History back/fwd  |
| Ctrl+T/W    | New/Close tab     |
| Escape      | Clear selection   |

Keybindings can be customized from Settings (Ctrl+,) > Keymap.

## Configuration

Config files are stored in the platform-specific config directory:

| Platform | Path |
|----------|------|
| macOS / Linux | `~/.config/kuf/` |
| Windows | `%APPDATA%\kuf\` |

- `settings.toml` — Display, navigation, sort, editor settings
- `keybind.toml` — Custom key bindings
- `bookmarks.toml` — Saved bookmarks

## Tech Stack

- [Tauri 2.0](https://v2.tauri.app/) — Rust backend + system WebView
- [SolidJS](https://www.solidjs.com/) — Fine-grained reactive UI
- [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vitejs.dev/)
- [Rust](https://www.rust-lang.org/) with chrono, dirs, serde, toml
