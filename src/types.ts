export interface FileInfo {
  name: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  extension: string;
  is_hidden: boolean;
  is_symlink: boolean;
  permissions: string;
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

export interface WorkspaceSnapshot {
  tabs: { left_path: string; right_path: string; active_side: Side }[];
  active_index: number;
}
export interface NamedWorkspace { name: string; snapshot: WorkspaceSnapshot; }
export interface WorkspaceData {
  version: number;
  last_session: WorkspaceSnapshot | null;
  workspaces: NamedWorkspace[];
}

export interface DisplaySettings {
  font_size: number;
  row_height: number;
  show_hidden: boolean;
  theme: string;
  columns: string[];
  rename_without_extension: boolean;
}

export interface NavigationSettings {
  left_dir: string;
  right_dir: string;
  restore_session?: boolean;
}

export interface SortSettings {
  dirs_first: boolean;
  case_sensitive: boolean;
}

export interface WindowSettings {
  mode: string; // "remember" | "fixed"
  width: number;
  height: number;
}

export interface AppSettings {
  display: DisplaySettings;
  navigation: NavigationSettings;
  sort: SortSettings;
  editor: string;
  window: WindowSettings;
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
  | "go_root"
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
  | "ssh_disconnect"
  | "drive_list"
  | "copy_as"
  | "move_as"
  | "goto_path"
  | "go_home"
  | "copy_path"
  | "copy_name"
  | "new_file"
  | "invert_selection"
  | "swap_panes"
  | "open_terminal"
  | "select_same_ext"
  | "filter"
  | "workspace_save"
  | "workspace_list";

export interface DriveInfo {
  name: string;
  path: string;
  total_bytes: number;
  available_bytes: number;
  drive_type: string;
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0";
  const units = ["B", "K", "M", "G", "T"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i === 0) return `${bytes}`;
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)}${units[i]}`;
}

function isWindowsLocalPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path) || path.startsWith("\\\\");
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
  if (isWindowsLocalPath(base) || base.includes("\\")) {
    const trimmed = base.replace(/[\\/]+$/, "");
    return `${trimmed}\\${name}`;
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
  if (isWindowsLocalPath(path) || path.includes("\\")) {
    const normalized = path.replace(/\//g, "\\").replace(/\\+$/, "");
    if (/^[A-Za-z]:$/.test(normalized)) return normalized + "\\";
    const lastSlash = normalized.lastIndexOf("\\");
    if (lastSlash <= 2 && /^[A-Za-z]:/.test(normalized)) {
      return normalized.slice(0, 2) + "\\";
    }
    if (normalized.startsWith("\\\\")) {
      const parts = normalized.split("\\").filter(Boolean);
      if (parts.length <= 2) return path;
      return "\\\\" + parts.slice(0, -1).join("\\");
    }
    if (lastSlash <= 0) return normalized;
    return normalized.substring(0, lastSlash);
  }
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return normalized.substring(0, lastSlash);
}

export function rootPath(path: string): string {
  if (isRemotePath(path)) {
    const parsed = parseRemotePath(path);
    if (!parsed) return path;
    return buildRemotePath(parsed.host, parsed.user, parsed.port, "/");
  }
  if (isWindowsLocalPath(path) || path.includes("\\")) {
    const normalized = path.replace(/\//g, "\\");
    if (normalized.startsWith("\\\\")) {
      const parts = normalized.split("\\").filter(Boolean);
      if (parts.length >= 2) return `\\\\${parts[0]}\\${parts[1]}`;
      return path;
    }
    const drive = normalized.match(/^([A-Za-z]:)/);
    if (drive) return `${drive[1]}\\`;
  }
  return "/";
}

export function baseName(path: string): string {
  if (isRemotePath(path)) {
    const parsed = parseRemotePath(path);
    const remote = (parsed?.remotePath ?? path).replace(/\/+$/, "");
    const lastSlash = remote.lastIndexOf("/");
    return lastSlash >= 0 ? remote.substring(lastSlash + 1) : remote;
  }
  const normalized = path.replace(/[\\/]+$/, "");
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

export function pathLabel(path: string): string {
  if (!path) return "...";
  if (isWindowsLocalPath(path)) {
    const normalized = path.replace(/\//g, "\\").replace(/\\+$/, "");
    if (/^[A-Za-z]:$/.test(normalized)) return normalized + "\\";
    const lastSlash = normalized.lastIndexOf("\\");
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
  }
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return normalized.substring(lastSlash + 1);
}

export function sortFiles(files: FileInfo[], dirsFirst: boolean, caseSensitive: boolean): FileInfo[] {
  const parent = files.filter((f) => f.name === "..");
  const rest = files.filter((f) => f.name !== "..").map((file) => ({
    file, key: caseSensitive ? file.name : file.name.toLowerCase(),
  }));
  rest.sort((a, b) => {
    if (dirsFirst && a.file.is_dir !== b.file.is_dir) return a.file.is_dir ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return [...parent, ...rest.map(({ file }) => file)];
}

// --- Remote path utilities ---

export interface ConnectedServer {
  alias: string;
  user: string;
  port: number;
}

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
