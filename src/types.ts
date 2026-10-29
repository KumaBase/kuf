export interface FileInfo {
  name: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  modified_timestamp?: number | null;
  extension: string;
  is_hidden: boolean;
  is_symlink: boolean;
  permissions: string;
}

export interface HistoryEntry {
  path: string;
  cursorIndex: number;
  cursorName?: string;
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

export type SortKey = "name" | "extension" | "size" | "modified";
export type SortOrder = "asc" | "desc";
export interface SortSpec { key: SortKey; order: SortOrder; }

export interface TabSnapshot {
  id: string;
  left: PaneState;
  right: PaneState;
  activeSide: Side;
}

export interface WorkspaceSnapshot {
  tabs: { left_path: string; right_path: string; active_side: Side; left_sort?: SortSpec; right_sort?: SortSpec }[];
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
  | "command_palette"
  | "settings"
  | "toggle_hidden"
  | "open_config_dir"
  | "paste"
  | "tab_duplicate"
  | "history_list"
  | "select_pattern"
  | "select_files"
  | "select_directories"
  | "select_range_up"
  | "select_range_down"
  | "select_range_top"
  | "select_range_bottom"
  | "select_range_page_up"
  | "select_range_page_down"
  | "compare_panes"
  | "search_files"
  | "zip_create"
  | "zip_extract"
  | "bulk_rename"
  | "external_commands"
  | "toggle_select_up"
  | "quit"
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
  | "sort"
  | "sort_name"
  | "sort_extension"
  | "sort_size"
  | "sort_modified"
  | "sort_reverse"
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

function usesWindowsSeparators(path: string): boolean {
  return isWindowsLocalPath(path) || (!path.startsWith("/") && path.includes("\\"));
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
  if (usesWindowsSeparators(base)) {
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
  if (usesWindowsSeparators(path)) {
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
  if (usesWindowsSeparators(path)) {
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
  const windows = usesWindowsSeparators(path);
  const normalized = windows ? path.replace(/[\\/]+$/, "") : path.replace(/\/+$/, "");
  const lastSlash = windows ? Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\")) : normalized.lastIndexOf("/");
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

export function sortFiles(files: FileInfo[], dirsFirst: boolean, caseSensitive: boolean, sort: SortSpec = { key: "name", order: "asc" }): FileInfo[] {
  const fold = (value: string) => caseSensitive ? value : value.toLowerCase();
  const extensionKey = (file: FileInfo) => {
    if (!file.extension) return "";
    if (!caseSensitive) return file.extension.toLowerCase();
    // The native extension field is lowercase; recover its original spelling.
    const dot = file.name.lastIndexOf(".");
    return dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1) : "";
  };
  const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
  const modifiedTime = (file: FileInfo): number | null => {
    // Only older payloads omit this field. Explicit null means unavailable.
    if (file.modified_timestamp !== undefined) {
      return file.modified_timestamp !== null && Number.isFinite(file.modified_timestamp) ? file.modified_timestamp : null;
    }
    if (!file.modified || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(file.modified)) return null;
    const value = Date.parse(`${file.modified.replace(" ", "T")}:00`);
    return Number.isFinite(value) ? value : null;
  };
  const direction = sort.order === "desc" ? -1 : 1;
  const parent = files.filter((f) => f.name === "..");
  const rest = files.filter((f) => f.name !== "..").map((file) => ({
    file, name: fold(file.name), extension: extensionKey(file),
    modified: sort.key === "modified" ? modifiedTime(file) : null,
  }));
  rest.sort((a, b) => {
    if (dirsFirst && a.file.is_dir !== b.file.is_dir) return a.file.is_dir ? -1 : 1;
    let result = 0;
    switch (sort.key) {
      case "extension": result = compare(a.extension, b.extension); break;
      case "size": result = compare(a.file.size, b.file.size); break;
      case "modified":
        // Missing timestamps remain last in either direction.
        if (a.modified === null && b.modified !== null) return 1;
        if (b.modified === null && a.modified !== null) return -1;
        result = compare(a.modified ?? 0, b.modified ?? 0);
        break;
    }
    return direction * (result || compare(a.name, b.name));
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
