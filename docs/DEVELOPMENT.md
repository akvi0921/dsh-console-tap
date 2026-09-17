# 开发文档 —— dsh-console-tap

面向要改这个插件的人。读完你应该能:独立跑起来、改一处功能、验证它、并且不踩我们已经踩过的坑。

- 需求与实测记录(含每个坑的证据):[`DESIGN.md`](./DESIGN.md)
- 用户向说明与安装:[`../README.md`](../README.md)

---

## 1. 环境与目录

| 东西 | 位置 |
| --- | --- |
| DSH 安装 | `$(dirname "$(readlink -f "$(command -v dsh)")")/..`(Termux 上通常是 `<PREFIX>/lib/node_modules/@deepseek-ai/dsh`) |
| DSH 家目录 | `~/.dsh`(或 `$DSH_HOME`) |
| 本插件安装点 | `~/.dsh/profiles/web/plugins/console-tap/` |
| 组合补丁(实际生效处) | `~/.dsh/profiles/web/cordis.patch.yml`(`patchReload: live` → 保存即热更新) |
| 诊断状态 | `~/.dsh/console-tap-status.json` + `GET /api/console/status` |
| 输出留档 | `~/.dsh/console-logs/<ISO 时间>-<命令 id>.log` |

开发前先确认插件在跑:

```bash
curl -s http://127.0.0.1:3080/api/console/status | head -40   # mark 列表能看出挂到哪一步
node tools/probe.mjs                                          # 应该收到 hello 帧
```

---

## 2. 代码结构(一个包,两个半个)

```
lib/host.js    宿主半个(约 1000 行)
  ├─ DEFAULTS / registry()            配置与进程级注册表
  ├─ mount(ctx, via)                  真正挂载(apply 与自举共用)
  ├─ tryHotUpgrade()                  同进程"就地热升级"运行中的实例
  ├─ reclaimOwnRoutes()               回收上一实例遗留的同名路由
  ├─ dropStaleClientRows()            清掉本插件旧包名的 boot 行
  └─ class ConsoleTap
       ├─ attachSubprocess()          spawn 打补丁(可逆,原型级)
       ├─ drain / drainOnce / drainFromSpill / deliver   采集与投递
       ├─ onSessionEvent / matchIdentity                  身份标注
       ├─ registerRoute()             WS /api/console + /api/console/status
       └─ startPolling()              采集循环

lib/client.js  浏览器半个(手工 bundle,无构建步骤)
  ├─ createFeed / writeScreen / statusOf   纯逻辑(帧→终端画面;可单测)
  ├─ createConnection()                    WS + 退避重连
  ├─ ConsoleRoot / ConsoleWindow / Launcher React 组件
  └─ window.__ModuleLoader__.load({ id, factory })   官方 bundle 契约
```

**为什么要分成两个半个**:宿主侧只认「组合行能不能 import」,浏览器侧只认「包元数据能不能被 `dsh-client-modules` 扫到」,这两件事的成败条件不同(见 `DESIGN.md` 第三节)。两半之间**只通过帧协议通信**,所以 APP 端可以照抄浏览器侧。

---

## 3. 加载与挂载(最容易踩的地方)

### 3.1 正常启动路径
`dsh web` 启动 → 组合 = 各 bundle + `cordis.patch.yml` + `--patch` → 我们的两条行被插入 → 宿主行被 `import` → **Cordis 调 `apply(ctx)`** → 挂载。

### 3.2 热插入路径(改补丁就生效的那种)
**模块会被 `import`,但 Cordis 不会调 `apply`**(父 include 的事务在热更新路径上不 settle)。因此 `host.js` 末尾有 `mountViaBootstrap()`:

1. import 时立刻给 `Context.prototype.extend / isolate / intercept` 挂钩子(这几个是 cordis 里唯一稳定可达的原型方法,`get/on/effect` 都是服务注入、不在原型上);
2. 钩子里拿 `this.root ?? this` 当候选 ctx;
3. **轮询到 `webServer` + `subprocess` 两个服务都就位**再 `mount()`(早于服务注册就挂会得到一个"空壳":实测全新启动时两个服务都是 `undefined`);
4. 拿到即还原原型;60 s 无果自动撤钩。

### 3.3 声明式 inject 是必须的
```js
export const inject = ['webServer', 'subprocess'];
```
两个理由:① Cordis 会**等服务就位**再 apply(否则全新启动时 apply 早于服务注册);② **读 `ctx.config` 本身以声明式 inject 为前提**,否则抛 `cannot get property "config" without inject`。

### 3.4 同进程热升级(改代码不用重启进程)
补丁文件一改,模块会被**重新 import**。`Registry`(挂在 `process[Symbol.for('dsh.console-tap.registry')]`)里存着运行中的实例:

- 新版本 import 时若发现注册表里有一个 `ok=true` 的实例且 `rev !== REV`,就把**原型方法整体重绑**到新实现(`tryHotUpgrade()`),并合并配置 → 运行中的实例立刻变新代码,**不重复挂载、不重注册路由**;
- 改代码的完整循环:改 `lib/host.js` → `cp lib/host.js lib/hostN.js` → 把组合行的 `name` 指向 `hostN.js`(改名字才会触发新的 import) → 看 `~/.dsh/console-tap-status.json`。
  注意:同名文件的内容改动**不会**重新求值(ESM 按 URL 缓存),所以迭代期用新文件名;发布时收敛回 `lib/host.js`。
- 若上一实例已失联(拿不到它的 disposer)而路由还占着路径,`reclaimOwnRoutes()` 会从官方 `webServer.upgrades/exact` 表里删掉**本插件自己的固定路径**再重注册(官方对重复路由是直接抛错的)。

### 3.5 旧包名的 boot 行会**让页面直接崩**
客户端 `dsh-client-modules` 对 boot 清单每一行都要求 `bundle <url> loaded without registering "<id>"`。换过包名后旧行指向同一个 bundle 却要求旧 id → 整页 boot 报错。`dropStaleClientRows()` 把"本插件名字但已不在 loader 里"的行塞进官方 `clientModules.dirty` 再 `flush()`,让官方自己重扫删除(不删条目、不写组合文件)。前端也做了**历史 id 兼容注册 + 全局单实例守卫**兜底。

---

## 4. 帧协议(WS `/api/console`,服务端 → 客户端)

| 帧 | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `version`, `pollMs`, `live[]` | 连上即发;`live` 是"正在跑"的命令(含命令原文、身份、cwd),中途接入也能立刻看到 |
| `command-start` | `id`, `command`, `argv`, `cwd`, `sessionId`, `callId`, `tool`, `confidence` | `confidence`:`exact`(命令原文等值命中)/`nearby`/`none` |
| `chunk` | `id`, `stream`(`stdout`\|`stderr`), `seq`, `text` | `seq` = 该流**已投递字节数**(单调递增,可对齐/去重) |
| `gap` | `id`, `stream`, `fromByte`, `toByte`, `source`, `note` | 只在内存尾窗与文件起点不对齐时出现;如实标注,不假装完整 |
| `command-end` | `id`, `exitCode`, `signal`, `ms`, `bytes{stdout,stderr}`, `logPath` | 结束帧;`logPath` 是留档文件 |

**兼容约定**:新增字段只加不改;`version` 只在破坏性变更时 +1;客户端对未知 `type` 必须忽略而不是报错。

---

## 5. 采集与"完整性"(核心难点)

官方 `dsh-subprocess-local` 的 `OutputCollector` 有两套语义:

- 内存里只保留**尾部窗口**(bash 工具约 64–128 KB,取决于 spawn 时的 `maxOutputBytes`/`stdoutMaxBytes`);
- `readFrom(from)` 在 `from < windowStart` 时置 `lossy` 并**只返回尾窗**;
- 首次溢出会另写 **spill 文件**:把**此前所有 chunk + 之后所有 chunk** 都写进去 → 即"从第 0 字节起的全量"(上限 `maxSpillBytes`,默认 64 MiB,超了官方删文件并标记不可恢复)。

所以 `ConsoleTap` 的采集规则是:

1. 平常:`reader.readFrom(rec.offset[which])` 增量投递(官方明确"独立读者互不消费",不影响模型/工具看到的内容)。
2. **一旦 `readFrom` 返回 `spillPath`**:改以文件为唯一来源,按**我们自己的文件游标** `rec.spillFrom[which]` 读;此时**绝不能**把内存尾窗文本直接投递(顺序会乱)。
3. **必须循环读到追平**:spill 模式一次只读 64 KiB,只读一次 → 命令结束时丢掉剩余部分(实测 300000 字节只投递 131072/65536 且没有 gap 帧)。`drain()` 与 `finish()` 都是循环。
4. 真的没有 spill 又 lossy 过:投递尾窗并广播 `gap`,前端会标出来。

验收用例(务必保持通过):

```bash
# 造一条远超内存窗口的输出(后台跑,免得刷屏)
python3 -c "import sys
line='X'*199+'\n'
for _ in range(1500): sys.stdout.write(line)
sys.stdout.flush()
for _ in range(500): sys.stderr.write('E'*99+'\n')" &
# 同时用 tools/probe.mjs 或自己的订阅器统计字节:stdout 应收到 300000、stderr 50000,gap 0 条
node tools/probe.mjs | tail -3
```

---

## 6. 身份标注(`tool/call` ↔ `spawn`)

- 会话事件 `tool/call` 给出 `sessionId/callId/tool/command`(bash 工具把命令原文原样交给 `bash -c`,所以 `argv[2] === command`);
- `spawn` 时用**命令原文等值匹配**取身份 → `confidence: exact`;
- 匹配不上(非 bash 工具起的进程、命令被改写)时退化为 `nearby`(3 s 内最近一次未认领的调用)或 `none` —— **不假装精确**。

---

## 7. 前端(`lib/client.js`)

手工 bundle,格式即官方契约:

```js
window.__ModuleLoader__.load({ id, factory: (require) => exports })
```

- 只 `require` 官方**静态种子表**里的模块(`react`、`react-dom/client`),不引第三方;
- UI 是**独立 React root 挂在 `document.body`** 的全局浮层(不占用 slot 布局,所以不会挤压页面);
- 纯逻辑(帧 reducer、终端画面、Gradle 状态行解析)与 React 组件分离,**纯逻辑可以在 Node 里直接单测**;
- 连接失败按指数退避重连,断开时窗口显示"未连接"而不是静默。

改前端后的自测:

```bash
node test/client-logic.test.mjs      # 12 项断言:CR 覆盖 / ANSI / stderr 分屏 / 状态行 / 缺口 / hello 恢复 / 行数上限
```

---

## 8. 开发循环(推荐姿势)

```bash
# 0) 一次准备:装好(见 README),确认 status 200
curl -s http://127.0.0.1:3080/api/console/status | head -20

# 1) 改后端
$EDITOR ~/.dsh/profiles/web/plugins/console-tap/lib/host.js
cp ~/.dsh/profiles/web/plugins/console-tap/lib/host.js \
   ~/.dsh/profiles/web/plugins/console-tap/lib/host$((RANDOM)).js      # 新 URL 才会重新求值
sed -i "s#name: './plugins/console-tap/lib/host[0-9]*.js'#name: './plugins/console-tap/lib/host<新的>.js'#" \
   ~/.dsh/profiles/web/cordis.patch.yml                                  # 保存即热更新
sleep 5; cat ~/.dsh/console-tap-status.json        # 看 marks:mount / route / subprocess / client-rows

# 2) 改前端:直接改 lib/client.js(客户端 bundle 带 rev 哈希,刷新页面即取新版)
node test/client-logic.test.mjs

# 3) 收尾:把最终实现收敛回 lib/host.js,删掉迭代用的 hostN.js,组合行指回 host.js
```

**两条铁律**:

1. **不要重启正在承载交互会话的 `dsh web` 进程**(重启等于把当前会话的宿主杀掉)。要验证"全新启动路径",用**临时 profile + 另一端口**:

   ```bash
   V=~/.dsh/profiles/web-verify
   mkdir -p $V/node_modules/@local
   cp ~/.dsh/profiles/web/cordis.yml $V/
   cp ~/.dsh/profiles/web/cordis.patch.yml $V/
   ln -sfn ../web/plugins $V/plugins
   ln -sfn ../../../web/plugins/console-tap $V/node_modules/@local/console-tap
   cat > $V/package.json <<'JSON'
   { "name": "dsh-profile-web-verify", "private": true, "type": "module",
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"], "patchReload": "live" } } }
   JSON
   DSH_PERMISSION_MODE=danger-full-access node --expose-internals \
     "$(dirname "$(readlink -f "$(command -v dsh)")")/../lib/bin.js" --profile web-verify --port 3099 --no-open
   # 验证:curl -s localhost:3099/api/console/status → 200;boot 清单只有一行 console-tap
   ```

2. **改完必须自己验一遍**:`/api/console/status` 200 + `node tools/probe.mjs` 收到帧 + 第 5 节的完整性用例。

---

## 9. 发布流程

1. 改 `lib/host.js` 里的 `REV`(整数,只增);
2. 收敛文件名:`lib/host.js` 为唯一实现,组合行样例指向它;
3. 跑 `node test/client-logic.test.mjs`(必须 12/12);
4. 用临时 profile 验一次**全新启动**(见上);
5. 更新 `package.json` 版本 + `docs/DESIGN.md` 的实测记录;
6. `bash install.sh --source . --dry-run` 自测安装器,再真跑一次;
7. `git tag vX.Y.Z && git push --tags`。

---

## 10. 踩坑清单(按"会浪费你多少时间"排序)

| # | 坑 | 结论 |
| --- | --- | --- |
| 1 | 热插入的行 `apply` 不被调用 | import 阶段要能自举挂载;`apply` 不能是唯一入口 |
| 2 | 裸包名的行宿主侧**不会**被 import | 宿主行必须用相对文件路径;浏览器行必须用裸包名 → **两条行** |
| 3 | 全新启动时 apply 早于服务注册 | 声明式 `inject`;自举要**重试到服务就位** |
| 4 | 读 `ctx.config` 抛 `without inject` | 同 3;并给 config 读取包 try/catch 降级 |
| 5 | 只投递内存尾窗 → 顺序乱 / 丢数据 | 有 spill 就以文件为唯一来源;并且**循环读到追平** |
| 6 | 旧包名的 boot 行 → 页面启动报错 | 清 `clientModules` 脏行 + 客户端做历史 id 兼容 |
| 7 | 重复路由官方**直接抛错** | 挂载前回收本插件遗留路由;注册路由包 try/catch |
| 8 | 同名文件改了不生效 | ESM 按 URL 缓存;迭代期换文件名(或重启进程) |
| 9 | `loader.entries()` 不是数组 | 用 `[...raw.values()]` 兼容 Map/迭代器 |
| 10 | 诊断只能靠文件 | 宿主 stdout 看不到(子进程输出是 `collect`),所以状态写盘 + HTTP 端点最实用 |

---

## 11. 下一步(欢迎 PR)

- APP 端接收器(同一套帧协议,直接复用 `createFeed/writeScreen` 的算法)
- 帧压缩/批量(超长输出时降低 WS 压力)
- 命令输出搜索与导出(当前只有「复制」)
- 审批/等待回答等会话事件并入同一窗口
