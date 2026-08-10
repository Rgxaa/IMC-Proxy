// 本喵是配置小管家喵~ (认真地翻看config.json小本本)
// 负责读取项目根目录的 config.json,把主人写的配置和默认值合在一起,
// 还要仔仔细细地检查每一项有没有写错喵~ 错了就立刻喵喵叫提醒主人!

'use strict';

const fs = require('fs');
const path = require('path');

// 默认配置喵~ 主人不写的话就用本喵这份贴心的预设
const DEFAULTS = {
  listen: { host: '0.0.0.0', port: 25565 },
  target: {
    url: 'wss://mc.smgoro.com',
    origin: 'https://mc.smgoro.com',
    headers: {}
  },

  // EaglerCraft 握手时冒充的网页客户端信息喵~
  // (单端口够用了喵,gameVers 字段决定具体伪装成哪个版本)
  eagler: {
    requestedServer: 'default',
    v1_8: { brand: 'EaglercraftX', version: 'u53' },
    v1_12: { brand: 'EaglercraftX', version: 'u24' }
  },
  logLevel: 'info',

  // LAN 多播广播的设置喵~ 让同局域网的客户端能自动发现本代理
  lan: { broadcast: true, refreshMs: 10000, group: '224.0.2.60', port: 4445 }
};

// 读取并解析一个配置文件喵~ 文件不存在或JSON坏了都要报告主人
function loadConfig(file) {
  // 没指定文件就用项目根目录的 config.json 喵
  const cfgPath = file || path.join(__dirname, '..', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (e) {
    throw new Error('无法读取配置文件 ' + cfgPath + ': ' + e.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // JSON 报错时顺便指出错在哪附近,体贴的喵~ (戳戳主人的错别字)
    const m = e.message.match(/position (\d+)/i);
    const hint = m ? '(位置 ' + m[1] + ' 附近: ' + raw.slice(Math.max(0, +m[1] - 30), +m[1] + 30).replace(/\n/g, '\\n') + ')' : '';
    throw new Error('配置 JSON 解析失败: ' + e.message + ' ' + hint);
  }
  return validateConfig(parsed);
}

// 把配置仔仔细细校验一遍再交出去喵~ 不许有坏配置混进来!
function validateConfig(cfg) {
  // 先拿一份默认值,再把主人的配置合进去(默认值兜底喵)
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  deepMerge(out, cfg || {});

  // 端口必须在合法范围喵(1~65535),不然后果很严重喵
  if (typeof out.listen.port !== 'number' || out.listen.port < 1 || out.listen.port > 65535) {
    throw new Error('config.listen.port 非法: ' + out.listen.port);
  }
  // 目标地址要以 ws:// 或 wss:// 开头喵
  if (!out.target.url || !/^wss?:\/\//.test(out.target.url)) {
    throw new Error('config.target.url 非法(需 ws:// 或 wss://): ' + out.target.url);
  }
  // 伪造的 Origin 头要以 http:// 或 https:// 开头喵
  if (!out.target.origin || !/^https?:\/\//.test(out.target.origin)) {
    throw new Error('config.target.origin 非法(需 http(s)://): ' + out.target.origin);
  }
  // 日志等级只认这四个喵~
  const lvl = String(out.logLevel).toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(lvl)) {
    throw new Error('config.logLevel 非法: ' + out.logLevel);
  }
  out.logLevel = lvl;

  // requestedServer 必须是字符串喵(类型检查)
  const req = out.eagler.requestedServer;
  if (req !== undefined && typeof req !== 'string') {
    throw new Error('config.eagler.requestedServer 必须为字符串');
  } else if (req === undefined) {
    out.eagler.requestedServer = 'default';
  }

  // 兼容旧版的扁平式 eagler.brand / version 喵~
  // (要是主人还在用旧写法,本喵帮它搬进 v1_8 里去)
  if (out.eagler.brand != null || out.eagler.version != null) {
    out.eagler.v1_8 = {
      brand: out.eagler.brand != null ? String(out.eagler.brand) : out.eagler.v1_8.brand,
      version: out.eagler.version != null ? String(out.eagler.version) : out.eagler.v1_8.version
    };
    delete out.eagler.brand;
    delete out.eagler.version;
  }
  normalizeEaglerVersionGroup(out.eagler, 'v1_8');
  normalizeEaglerVersionGroup(out.eagler, 'v1_12');

  // LAN 部分也单独校验一下喵
  out.lan = validateLan(out.lan);
  return out;
}

// 把两个版本组分别校验一遍喵~ (brand/version 都得是非空字符串才合格)
function normalizeEaglerVersionGroup(eg, key) {
  // 这一组没写?那就先用 v1_8 的顶上喵
  if (eg[key] == null) {
    eg[key] = { brand: eg.v1_8.brand, version: eg.v1_8.version };
    return;
  }
  // 必须是个对象喵,数组、字符串什么的都不行
  if (typeof eg[key] !== 'object' || Array.isArray(eg[key])) {
    throw new Error('config.eagler.' + key + ' 必须为对象 { brand, version }');
  }
  const g = eg[key];
  // brand 要是非空字符串喵,空的话退一步用v1_8的兜底
  if (typeof g.brand !== 'string' || !g.brand.length) {
    if (eg.v1_8 && eg.v1_8.brand) g.brand = eg.v1_8.brand;
    else throw new Error('config.eagler.' + key + '.brand 必须为非空字符串');
  }
  // version 同理喵~
  if (typeof g.version !== 'string' || !g.version.length) {
    if (eg.v1_8 && eg.v1_8.version) g.version = eg.v1_8.version;
    else throw new Error('config.eagler.' + key + '.version 必须为非空字符串');
  }
}

// 深合并:把 src 的键逐层并进 dst 喵(对象会并到一起,基本类型直接覆盖)
function deepMerge(dst, src) {
  for (const k of Object.keys(src || {})) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
      deepMerge(dst[k], src[k]);
    } else {
      dst[k] = src[k];
    }
  }
}

// 校验 LAN 那一摞设置喵~ 不合法的就拿默认值替上
function validateLan(lan) {
  const def = DEFAULTS.lan;
  // 优先用主人写的LAN对象,没啥就用默认的一份喵
  const out = lan && typeof lan === 'object' && !Array.isArray(lan) ? Object.assign({}, def, lan) : Object.assign({}, def);
  // broadcast 默认true,只有显式写false才关掉喵
  out.broadcast = out.broadcast === true;
  if (lan && typeof lan === 'object' && !Array.isArray(lan) && lan.broadcast === false) out.broadcast = false;

  // refreshMs 太小也没意思喵,至少给个1000ms
  if (typeof out.refreshMs !== 'number' || !isFinite(out.refreshMs) || out.refreshMs < 1000) {
    out.refreshMs = def.refreshMs;
  }

  // 组播地址得合法(224~239开头),不是的话就用默认的喵
  if (!isValidMulticast(out.group)) out.group = def.group;

  // 端口要是个整数,且在合法范围喵
  if (typeof out.port !== 'number' || !isFinite(out.port) || out.port < 1 || out.port > 65535 || Math.floor(out.port) !== out.port) {
    out.port = def.port;
  }
  return out;
}

// 看一眼这个字符串是不是合法的IPv4组播地址喵
// (组播地址第一位得在224~239之间,猫眯着眼也能认出来喵)
function isValidMulticast(s) {
  if (typeof s !== 'string') return false;
  const m = s.split('.');
  if (m.length !== 4) return false;
  for (const p of m) { if (!/^\d+$/.test(p) || +p < 0 || +p > 255) return false; }
  const first = +m[0];
  return first >= 224 && first <= 239;
}

module.exports = { loadConfig, load: loadConfig, validateConfig, DEFAULTS };
