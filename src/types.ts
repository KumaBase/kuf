export interface FileInfo {
  name: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  extension: string;
  is_hidden: boolean;
  is_symlink: boolean;
}

export interface HistoryEntry {
  path: string;
  cursorIndex: number;
}

export interface PaneState {
  path: string;
  files: FileInfo[];
  cursorIndex: number;
  selectedIndices: number[];
  history: HistoryEntry[];
  historyIndex: number;
}

export type Side = "left" | "right";

export interface TabSnapshot {
  id: string;
  left: PaneState;
  right: PaneState;
  activeSide: Side;
}

export interface DisplaySettings {
  font_size: number;
  row_height: number;
  show_hidden: boolean;
  theme: string;
}

export interface NavigationSettings {
  left_dir: string;
  right_dir: string;
}

export interface SortSettings {
  dirs_first: boolean;
  case_sensitive: boolean;
}

export interface AppSettings {
  display: DisplaySettings;
  navigation: NavigationSettings;
  sort: SortSettings;
  editor: string;
}

export type Command =
  | "cursor_up"
  | "cursor_down"
  | "cursor_top"
  | "cursor_bottom"
  | "cursor_page_up"
  | "cursor_page_down"
  | "enter"
  | "parent_dir"
  | "switch_pane"
  | "toggle_select"
  | "select_all"
  | "refresh"
  | "copy"
  | "move"
  | "delete"
  | "rename"
  | "new_folder"
  | "clear_selection"
  | "bookmark_add"
  | "bookmark_list"
  | "history_back"
  | "history_forward"
  | "left_pane"
  | "right_pane"
  | "sync_to_other"
  | "sync_from_other"
  | "copy_to_other"
  | "move_to_other"
  | "tab_new"
  | "tab_close"
  | "tab_next"
  | "tab_prev"
  | "open_file"
  | "open_in_editor"
  | "preview"
  | "ssh_connect"
  | "ssh_disconnect";

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0";
  const units = ["B", "K", "M", "G", "T"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i === 0) return `${bytes}`;
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)}${units[i]}`;
}

export function joinPath(base: string, name: string): string {
  if (isRemotePath(base)) {
    const parsed = parseRemotePath(base);
    if (!parsed) return base;
    const newPath = parsed.remotePath.endsWith("/")
      ? parsed.remotePath + name
      : parsed.remotePath + "/" + name;
    return buildRemotePath(parsed.host, parsed.user, parsed.port, newPath);
  }
  if (base.endsWith("/")) return base + name;
  return base + "/" + name;
}

export function parentPath(path: string): string {
  if (isRemotePath(path)) {
    const parsed = parseRemotePath(path);
    if (!parsed) return path;
    const normalized = parsed.remotePath.replace(/\/+$/, "");
    if (normalized === "" || normalized === "/") return path;
    const lastSlash = normalized.lastIndexOf("/");
    const newRemote = lastSlash <= 0 ? "/" : normalized.substring(0, lastSlash);
    return buildRemotePath(parsed.host, parsed.user, parsed.port, newRemote);
  }
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return normalized.substring(0, lastSlash);
}

export function pathLabel(path: string): string {
  if (!path) return "...";
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return normalized.substring(lastSlash + 1);
}

// --- Remote path utilities ---

export interface SshHost {
  alias: string;
  host_name: string | null;
  user: string | null;
  port: number;
  identity_file: string | null;
}

export function isRemotePath(path: string): boolean {
  return path.startsWith("sftp://");
}

export function parseRemotePath(path: string): {
  host: string;
  user: string;
  port: number;
  remotePath: string;
} | null {
  if (!isRemotePath(path)) return null;
  // sftp://user@host:port/path
  const rest = path.slice(7); // remove "sftp://"
  const slashIdx = rest.indexOf("/");
  const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  const remotePath = slashIdx >= 0 ? rest.slice(slashIdx) : "/";

  let user = "";
  let hostPort = authority;
  const atIdx = authority.indexOf("@");
  if (atIdx >= 0) {
    user = authority.slice(0, atIdx);
    hostPort = authority.slice(atIdx + 1);
  }

  let host = hostPort;
  let port = 22;
  const colonIdx = hostPort.lastIndexOf(":");
  if (colonIdx >= 0) {
    const parsed = parseInt(hostPort.slice(colonIdx + 1), 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
      host = hostPort.slice(0, colonIdx);
    }
  }

  return { host, user, port, remotePath };
}

export function buildRemotePath(
  host: string,
  user: string,
  port: number,
  remotePath: string
): string {
  const portSuffix = port !== 22 ? `:${port}` : "";
  return `sftp://${user}@${host}${portSuffix}${remotePath}`;
}

export function remotePathHost(path: string): string | null {
  const parsed = parseRemotePath(path);
  return parsed?.host ?? null;
}

export function remotePathOnly(path: string): string {
  const parsed = parseRemotePath(path);
  return parsed?.remotePath ?? path;
}
