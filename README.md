# kuf

Dual-pane file manager built with Tauri 2.0 + SolidJS.

![version](https://img.shields.io/badge/version-0.2.1-blue)

## Requirements

- **Node.js** >= 18
- **Rust** stable (install via [rustup](https://rustup.rs); CI uses the stable toolchain)
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
| Windows  | `src-tauri/target/release/bundle/msi/kuf_0.2.1_x64_en-US.msi` |
| Linux    | `src-tauri/target/release/bundle/deb/kuf_0.2.1_amd64.deb` |

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
| F8 / Delete | Recycle locally / delete remotely |
| Space       | Toggle select     |
| Ctrl+A      | Select all        |
| Ctrl+R      | Refresh           |
| / or Ctrl+F | Filter the current pane by name |
| Ctrl+D      | Add bookmark      |
| Alt+←/→     | History back/fwd  |
| Ctrl+T/W    | New/Close tab     |
| Escape      | Clear filter, then selection |

Keybindings can be customized from Settings (Ctrl+,) > Keymap.

## Everyday use

- Filter with ranked fuzzy matching (`usrctrl` → `UserController.ts`), offline Migemo (`nihon` → `日本`), or multiple terms (`siryou pdf`). Matches are highlighted. Toggle **あいまい / 部分一致** for literal matching; wildcards (`*.txt`) retain their usual behavior. Enter returns to the list; Escape clears the filter. File operations target only visible items in the current folder.
- Use the **作業セット** menu to save and restore both panes and tabs by name. The previous session is restored on startup by default; this can be disabled in navigation settings.
- Visible local folders update automatically when files change. Refresh waits while file operations or navigation are running. SFTP uses manual refresh; network shares depend on OS notifications.
- Local Delete/F8 moves items to the OS trash. Windows supports fixed local drives and refuses unsupported locations without a permanent-delete fallback. Remote deletion remains permanent and requires confirmation.

See [使い方と検証結果](docs/usability.md) for details and limitations.

## Configuration

Config files are stored in the platform-specific config directory:

| Platform | Path |
|----------|------|
| macOS / Linux | `~/.config/kuf/` |
| Windows | `%APPDATA%\kuf\` |

- `settings.toml` — Display, navigation, sort, editor settings
- `keybind.toml` — Custom key bindings
- `bookmarks.toml` — Saved bookmarks
- `workspaces.json` — Named workspaces and the previous session (paths, tabs and active pane)

## Tech Stack

- [Tauri 2.0](https://v2.tauri.app/) — Rust backend + system WebView
- [SolidJS](https://www.solidjs.com/) — Fine-grained reactive UI
- [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vitejs.dev/)
- [Rust](https://www.rust-lang.org/) with chrono, dirs, serde, toml
