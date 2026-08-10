// 本喵是 LAN 广播小喇叭 + 状态缓存小管家喵~ (扛着大喇叭到处喊)
// 两件大事:
//   1) 周期性向 LAN 多播 "[MOTD]...[/MOTD][AD]端口[/AD]",
//      让同局域网的MC客户端能自动发现本代理喵~
//   2) 周期性去问EaglerCraft服务器一趟MOTD,
//      缓存下来给bridge的STATUS请求喂(省得每次都现连喵)
//   另外还维护"代理玩家列表"(把延迟/在线人数/内存/运行时间塞进player sample里)

'use strict';

const dgram = require('dgram');
const {
  queryMotd,
  eaglerMotdToVanillaServerInfo
} = require('./query');

// 多播小喇叭多久响一次喵(1.5秒)
const BROADCAST_INTERVAL_MS = 1500;
// 连续失败几次之后就懒得喵喵叫了,改成静默重试喵
const FAIL_WARN_THRESHOLD = 5;

// 默认的多播组地址喵(MC客户端认这个组能找服务器)
const DEFAULT_GROUP = '224.0.2.60';
// 默认的多播端口喵
const DEFAULT_PORT = 4445;
// 默认MOTD缓存多久刷新一次喵
const DEFAULT_REFRESH_MS = 10000;
// 连不上目标时显示的占位MOTD喵
const PLACEHOLDER_MOTD = '§4无法连接到目标Eaglercraft服务器';

// LAN广播的运行态喵(没启动就是null)
let state = null;
// 代理层面维护的"正在用本代理连的玩家"们喵
let proxyState = null;

// 本代理进程启动的那一刻喵(用来算uptime展示给主人看)
const PROXY_START_HR = process.hrtime();

// 有新玩家通过本代理进服务器了,登记一下喵~
// 返回一个id,以后注销时拿这个id来对号喵
function registerAdapterPlayer(name) {
  if (!proxyState) proxyState = { adapterPlayers: new Map(), adapterSeq: 0 };
  const id = ++proxyState.adapterSeq;
  proxyState.adapterPlayers.set(id, String(name || ''));
  return id;
}

// 玩家离开了,把它的名额撤销喵~(没事干就空操作)
function unregisterAdapterPlayer(id) {
  if (!proxyState || id == null) return;
  proxyState.adapterPlayers.delete(id);
}

// 根据延迟(ms)返回对应的"颜色代码"喵(看着MC的player sample就知道连得稳不稳)
//   <150 绿色(好)→<300 黄色→<600 橙色→<1000 红色→更久就深红喵
function rttFormat(rttMs) {
  if (typeof rttMs !== 'number' || rttMs < 0) return '§7';
  if (rttMs < 150) return '§a';
  if (rttMs < 300) return '§e§l';
  if (rttMs < 600) return '§6§l';
  if (rttMs < 1000) return '§c§l§n';
  return '§4§l§n';
}

// 拼装要塞进player sample的"额外信息条"喵~
// (本喵把代理状态信息伪装成一堆假玩家,这样客户端的服务器列表里能看到喵)
// parsed是查到的MOTD信息(可为null,就按0处理),rttMs是这次到服务器的延迟喵
function buildSampleExtras(parsed, rttMs) {
  const online = parsed && typeof parsed.online === 'number' ? parsed.online : 0;
  const max = parsed && typeof parsed.max === 'number' ? parsed.max : 0;
  // 当前通过本代理连着的玩家名字们喵~ 一个都没有就放"§1§m滚木"凑数
  const adapterNames = proxyState && proxyState.adapterPlayers ?
    Array.from(proxyState.adapterPlayers.values()) : [];
  const displayNames = adapterNames.length ? adapterNames : ['§1§m滚木'];
  const fmt = rttFormat(rttMs);
  const rtt = typeof rttMs === 'number' ? fmt + rttMs + 'ms' : fmt + 'N/A';
  const uptimeSec = process.hrtime(PROXY_START_HR)[0];
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  // 一组装饰用的"伪玩家"信息条喵~ 每条{name, id}对应sample里一格
  const extras = [
    { name: '§lIMC-Proxy', id: padSeq(0) },
    { name: '§7延迟:§f ' + rtt, id: padSeq(1) },
    { name: '§7在线人数:§f ' + online + ' / ' + max, id: padSeq(2) },
    { name: '§7代理人数:§f ' + adapterNames.length, id: padSeq(3) },
    { name: '§7运行时间:§f ' + formatUptime(uptimeSec), id: padSeq(4) },
    { name: '§7占用内存:§f ' + rssMb.toFixed(1) + 'MB', id: padSeq(5) },
    { name: '§8---- 代理玩家列表 ----', id: padSeq(6) }];

  // 后面接着把当前代理玩家也都列上去喵~ id接着编号
  let i = 7;
  for (const nm of displayNames) {
    extras.push({ name: '§f' + nm, id: padSeq(i) });
    i++;
  }
  return extras;
}

// 把序号 i 包装成一个固定的UUID字符串喵(在player sample里能稳定占位)
// 前12段全是0,最后一段塞i,看起来就是个合规UUID喵
function padSeq(i) {
  const s = String(i & 0xffffff).padStart(8, '0');
  return '00000000-0000-0000-0000-' + s;
}

// 把秒数格式化成 "1s" / "2m 3s" / "1h 2m" / "1d 3h" 这种人话喵
function formatUptime(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return h + 'h ' + mm + 'm';
  const d = Math.floor(h / 24), hh = h % 24;
  return d + 'd ' + hh + 'h';
}

// 启动LAN广播喵~ (cfg配着logger一起喂进来)
function startLanBroadcaster(cfg, baseLog) {
  // 已经在跑了就别再起一遍喵(避免重复刷屏)
  if (state) {
    baseLog.warn('LAN 广播已在运行,忽略重复 start');
    return;
  }
  const lan = cfg && cfg.lan || {};
  if (lan.broadcast !== true) {
    baseLog.info('LAN 广播未启用 (config.lan.broadcast=false)');
    return;
  }
  const group = lan.group || DEFAULT_GROUP;
  const port = typeof lan.port === 'number' && lan.port || DEFAULT_PORT;
  const refreshMs = lan.refreshMs || DEFAULT_REFRESH_MS;
  const cfgPort = String(cfg.listen.port);

  // 监听地址要是只绑了环回,同LAN的客户端点进来会connection refused喵~ 提醒一下主人
  const lh = String(cfg.listen.host || '');
  if (lh === '127.0.0.1' || lh === 'localhost' || lh === '::1' || lh === '::1/128') {
    baseLog.warn('LAN 广播已开但 listen.host=' + lh + ' 仅绑环回, 同 LAN 客户端点入会 Connection refused。' +
      '请在 config.json 设 listen.host 为 "0.0.0.0"(或本机 LAN IP)。');
  }

  // 开个UDP4的socket当小喇叭喵(设成unref,这样进程不会被它拖着不退出)
  const socket = dgram.createSocket('udp4');
  socket.unref();
  socket.on('error', (e) => {
    // 小喇叭自己也得听着错误喵(网络毛病先记下来)
    baseLog.warn('LAN 广播 socket error:', e && e.message ? e.message : e);
  });

  // 把所有运行态存进state喵(待会儿广播/刷新都用它)
  state = {
    socket,
    broadcastTimer: null,
    refreshTimer: null,
    cfg,
    motdCache: PLACEHOLDER_MOTD,
    parsedCache: null,
    lastRttMs: null,
    failCount: 0,
    group,
    port,
    cfgPort,
    log: baseLog,
    running: true
  };

  // 先喵一声(立刻广播一次),再挂1.5秒一次的定时广播喵
  sendAd();
  state.broadcastTimer = setInterval(sendAd, BROADCAST_INTERVAL_MS);
  state.broadcastTimer.unref();

  // 同时起一个MOTD缓存刷新定时器喵(先现刷一次,后面按refreshMs重复)
  refreshLanMotd(cfg, baseLog).catch(() => {
  });
  state.refreshTimer = setInterval(() => {
    refreshLanMotd(cfg, baseLog).catch(() => {});
  }, refreshMs);
  state.refreshTimer.unref();

  baseLog.info('LAN 广播已启动: ' + group + ':' + port + ' → 广播本机 :' + cfgPort);
}

// 去问一趟EaglerCraft服务器的MOTD,刷新到缓存里喵~
// (失败就清缓存,下次有STATUS请求时让bridge自己现查)
async function refreshLanMotd(cfg, baseLog) {
  if (!state || !state.running) return;
  const t0 = process.hrtime();
  try {
    const parsed = await queryMotd(cfg.target, baseLog);
    // 算这次MOTD查询花了多久喵(算作"延迟"塞进sample)
    const dtMs = Math.round(process.hrtime(t0)[0] * 1e3 + process.hrtime(t0)[1] / 1e6);
    const info = eaglerMotdToVanillaServerInfo(parsed);
    const text = String(info && info.description || '').replace(/\n/g, ' ').trim();
    // 刷出来的MOTD是空的?那就清掉缓存,免得喂旧空内容喵
    if (!text) {
      baseLog.warn('LAN MOTD 快照为空,清空缓存(下次 ping 自查)');
      state.parsedCache = null;
      state.lastRttMs = null;
      state.motdCache = PLACEHOLDER_MOTD;
      return;
    }
    // 一切正常喵~ 缓存设上,延迟记上
    state.motdCache = text;
    state.parsedCache = parsed;
    state.lastRttMs = dtMs;
    state.refreshEmptyCount = 0;
  } catch (e) {
    // 查MOTD失败了喵~ 先清缓存,第一次失败才warn一下,后面就只debug躲着主人念叨
    if (!state) return;
    state.parsedCache = null;
    state.lastRttMs = null;
    state.motdCache = PLACEHOLDER_MOTD;
    state.refreshEmptyCount = (state.refreshEmptyCount || 0) + 1;
    if (state.refreshEmptyCount === 1) {
      baseLog.warn('MOTD 快照刷新失败(已清缓存,下次 ping 自查):', e && e.message || e);
    } else {
      baseLog.debug('MOTD 快照刷新仍失败(已清缓存):', e && e.message || e);
    }
  }
}

// 实际向多播组喊一嗓子广告喵~ (内容是 [MOTD]...[/MOTD][AD]端口[/AD])
function sendAd() {
  if (!state || !state.running) return;
  const s = state;
  const payload = Buffer.from(
    '[MOTD]' + s.motdCache.replace(/\n/g, ' ') + '[/MOTD][AD]' + s.cfgPort + '[/AD]',
    'utf8'
  );
  s.socket.send(payload, 0, payload.length, s.port, s.group, (err) => {
    if (err) {
      fail(err);
    } else {
      // 成功一次就清零失败计数喵(满血复活!)
      s.failCount = 0;
    }
  });
}

// 广播发送失败时的处理喵~ (失败次数渐增,警告逐步加码,最后静默重试)
function fail(err) {
  if (!state) return;
  const s = state;
  const n = s.failCount + 1;
  s.failCount = n;
  if (n === 1) {
    // 第一次失败:嚎一嗓子,顺手再刷一次MOTD喵(让缓存别那么旧)
    s.log.warn('LAN 广播发送失败:', err && err.message ? err.message : err);
    refreshLanMotd(s.cfg, s.log).catch(() => {});
  } else if (n < FAIL_WARN_THRESHOLD) {
    s.log.warn('LAN 广播发送失败,继续重试…');
  } else if (n === FAIL_WARN_THRESHOLD) {
    // 连续失败够多次了喵,之后就不吵了,改成静悄悄地重试到网络好为止
    s.log.error('LAN 广播连续失败,后续将静默重试直到网络修复。');
  }
}

// 把LAN广播整个停掉喵~ (SIGINT退出时调它,拔掉小喇叭)
function stopLanBroadcaster() {
  if (!state) return;
  const s = state;
  state = null;
  s.running = false;
  try {
    if (s.broadcastTimer) clearInterval(s.broadcastTimer);
  } catch (_) {}
  try {
    if (s.refreshTimer) clearInterval(s.refreshTimer);
  } catch (_) {}
  try {
    s.socket.close();
  } catch (_) {}
}

// 给bridgeSTATUS期喂缓存用的喵~ 有parsedCache才返回,否则返回null(让bridge自查)
// 把刚才缓存的好MOTD,加上额外的sample信息,直接组装成vanilla ServerInfo喵
function getStatusSnapshot(clientVerTag, versionOverride) {
  if (!state || !state.running) return null;
  const parsed = state.parsedCache;
  if (!parsed) return null;
  const sampleExtras = buildSampleExtras(parsed, state.lastRttMs);
  return eaglerMotdToVanillaServerInfo(parsed, clientVerTag, { versionOverride, sampleExtras });
}

module.exports = {
  startLanBroadcaster,
  stopLanBroadcaster,
  getStatusSnapshot,
  refreshLanMotd,
  registerAdapterPlayer,
  unregisterAdapterPlayer,
  buildProxySampleExtras: buildSampleExtras,
  _constants: {
    BROADCAST_INTERVAL_MS,
    DEFAULT_GROUP,
    DEFAULT_PORT,
    DEFAULT_REFRESH_MS,
    PLACEHOLDER_MOTD,
    FAIL_WARN_THRESHOLD
  },
  _buildPayload: buildPayload
};

// 构造LAN广播用的payload字节喵~ (单独抽出来方便测试,[MOTD]..[/MOTD][AD]端口[/AD])
// 这个函数故意放在 module.exports 后面,靠 JS 的函数提升也能正常 export 喵(原文设计)
function buildPayload(motdText, cfgPort) {
  return Buffer.from(
    '[MOTD]' + String(motdText).replace(/\n/g, ' ') + '[/MOTD][AD]' + String(cfgPort) + '[/AD]',
    'utf8'
  );
}
