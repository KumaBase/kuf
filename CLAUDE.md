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

There are no test suites or linters configured.

## Architecture

### Frontend (SolidJS) — `src/`

- **`app.tsx`** (~1030 lines) — Main application component: dual-pane layout, all file operation handlers, keyboard event routing, dialog management. This is the monolithic heart of the frontend.
- **`state.ts`** — State management using SolidJS primitives (`createSignal`, `createStore`). Exports `createPaneState()` factory for per-pane state (tabs, selection, cursor, history). Global state for keybinds, settings, clipboard, and search.
- **`types.ts`** — Shared TypeScript interfaces (`FileEntry`, `AppSettings`, `PaneState`, etc.).
- **`themes.ts`** — Theme definitions (Tokyo Night, Catppuccin, Nord, Solarized Dark, Gruvbox) applied via CSS custom properties.
- **`components/`** — UI components: `Pane`, `FileList`, `TabBar`, `StatusBar`, `Dialog`, `FileViewer`, `SettingsDialog`, `BookmarkDialog`, `ConnectDialog`.

### Backend (Rust/Tauri) — `src-tauri/src/`

- **`lib.rs`** — All `#[tauri::command]` handlers bridging frontend to Rust. Commands return `Result<T, String>`.
- **`config.rs`** — TOML-based config persistence at `~/.config/kuf/` (settings.toml, keybind.toml, bookmarks.toml).
- **`fs/`** — `FileSystem` trait abstraction with `LocalFs` and `SftpFs` implementations. `transfer.rs` handles cross-filesystem copy/move.
- **`ssh/`** — SSH connection management: `ConnectionManager` (pooling), `config.rs` (parses `~/.ssh/config`), `known_hosts.rs` (host key verification). Uses `ssh2` crate.

### Key Patterns

- **No external state library** — pure SolidJS fine-grained reactivity.
- **FileSystem trait** — plugin-style abstraction; add new backends by implementing the trait in `fs/`.
- **Props drilling** — callbacks passed down through component hierarchy (no context/store library).
- **Virtual scrolling** — used in `FileList` for large directories.
- **Keyboard-first design** — comprehensive keybind system with full customization support.

### Cross-boundary types

Frontend `types.ts` and Rust structs in `lib.rs`/`config.rs` must stay in sync. Tauri serializes with serde; the frontend consumes JSON.
