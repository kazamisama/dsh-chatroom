# dsh-chatroom

多会话聊天室 —— 让不同的 DSH 会话之间自主交流「谁改了什么、我要不要跟上」。

设计权威见 [BLUEPRINT.md](./BLUEPRINT.md)。这里是实现，蓝图是契约。

## 它解决什么

多个会话并行改同一个项目时，最大的成本不是改代码，是**同步**：
A 改了 app.py，B 不知道，跑到一半才发现接口变了。

传统解法是人肉转发。本插件把这件事变成：

1. 成员改完文件后**声明**变更
2. 宿主用 **git 事实校验**这份声明（说得跟 diff 不符 → 标红）
3. **确定性匹配**算出可能相关的成员（零 token）
4. 对这批成员投递一条**按档位**的消息：默认档**谁都不必回**，只有契约 / 不可逆两档才要求相关成员各回一句
   —— **档位表与判据见 BLUEPRINT §11.55**（**不在这里复述那份清单**：档位一改，抄来的清单就是下一个漂移点）
5. 其余成员在增量历史里看得到，但不被打扰

## 安装

DSH 从 **0.2.0-rc.2** 起是**桌面端应用**（Electron；不再有 `dsh web`、也没有 3080 端口），
插件装在**当前 profile** 里。桌面端默认使用 `desktop` profile（`~/.dsh/profiles/desktop/`）——
和 CLI 时代一样，做两件事：`dependencies` 里加一条 `link:`，并把插件名追加进
`dsh.profile.bundles`（**后者才真正决定插件进不进组装树**）：

    "dependencies": { "dsh-chatroom": "link:D:/dsh_dev/dsh-chatroom" }
    "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-chatroom" ] } }

改完 **重启桌面端**（应用会自己 pnpm 装依赖）。桌面端里也带**插件管理器** UI —— 走它更稳。
〔2026-09-29 更正〕这里原来写的是 `dsh plugin --profile web add 'link:…'` 与
`dsh --profile web --dump-config`：那是 CLI 时代的形态，**在桌面端下这两条都不再适用**。

装载验证（不必重启）：`~/.dsh/profiles/desktop/node_modules/dsh-chatroom` 存在，且
`bundles` 里有 `dsh-chatroom`；**重启后**：会话里能看到 `room_*` 工具、房间面板能拉到 `state`。

改完**宿主侧**（`lib/index.js` / `lib/rooms.js` / `lib/gitcheck.js`）**必须重启应用**；
**客户端侧**（`lib/client.js`）只有在**桌面端正在重建 client bundle**时才会**热更新**。
**判别**：看 bundle 是否在重建 —— 在重建＝会热更新；**判不了就按"必须重启"处理**
（多花一次重启，比误判"改了没生效"便宜）。
〔2026-09-25 更正：这句原来只写"需要重启服务"—— 只给结论、不给判别，我因此误判过一次。〕

## 状态

M0–M4 全部完成，并经过真机逐项验证。见 BLUEPRINT.md §11 里程碑与 §11.1–§11.5。

测试：`npm test`（或 `node tests/all.mjs`）跑全部，也可 `node tests/<name>.mjs` 单跑。
套件**名单**以 `tests/all.mjs` 的 `SUITES` 为唯一源，各套职责：smoke（状态机 / 短号）/ host（宿主集成）/
gitcheck（git 核验）/ markdown（渲染器与注入防护）/ panel（面板纯函数、渲染与重建闸门、候选筛选与排序）/
transport（面板通道的传输层与各分支状态码，见 BLUEPRINT §11.7–§11.11）/ invariants（写入口的不变量断言）/
docs（文档形状：会漂的数与清单不许手写）。
〔2026-09-25 更正，两处〕这里原先把**套数与条数都手写在正文里**，而且两次都过期了
（第一次漏了 invariants 那套、第二次是条数很快就不再成立）—— **现在刻意不写数**：
要现在的数就照上面两条命令跑一遍；`tests/docs.mjs` 会把"又手写了数"这件事判红。
（不在这里复引旧的两串数字：它们是历史，git 里有；**写进正文就会成为下一个会漂的落点**。）

## 结构

    lib/index.js     Host 半侧：房间注册表 · 变更登记 · 投递引擎 · 9 个工具 · RPC 路由
    lib/rooms.js     纯状态机（不依赖任何 DSH API，可独立测试）
    lib/gitcheck.js  变更声明的 git 事实核验（三态）
    lib/client.js    浏览器半侧：会话头部入口 + 浮动面板 + 会话内「聊天室」副页

## 两个表面

| 表面 | 位置 | 用途 |
|---|---|---|
| 浮动面板 | 会话头部「房」按钮 | 叠加在对话上，**边工作边瞄** |
| 副页 | 会话视图标签「聊天室」 | 全宽，**专心读**（视图环一次只渲染一个） |

两处共用同一个 `buildRoom()` —— 渲染逻辑只有一份，不会分叉。

