# 本地 fork 维护说明

本仓库是 `moyuanhua/dsh-feishu-plugin` 的 fork，`local` 分支承载上游没有的功能。
上游更新时**用 git merge 三方合并**，不是把改动重新加一遍。

## 仓库与远程

```
origin   → https://github.com/TIANXT97/dsh-feishu-plugin   (fork，可写)
upstream → https://github.com/moyuanhua/dsh-feishu-plugin  (只读)
分支      local（长期分支，按功能一个 commit）
```

## 我们相对上游多了什么

1. **推理强度**（`/effort`、模型卡强度入口）——上游从未实现。
2. **流式卡片引擎**（CardKit 卡片实体、打字机、自适应节流）——上游从未实现；
   本仓库原先只存在于压缩产物补丁中，现重建为源码模块。
3. **fry 风格卡片版式**（统一底部面板、思考与工具按步交错、页脚统计）。
4. **遗留卡片收尾**（进程重启后把卡住的「处理中」卡片标记为中断并保留内容）。

## 上游更新流程

```bash
git fetch upstream
git merge upstream/main      # 三方合并，保留历史；不要 rebase
npm test                     # 上游自带测试
node scripts/build.mjs       # esbuild 打 bundle
git push origin local
```

合并判定：

| 情况 | 结果 |
|---|---|
| 上游改的文件我们没碰 | 取上游新版 |
| 我们改的文件上游没碰 | 自动保留我们的改动 |
| 双方改了同一区域 | 冲突，人工解决（源码层可读） |

## 冲突面积最小化原则

能新建文件就不改上游文件。新增模块：

```
src/dsh/streaming.js    流式引擎（批量更新 / 自适应节流 / rollover）
src/feishu/cardkit.js   卡片实体（create / send / batch_update / close）
src/dsh/recovery.js     遗留卡片收尾
```

只在必要处接触上游文件，且保持改动块尽量小：

| 文件 | 我们的改动 |
|---|---|
| `src/cards.js` | `runCard` 内接入统一面板与固定答案元素 id |
| `src/dsh/runs.js` | `start` / `patch` / `finish` 调用流式引擎 |
| `src/state.js` | `liveCards` 持久化 |
| `src/app.js` | `/effort` 命令与卡片动作 |
| `src/commands.js` | 命令白名单 |
| `src/dsh/controller.js` | 目录携带 reasoning 元数据、强度切换方法 |

## 安装

| 阶段 | 方式 |
|---|---|
| 开发迭代 | `dsh plugin --profile web add file:/data/home/repos/dsh-feishu-plugin` |
| 日常使用 | `dsh plugin --profile web add github:TIANXT97/dsh-feishu-plugin#local` |
| 长期稳定 | 发布到自有 npm scope（复用 `.github/workflows/publish.yml`） |

`github:` 安装会跑 `prepare`（即 `npm run build`），需在 profile 的
`pnpm-workspace.yaml` 里把包名加入 `allowBuilds`。

## 版本号

fork 的 `version` 使用后缀区分：`0.5.21-local.1`，每次发布自增，
避免与上游版本混淆。

## 回滚

- 单个功能出问题：`git revert <sha>`；
- 整体不可用：`git checkout v0.5.21 && node scripts/build.mjs`；
- 运行版本核对：读 profile 里该包 `package.json` 的 `version`。

## 首次建仓的额外成本（一次性）

流式层原本只存在于压缩产物的补丁里，需要按 `src/dsh/streaming.js` +
`src/feishu/cardkit.js` 的形式重建为源码；重建时参考 fry-cards 的实现：
`card.batch_update` 批量 actions、按体积自适应节流、`print_frequency_ms: 15`。
