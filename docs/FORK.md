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
5. **工作区归属**（`controller.workspaceFor()`：把 `defaultDirectory` 解析或自动
   创建成 DSH 工作区，会话创建携带 `workspaceId`）——上游从未实现；
   让飞书会话在 Web 侧栏按工作区分组，而不是落进「未分组」。
   ⚠️ 2026-11-09 重建 0.5.21 时曾丢失该特性，所有新会话退回未分组，后回归移植。
6. **卡片序号单点所有**（`cardkit` 内每卡一个严格递增计数器）——上游从未实现；
   整卡更新与元素流式共用一张卡时不再各自从 0 发 `sequence=1`（根治飞书 300317
   与打字机首帧即失效）；计数持久化进 `state.json` liveCards，重启后 `adopt` 续号。

## 上游更新流程

```bash
git fetch upstream
git merge upstream/main      # 三方合并，保留历史；不要 rebase
npm test                     # 上游自带测试 + 本仓库回归测试
./scripts/check-carried.sh   # 携带特性自查（见下节），任何一项失败都必须人工处理
node scripts/build.mjs       # esbuild 打 bundle
git push origin local
./scripts/publish-dist.sh    # 重建并强制推送 dist 分支
```

### 上游更新后的携带特性自查（必做）

三方合并对「上游重写过的区域」不设防：合并可以零冲突通过，却把只在补丁层
或旧构建里存在的问题静默带回来。2026-11-09 同步 0.5.21 时就丢过工作区归属
（全部飞书会话退回「未分组」）。`scripts/check-carried.sh` 用 grep 钉住每个
必须存在的特性，任何一项缺失即非零退出：

| 检查 | 特性 |
|---|---|
| `src/dsh/controller.js` 含 `async workspaceFor` | 工作区归属 |
| `src/index.js` 的 inject 含 `workspaceRegistry` | 工作区归属的宿主服务注入 |
| `src/feishu/cardkit.js` 含 `function take(cardId)` | 卡片序号单点所有 |
| `npm test` 中 `sequence-monotonic` 通过 | 序号严格递增回归网 |

历史上踩过的同类坑（复查时对着验证）：

- **300317 双计数器**：整卡更新（`run.sequence`）与元素流式
  （`CardStream.sequence`）各自从 0 发 `sequence=1`，打字机首帧即被拒、
  卡片永久退化为整卡重发。修复见 `bc92121`；复现脚本
  `scripts/seq-repro.mjs <仓库根>`，退出码 0 = 健康。
- **300313 / 300309**：整卡 JSON 不带 `run_answer` 元素、或往已关流的卡写内容，
  与序号记账同族，修复序号后如复发按「单写者」思路排查。

## 冲突面积最小化原则

能新建文件就不改上游文件。新增模块：

```
src/dsh/streaming.js    流式引擎（批量更新 / 自适应节流 / rollover）
src/feishu/cardkit.js   卡片实体（create / send / batch_update / close / 每卡序号所有者）
src/dsh/recovery.js     遗留卡片收尾
```

只在必要处接触上游文件，且保持改动块尽量小：

| 文件 | 我们的改动 |
|---|---|
| `src/cards.js` | `runCard` 内接入统一面板与固定答案元素 id |
| `src/dsh/runs.js` | `start` / `patch` / `finish` 调用流式引擎；序号/持久化交由 cardkit+state |
| `src/state.js` | `liveCards` 持久化（含每卡 `sequence`，供重启恢复 `adopt` 续号） |
| `src/app.js` | `/effort` 命令与卡片动作 |
| `src/commands.js` | 命令白名单 |
| `src/dsh/controller.js` | 目录携带 reasoning 元数据、强度切换方法、工作区归属（`workspaceFor` + 创建会话携带 `workspaceId`） |

## 安装

| 阶段 | 方式 |
|---|---|
| 开发迭代 | `dsh plugin --profile web add file:/data/home/repos/dsh-feishu-plugin` |
| 日常使用 | profile 直接依赖 `github:TIANXT97/dsh-feishu-plugin#dist`（发布流见下节） |
| 长期稳定 | 发布到自有 npm scope（复用 `.github/workflows/publish.yml`） |

`github:` 装**源码分支**（例如 `#local`）会跑 `prepare`（即 `npm run build`），
需在 profile 的 `pnpm-workspace.yaml` 里把包名加入 `allowBuilds`；
`#dist` 分支没有 scripts，无此要求。

## 版本号

跟随上游基线、每次发 dist 自增 patch：`0.5.21` → `0.5.22`（当前），
`src/index.js` 的 `BUILD_TAG` 与 package.json 同步改动（BUILD_TAG 会进诊断
输出，便于线上线下对版本）。若要与上游同基线并行维护，再加 `-local.N`
后缀区分。

## 回滚

- 单个功能出问题：`git revert <sha>`；
- 整体不可用：`git checkout v0.5.21 && node scripts/build.mjs`；
- 运行版本核对：读 profile 里该包 `package.json` 的 `version`。

## 首次建仓的额外成本（一次性）

流式层原本只存在于压缩产物的补丁里，需要按 `src/dsh/streaming.js` +
`src/feishu/cardkit.js` 的形式重建为源码；重建时参考 fry-cards 的实现：
`card.batch_update` 批量 actions、按体积自适应节流、`print_frequency_ms: 15`。

## 发布：dist 分支

profile 安装的是 `github:TIANXT97/dsh-feishu-plugin#dist`。`dist` 是**只含构建产物**的
孤儿分支（`lib/` + package.json + locale 等，且 **没有 scripts**），因此安装时不需要
执行 prepare，也就不需要把包名写进 `allowBuilds`（那个键还会 pin 到具体 commit URL，
每次推送都会变）。

发布一条命令：

```bash
./scripts/publish-dist.sh     # 构建 → 组装 → 强制推送 dist
```

源码仍在 `local` 分支；`dist` 只由脚本生成，不要手工编辑。

### 装新版（重要）

`#dist` 是分支引用，锁文件会记住解析到的 commit，因此普通 `pnpm install` 不会重新拉取：

```bash
cd ~/.dsh/profiles/web
pnpm update dsh-feishu-plugin    # 必须用 update，install 会显示 Already up to date
```

然后重启 dsh-web。
