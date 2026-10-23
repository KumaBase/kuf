import type { Command } from "./types";

export interface CommandInfo {
  id: Command;
  label: string;
  group: string;
  description: string;
}

export const COMMAND_GROUPS = [
  "移動",
  "選択",
  "ファイル操作",
  "ペイン",
  "タブ",
  "ブックマーク / ドライブ",
  "リモート",
] as const;

export const COMMAND_CATALOG: CommandInfo[] = [
  { id: "cursor_up", label: "カーソル上", group: "移動", description: "1行上へ" },
  { id: "cursor_down", label: "カーソル下", group: "移動", description: "1行下へ" },
  { id: "cursor_top", label: "先頭へ", group: "移動", description: "一覧の先頭" },
  { id: "cursor_bottom", label: "末尾へ", group: "移動", description: "一覧の末尾" },
  { id: "cursor_page_up", label: "ページアップ", group: "移動", description: "1画面分上へ" },
  { id: "cursor_page_down", label: "ページダウン", group: "移動", description: "1画面分下へ" },
  { id: "enter", label: "開く / 入る", group: "移動", description: "フォルダに入る、またはファイルを開く" },
  { id: "parent_dir", label: "親フォルダ", group: "移動", description: "一つ上のフォルダへ" },
  { id: "go_root", label: "ルートへ", group: "移動", description: "ドライブ / 共有のルートへ" },
  { id: "history_back", label: "履歴を戻る", group: "移動", description: "前にいたフォルダへ" },
  { id: "history_forward", label: "履歴を進む", group: "移動", description: "戻る前のフォルダへ" },
  { id: "go_home", label: "ホームへ", group: "移動", description: "ホームディレクトリを開く" },
  { id: "goto_path", label: "パスへ移動", group: "移動", description: "入力したパスへジャンプ" },
  { id: "filter", label: "一覧を絞り込む", group: "移動", description: "部分一致・*・?でファイル名を絞り込む" },

  { id: "toggle_select", label: "選択切替", group: "選択", description: "カーソル位置の選択を切替" },
  { id: "select_all", label: "すべて選択", group: "選択", description: "表示中の項目をすべて選択" },
  { id: "clear_selection", label: "選択解除", group: "選択", description: "選択と検索をクリア" },
  { id: "invert_selection", label: "選択反転", group: "選択", description: "選択状態を反転" },
  { id: "select_same_ext", label: "同拡張子を選択", group: "選択", description: "カーソルと同じ拡張子を選択" },

  { id: "copy", label: "クリップボードへコピー", group: "ファイル操作", description: "貼り付け用にマーク" },
  { id: "move", label: "クリップボードへ切り取り", group: "ファイル操作", description: "移動用にマーク" },
  { id: "copy_to_other", label: "相手窓へコピー", group: "ファイル操作", description: "1件なら名前を変えてコピー可能" },
  { id: "move_to_other", label: "相手窓へ移動", group: "ファイル操作", description: "1件なら名前を変えて移動可能" },
  { id: "copy_as", label: "名前を変えてコピー", group: "ファイル操作", description: "相手窓へ、名前を指定してコピー" },
  { id: "move_as", label: "名前を変えて移動", group: "ファイル操作", description: "相手窓へ、名前を指定して移動" },
  { id: "delete", label: "削除", group: "ファイル操作", description: "ローカルはごみ箱へ移動、リモートは確認して完全削除" },
  { id: "rename", label: "リネーム", group: "ファイル操作", description: "カーソル位置の名前を変更" },
  { id: "new_folder", label: "新規フォルダ", group: "ファイル操作", description: "フォルダを作成" },
  { id: "new_file", label: "新規ファイル", group: "ファイル操作", description: "空のファイルを作成" },
  { id: "open_file", label: "関連付けで開く", group: "ファイル操作", description: "OSの関連アプリで開く" },
  { id: "open_in_editor", label: "エディタで開く", group: "ファイル操作", description: "設定したエディタで開く" },
  { id: "preview", label: "プレビュー", group: "ファイル操作", description: "内蔵ビューアで表示" },
  { id: "copy_path", label: "フルパスをコピー", group: "ファイル操作", description: "絶対パスをクリップボードへ" },
  { id: "copy_name", label: "名前をコピー", group: "ファイル操作", description: "ファイル名だけクリップボードへ" },
  { id: "open_terminal", label: "ターミナルを開く", group: "ファイル操作", description: "このフォルダで端末を起動" },
  { id: "refresh", label: "更新", group: "ファイル操作", description: "一覧を再読み込み" },

  { id: "switch_pane", label: "ペイン切替", group: "ペイン", description: "左右のアクティブを切替" },
  { id: "left_pane", label: "左ペイン", group: "ペイン", description: "左をアクティブに（←）" },
  { id: "right_pane", label: "右ペイン", group: "ペイン", description: "右をアクティブに（→）" },
  { id: "sync_to_other", label: "相手を同じ場所へ", group: "ペイン", description: "相手ペインをこのパスへ" },
  { id: "sync_from_other", label: "相手に合わせる", group: "ペイン", description: "このペインを相手のパスへ" },
  { id: "swap_panes", label: "左右を入れ替え", group: "ペイン", description: "左右の場所を交換" },

  { id: "tab_new", label: "新しいタブ", group: "タブ", description: "タブを追加" },
  { id: "tab_close", label: "タブを閉じる", group: "タブ", description: "現在のタブを閉じる" },
  { id: "tab_next", label: "次のタブ", group: "タブ", description: "右のタブへ" },
  { id: "tab_prev", label: "前のタブ", group: "タブ", description: "左のタブへ" },
  { id: "workspace_save", label: "作業セットを保存", group: "タブ", description: "左右の場所とタブ構成に名前を付けて保存" },
  { id: "workspace_list", label: "作業セットを開く", group: "タブ", description: "保存したタブ構成を復元" },

  { id: "bookmark_add", label: "ブックマーク追加", group: "ブックマーク / ドライブ", description: "現在地を登録" },
  { id: "bookmark_list", label: "ブックマーク一覧", group: "ブックマーク / ドライブ", description: "登録フォルダへジャンプ（J / ;）" },
  { id: "drive_list", label: "ドライブ一覧", group: "ブックマーク / ドライブ", description: "ドライブ / マウントを表示" },

  { id: "ssh_connect", label: "SSH 接続", group: "リモート", description: "接続ダイアログを開く" },
  { id: "ssh_disconnect", label: "SSH 切断", group: "リモート", description: "現在のリモート接続を切る" },
];

export const ALL_COMMANDS: Command[] = COMMAND_CATALOG.map((c) => c.id);

export function commandLabel(id: string): string {
  return COMMAND_CATALOG.find((c) => c.id === id)?.label ?? id;
}

export function formatKeyEvent(e: KeyboardEvent): string {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  parts.push(key);
  return parts.join("+");
}
