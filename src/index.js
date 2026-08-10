// 本喵是整个imc-proxy的入口喵~
// 活儿是: 读配置 → 起一个本地TCP服务器(假装自己是原版MC服) → 监听端口,
//         每来一个连接就交给bridge.attachSocket去翻译成EaglerCraft的WebSocket喵~
//         顺便还会启动LAN广播(让同局域网客户端能自动发现本喵),
//         把目标地址解析一下打印给主人看,处理一下SIGINT和未捕获异常喵

'use strict';

const net = require('net');
const dns = require('dns');
const { URL } = require('url');
const { load } = require('./config');
const { createLogger } = require('./log');
const { attachSocket } = require('./bridge');
const { startLanBroadcaster, stopLanBroadcaster } = require('./broadcaster');

// 异步把目标URL里的域名解析成IP地址喵~ (纯展示给主人看,不影响后续连接)
// 是IP就直接返回,是域名就dns.lookup拿所有地址拼起来喵
function resolveTargetIpAsync(url) {
  return new Promise((resolve) => {
    let host;
    try { host = new URL(url).hostname; } catch (_) { return resolve(null); }
    // 看着像IPv4或IPv6的就用原样喵~ 不必再去查DNS
    if (/^[\d.]+$/.test(host) || /^[\da-f:]+$/i.test(host)) return resolve(host);
    dns.lookup(host, { all: true }, (e, addrs) => {
      if (e || !addrs || !addrs.length) return resolve(null);
      resolve(addrs.map((a) => a.address).filter(Boolean).join(', '));
    });
  });
}

// 主入口喵~
function main() {
  // 先把配置读进来喵
  const cfg = load();

  // 允许命令行 --log debug|info|warn|error 临时覆盖日志等级喵
  const ai = process.argv.indexOf('--log');
  if (ai !== -1 && process.argv[ai + 1] && ['debug', 'info', 'warn', 'error'].includes(process.argv[ai + 1])) {
    cfg.logLevel = process.argv[ai + 1];
  }

  // debug级别才会开启文本包转储喵(其它级别一概不浪费这个开销)
  cfg.dumpTextPackets = cfg.logLevel === 'debug';
  const logger = createLogger(cfg.logLevel);

  // 打出一组启动信息喵~ 让主人一眼看清当前配置
  logger.info('imc-proxy 启动(请使用或via转换成1.8.x或1.12.2连接)');
  logger.info('  监听     ' + cfg.listen.host + ':' + cfg.listen.port);
  logger.info('  目标     ' + cfg.target.url);
  logger.info('  Origin   ' + cfg.target.origin);
  logger.info('  eagler   v1_8: ' + cfg.eagler.v1_8.brand + ' ' + cfg.eagler.v1_8.version +
    ' | v1_12: ' + cfg.eagler.v1_12.brand + ' ' + cfg.eagler.v1_12.version);
  logger.info('  诊断     ' + (cfg.dumpTextPackets ? '文本包转储 ON (debug)' : '关'));

  // 顺手把目标解析成IP打印一下喵(失败不影响启动,连接时还会再试)
  resolveTargetIpAsync(cfg.target.url).then((ip) => {
    if (ip) logger.info('  目标解析 ' + ip);
    else logger.warn('  目标解析 失败(连接将于 EC侧 ws 建连时再试)');
  });

  // 起本地TCP服务器喵~ 每条新连接交给attachSocket去处理(它包了try/catch兜底)
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    try { attachSocket(socket, cfg, logger); }
    catch (e) {
      logger.error('attachSocket 异常:', e && e.stack ? e.stack : e);
      try { socket.destroy(); } catch (_) {}
    }
  });

  server.on('error', (e) => logger.error('net server error:', e && e.stack ? e.stack : e));

  // 真正开始监听,监听成功后再启动LAN广播喵(广播逻辑要用监听端口)
  server.listen(cfg.listen.port, cfg.listen.host, () => {
    try { startLanBroadcaster(cfg, logger); }
    catch (e) { logger.warn('LAN 广播启动异常(已忽略,继续运行):', e && e.message ? e.message : e); }
  });

  // 收到Ctrl+C就优雅停掉LAN广播然后退出喵(0表示没毛病)
  process.on('SIGINT', () => { logger.info('收到 SIGINT,退出'); try { stopLanBroadcaster(); } catch (_) {} process.exit(0); });
  // 未捕获异常喵~ 别让进程直接崩,先记到日志里(尽量活着)
  process.on('uncaughtException', (e) => logger.error('uncaughtException:', e && e.stack ? e.stack : e));
  // 未处理的Promise rejection喵~ 同样也记下来
  process.on('unhandledRejection', (r) => logger.error('unhandledRejection:', r));
}

main();
