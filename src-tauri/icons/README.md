# アプリアイコン

`source.png` は、指定された「ファイル管理を見守るくまアイコン.png」の無変更コピーです。

- 元画像: 1254 × 1254 px、RGB PNG
- SHA-256: `eb3a68f487937d49601429620bc57a8cdbab4873ba503154393d850060c6b6b0`
- 変換ツール: Tauri CLI 2.10.1

プロジェクトのルートから、次のコマンドで各サイズの PNG、Windows の ICO、macOS の ICNS、Android / iOS 用アイコンを生成します。

```sh
npm run tauri -- icon src-tauri/icons/source.png --output src-tauri/icons
```

Tauri の設定は `icon.png`、`icon.ico`、`icon.icns` を参照しています。元画像のデザインと背景は変更していません。
