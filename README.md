# dsh-console-tap —— DSH「控制台显形」插件

把 **AI 助手执行的每一条命令 + 它的完整控制台输出**,**实时**推给 DSH 前端(官方 WebUI 里就是一个悬浮控制台窗口)。

- 🔍 命令原文、argv、cwd、所属会话/调用,一目了然
- 🖥 stdout / stderr 分屏渲染,CR 覆盖与 ANSI 颜色正确还原(进度条会原地刷新,不会刷屏)
- 📊 自动识别 Gradle 那种 `<=====> 73% EXECUTING [1m 32s]` 状态行并吸顶显示
- ✅ **完整**:官方 subprocess 内存只留尾部窗口,本插件在溢出时改读官方 spill 文件补齐 —— 实测 300 KB stdout + 50 KB stderr 逐字节全量到达、0 缺口
- 💾 每条命令的输出另存一份:`~/.dsh/console-logs/<时间>-<id>.log`
- 🧩 不替换任何官方组合行、不改模型可见的输出上限;所有补丁可逆,异常绝不影响命令执行

> 状态:1.0(宿主插件 + 官方 WebUI 客户端),APP 侧尚未实现(帧协议已解耦,见 `docs/DEVELOPMENT.md`)。

---

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/akvi0921/dsh-console-tap/main/install.sh | bash
```

国内网络直连 raw 不稳时,用镜像:

```bash
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/akvi0921/dsh-console-tap/main/install.sh | bash
```

先看它要做什么(不落任何改动):

```bash
curl -fsSL https://raw.githubusercontent.com/akvi0921/dsh-console-tap/main/install.sh | bash -s -- --dry-run
```

装完 **刷新一下 DSH Web UI 页面** → 右下角出现悬浮「控制台」。

### 手动安装(等价于脚本做的事)

```bash
git clone --depth 1 https://github.com/akvi0921/dsh-console-tap.git
cd dsh-console-tap

# 1) 包落到 web profile 的 plugins 下(目录名必须是 console-tap)
mkdir -p ~/.dsh/profiles/web/plugins/console-tap
cp package.json ~/.dsh/profiles/web/plugins/console-tap/
cp -r lib ~/.dsh/profiles/web/plugins/console-tap/

# 2) 软链:四处锚点都要(宿主 import 与浏览器端包扫描的解析基准不同)
PKG=~/.dsh/profiles/web/plugins/console-tap
for d in ~/.dsh/profiles/node_modules/@local \
         ~/.dsh/profiles/web/node_modules/@local \
         ~/.dsh/node_modules/@local \
         "$(dirname "$(readlink -f "$(command -v dsh)")")/../node_modules/@local"; do
  mkdir -p "$d" && ln -sfn "$PKG" "$d/console-tap"
done

# 3) 组合行:把下面这段追加到 ~/.dsh/profiles/web/cordis.patch.yml
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'

- insert:
    - id: console-tap-host
      name: './plugins/console-tap/lib/host.js'
      config: { pollMs: 150, fileLogBytes: 67108864, trace: false }
    - id: console-tap-ui
      name: '@local/dsh-console-tap-ui'
YAML
```

---

## 用法

| 想干什么 | 怎么做 |
| --- | --- |
| 打开/收起控制台 | 点右下角悬浮「控制台」按钮(按钮上带在跑命令数) |
| 拖动窗口 | 按住标题栏拖 |
| 复制某个命令的输出 | 该命令标题栏右侧「复制」 |
| 看命令是否还在跑 | 按钮上的数字;窗口内每段标题有状态点 |
| 看完整输出留档 | `~/.dsh/console-logs/`(单条上限 `fileLogBytes`,设 0 关闭) |
| 自查插件挂没挂 | `curl -s http://127.0.0.1:3080/api/console/status \| head -40` |
| 命令行看实时流 | `node tools/probe.mjs`(零依赖,Node 22+ 自带 WebSocket) |

配置项写在组合行的 `config:` 里(`~/.dsh/profiles/web/cordis.patch.yml`),改完即热生效:

```yaml
    - id: console-tap-host
      name: './plugins/console-tap/lib/host.js'
      config:
        pollMs: 150            # 采集轮询间隔(ms),越小越实时
        memoryBytes: 262144    # 中途接入时给订阅者的尾部快照上限
        fileLogBytes: 67108864 # 单条命令输出留档上限(0 = 不留档)
        logDir: null           # 留档目录(null = $DSH_HOME/console-logs)
        matchWindowMs: 15000   # tool/call 与 spawn 的匹配时间窗
        trace: false           # true = 把每次读的真实偏移写 console-tap-drain.jsonl(排查完整性用)
```

卸载:

```bash
curl -fsSL https://raw.githubusercontent.com/akvi0921/dsh-console-tap/main/uninstall.sh | bash
# 或本地:bash uninstall.sh [--purge  # 连输出留档一起删]
```

---

## 工作原理(30 秒版)

```
浏览器(官方 WebUI)
  └─ boot 清单里的一行:/plugins/@local/dsh-console-tap-ui/client.js
        └─ 悬浮窗口 ← ws://<同源>/api/console ← 帧(hello/command-start/chunk/gap/command-end)
DSH 宿主进程
  └─ console-tap 宿主半个:spawn 补丁(可逆)→ 增量读 stdout/stderr → 溢出读官方 spill 文件补齐
        ├─ 身份:tool/call 的命令原文 ↔ argv 等值匹配
        └─ 落档:~/.dsh/console-logs/*.log
```

组合层需要**两条行**,因为它们走的是两条完全不同的发现路径:

| 行 | 名字形式 | 为什么必须这样 |
| --- | --- | --- |
| `console-tap-host` | `'./plugins/console-tap/lib/host.js'` | 宿主侧:补丁层**热插入**的行一定会被 `import`,但 Cordis **不会调 `apply`** → 插件在 import 时自举挂载(见开发文档) |
| `console-tap-ui` | `'@local/dsh-console-tap-ui'` | 浏览器侧:官方 `dsh-client-modules` **只按包元数据**(`dsh.client` + `exports["./client"]`)发布 bundle,与宿主 import 成功与否无关 |

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面右下角没有「控制台」 | ① 先**刷新页面**(boot 清单每请求重建);② `curl .../api/console/status` 是否 200;③ 404 时改一下 `cordis.patch.yml`(触发热更新)或重启 `dsh web` |
| 页面白屏 / 控制台报 `bundle ... loaded without registering "…"` | boot 清单里残留了**本插件旧包名**的行(换过包名才有)。重装本插件(install.sh 会清理)或重启一次 `dsh web` |
| status 200 但窗口收不到帧 | 看 `hello` 帧有没有到(`node tools/probe.mjs`);没到说明 WS 路由被别的进程占用/端口不对 |
| 输出里出现 `⚠ 缺口` | 该段字节在官方内存窗口滑走且 spill 也已不可用(超 `maxSpillBytes` 被删)。属官方语义,已如实标注 |
| 升级 `@deepseek-ai/dsh` 后浏览器半个失效 | npm 可能清掉 `…/dsh/node_modules/@local/…` 软链 → 重跑 `install.sh` |
| 想让模型也看到完整输出 | 本插件**不改** `maxOutputBytes`(模型可见上限原样保留);留档文件与前端视图才是全量 |

---

## 目录结构

```
.
├── install.sh              # 一键安装(幂等,含自检)
├── uninstall.sh            # 一键卸载
├── package.json            # 包元数据(含 dsh.client 声明,浏览器半个靠它被发现)
├── lib/host.js             # 宿主半个:采集 + WS 服务端
├── lib/client.js           # 浏览器半个:悬浮控制台(手工 bundle,无构建步骤)
├── tools/probe.mjs         # WS 帧探针(零依赖)
├── test/client-logic.test.mjs  # 前端纯逻辑测试(node test/… → 12/12)
└── docs/
    ├── DEVELOPMENT.md      # 开发文档(架构/协议/开发循环/测试/踩坑)
    └── DESIGN.md           # 设计与实测记录(需求映射 + 5 个硬坑的证据)
```

## 环境要求

- DSH(Harness)且使用 **web** profile(`~/.dsh/profiles/web`)
- Node 22+(实测 Node 26;宿主半个用到的 `ws` 由 DSH 自带依赖提供)
- 平台:Termux/Android、Linux、macOS(只要 DSH 能跑)

## License

MIT
