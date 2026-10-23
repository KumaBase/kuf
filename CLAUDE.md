# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

kuf is a dual-pane file manager built with **SolidJS + TypeScript** (frontend) and **Rust via Tauri 2.0** (backend). It supports local filesystem operations and remote SFTP via SSH.

## Build & Development Commands

```bash
npx tauri dev                      # Start dev server with hot reload
npx tauri build                    # Production build
npx tsc --noEmit                   # TypeScript type checking
cargo check --manifest-path src-tauri/Cargo.toml  # Rust type checking
npm run build                      # Build frontend only (Vite)
```

`npm test` runs frontend state regression tests. `cargo test --manifest-path src-tauri/Cargo.toml --lib` runs Rust regression tests. `npm run bench` runs synthetic frontend benchmarks. See `docs/performance.md` for measurements, native smoke tests and limits. No linter is configured.

## Architecture

### Frontend (SolidJS) — `src/`

- **`app.tsx`** — Main application component: dual-pane layout, file operation handlers, keyboard routing, dialogs, workspace persistence and watch registration.
- **`state.ts`** — State management using SolidJS primitives (`createSignal`, `createStore`). `createTabState()` retains independent `createPaneState()` instances per tab; switching tabs must not serialize or copy file listings. Global state for keybinds, settings, clipboard, and search.
- **`types.ts`** — Shared TypeScript interfaces (`FileEntry`, `AppSettings`, `PaneState`, etc.).
- **`themes.ts`** — Theme definitions (Tokyo Night, Catppuccin, Nord, Solarized Dark, Gruvbox) applied via CSS custom properties.
- **`filter.ts`** — Prepared filename normalization, ranked fuzzy/AND matching, literal and wildcard modes, and original UTF-16 highlight positions. Hidden selections must never remain operation targets.
- **`migemo.ts`** — Loads the bundled dictionary once and caches bounded Romanized Japanese expansions. Keep filtering offline; retain the asset notices under `public/migemo/`.
- **`auto-refresh.ts`** — Coalesces filesystem invalidations and defers refresh during file operations or navigation.
- **`components/`** — UI components: `Pane`, `FileList`, `TabBar`, `StatusBar`, `Dialog`, `FileViewer`, `SettingsDialog`, `BookmarkDialog`, `ConnectDialog`.

### Backend (Rust/Tauri) — `src-tauri/src/`

- **`lib.rs`** — All `#[tauri::command]` handlers bridging frontend to Rust. Commands return `Result<T, String>`.
- **`background.rs`** — Blocking filesystem work runs on `spawn_blocking`, not the window thread or async workers.
- **`operation.rs`** — Operation identity, progress and cooperative cancellation between top-level items. Never interrupt a move between copying and deleting its current item.
- **`workspace.rs`** — Validated, versioned JSON storage with atomic replacement. Preserve corrupt or unsupported files. Snapshots contain paths and tab positions, not listings or credentials.
- **`watcher.rs`** — Nonrecursive OS watches for the two visible local paths and their parents; generation checks, debounce and missing-directory recovery.
- **`trash.rs`** — User-requested local deletion uses OS recycling with no permanent-delete fallback. Internal move cleanup stays in `LocalFs`; SFTP deletion remains separate.
- **`config.rs`** — TOML-based config persistence at `~/.config/kuf/` (settings.toml, keybind.toml, bookmarks.toml).
- **`fs/`** — `FileSystem` trait abstraction with `LocalFs` and `SftpFs` implementations. `transfer.rs` handles cross-filesystem copy/move.
- **`ssh/`** — SSH connection management: `ConnectionManager` (pooling), `config.rs` (parses `~/.ssh/config`), `known_hosts.rs` (host key utilities). Uses `russh`. Check the actual connection path before assuming host key utilities are wired in.

### Key Patterns

- **No external state library** — pure SolidJS fine-grained reactivity.
- **FileSystem trait** — plugin-style abstraction; add new backends by implementing the trait in `fs/`.
- **Props drilling** — callbacks passed down through component hierarchy (no context/store library).
- **Virtual scrolling** — used in `FileList` for large directories.
- **Keyboard-first design** — comprehensive keybind system with full customization support.

### Cross-boundary types

Frontend `types.ts` and Rust structs in `lib.rs`/`config.rs` must stay in sync. Tauri serializes with serde; the frontend consumes JSON.
