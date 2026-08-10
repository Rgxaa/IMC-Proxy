// 本喵负责建立到EaglerCraft服务器的WebSocket连接喵~
// (蹲在门口,准备跃到 wss://mc.smgoro.com 上去)
// 关键点:带上伪造的 Origin 头(骗过 originblacklist),关闭分片压缩,
// 连上之后每隔15秒喵一声 ws.ping() 保活,免得连接被服务器当死的踢掉喵

'use strict';

const WebSocket = require('ws');
const {
  createLogger
} = require('./log');

// 给本喵一个target({url, origin, headers}),本喵就建一条ws过去喵
function connectEagler(target, log) {
  const url = target.url;
  // 头部放上伪造的Origin和固定的User-Agent喵~ (主人额外写的headers也并进来)
  const headers = Object.assign({
    Origin: target.origin || '',
    'User-Agent': 'Mozilla/5.0 (imc-proxy)'
  },
  target.headers || {}
  );

  log.debug('连接 EaglerCraft 服务器:', url, 'Origin=', headers.Origin);

  // 真正的ws连接喵~ 关掉perMessageDeflate(避免和Eagler协议打架),握手15秒超时
  const ws = new WebSocket(url, {
    headers,
    perMessageDeflate: false,
    handshakeTimeout: 15000
  });

  // 连上之后启动15秒一次的ping保活计时器喵(没这手很容易被踢)
  let pingTimer = null;
  ws.on('open', () => {
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (_) {}
      }
    }, 15000);
    ws._imcPingTimer = pingTimer; // 存到ws身上,待会儿好清理喵
  });
  // 服务器回了pong,本喵啥也不做(收到就够啦喵)
  ws.on('pong', () => {
  });

  return ws;
}

// 收拾一条ws喵~ (把保活计时器停掉,免得它一直空跑)
function disposeWs(ws) {
  try {
    if (ws && ws._imcPingTimer) {
      clearInterval(ws._imcPingTimer);
      ws._imcPingTimer = null;
    }
  } catch (_) {}
}

module.exports = {
  connectEagler,
  disposeWs
};
