# GPT 桌宠

193 个透明动作（待机、手势互动、礼仪致意、情绪反应、运动健身、武术格斗、龙族特性等）。 由 [hunmer/aboutme-pets](https://github.com/hunmer/aboutme-pets) 的 193 张透明 WebP 精灵图逐帧转码而来，保留原始帧数、时序与透明通道。

<!-- upstream-commit: d5a117c4264ca48786faacfec16e558e64625fbf -->

<p align="center">
  <img src="preview/preview.gif" width="240" alt="GPT 桌宠 预览">
</p>

## 导入

在支持 GitHub 视频宠物导入的 DSH 宿主（[DSH Tauri](https://github.com/dsh-tauri/deepseek-harness-desktop)）中：

```text
https://github.com/hairyf/dsh-pet-gpt
```

或把本仓库整体放进 `<DSH_HOME>/pets/dsh-pet-gpt/`。

## 目录结构

```text
dsh-pet-gpt/
├── pet.json              # 宿主清单：id、显示名、webm/mov 目录、尺寸
├── config.jsonc          # 动作配置：motions、clicks、分类与工作状态事件
├── convert.mjs           # 转码与校验入口（同步、预览、校验）
├── webm/                 # 193 个 VP9-alpha WebM（Windows / Linux 播放）
├── mov/                  # 193 个 HEVC-alpha MOV（macOS / WKWebView 播放）
├── preview/
│   ├── preview.gif       # 方形透明 GIF 预览（由待机动画生成）
│   └── idle.png          # 待机首帧透明 PNG
└── scripts/              # 素材库、动作映射与 macOS 编码/校验脚本
```

## 动作配置

- `motions`：`idle`、`turn`、`moving-left`、`moving-right`、`dragging`、`waiting` 六个固定槽位。
- `animations.clicks`：单击宠物时随机播放的 189 个动作（待机、移动、拖拽等固定槽位动作与待机重复项除外）。
- `animations.categories`：按上游分类分组，全部 193 个动作都可点击播放。
- `animations.events.workStatus`：保持上游六档顺序（思考、工作、结果、等待、完成、失败），每档三选一的动作池。

改动作映射请编辑 `scripts/lib/pools.mjs` 后重新运行 `node convert.mjs sync`，`config.jsonc` 是生成产物。

## 本地重建

需要 Node.js 20+ 与 FFmpeg（含 `libvpx-vp9`）：

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/hunmer/aboutme-pets .upstream
git -C .upstream sparse-checkout set pets/gpt
node convert.mjs sync      # 重新生成 webm/、pet.json、config.jsonc
node convert.mjs preview   # 重新生成 preview/preview.gif
node convert.mjs verify    # 校验帧数、时长、透明通道与引用完整性
```

macOS 的 HEVC-alpha MOV 只能由 AVAssetWriter 产出，需在 macOS 上编译上游固定提交的编码器：

```sh
python3 scripts/build-mov.py self-check
ENCODER=/path/to/hevc-alpha-encoder python3 scripts/build-mov.py run
ALPHA_VERIFIER=/path/to/verify-alpha python3 scripts/verify-mov.py
```

Windows 上只能生成 WebM；`mov/` 由 CI 在 macOS runner 上补齐。

## 自动同步

`.github/workflows/sync-upstream.yml` 每周一 03:17 UTC 运行，也可在 Actions 页面手动触发（可勾选 `force` 全量重编码）：

1. 稀疏 clone `hunmer/aboutme-pets` 的 `pets/gpt`；
2. 重新转码 `webm/`、生成 `pet.json`、`config.jsonc` 与方形预览 GIF；
3. 在 macOS runner 上编译固定提交的 HEVC-alpha 编码器并生成 `mov/`；
4. 用 AVFoundation 逐帧校验每个 MOV 的透明通道，校验通过后自动提交。

上游新增或改名的动作会自动进入点击池；已在 `scripts/lib/pools.mjs` 中按名称引用的槽位若被上游移除，会自动回落到待机动作而不是生成坏引用。

## 许可

素材来自 [hunmer/aboutme-pets](https://github.com/hunmer/aboutme-pets)，上游约定**禁止商用**，二创在公开渠道须署名上游仓库。脚本代码为 MIT。
