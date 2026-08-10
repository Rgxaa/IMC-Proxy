// 本喵负责问EaglerCraft服务器要它的MOTD(服务器列表信息)喵~
// (眯眼探头~ 就像原版MC点"刷新服务器列表"时做的事)
// 流程是:连上ws → 发文本帧 "Accept: MOTD" → 服务器先回一个JSON
// {type:motd,data:{motd,online,max,players,icon}} →
// 如果JSON里icon=true,紧接着再来一帧16384字节的64x64 RGBA原图喵~
// 本喵还会顺手把Eagler风格的MOTD,翻译成原版MC看得懂的ServerInfo格式喵

'use strict';

const {
  connectEagler,
  disposeWs
} = require('./wsclient');
const {
  encodeRgbaPng
} = require('./png');

// MOTD查询最多等10秒喵,再不回就放弃(.MouseEvent都不给喵!)
const QUERY_TIMEOUT_MS = 10000;
// 一开始要发的文本帧内容喵(就这一句,服务器就知道本喵要MOTD啦)
const ACCEPT_FRAME = 'Accept: MOTD';
// 64x64 RGBA = 64*64*4 = 16384字节喵(服务器发的图标就是这个固定长度)
const ICON_BYTES = 16384;

// 把一摞监听器从ws上一个个摘下来喵~ (免得它们赖着不走)
function _offAll(ws, handlers) {
  for (const [ev, fn] of Object.entries(handlers)) {
    try {
      ws.off(ev, fn);
    } catch (_) {}
  }
}

// 主角登场!去target.query一趟MOTD回来喵~
// 回来的是一个 {envelope, motd, online, max, players, iconFlag, iconRgba}
// 失败就reject,本喵会让主人知道出了啥岔子喵
function queryMotd(target, L) {
  return new Promise((resolve, reject) => {
    let settled = false; // 已经定下来了就不再处理喵(避免重复resolve/reject)
    let timer = null;
    const state = {
      gotJson: false,  // JSON拿到没有喵
      parsed: null     // 拿到的原始parsed对象(等图标到齐再用)
    };

    const ws = connectEagler(target, L);
    const handlers = {};

    // 统一的收尾函数喵~ settle过就跳过,清timer摘监听器关ws,然后按要求resolve/reject
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      _offAll(ws, handlers);
      disposeWs(ws);
      try {
        ws.close();
      } catch (_) {}
      if (err) reject(err);
      else resolve(val);
    };

    // 一连上就发 "Accept: MOTD" 喵
    handlers.open = () => {
      L.debug('MOTD query 已发送 Accept: MOTD');
      try {
        ws.send(ACCEPT_FRAME, {
          binary: false
        });
      } catch (e) {
        finish(new Error('发送 Accept: MOTD 失败: ' + (e && e.message || e)));
      }
    };

    // 收到一帧喵~ 文本帧是JSON,二进制帧是图标原图
    handlers.message = (data, isBinary) => {
      if (settled) return;
      if (!isBinary) {
        // 文本帧:先trim干净再看喵
        const text = (Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).trim();

        // 服务器直接甩个 BLOCKED/LOCKED 上来,就是被限速了喵
        if (/^(BLOCKED|LOCKED)$/i.test(text)) {
          finish(new Error('服务器速率限制: ' + text));
          return;
        }
        // 试着按JSON解析这个文本喵
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          finish(new Error('MOTD JSON 解析失败: ' + (e && e.message || e)));
          return;
        }
        const t = parsed && parsed.type;
        // JSON里也有可能用"blocked"/"locked"表达限速喵
        if (t === 'blocked' || t === 'locked') {
          finish(new Error('服务器速率限制: type=' + t));
          return;
        }
        // 必须是motd类型喵,别的本喵都不接收
        if (t && t !== 'motd') {
          finish(new Error('意外 MOTD 响应类型: ' + t));
          return;
        }
        // 仔细检查data形状对不对喵(motd数组、online/max数字、players数组、icon布尔)
        const d = parsed && parsed.data;
        if (!d || !Array.isArray(d.motd) || typeof d.online !== 'number' ||
          typeof d.max !== 'number' || !Array.isArray(d.players) ||
          typeof d.icon !== 'boolean') {
          finish(new Error('MOTD 响应数据形状不符'));
          return;
        }
        state.gotJson = true;
        state.parsed = parsed;

        // 不带图标?直接收工,把icon置空喵
        if (d.icon !== true) {
          finish(null, _result(parsed, null));
        }

        return;
      }

      // 二进制帧: 必须是JSON先到 + JSON里说有图标,本喵才认它是图标喵
      if (!state.gotJson || !(state.parsed && state.parsed.data && state.parsed.data.icon === true)) {
        L.warn('MOTD: JSON 前收到意外二进制帧,忽略 len=', _bufLen(data));
        return;
      }
      const buf = _toBuffer(data);
      // 长度对不上16384?那图标坏了,本喵干脆省略favicon喵
      if (buf.length !== ICON_BYTES) {
        L.warn('MOTD: 图标帧长度异常 =', buf.length, '期望', ICON_BYTES, '→ 省略 favicon');
        finish(null, _result(state.parsed, null));
        return;
      }
      // 图标也到齐啦喵~ 真正收工!
      finish(null, _result(state.parsed, buf));
    };

    // 各种翻车事件喵~
    handlers.error = (e) => finish(new Error('ws 错误: ' + (e && e.message || e)));
    handlers.close = (code) => finish(new Error('ws 在 MOTD 响应前关闭 code=' + code));
    handlers.unexpectedResponse = (req, res) =>
      finish(new Error('ws unexpected-response status=' + (res && res.statusCode || 0)));

    // 把监听器一个个挂上去喵
    for (const [ev, fn] of Object.entries(handlers)) ws.on(ev, fn);

    // 起个10秒闹钟,到点还没结果就判超时喵
    timer = setTimeout(() => finish(new Error('MOTD query 超时')), QUERY_TIMEOUT_MS);
  });
}

// 瞄一眼这帧有多长喵~ (各种ArrayBuffer/Buffer/View都照顾到)
function _bufLen(data) {
  if (data == null) return 0;
  if (Buffer.isBuffer(data)) return data.length;
  if (data.byteLength != null) return data.byteLength;
  return -1;
}

// 把ws收到的各种形态转成Node的Buffer喵~ (ArrayBuffer/View/Buffer/别的)
function _toBuffer(data) {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

// 把 envelope + raw图标 包装成本喵对外的MOTD结果对象喵
function _result(parsed, iconRgba) {
  const d = parsed.data;
  return {
    envelope: parsed,
    motd: d.motd,
    online: d.online,
    max: d.max,
    players: d.players,
    iconFlag: d.icon === true,
    iconRgba: iconRgba || null
  };
}

// 把Eagler风格的MOTD翻译成原版MC的ServerInfo JSON喵~
// (这是给客户端看的那一坨:version/players.sample/description/favicon)
// opts里可以带 versionOverride(覆盖显示的版本名/协议号)和 sampleExtras(塞进player列表的小尾巴)
function eaglerMotdToVanillaServerInfo(parsed, clientVerTag, opts) {

  // opts可能是老式{name,protocol}也可能是{versionOverride,sampleExtras}喵~ 本喵都兼容
  let versionOverride = null,
    sampleExtras = null;
  if (opts && typeof opts === 'object') {
    if (typeof opts.name === 'string' || typeof opts.protocol === 'number') {
      versionOverride = opts;
    } else {
      versionOverride = opts.versionOverride || null;
      sampleExtras = Array.isArray(opts.sampleExtras) ? opts.sampleExtras : null;
    }
  }
  // 默认按1.8版本展示喵~
  let verName = '1.8.8',
    verProto = 47;
  if (clientVerTag === '1.12') {
    verName = '1.12.2';
    verProto = 340;
  }
  // 有versionOverride就用它覆盖版本展示信息喵
  if (versionOverride && typeof versionOverride === 'object') {
    if (typeof versionOverride.name === 'string') verName = versionOverride.name;
    if (typeof versionOverride.protocol === 'number') verProto = versionOverride.protocol;
  }
  // 服务器原始players列表,弄成{name,id}的样子喵(UUID先填占位的0)
  const baseSample = parsed.players.map((name) => ({
    name,
    id: '00000000-0000-0000-0000-000000000000'
  }));
  let sample = baseSample;
  // 要是有额外塞进来的sampleExtras,就用它们替代原始列表喵
  if (sampleExtras && sampleExtras.length) {
    sample = sampleExtras.map((e) => ({
      name: String(e && e.name != null ? e.name : ''),
      id: e && (e.uuid || e.id) || '00000000-0000-0000-0000-000000000000'
    })).filter((e) => e.name.length > 0);
  }
  // 组装最终ServerInfo喵~ (version + players + description)
  const info = {
    version: {
      name: verName,
      protocol: verProto
    },
    players: {
      max: parsed.max,
      online: parsed.online,
      sample
    },
    description: parsed.motd.join('\n') // motd数组用换行拼成一段喵
  };
  // 有图标就把它encode成PNG,再凑成base64的favicon数据URI喵~
  if (parsed.iconRgba) {
    info.favicon = 'data:image/png;base64,' + encodeRgbaPng(parsed.iconRgba, 64, 64).toString('base64');
  }
  return info;
}

module.exports = {
  queryMotd,
  eaglerMotdToVanillaServerInfo,
  QUERY_TIMEOUT_MS,
  ICON_BYTES
};
