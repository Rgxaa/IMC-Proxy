// 本喵是日志小管家喵~ (扭扭尾巴)
// 负责把各种 debug / info / warn / error 消息,带上时间戳和等级,
// 整整齐齐地交到主人面前喵~ 每条TCP连接还会分到一个 #编号 当名牌哦

'use strict';

// 四个等级从低到高喵,数字越大越重要(越要让主人看见)
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// 造一个 logger,之后只吐出不低于 level 的消息喵~
// (低于设定等级的统统闭嘴,本喵有选择性的喵!)
function createLogger(level) {
  const min = LEVELS[level] || LEVELS.info;

  // 把当前时间戳格式化成 时:分:秒, 给日志盖个章喵
  function ts() {
    const d = new Date();
    const p = (n, w) => String(n).padStart(w, '0');
    return p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2);
  }

  // 给每条消息贴上 [时间][等级] 的标签,整整齐齐才好看喵
  function fmt(tag, args) {
    return [`[${ts()}]${tag}`, ...args];
  }

  return {
    // debug 是碎碎念啦,默认不显示,主人要调到 debug 才看得见喵
    debug: (...a) => { if (LEVELS.debug >= min) console.log(...fmt('[DEBUG]', a)); },
    // info 是正常唠嗑喵
    info: (...a) => { if (LEVELS.info >= min) console.log(...fmt('[INFO] ', a)); },
    // warn 是竖起耳朵警惕一下喵(走错路啦主人!)
    warn: (...a) => { if (LEVELS.warn >= min) console.warn(...fmt('[WARN] ', a)); },
    // error 是炸毛了喵!(出大事啦主人快点看)
    error: (...a) => { if (LEVELS.error >= min) console.error(...fmt('[ERROR]', a)); }
  };
}

// 给下一个进来的连接发号牌喵~ 从 1 开始一直往上加,永不重复
let nextCid = 1;
function newCid() { return String(nextCid++); }

// 把编号变成 #1 / #2 这样的标签,贴在每条连接的日志上喵
function connTag(cid) { return `#${cid}`; }

module.exports = { createLogger, LEVELS, newCid, connTag };
