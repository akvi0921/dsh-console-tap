#!/usr/bin/env node
/**
 * 控制台帧探针 —— 连上 /api/console 把帧打出来(排查"插件到底推没推"用它最快)。
 *
 * 用法:
 *   node tools/probe.mjs                       # 默认 ws://127.0.0.1:3080/api/console
 *   node tools/probe.mjs --port 3081 --json     # 另一端口 / 打成原始 JSON 行
 *   node tools/probe.mjs --text-only            # 只打印命令输出文本(像 tail -f)
 *
 * 零依赖:用 Node 内置的全局 WebSocket(Node 22+;Termux 的 Node 26 自带)。
 */
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : (argv[i + 1] ?? true);
};
const port = flag('--port', process.env.DSH_PORT ?? 3080);
const json = argv.includes('--json');
const textOnly = argv.includes('--text-only');
const path = flag('--path', '/api/console');
const url = `ws://127.0.0.1:${port}${path}`;

const c = { dim: '\u001b[2m', cyan: '\u001b[36m', yellow: '\u001b[33m', red: '\u001b[31m', reset: '\u001b[0m' };
const stamp = () => new Date().toISOString().slice(11, 23);

console.error(`${c.dim}连接 ${url} …${c.reset}`);
const ws = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${port}` } });

ws.addEventListener('open', () => console.error(`${c.dim}已连接,等待帧(Ctrl-C 退出)${c.reset}`));
ws.addEventListener('error', (event) => {
  console.error(`${c.red}连接错误${c.reset}: ${event?.message ?? '(检查 DSH Web 是否在跑、端口是否正确)'}`);
  process.exit(1);
});
ws.addEventListener('message', (event) => {
  let frame;
  try { frame = JSON.parse(String(event.data)); } catch { return; }
  if (json) { console.log(JSON.stringify(frame)); return; }
  switch (frame.type) {
    case 'hello':
      console.log(`${c.dim}[${stamp()}] hello  pollMs=${frame.pollMs} 在跑的命令=${(frame.live ?? []).length}${c.reset}`);
      for (const item of frame.live ?? []) console.log(`${c.yellow}  ▶ ${item.id} ${item.command}${c.reset}`);
      break;
    case 'command-start':
      console.log(`${c.cyan}[${stamp()}] $ ${frame.command}${c.reset}${c.dim}  (id=${frame.id} cwd=${frame.cwd} 身份=${frame.confidence ?? 'n/a'})${c.reset}`);
      break;
    case 'chunk':
      process.stdout.write(frame.stream === 'stderr' ? `${c.red}${frame.text}${c.reset}` : frame.text);
      break;
    case 'gap':
      console.log(`${c.yellow}[${stamp()}] ⚠ 缺口 ${frame.stream} ${frame.fromByte}→${frame.toByte} (${frame.note ?? frame.source})${c.reset}`);
      break;
    case 'command-end':
      console.log(`${c.dim}[${stamp()}] ■ 结束 id=${frame.id} exit=${frame.exitCode} 用时=${frame.ms}ms bytes=${JSON.stringify(frame.bytes)} log=${frame.logPath ?? '-'}${c.reset}`);
      break;
    default:
      if (!textOnly) console.log(`${c.dim}${JSON.stringify(frame)}${c.reset}`);
  }
});
