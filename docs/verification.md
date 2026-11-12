# 验证记录

日期：2026-10-25 11:40（Asia/Shanghai）

## 已完成

| 项 | 结果 |
|---|---|
| git | `2.50.1 (Apple Git-155)`，已可用 |
| 参考仓库 | `/Users/code/wps/opencode-feishu-plugin` 已 clone |
| 插件构建 | `dsh-feishu-plugin` 0.5.9：`lib/index.js` 自包含 Host + `lib/client.js` 配置页 |
| 插件安装 | `dsh-feishu-plugin` 0.5.9（本地 link）→ `application: applied`；插件列表只有 1 个「飞书桥接」 |
| 飞书凭据校验 | tenant_access_token / bot info 返回 `code: 0` |
| 飞书 WS（独立 SDK 测试） | 使用同一组凭据 `onReady` 触发，`ws client ready` |
| 插件 WS 连接 | 日志出现「飞书长连接已就绪（收到 ready）」，连接状态 `state: connected` |
| 配置页合并 | 同一包内 Client 模块注册配置页；插件详情页直接显示 App ID / Secret / 调试日志表单 |
| 新图标 | DSH 鲸鱼 + 飞书蓝气泡构图，128px / 48px 两档渲染检查通过 |
| 卡片按钮刷新 | 列表/翻页类按钮在回调响应返回卡片；进入/创建话题类按钮只返回 toast，回调后再 patch，避免与新话题创建冲突 |
| 调试开关 | `debugLog` volatile 字段：插件页勾选即强制 debug 级别，日志仍写 `feishu.log` |
| 工具抽屉 | 工具全部收在一个常驻折叠抽屉，只显示总次数；展开见明细；最多保留 12 个 |
| 长连接观测 | 60s 心跳日志（state/inboundCount/lastInboundAgoMs/reconnectAttempts），状态变化单独记录；debugLog 打开后含 SDK ping/pong trace |
| 长连接自愈 | `pingTimeout=30` + 60s 状态 watchdog；半开连接自动断开重连，状态写日志 |
| 意图兜底 | 模型失败时确定性回退：识别到列表/进入/任务文本仍可用默认目录开预填表单 |
| 意图模型 | 意图识别复用插件页配置的默认工作模型（defaultModel），不再有独立 intentModel |
| 意图模型调用 | `prepareCall` 与 `stream` 使用同一份 config，修复 `INVALID_PREPARED_CALL`；标题支持 bigram 模糊匹配 |
| 主会话意图 | 一次性判断：能明确 create/enter/list 就执行，判断不了直接回管理台，不做 clarify 多轮 |
| 思考保留 | 工具循环进入下一步时不再清空上一步 reasoning，思考抽屉保留最近思考内容 |
| 抽屉常驻 | 思考/工具两个抽屉始终存在并默认折叠；工具只显示次数，展开见明细 |
| 流式卡片 | 固定骨架 + 思考面板折叠 + 思考状态每秒刷新；回答/工具不互相替换 |
| 意图识别 | 主聊天流普通文本 → `ctx.llm` 一次性 JSON 意图分类；目录/模型/会话全部二次校验；失败回退管理台 |
| 话题标题 | 进入/创建会话时卡片 header 使用 DSH 会话标题，飞书话题列表显示真实标题 |
| 话题路由 | 每次进入新建话题并绑定已有 DSH 会话（参考 OpenCode resume）；回答跟随用户发言话题 |
| 会话标识 | 进入老会话的主卡片与话题根卡都显示完整 `session-...` ID，便于在 DSH Web 里定位 |
| 会话简介 | `sessionQuery.readSurface` 读取冷会话 surface；进入老会话时附历史摘要/上一条/上次回复，`/brief` 可重复读取 |
| 新会话默认值 | `defaultDirectory` / `defaultModel` / `defaultPermissionPreset` 均可从插件页编辑；目录走 `uiWorkspace.pickDirectory()`，模型/权限来自 DSH catalog |
| npm 包结构 | `npm pack --dry-run`：10 个文件，含 `lib/index.js`、`lib/client.js`、patch、locale、icon、README/LICENSE/NOTICE |
| Web 配置页 | headless Chrome 实测：插件页 → 飞书桥接 → 配置，App ID 回显正确 |
| 配置页保存 | 通过页面写入 App Secret，提示「已保存」 |
| 实时重连 | 页面把 App ID 改成测试值保存后，日志出现「飞书凭据已更新，长连接已重启」并以新 App ID 启动；随后改回并再次重启成功 |
| 单元测试 | `node --test` 25 项全部通过 |

## 尚未实测

- **真实飞书入站消息 → 自动建会话 → 流式卡片**：需要用户本人向机器人发一条单聊消息（或先发 `/new`）。当前 App 的机器人 open_id：`ou_315a65bbd41ffa459b5054f5d905d502`。
- 群聊 / 群话题：按设计不支持（只处理 p2p）。
- 图片 / 文件：代码路径已实现，但未用真实消息资源验证（需 `im:message:readonly` 且重新发布版本）。
- DSH 审批 / 提问卡片：需要真实会话触发工具审批或 `ask_user_question` 才能端到端验证。

## 如何继续实测

1. 飞书里给这个应用（机器人名 `opencode-mac`）发一条单聊消息：
   - 普通文本 → 应收到「管理台」卡片；
   - `/new` → 应收到建会话表单，提交后自动开话题；
   - 在话题里发消息 → 应出现流式运行卡片。
2. 若没有响应，查看 `~/.dsh/feishu-plugin/feishu.log` 与
   `~/Library/Logs/dsh/dsh.err.log`。
3. 审批卡：在话题里让模型执行需要审批的工具（或把权限预设切到高风险档），应出现「允许一次 / 拒绝」卡片。

## 2026-11-10 增补（300317 序号修复 + 工作区归属回归）

| 项 | 结果 |
|---|---|
| 300317 根因 | 整卡更新（`run.sequence`）与元素流式（`CardStream.sequence`）为同一张卡各发一个 `sequence=1`，打字机首帧即被拒、卡片永久退化为整卡重发（排查报告：`DSH 飞书通道/streamfix-sequence-300317-report.md`） |
| 修复 | `cardkit` 成为每卡序号唯一所有者（`take/adopt/last/forget`），调用方不再传号；计数持久化进 `state.json` 的 `liveCards.sequence`，重启 `adopt` 精确续号，替代曾三次实测失败的「硬编码 2147483646」 |
| 复现脚本 | `scripts/seq-repro.mjs`：修复前退出码 1（复现 300317）；修复后退出码 0，序号 1→2→3 严格递增 |
| 工作区归属 | 0.5.21 上游同步时丢失的 `workspaceFor` 已回归移植，`inject` 增加 `workspaceRegistry`；飞书会话重新按工作区分组，不再落「未分组」 |
| 携带特性防线 | 新增 `scripts/check-carried.sh`（5 项 grep 检查），已接入 `update.sh`，上游同步后自动阻断特性悄悄消失 |
| 单元测试 | `node --test` 47 项全部通过（新增 `test/sequence-monotonic.test.mjs`：单调性回归 + 重启恢复 adopt） |
| 上线状态 | lib 已装入 profile；待 dsh-web 空闲重启后观察 `feishu.log` 不再新增 300317、打字机逐字回归、新会话落「DSH 飞书通道」工作区 |

## 2026-11-12 增补（300317 修复的线上验收）

排查报告：`/data/home/DSH 飞书通道/streamfix-sequence-300317-report.md` §9。

| 项 | 结果 |
|---|---|
| 源码/构建 | `local` HEAD `9477c45`（0.5.22），仓库 `lib/index.js` 与 profile 安装产物 `cmp` 相同（6,467,879 字节）；bundle 内 `function take(cardId)` ×1、`const sequence = take(cardId)` ×4，无 `Math.min(…sequence…)` |
| 复现脚本 | `scripts/seq-repro.mjs` 退出码 **0**，序号 1→2→3 严格递增 |
| 单元测试 | `pnpm test` **47 通过 / 0 失败** |
| 线上日志 | 0.5.22 起点（2026-11-10T06:45:44Z，日志第 9190 行）之后：`300317` **0**、`回退为整卡更新` **0**、`收尾遗留卡片` **0**；最后一次 300317 为 2026-11-10T01:59:48Z（修复上线前） |
| 连接健康 | 0.5.22 起点后 204 条心跳均 `connected`；4 条 WARN 全部是 `no pong/inbound within 30s` → 自动重连，与卡片无关 |
| 未闭合 | 只跑完 1 个完整回合（2026-11-12T01:20:41Z），需继续累计到 3–5 轮；打字机逐字效果需人工目测；`300309`/`300313` 尚未定根因 |

## 2026-11-12 增补（§7 待核查项的真机探测）

详情见排查报告 §10（`/data/home/DSH 飞书通道/streamfix-sequence-300317-report.md`）。

| 项 | 结果 |
|---|---|
| sequence 语义（真机） | **只要求「大于这张卡上一次被接受的值」，不要求 +1 连续**：`1 → 4` 接受、`3` 拒 300317、`2147483646` / `2147483647` 接受 |
| 300317 词条含义 | 「未严格递增」= 不大于上一次，与“必须依次 +1”无关；11-07 恢复路径 `2147483646` 被拒 = 那张卡已发到该值，佐证 `adopt`+`liveCards.sequence` 持久化的必要性 |
| uuid | 重复 uuid 返回 **200770 UUID conflict**（与 sequence 无关的另一道闸门）；`u_${cardId}_${sequence}` 同卡内天然唯一 |
| 300309 | 真机复现条件：卡片**创建时未开启 `streaming_mode`**，向其写元素即 300309；生产 `run.cardId` 均来自 `createCard(..., streaming: true)` |
| 300313 | 代码核实：带 `element_id` 的只有 `runCard()` 的答案元素；`stripTransientElements` 只用于内存中重建的中断卡，回写卡片来自 `cardContentOf`（含 element_id）；`interruptedRunCard` 不新增元素 |
| seq-repro.mjs | 假飞书按真机语义修正（顺序闸门 + uuid 幂等闸门）；修复前退出码 1、修复后 0 |
| 新发现（未修） | `fitCard()` 按 29KB **字节**截断，中文回答约 ≥9,300 字会被截到 9,273 字，`maxChars: 30_000` 的滚动换卡阈值达不到 |

## 2026-11-12 增补（卡片 29KB 字节预算：答案优先，0.5.23）

| 项 | 结果 |
|---|---|
| 问题 | `maxAnswerChars` 是**字符**上限，飞书卡片是 **30KB 字节**上限。中文 12,000 字 ≈ 36KB，字符预算放行后被 `fitCard` 兜底按字节切到 **9,273 字**；带 2,400 字思考面板时更只剩 **8,459 字**，且面板的字节是从答案嘴里抢的 |
| 修法 | `runCard` 单点按字节计量整卡：先吃字符上限，超了**先削面板**（可退成一行占位，标题的 💬/🔧/🕐 保留），面板到 320B 保底后再动答案；截断补省略号 + 「卡片已截断」说明。`card()` 拆成 `cardShell()` + `fitCard()`，预算在兜底前测量 |
| 配套 | `patch()` 把面板字节数与截断状态并入 chrome 指纹——打字机只改元素，若面板缩了却不整卡重写，服务端会留着大面板并越过 30KB |
| 实测（热路径 `runCard`） | 中文答案保留 **~9,200 字**（原 8,459/9,273）；中文 9,000 字 + 2,400 字面板：答案**完整**、面板自动缩到 250 字；英文 27,000 字完整，28,000 字保留 27,615；流式过程答案**只增不减** |
| 测试 | `node --test` **53 项全通过**（新增 5 项：面板让位、显式截断、字符上限、流式单调性、整卡重写判定） |
| 携带特性 | `scripts/check-carried.sh` 新增两项（`panelBodyFor` / `built.panelBytes`），6 项全过 |
| 上线状态 | lib 与 profile 安装产物逐字节相同（6,470,456B）；**2026-11-12T02:18:08Z 已随 dsh 重启生效**（`buildTag=0.5.23`，PID 9374），重启后 300317 / 回退为整卡更新 0 次 |
| 真机验收 | 长中文答案整卡 **28,934B** 写入 `code=0`；回读确认服务端答案 **9,193 字**（修前同场景 8,459 字），面板让位到 17 字 |
| 热路径真机 | 整卡(短)→元素(6,000 字)→整卡(9,199 字+让位面板)→元素(最终)→关流，**5 步全部接受**，无 300317 / 200860 |
| 更正 | 「元素更新会被 30KB 卡住」不成立：实测给仍带 830 字面板的卡推 9,273 字元素返回 code=0 且已落盘（整卡 ~31KB）。30KB 是**整卡写入**的硬约束；`patch()` 里把面板尺寸并入 chrome 指纹因此是**保守选择**（让服务端卡片留在文档限值内、面板与预算一致），不是必需项 |
