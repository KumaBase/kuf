import { createSignal, For, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { SshHost } from "../types";

interface ConnectDialogProps {
  onClose: () => void;
  onConnected: (host: string, user: string, port: number, path: string) => void;
}

export default function ConnectDialog(props: ConnectDialogProps) {
  const [hosts, setHosts] = createSignal<SshHost[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [connecting, setConnecting] = createSignal(false);
  const [manualMode, setManualMode] = createSignal(false);

  // Manual entry fields
  const [manualHost, setManualHost] = createSignal("");
  const [manualUser, setManualUser] = createSignal("");
  const [manualPort, setManualPort] = createSignal(22);
  const [manualPath, setManualPath] = createSignal("/");

  // Password auth
  const [showPassword, setShowPassword] = createSignal(false);
  const [password, setPassword] = createSignal("");

  // Host key confirmation (TOFU)
  const [hostKeyInfo, setHostKeyInfo] = createSignal<{
    keyType: string;
    fingerprint: string;
    host: string;
    port: number;
    user: string | null;
    initialPath: string;
  } | null>(null);

  onMount(async () => {
    try {
      const list = await invoke<SshHost[]>("ssh_list_hosts");
      setHosts(list);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  });

  async function doConnect(
    host: string,
    user: string | null,
    port: number,
    initialPath: string
  ) {
    setConnecting(true);
    setError("");
    setHostKeyInfo(null);

    try {
      const auth = showPassword()
        ? { Password: { password: password() } }
        : "Default";

      await invoke("ssh_connect", {
        host,
        port,
        user: user || null,
        auth: auth === "Default" ? null : auth,
      });

      // Try to resolve home directory for initial path
      let resolvedPath = initialPath;
      if (initialPath === "~" || initialPath === "") {
        try {
          const files = await invoke<
            { name: string; is_dir: boolean }[]
          >("ssh_read_dir", { host, port, path: "/" });
          resolvedPath = "/";
        } catch {
          resolvedPath = "/";
        }
      }

      const effectiveUser = user;
      if (!effectiveUser) {
        setError("Username is required. Set User in ssh config or enter manually.");
        setConnecting(false);
        return;
      }
      props.onConnected(host, effectiveUser, port, resolvedPath);
      props.onClose();
    } catch (e) {
      const msg = String(e);
      // Check for unknown host key — offer TOFU acceptance
      if (msg.startsWith("[UNKNOWN_HOST_KEY]")) {
        const parts = msg.slice("[UNKNOWN_HOST_KEY]".length).split("\n");
        const keyType = parts[0] || "unknown";
        const fingerprint = parts[1] || "";
        const hostPort = (parts[2] || "").split(":");
        const keyHost = hostPort[0] || host;
        const keyPort = parseInt(hostPort[1]) || port;
        setHostKeyInfo({ keyType, fingerprint, host: keyHost, port: keyPort, user, initialPath });
        setConnecting(false);
        return;
      }
      setError(msg);
    }
    setConnecting(false);
  }

  async function acceptHostKey() {
    const info = hostKeyInfo();
    if (!info) return;
    setConnecting(true);
    setError("");
    try {
      await invoke("ssh_accept_host", {
        host: info.host,
        port: info.port,
        user: info.user,
      });
      // Retry connection after accepting
      setHostKeyInfo(null);
      await doConnect(info.host, info.user, info.port, info.initialPath);
    } catch (e) {
      setError(String(e));
      setConnecting(false);
    }
  }

  function rejectHostKey() {
    setHostKeyInfo(null);
    setError("Host key rejected by user.");
  }

  function connectSelected() {
    const idx = selectedIndex();
    const list = hosts();
    if (idx < 0 || idx >= list.length) return;
    const h = list[idx];
    const user = h.user;
    if (!user) {
      setError(`No User set for ${h.alias}. Add User to ~/.ssh/config or use Manual tab.`);
      return;
    }
    const initialPath = `~`;
    doConnect(h.alias, user, h.port, initialPath);
  }

  function connectManual() {
    const h = manualHost();
    if (!h) {
      setError("Host is required");
      return;
    }
    doConnect(h, manualUser() || null, manualPort(), manualPath());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const list = hosts();
      setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (manualMode()) {
        connectManual();
      } else {
        connectSelected();
      }
    }
  }

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div
        class="connect-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div class="connect-header">
          <span class="connect-title">Connect to Server</span>
          <div class="connect-tabs">
            <button
              class={`connect-tab ${!manualMode() ? "active" : ""}`}
              onClick={() => setManualMode(false)}
            >
              SSH Config
            </button>
            <button
              class={`connect-tab ${manualMode() ? "active" : ""}`}
              onClick={() => setManualMode(true)}
            >
              Manual
            </button>
          </div>
        </div>

        <Show when={!manualMode()}>
          <div class="connect-body">
            <Show when={loading()}>
              <div class="connect-loading">Loading hosts...</div>
            </Show>
            <Show when={!loading() && hosts().length === 0}>
              <div class="connect-empty">
                No hosts found in ~/.ssh/config
              </div>
            </Show>
            <For each={hosts()}>
              {(host, i) => (
                <div
                  class={`connect-host-row ${selectedIndex() === i() ? "selected" : ""}`}
                  onClick={() => setSelectedIndex(i())}
                  onDblClick={() => {
                    setSelectedIndex(i());
                    connectSelected();
                  }}
                >
                  <span class="connect-host-alias">{host.alias}</span>
                  <span class="connect-host-info">
                    {host.user && `${host.user}@`}
                    {host.host_name || host.alias}:{host.port}
                  </span>
                  <Show when={host.identity_file}>
                    <span class="connect-host-key" title={host.identity_file!}>
                      key
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={manualMode()}>
          <div class="connect-manual">
            <label class="connect-field">
              <span class="connect-label">Host</span>
              <input
                class="connect-input"
                type="text"
                value={manualHost()}
                onInput={(e) => setManualHost(e.currentTarget.value)}
                placeholder="example.com"
              />
            </label>
            <label class="connect-field">
              <span class="connect-label">User</span>
              <input
                class="connect-input"
                type="text"
                value={manualUser()}
                onInput={(e) => setManualUser(e.currentTarget.value)}
                placeholder="username"
              />
            </label>
            <label class="connect-field">
              <span class="connect-label">Port</span>
              <input
                class="connect-input"
                type="number"
                value={manualPort()}
                onInput={(e) =>
                  setManualPort(parseInt(e.currentTarget.value) || 22)
                }
              />
            </label>
            <label class="connect-field">
              <span class="connect-label">Path</span>
              <input
                class="connect-input"
                type="text"
                value={manualPath()}
                onInput={(e) => setManualPath(e.currentTarget.value)}
                placeholder="/"
              />
            </label>
          </div>
        </Show>

        <div class="connect-auth">
          <label class="connect-field-inline">
            <input
              type="checkbox"
              checked={showPassword()}
              onChange={(e) => setShowPassword(e.currentTarget.checked)}
            />
            <span>Use password authentication</span>
          </label>
          <Show when={showPassword()}>
            <input
              class="connect-input"
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              placeholder="Password"
              style={{ "margin-top": "4px" }}
            />
          </Show>
        </div>

        <Show when={hostKeyInfo()}>
          {(info) => (
            <div class="connect-hostkey-confirm">
              <div class="connect-hostkey-title">
                Unknown Host Key
              </div>
              <div class="connect-hostkey-detail">
                The server {info().host}:{info().port} is not in known_hosts.
              </div>
              <div class="connect-hostkey-detail">
                Key type: {info().keyType}
              </div>
              <div class="connect-hostkey-detail">
                Fingerprint: {info().fingerprint}
              </div>
              <div class="connect-hostkey-warning">
                Only accept if you trust this server.
              </div>
              <div class="connect-hostkey-actions">
                <button class="dialog-btn" onClick={rejectHostKey}>
                  Reject
                </button>
                <button class="dialog-btn btn-ok" onClick={acceptHostKey} disabled={connecting()}>
                  {connecting() ? "Accepting..." : "Accept & Connect"}
                </button>
              </div>
            </div>
          )}
        </Show>

        <Show when={error()}>
          <div class="connect-error">{error()}</div>
        </Show>

        <Show when={!hostKeyInfo()}>
          <div class="connect-footer">
            <button class="dialog-btn" onClick={props.onClose}>
              Cancel
            </button>
            <button
              class="dialog-btn btn-ok"
              onClick={() =>
                manualMode() ? connectManual() : connectSelected()
              }
              disabled={connecting()}
            >
              {connecting() ? "Connecting..." : "Connect"}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
