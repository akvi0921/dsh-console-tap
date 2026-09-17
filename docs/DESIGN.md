# 控制台显形插件(console-tap)1.0 —— 助手执行的命令 + 完整控制台输出,实时推给前端

> 需求原话:「我要能看见助手跑了什么命令,以及它的控制台输出,而且要完整、要实时。」
> 落地形态:一个 **DSH 宿主插件 + 官方 WebUI 客户端插件** 的组合包。
> 本文件记录:目标 → 架构 → 实测踩到的 5 个硬坑 → 协议 → 验收证据 → 安装/恢复 → 已知限制。

---

## 一、功能与目标(逐条对应实现)

| 需求 | 实现 |
| --- | --- |
| ① 助手跑了**什么命令** | 给 `subprocess` 服务实例的 `spawn` 打一层**可逆**补丁,从 `argv/cwd` 拿到命令原文;再用会话事件 `tool/call` 里的 `command` 做**等值匹配**打上身份(会话/调用/工具) |
| ② 它的**控制台输出** | 非消费式增量读 `handle.collected.stdout/stderr.readFrom(offset)`(官方注释保证"独立读者之间互不消费"),stdout / stderr 分开 |
| ③ 输出要**完整** | 官方内存只留**尾部窗口**(bash 工具约 64–128 KB),窗口滑走时 `readFrom` 会置 `lossy`;溢出时官方会另写 **spill 文件(含从第 0 字节起的全量)** → 检测到 spill 就改按文件游标读,一直读到追平 |
| ④ **实时**收上去 | 插件自建 WebSocket `/api/console`(官方 `webServer.registerUpgrade`,与 `/api/events.mux` 同一套 API),默认 150 ms 轮询投递增量 |
| ⑤ 前端渲染 | 官方 WebUI 客户端插件:右下角悬浮「控制台」按钮 + 可拖动窗口,按命令分段显示、stdout/stderr 分屏、Gradle 进度状态行高亮、缺口如实标注 |
| ⑥ 不改官方行为 | 不替换任何组合行;不改 `maxOutputBytes`(模型可见上限一个字节不动);spawn 补丁在卸载时还原;所有异常只记诊断、绝不影响命令执行 |

---

## 二、架构

```
┌─ 官方 WebUI 浏览器页 ────────────────────────────────────────────┐
│  boot 清单里的一行:/plugins/@local/dsh-console-tap-ui/client.js  │
│  ↓ 悬浮窗口(独立 React root 挂在 document.body,不挤布局)        │
│  ws(s)://<location.host>/api/console                             │
└───────────────────────────┬──────────────────────────────────────┘
                            │ 帧:hello / command-start / chunk / gap / command-end
┌─ DSH 宿主进程 ─────────────▼──────────────────────────────────────┐
│  console-tap 宿主半个(lib/host.js)                              │
│   ├─ spawn 补丁(原型级、可逆)→ 每条进程一条流记录              │
│   ├─ 采集循环(默认 150ms):readFrom(游标) / spill 文件游标       │
│   ├─ 身份匹配:tool/call 的 command 原文 ↔ argv[2]               │
│   └─ WebSocket 服务端(只认回环 + 同源 Origin)                   │
│  另:每条命令的完整输出另存 ~/.dsh/console-logs/<时间>-<id>.log    │
└──────────────────────────────────────────────────────────────────┘
```

组合层(见 `console-tap-plugin/cordis.patch.yml.example`)**两条行**:

```yaml
- insert:
    - id: console-tap-host
      name: './plugins/console-tap/lib/host.js'   # 宿主半个:相对文件路径
      config: { pollMs: 150, fileLogBytes: 67108864, trace: false }
    - id: console-tap-ui
      name: '@local/dsh-console-tap-ui'           # 浏览器半个:裸包名
```

---

## 三、实测踩到的 5 个硬坑(全部有证据,复用时别再踩)

### 1. 补丁层「热插入」的行:**模块会被 import,但 Cordis 不调 apply**
- 证据:`marker-probe.js`(新文件、相对路径)被 import 时能落盘(pid=7024 ✓),但同一个探针里的 `apply()` 内的落盘**从未发生**;`apply` 直到**下一次补丁更新**才被调用。
- 原因:父 include 的事务在热更新路径上不 settle(`cordis-plugin-include` 自己也注释了 "strand the include fiber without settling")。
- 对策:`lib/host.js` 末尾的 **自举挂载**(`mountViaBootstrap`):import 时给 `Context.prototype.extend/isolate/intercept` 挂一次性钩子拿 root ctx,**轮询到 `webServer` + `subprocess` 两个服务都就位**再 `mount()`;拿到即还原原型。钩子 60 s 无果自动撤除,不留驻。

### 2. 裸包名的行:能发布浏览器 bundle,**宿主侧却不会被 import**
- 证据:`@local/dsh-console-tap3` 行在 boot 清单里出现、`/plugins/.../client.js` 返回 200,但 `console-tap-import.json` 始终没有该 URL。
- 原因:浏览器侧靠**包元数据**发现(`dsh-client-modules` 读 `dsh.client` + `exports["./client"]`),这条路与宿主侧 `import` 是否成功**无关**。
- 对策:**两条行**——宿主半个用相对文件路径,浏览器半个用裸包名,指向同一个包目录;`apply()` 内另有进程级注册表保证只挂一份。

### 3. 全新启动时,`apply` 可能**早于服务注册**
- 证据(临时 profile `web-verify` 全新启动):`mount:apply` → `mount:init-failed cannot get property "config" without inject`,探针显示 `webServer/subprocess` 都是 `undefined`。
- 原因:Cordis 对根级条目是并发 apply;未声明 inject 时不会等服务就位,而且**读 `ctx.config` 本身就以声明式 inject 为前提**。
- 对策:`export const inject = ['webServer', 'subprocess']`(声明式等待)+ 读 config 包 try/catch 降级。

### 4. 「完整」的真正难点:官方内存是**尾部窗口**,而且一次只能读一块
- 证据:子进程自报 stdout 300000 字节,插件只投递了 131072 / 65536 字节,**且没有 gap 帧**。
- 机制(`dsh-subprocess-local` 的 `OutputCollector`):内存保留尾部窗口;`readFrom(from)` 在 `from < windowStart` 时置 `lossy` 并**只回尾窗**;首次溢出会另开 spill 文件并把**此前所有 chunk + 之后所有 chunk**都写进去(即从第 0 字节起的全量)。
- 两处修复:
  1. 有 spill 就**以文件为唯一来源**,按我们自己的字节游标读(不能把内存尾窗直接投递,否则顺序错乱);
  2. `drain()` 必须**循环读到追平** —— spill 模式一次最多 64 KiB,只读一次就会在"命令已结束"时丢掉剩下的部分(`finish()` 里同样是循环)。
- 修复后证据:**300000 + 50000 字节逐字节全量到达,0 缺口**(见下)。

### 5. 旧包名残留的 boot 行会让**页面直接启动失败**
- 机制(官方客户端 `dsh-client-modules/lib/client.js`):`bundle ${url} loaded without registering "${id}"` —— 每一行都要求 bundle 注册**那个 id**。开发期换过包名,旧行仍指向同一 bundle 却要求旧 id。
- 对策(两层):
  1. 宿主侧 `dropStaleClientRows()`:把"本插件名字但已不在 loader 里"的行标脏,再让官方 registry 自己重扫删除(`clientModules.dirty` + `flush`)——**不删条目、不写任何组合文件**;
  2. 客户端 bundle 把历史 id 一并注册(重复注册用 try/catch 吞掉)+ **全局单实例守卫**(多行也不会挂出多个窗口)。

---

## 四、帧协议(WS `/api/console`,服务端 → 客户端)

| 帧 | 关键字段 | 说明 |
| --- | --- | --- |
| `hello` | `version`, `pollMs`, `live[]` | 连上即发;`live` 是"正在跑"的命令快照(含命令原文、身份),便于中途接入 |
| `command-start` | `id`, `command`, `argv`, `cwd`, `sessionId`, `callId`, `tool`, `confidence` | `confidence`: `exact`(命令原文等值命中)/ `nearby` / `none` |
| `chunk` | `id`, `stream`(`stdout`/`stderr`), `seq`, `text` | `seq` 是该流**已投递字节数**,单调递增,可用来对齐 |
| `gap` | `id`, `stream`, `fromByte`, `toByte`, `source`, `note` | 只在"内存尾窗与文件起点不对齐"等情况下出现,如实标注而非假装完整 |
| `command-end` | `id`, `exitCode`, `signal`, `ms`, `bytes{stdout,stderr}`, `logPath` | 结束;`logPath` 是宿主侧落盘的完整输出文件 |

---

## 五、验收证据(全部为本机实测)

| 项目 | 结果 |
| --- | --- |
| 插件是否被 import | `~/.dsh/console-tap-import.json`(仅开发期诊断,正式版已移除)记录 pid 7024 + 文件 URL ✓ |
| 挂载 | `GET /api/console/status` → **200**,marks: `route:status-registered` / `subprocess:patched` / `route:ws-registered /api/console` / `mount:done` ✓ |
| WS 握手 | `hello` 帧到达,`live` 列表带命令原文 ✓ |
| 小命令端到端 | `command-start`(含 `argv/cwd/sessionId`)→ 3 条 stdout `chunk` + 1 条 stderr `chunk` → `command-end`(`exitCode=0`, `ms=3017`, `bytes{stdout:48,stderr:16}`, `logPath`)✓ |
| **完整性(超窗口)** | 子进程自报 stdout **300000** / stderr **50000** 字节 → 插件自报与前端**实际收到**均为 **300000 / 50000**,`gap` 帧 **0** 条 ✓ |
| 客户端纯逻辑测试 | `client-logic-test.mjs` **PASS=12 FAIL=0**(CR 覆盖、ANSI 剔除、stderr 分屏、Gradle 状态行解析出 `73% EXECUTING 1m 32s`、缺口计数、`hello` 恢复、3000 行上限)✓ |
| 全新启动验证 | 临时 profile 另一端口全新启动:`/api/console/status` **200**、WS 收到 `hello`、boot 清单**只有一行** console-tap ✓(验证后临时 profile 已删除)|

> 说明:线上 3080 这个进程**不能重启**(它承载着正在交互的会话,重启即自杀),所以"全新启动"是用临时 profile(独立目录 + 软链回插件 + 独立端口 3099)验证的。

---

## 六、安装 / 恢复(换机、升级 dsh 后照这个来)

1. 把 `console-tap-plugin/` 放到 `~/.dsh/profiles/web/plugins/console-tap/`(包名 `@local/dsh-console-tap-ui`)。
2. 建软链(**四处都要**,理由:客户端扫描与宿主 import 用的解析锚点不同):
   ```bash
   PKG=~/.dsh/profiles/web/plugins/console-tap
   for d in ~/.dsh/profiles/node_modules/@local ~/.dsh/profiles/web/node_modules/@local \
            ~/.dsh/node_modules/@local \
            /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@local; do
     mkdir -p "$d"; ln -sfn "$PKG" "$d/dsh-console-tap-ui"
   done
   ```
3. 把 `console-tap-plugin/cordis.patch.yml.example` 里 console-tap 的两条行追加到
   `~/.dsh/profiles/web/cordis.patch.yml`(`patchReload: live`,写完即热生效)。
4. 自查:`curl -s http://127.0.0.1:3080/api/console/status`,浏览器刷新页面 → 右下角出现「控制台」。

> 升级 `@deepseek-ai/dsh` 后,`…/dsh/node_modules/@local/…` 这条软链可能被 npm 清掉(插件还能跑,但**浏览器半个**的裸包名解析会失败)——按上面第 2 步重建即可。

---

## 七、已知限制(有意保留,均已在上文标注)

1. **同一进程里可能同时存在两个"实现版本"**:开发期反复改补丁会留下旧实例(它的 spawn 补丁仍在)。表现为日志文件成对出现,但**推给浏览器的那一份是外层(最新)实例的**,功能不受影响;进程重启后自然只剩一个。正式版已通过"进程级注册表 + 就地热升级 + 路由回收"把这种累积降到不会重复挂载。
2. 每条命令的输出会另存一份到 `~/.dsh/console-logs/`(单条上限 `fileLogBytes`,默认 64 MiB;设 0 可关)。
3. spill 文件由内核/官方管理在私有临时目录,单流上限 64 MiB(`maxSpillBytes`);超限时官方会删掉 spill 并标记不可恢复,插件会如实发 `gap` 帧。
4. `tool/call` 身份匹配用**命令原文等值**;命令原文对不上(例如非 bash 工具起的进程)时标 `nearby`/`none`,不假装精确。
5. 仅监听回环:非回环 Host、跨站 `sec-fetch-site`、异源 Origin 一律 403。

---

## 七点五、发布形态(官方包契约)

仓库按 DSH 官方 bundle 契约发布,可被 `dsh plugin add` 直接安装:

```jsonc
// package.json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 官方包安装的门槛(只有 dsh.client 不算可安装)
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] }
}
```

`cordis.patch.yml`(bundle 补丁)只插**一行**、用**裸包名** —— 与官方 `@deepseek-ai/dsh-base` 的写法一致。
实测(临时 profile,包真实落在 `<profile>/node_modules/@local/dsh-console-tap-ui`,profile 只保留与本插件无关的一行补丁):
全新启动 → 首页 200、`/api/console/status` 200、marks 齐全、boot 清单恰好一行 console-tap、WS 收到 `hello`。

## 八、APP 侧(下一步,尚未实施)

宿主半个与前端**完全解耦**:APP 只要
① 连 `ws://127.0.0.1:3080/api/console`(或在应用内直接读 `~/.dsh/console-logs/*.log`),
② 按上面第四节渲染同一套帧,就能拿到与 WebUI 完全一致的控制台视图。
