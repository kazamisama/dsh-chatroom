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
4. 对这批成员投递一条**按档位**的消息：默认（`routine`）只作通知、**谁都不必回**；
   只有 `contract`（接口 / 字段 / 枚举变了）与 `irreversible`（删数据 / 改 schema / 进历史）才要求相关成员**各回一句**
5. 其余成员在增量历史里看得到，但不被打扰

## 安装

```powershell
dsh plugin --profile web add 'link:D:\dsh_dev\dsh-chatroom'
```

它会做两件事：在 profile 的 `dependencies` 里加一条 `link:`，并把 `dsh-chatroom` 追加进
`dsh.profile.bundles` —— **后者才真正决定插件进不进组装树**。

装载验证（不必启服务）：

```powershell
dsh --profile web --dump-config | Select-String chatroom
```

改完**宿主侧**（`lib/index.js` / `lib/rooms.js` / `lib/gitcheck.js`）**必须重启服务**；
**客户端侧**（`lib/client.js`）在 dev bundle 被重建时（例如跑着 `pnpm run dev:web`）会**热更新**，
否则同样要重启 + 刷新页面（bundle 带内容哈希）。
〔2026-09-25 补：这句原来只写"需要重启服务"—— 我因为它在客户端侧误判过一次"改了没生效"。〕

## 状态

M0–M4 全部完成，并经过真机逐项验证。见 BLUEPRINT.md §11 里程碑与 §11.1–§11.5。

测试：`npm test`（或 `node tests/all.mjs`）跑全部，也可 `node tests/<name>.mjs` 单跑 —— **七套共 1071 条断言**：
smoke（状态机 / 短号）/ host（宿主集成）/ gitcheck（git 核验）/ markdown（渲染器与注入防护）/
panel（面板纯函数、渲染与重建闸门、候选筛选与排序）/
transport（面板通道的传输层与各分支状态码，见 BLUEPRINT §11.7–§11.11）/
invariants（写入口的不变量断言）。
〔2026-09-25 更正：这里原来写"六套共 271 条"—— 漏了 invariants，条数也早已不是 271。〕

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

