/** The local read-only search invoke/event contract, kept separate from pane data. */
export interface SearchResult {
  path: string;
  parent_path: string;
  name: string;
  is_dir: boolean;
  is_symlink: boolean;
}

export interface SearchRequest {
  search_id: string;
  root_path: string;
  query: string;
  include_files: boolean;
  include_directories: boolean;
  show_hidden: boolean;
  case_sensitive: boolean;
  max_results?: number;
}

export interface SearchProgress {
  search_id: string;
  visited: number;
  matched: number;
  skipped: number;
}

export interface SearchResponse {
  search_id: string;
  results: SearchResult[];
  visited: number;
  skipped: number;
  truncated: boolean;
  limit_reason: "results" | "visited" | "depth" | null;
  cancelled: boolean;
  elapsed_ms: number;
}
