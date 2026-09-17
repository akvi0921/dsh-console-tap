/**
 * console-tap 浏览器侧:悬浮"控制台"窗口。
 * ---------------------------------------------------------------------------
 * 与宿主侧(../index.js)配对:
 *   宿主把"命令 + stdout/stderr"通过自建 WebSocket `/api/console` 推过来,
 *   这里连上它、把帧还原成"终端画面",渲染在一个悬浮窗口里。
 *
 * 为什么这么写(而不是注册 slot 贡献):
 *   - 我们这个窗口是**全局浮层**,不属于某个 slot 的布局;用自己创建的 React root
 *     挂到 document.body 上,既不受布局/裁剪影响,也不用耦合具体 slot 名。
 *   - 只 require 官方**静态种子表**里的模块(react / react-dom/client),
 *     这些由 web shell 直接提供,不需要进 dsh.client.external。
 *
 * 手工写的 bundle(无构建步骤),格式与官方 lib/client.js 一致:
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 */

/**
 * 注册 id 列表:首选 id 是本插件的正式包名;其余是历史版本用过的名字。
 * 为什么全都注册:宿主侧组合行若还留着旧名字的行,浏览器模块系统会为那一行
 * 加载同一个 bundle、却要求 bundle 注册那个旧 id —— 只注册一个 id 就会在启动时报
 * `bundle ... loaded without registering "<id>"`。多注册几个是**防御性兼容**:
 * 重复注册由 try/catch 吞掉(官方对同 id 二次注册是抛错的)。
 */
const REGISTER_IDS = [
  '@local/dsh-console-tap-ui',
  '@local/dsh-console-tap',
  '@local/dsh-console-tap2',
  '@local/dsh-console-tap3',
  '@local/dsh-console-tap4',
];

const moduleFactory = (require) => {
    const React = require('react');
    const ReactDOMClient = require('react-dom/client');
    const h = React.createElement;

    // ==================== 一、纯逻辑:帧 → 终端画面(可单独测试) ====================

    /** 每条命令在内存里保留的最大行数(超出丢最旧的)。 */
    const MAX_LINES = 3000;
    /** 单行长度上限(超长行从头部丢,保留尾部)。 */
    const MAX_LINE_CHARS = 2000;

    /** 去掉 ANSI 转义序列(颜色/光标控制);保留文本。 */
    function stripAnsi(text) {
      return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
    }

    /** 造一个"每命令两块屏"的终端模型:处理 CR 覆盖、LF 换行、行数上限。 */
    /**
     * 终端画面:**光标感知**的迷你终端(与 APP 端 ui/ConsoleLogModels.kt 的 TerminalBuffer 同一套语义)。
     *
     * 为什么必须光标感知(实测):Gradle 的 rich 控制台画进度条**不是**用 `\r`,而是
     * `ESC[3A`(上移 3 行)+ `ESC[37D`(左移 37 列)+ `ESC[0K`(擦除本行到行尾)+ 新文本 + `ESC[2B`。
     * 单次构建 12KB 输出里:`ESC[1B`×72、`ESC[3A`×62、`ESC[2A`×58、`ESC[35D`×52、`ESC[0K`×43,
     * **`\r` 一次都没有**。把光标序列当垃圾丢掉,就把"原地重绘"退化成了"纯追加"——
     * 一行里会挤进几十个进度值(`11%…13%…16%…` 连成一片),完全不能看。
     */
    function createScreen() {
      return { lines: [''], row: 0, col: 0 };
    }

    /** 处理一个 CSI 序列(ESC[ 参数 终止字节)。 */
    function applyCsi(screen, params, final) {
      const first = parseInt(params.split(';')[0], 10);
      const n = Number.isFinite(first) && first > 0 ? first : 1;
      switch (final) {
        case 'A': screen.row = Math.max(0, screen.row - n); break;
        case 'B': screen.row += n; ensureRow(screen); break;
        case 'C': screen.col += n; break;
        case 'D': screen.col = Math.max(0, screen.col - n); break;
        case 'E': screen.row += n; screen.col = 0; ensureRow(screen); break;
        case 'F': screen.row = Math.max(0, screen.row - n); screen.col = 0; break;
        case 'G': screen.col = n - 1; break;
        case 'H':
        case 'f': {
          const parts = params.split(';');
          screen.row = Math.max(0, (parseInt(parts[0], 10) || 1) - 1);
          screen.col = Math.max(0, (parseInt(parts[1], 10) || 1) - 1);
          ensureRow(screen);
          break;
        }
        case 'K': eraseLine(screen, Number.isFinite(first) ? first : 0); break;
        case 'J': eraseDisplay(screen, Number.isFinite(first) ? first : 0); break;
        default: break; // SGR(m)/私有模式(?25l)等忽略
      }
    }

    function ensureRow(screen) {
      while (screen.lines.length <= screen.row) screen.lines.push('');
    }

    function eraseLine(screen, mode) {
      if (screen.row >= screen.lines.length) return;
      const line = screen.lines[screen.row];
      if (mode === 2) screen.lines[screen.row] = '';
      else if (mode === 1) screen.lines[screen.row] = ' '.repeat(Math.min(screen.col, line.length)) + line.slice(screen.col);
      else screen.lines[screen.row] = line.slice(0, screen.col);
    }

    function eraseDisplay(screen, mode) {
      if (mode === 2) {
        screen.lines = [''];
        screen.row = 0;
        screen.col = 0;
        return;
      }
      if (mode === 1) {
        for (let i = 0; i < Math.min(screen.row, screen.lines.length); i += 1) screen.lines[i] = '';
        eraseLine(screen, 1);
        return;
      }
      eraseLine(screen, 0);
      screen.lines.length = Math.min(screen.lines.length, screen.row + 1);
      ensureRow(screen);
    }

    /** 写入画面。跨帧半个转义序列由调用方通过 screen.pending 缓存(见 writeScreen)。 */
    function writeScreen(screen, text) {
      const s = (screen.pending || '') + text;
      screen.pending = '';
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '\u001b') {
          const next = s[i + 1];
          if (next === undefined) { screen.pending = s.slice(i); break; }
          if (next === '[') {
            let j = i + 2;
            let params = '';
            while (j < s.length && s[j] >= '0' && s[j] <= '?') { params += s[j]; j += 1; }
            while (j < s.length && s[j] >= ' ' && s[j] <= '/') j += 1;
            if (j >= s.length) { screen.pending = s.slice(i); break; }
            applyCsi(screen, params, s[j]);
            i = j + 1;
            continue;
          }
          if (next === ']') { // OSC 到 BEL 或 ESC \
            let j = i + 2;
            while (j < s.length && s[j] !== '\u0007') {
              if (s[j] === '\u001b' && s[j + 1] === '\\') break;
              j += 1;
            }
            if (j >= s.length) { screen.pending = s.slice(i); break; }
            i = j + 1;
            continue;
          }
          i += 2;
          continue;
        }
        if (ch === '\r') {
          screen.col = 0;
        } else if (ch === '\n') {
          screen.row += 1;
          screen.col = 0;
          ensureRow(screen);
        } else if (ch === '\b') {
          if (screen.col > 0) screen.col -= 1;
        } else if (ch >= ' ') {
          ensureRow(screen);
          const line = screen.lines[screen.row];
          if (screen.col < line.length) {
            screen.lines[screen.row] = line.slice(0, screen.col) + ch + line.slice(screen.col + 1);
          } else {
            screen.lines[screen.row] = line + ' '.repeat(Math.max(0, screen.col - line.length)) + ch;
          }
          screen.col += 1;
        }
        i += 1;
      }
      // 行数上限:从头部丢(尾部才有用),并把光标行号同步左移
      while (screen.lines.length > MAX_LINES) {
        screen.lines.shift();
        screen.row = Math.max(0, screen.row - 1);
        screen.truncated = true;
      }
      // 单行长度上限:只裁当前行(不能拿整段 chunk 截断 —— 那样一次大输出会被整块砍掉)
      const cur = screen.lines[screen.row];
      if (cur && cur.length > MAX_LINE_CHARS) {
        const cut = cur.length - MAX_LINE_CHARS;
        screen.lines[screen.row] = cur.slice(cut);
        screen.col = Math.max(0, screen.col - cut);
      }
    }

    /** 从画面里找"进度状态行"(Gradle rich 控制台的真实百分比行)。 */
    const STATUS_RE = /<\s*[-=]+>\s*(\d+)%\s*([A-Z]+)\s*\[([^\]]+)\]/;
    function statusOf(lines) {
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i -= 1) {
        const m = STATUS_RE.exec(lines[i] ?? '');
        if (m !== null) return { percent: Number(m[1]), phase: m[2], elapsed: m[3], line: lines[i] };
      }
      return null;
    }

    /** 命令列表的展示字段。 */
    function commandLabel(command) {
      const first = String(command ?? '').split('\n')[0];
      return first.length > 90 ? `${first.slice(0, 90)}…` : first;
    }

    /**
     * 帧消费器:与 React 解耦(纯对象),便于单测与"非 React 环境"复用。
     * 用法:feed.handle(frame) → 变化时返回 true(调用方据此触发重渲染)。
     */
    function createFeed() {
      const commands = new Map();
      let order = [];
      let version = 0;
      const listeners = new Set();

      function notify() {
        version += 1;
        for (const listener of listeners) listener();
      }

      function ensure(id) {
        let entry = commands.get(id);
        if (entry === undefined) {
          entry = {
            id,
            command: '',
            argv: [],
            cwd: '',
            tool: '',
            sessionId: '',
            callId: '',
            confidence: 'none',
            startedAt: Date.now(),
            endedAt: null,
            exitCode: null,
            signal: null,
            ms: 0,
            bytes: { stdout: 0, stderr: 0 },
            screens: { stdout: createScreen(), stderr: createScreen() },
            gaps: [],
            logPath: null,
          };
          commands.set(id, entry);
          order = [...order, id];
        }
        return entry;
      }

      return {
        handle(frame) {
          if (frame === null || typeof frame !== 'object') return false;
          if (frame.type === 'hello') {
            for (const live of frame.live ?? []) {
              const entry = ensure(live.id);
              Object.assign(entry, live, { screens: entry.screens, bytes: entry.bytes });
            }
            notify();
            return true;
          }
          if (frame.type === 'command-start') {
            const entry = ensure(frame.id);
            Object.assign(entry, {
              command: frame.command ?? '',
              argv: frame.argv ?? [],
              cwd: frame.cwd ?? '',
              tool: frame.tool ?? '',
              sessionId: frame.sessionId ?? '',
              callId: frame.callId ?? '',
              confidence: frame.confidence ?? 'none',
              startedAt: frame.at ?? Date.now(),
              logPath: frame.logPath ?? null,
            });
            notify();
            return true;
          }
          if (frame.type === 'chunk') {
            const entry = ensure(frame.id);
            const stream = frame.stream === 'stderr' ? 'stderr' : 'stdout';
            writeScreen(entry.screens[stream], String(frame.text ?? ''));
            entry.bytes = { ...entry.bytes, [stream]: frame.seq ?? entry.bytes[stream] };
            notify();
            return true;
          }
          if (frame.type === 'gap') {
            const entry = ensure(frame.id);
            entry.gaps = [...entry.gaps, frame];
            writeScreen(
              entry.screens[frame.stream === 'stderr' ? 'stderr' : 'stdout'],
              `\n[缺口 ${frame.fromByte}→${frame.toByte}:${frame.note ?? ''}]\n`,
            );
            notify();
            return true;
          }
          if (frame.type === 'command-end') {
            const entry = ensure(frame.id);
            Object.assign(entry, {
              endedAt: frame.at ?? Date.now(),
              exitCode: frame.exitCode ?? null,
              signal: frame.signal ?? null,
              ms: frame.ms ?? 0,
              bytes: frame.bytes ?? entry.bytes,
              logPath: frame.logPath ?? entry.logPath,
            });
            notify();
            return true;
          }
          if (frame.type === 'snapshot') {
            const entry = ensure(frame.id);
            const stream = frame.stream === 'stderr' ? 'stderr' : 'stdout';
            entry.screens[stream] = createScreen();
            writeScreen(entry.screens[stream], String(frame.text ?? ''));
            notify();
            return true;
          }
          return false;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getVersion: () => version,
        list: () => order.map((id) => commands.get(id)).filter(Boolean),
        get: (id) => commands.get(id) ?? null,
        clear: () => {
          commands.clear();
          order = [];
          notify();
        },
      };
    }

    // ==================== 二、WebSocket 连接(自动重连) ====================

    function createConnection(feed, onStatus) {
      let socket = null;
      let closed = false;
      let retry = 0;
      let timer = null;

      function url() {
        const scheme = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws';
        return `${scheme}://${globalThis.location?.host ?? '127.0.0.1:3080'}/api/console`;
      }

      function connect() {
        if (closed) return;
        onStatus('connecting');
        try {
          socket = new WebSocket(url());
        } catch {
          schedule();
          return;
        }
        socket.onopen = () => {
          retry = 0;
          onStatus('open');
        };
        socket.onmessage = (event) => {
          try {
            feed.handle(JSON.parse(String(event.data)));
          } catch {
            /* 坏帧忽略 */
          }
        };
        socket.onclose = () => {
          onStatus('closed');
          schedule();
        };
        socket.onerror = () => {
          try {
            socket.close();
          } catch {}
        };
      }

      function schedule() {
        if (closed) return;
        retry += 1;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(retry, 5));
        timer = setTimeout(connect, delay);
      }

      connect();
      return {
        requestSnapshot(id, stream) {
          try {
            if (socket !== null && socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'snapshot-request', id, stream }));
            }
          } catch {}
        },
        dispose() {
          closed = true;
          if (timer !== null) clearTimeout(timer);
          try {
            socket?.close();
          } catch {}
        },
      };
    }

    // ==================== 三、样式(内联注入,避免依赖构建) ====================

    const CSS = `
.dsh-ct-launcher{position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:6px;
  padding:7px 12px;border-radius:18px;border:1px solid rgba(140,150,170,.45);background:rgba(22,26,34,.92);color:#e6ecf5;
  font:500 12px/1.2 system-ui,-apple-system,"Noto Sans SC",sans-serif;cursor:pointer;backdrop-filter:blur(6px)}
.dsh-ct-launcher:hover{background:rgba(34,40,52,.95)}
.dsh-ct-dot{width:8px;height:8px;border-radius:50%;background:#8a93a5}
.dsh-ct-dot.open{background:#2e9e5b}
.dsh-ct-win{position:fixed;right:14px;bottom:58px;z-index:2147483000;display:flex;flex-direction:column;
  width:min(760px,94vw);height:min(520px,74vh);border-radius:12px;overflow:hidden;border:1px solid rgba(140,150,170,.4);
  background:#12161d;color:#e6ecf5;box-shadow:0 18px 48px rgba(0,0,0,.55);
  font:12px/1.45 system-ui,-apple-system,"Noto Sans SC",sans-serif}
.dsh-ct-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#171c25;border-bottom:1px solid rgba(140,150,170,.25);cursor:move}
.dsh-ct-title{font-weight:600}
.dsh-ct-btn{border:1px solid rgba(140,150,170,.4);background:transparent;color:#c9d4e2;border-radius:6px;
  padding:3px 8px;font:inherit;cursor:pointer}
.dsh-ct-btn:hover{background:rgba(255,255,255,.06)}
.dsh-ct-btn.on{background:#2b3a5c;border-color:#4d6bfe;color:#fff}
.dsh-ct-spacer{flex:1}
.dsh-ct-body{display:flex;flex:1;min-height:0}
.dsh-ct-list{width:230px;border-right:1px solid rgba(140,150,170,.25);overflow:auto;padding:6px}
.dsh-ct-item{display:flex;gap:6px;align-items:flex-start;padding:6px 7px;border-radius:7px;cursor:pointer}
.dsh-ct-item:hover{background:rgba(255,255,255,.05)}
.dsh-ct-item.sel{background:rgba(77,107,254,.22)}
.dsh-ct-cmd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}
.dsh-ct-meta{color:#8a93a5;font-size:10px;margin-top:2px}
.dsh-ct-out{flex:1;min-width:0;display:flex;flex-direction:column}
.dsh-ct-pre{flex:1;margin:0;padding:8px 10px;overflow:auto;white-space:pre-wrap;word-break:break-all;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.45;background:#0d1015}
.dsh-ct-stderr{color:#e5a33d}
.dsh-ct-bar{display:flex;align-items:center;gap:8px;padding:5px 10px;border-top:1px solid rgba(140,150,170,.25);background:#171c25}
.dsh-ct-empty{padding:16px;color:#8a93a5;text-align:center}
.dsh-ct-progress{flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden}
.dsh-ct-progress > i{display:block;height:100%;background:#4d6bfe}
`;

    function ensureStyle(tagId) {
      if (document.querySelector(`style[data-dsh-plugin-css="${tagId}"]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.dshPluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ==================== 四、React 界面 ====================

    function ConsoleApp(props) {
      const feed = props.feed;
      const [, forceRender] = React.useState(0);
      const [selected, setSelected] = React.useState(null);
      const [follow, setFollow] = React.useState(true);
      const [showStderr, setShowStderr] = React.useState(false);
      const [status, setStatus] = React.useState('connecting');
      const preRef = React.useRef(null);

      // 帧驱动的重渲染:120ms 合批,避免构建日志刷爆 React
      React.useEffect(() => {
        let dirty = false;
        let timer = null;
        const unsubscribe = feed.subscribe(() => {
          dirty = true;
          if (timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            if (dirty) {
              dirty = false;
              forceRender((v) => v + 1);
            }
          }, 120);
        });
        return () => {
          unsubscribe();
          if (timer !== null) clearTimeout(timer);
        };
      }, [feed]);

      React.useEffect(() => {
        props.onStatus = setStatus;
      }, [props, setStatus]);

      const list = feed.list();
      const current = selected !== null ? feed.get(selected) : list[list.length - 1] ?? null;

      React.useEffect(() => {
        if (!follow || preRef.current === null) return;
        preRef.current.scrollTop = preRef.current.scrollHeight;
      }, [feed.getVersion(), follow, current?.id]);

      const stream = showStderr ? 'stderr' : 'stdout';
      const lines = current !== null ? current.screens[stream].lines : [];
      const progress = current !== null ? statusOf(lines) : null;
      const text = lines.join('\n');

      return h(
        'div',
        { className: 'dsh-ct-win' },
        h(
          'div',
          { className: 'dsh-ct-head', onMouseDown: makeDragHandler() },
          h('span', { className: `dsh-ct-dot ${status === 'open' ? 'open' : ''}` }),
          h('span', { className: 'dsh-ct-title' }, '控制台'),
          h('span', { className: 'dsh-ct-meta' }, `${list.length} 条命令${status === 'open' ? '' : '(未连接)'}`),
          h('span', { className: 'dsh-ct-spacer' }),
          h('button', { className: `dsh-ct-btn ${follow ? 'on' : ''}`, onClick: () => setFollow((v) => !v) }, '跟随最新'),
          h('button', { className: 'dsh-ct-btn', onClick: () => props.onCopy(text) }, '复制'),
          h('button', { className: 'dsh-ct-btn', onClick: () => feed.clear() }, '清屏'),
          h('button', { className: 'dsh-ct-btn', onClick: props.onClose }, '×'),
        ),
        h(
          'div',
          { className: 'dsh-ct-body' },
          h(
            'div',
            { className: 'dsh-ct-list' },
            list.length === 0
              ? h('div', { className: 'dsh-ct-empty' }, '还没有命令输出')
              : list
                  .slice()
                  .reverse()
                  .map((entry) =>
                    h(
                      'div',
                      {
                        key: entry.id,
                        className: `dsh-ct-item ${current !== null && current.id === entry.id ? 'sel' : ''}`,
                        onClick: () => setSelected(entry.id),
                      },
                      h('span', {
                        className: 'dsh-ct-dot',
                        style: { background: entry.endedAt === null ? '#2e9e5b' : entry.exitCode === 0 ? '#8a93a5' : '#e5484d' },
                      }),
                      h(
                        'div',
                        { style: { minWidth: 0, flex: 1 } },
                        h('div', { className: 'dsh-ct-cmd' }, commandLabel(entry.command) || entry.id),
                        h(
                          'div',
                          { className: 'dsh-ct-meta' },
                          `${entry.tool || 'proc'}${entry.sessionId ? ` · ${entry.sessionId.slice(-8)}` : ''}` +
                            `${entry.endedAt === null ? ' · 运行中' : ` · ${Math.round(entry.ms / 100) / 10}s · exit ${entry.exitCode ?? entry.signal ?? '?'}`}`,
                        ),
                      ),
                    ),
                  ),
          ),
          h(
            'div',
            { className: 'dsh-ct-out' },
            h('pre', { className: 'dsh-ct-pre', ref: preRef }, text.length > 0 ? text : '（等待输出…）'),
            h(
              'div',
              { className: 'dsh-ct-bar' },
              progress !== null
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'dsh-ct-meta' }, `${progress.percent}% ${progress.phase} ${progress.elapsed}`),
                    h('span', { className: 'dsh-ct-progress' }, h('i', { style: { width: `${progress.percent}%` } })),
                  )
                : h('span', { className: 'dsh-ct-meta' }, current === null ? '—' : `${current.bytes.stdout} B`),
              h('span', { className: 'dsh-ct-spacer' }),
              current !== null && current.gaps.length > 0
                ? h('span', { className: 'dsh-ct-meta', title: '有缺失字节,已尽量用 spill 文件补齐' }, `缺口 ${current.gaps.length}`)
                : null,
              h(
                'button',
                { className: `dsh-ct-btn ${showStderr ? 'on' : ''}`, onClick: () => setShowStderr((v) => !v) },
                'stderr',
              ),
            ),
          ),
        ),
      );
    }

    /** 头部拖动:纯 DOM 改 style(left/top),不参与 React 状态。 */
    function makeDragHandler() {
      return (event) => {
        const win = event.currentTarget.parentElement;
        if (win === null) return;
        const rect = win.getBoundingClientRect();
        const dx = event.clientX - rect.left;
        const dy = event.clientY - rect.top;
        const move = (e) => {
          win.style.left = `${e.clientX - dx}px`;
          win.style.top = `${e.clientY - dy}px`;
          win.style.right = 'auto';
          win.style.bottom = 'auto';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      };
    }

    function ConsoleRoot() {
      const [open, setOpen] = React.useState(false);
      const feedRef = React.useRef(null);
      const connRef = React.useRef(null);
      const statusRef = React.useRef('connecting');
      if (feedRef.current === null) feedRef.current = createFeed();

      React.useEffect(() => {
        const conn = createConnection(feedRef.current, (s) => {
          statusRef.current = s;
        });
        connRef.current = conn;
        return () => conn.dispose();
      }, []);

      const list = feedRef.current.list();
      const running = list.filter((entry) => entry.endedAt === null).length;

      return h(
        React.Fragment,
        null,
        open
          ? h(ConsoleApp, {
              feed: feedRef.current,
              onClose: () => setOpen(false),
              onCopy: (text) => {
                try {
                  navigator.clipboard?.writeText(text);
                } catch {}
              },
            })
          : null,
        h(
          'button',
          { className: 'dsh-ct-launcher', onClick: () => setOpen((v) => !v) },
          h('span', { className: `dsh-ct-dot ${statusRef.current === 'open' ? 'open' : ''}` }),
          `控制台${running > 0 ? ` · ${running}` : ''}`,
        ),
      );
    }

    // ==================== 五、挂载(独立 React root,挂在 body 上) ====================

    function mount() {
      ensureStyle('@local/dsh-console-tap/window.css');
      const container = document.createElement('div');
      container.setAttribute('data-dsh-console-tap', '');
      document.body.appendChild(container);
      const root = ReactDOMClient.createRoot(container);
      root.render(h(ConsoleRoot));
      return () => {
        try {
          root.unmount();
        } catch {}
        container.remove();
      };
    }

    function apply(ctx) {
      // 全局单实例:同一个页面可能因多行/多次 apply 而重复挂载 → 只保留第一个窗口。
      const FLAG = '__DSH_CONSOLE_TAP_MOUNTED__';
      if (window[FLAG] === true) return;
      window[FLAG] = true;
      ctx.effect(() => {
        const dispose = mount();
        return () => {
          window[FLAG] = false;
          dispose();
        };
      }, 'console-tap: 悬浮控制台');
    }

    const inject = [];
    const name = 'console-tap';

    return { apply, inject, name, createFeed, createScreen, writeScreen, statusOf, commandLabel };
};

for (const id of REGISTER_IDS) {
  try {
    window.__ModuleLoader__.load({ id, factory: moduleFactory });
  } catch (error) {
    // 同 id 二次注册(或该 id 已被别的 bundle 占用)不影响其它 id
  }
}
