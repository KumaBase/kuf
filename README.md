# kuf

Dual-pane file manager built with Tauri 2.0 + SolidJS.

![version](https://img.shields.io/badge/version-0.1.0-blue)

## Requirements

- **Node.js** >= 18
- **Rust** >= 1.70 (install via [rustup](https://rustup.rs))
- **macOS** (primary target)

## Getting Started

```bash
# Install frontend dependencies
npm install

# Start dev server (hot reload)
npx tauri dev
```

## Build

```bash
# Production build (.app)
npx tauri build --bundles app

# Output:
#   macOS: src-tauri/target/release/bundle/macos/kuf.app
```

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

Config files are stored in `~/.config/kuf/`:

- `settings.toml` — Display, navigation, sort, editor settings
- `keybind.toml` — Custom key bindings
- `bookmarks.toml` — Saved bookmarks

## Tech Stack

- [Tauri 2.0](https://v2.tauri.app/) — Rust backend + system WebView
- [SolidJS](https://www.solidjs.com/) — Fine-grained reactive UI
- [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vitejs.dev/)
- [Rust](https://www.rust-lang.org/) with chrono, dirs, serde, toml
