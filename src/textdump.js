// 本喵是文本包小侦探喵~ (推推眼镜)
// 在debug模式下,本喵偷偷瞄一眼PLAY期间的文本类包(chat/kick/title/header),
// 只读不改地把内容打印到日志里喵~ (主人用来排错用的)
// 注意: 不同MC版本同一个含义的包ID不一样!所以本喵手上有1.8和1.12.2两张表喵~

'use strict';

const varInt = require('./varint');

// 两版MC的文本包ID对照表喵~ (chat/kick/title/header + title的动作集合)
const TABLES = {
  '1.8': {
    chat: 0x02,               // 聊天包ID喵(1.8是0x02)
    kick: 0x40,               // 踢人包ID喵
    title: 0x45,              // 标题包ID喵
    header: 0x47,             // playerList列表头/尾包ID喵
    titleTextActions: new Set([0, 1]), // title里"带文本"的动作集合喵(1.8只有0/1)
    tag: '1.8'
  },
  '1.12': {
    chat: 0x0F,               // 1.12.2 把chat换到了0x0F喵
    kick: 0x1A,
    title: 0x48,
    header: 0x4A,
    titleTextActions: new Set([0, 1, 2]), // 1.12 title多了个reset动作
    tag: '1.12'
  }
};

// 从buf的offset处读一个 VarInt前缀的字符串喵~ (读不下去就返回null悄悄退场)
function readPrefixedString(buf, offset) {
  let lenInfo;
  try {
    lenInfo = varInt.readVarInt(buf, offset);
  } catch (_) {
    return null;
  }
  const len = lenInfo.value;
  if (len < 0) return null;
  const start = offset + lenInfo.bytes;
  const end = start + len;
  if (end > buf.length) return null;
  return { str: buf.toString('utf8', start, end), next: end };
}

// 把一段原始JSON文本漂亮地打印出来喵~ (顺便格式化,主人看得舒服)
function safeLog(L, label, raw) {
  L.info('=-=-=-= ' + label + ' (raw) =-=-=-');
  L.info(raw);
  // 试着再parse一遍美化一下,美化和原raw一样就不重复打喵
  let pretty = null;
  try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch (_) {}
  if (pretty && pretty !== raw) {
    L.info('=-=-=-= ' + label + ' (parsed) =-=-=-');
    L.info(pretty);
  }
}

// 主角:看一个PLAY包,如果是文本类就转储它喵~
// bodyCopy是包体(含包ID VarInt),clientVerTag 决定用哪张表喵
function dumpTextPacket(bodyCopy, L, clientVerTag) {
  if (!bodyCopy || !bodyCopy.length) return;
  // 没有对应版本表就用1.8的兜底喵
  const t = TABLES[clientVerTag] || TABLES['1.8'];
  let idInfo;
  try {
    idInfo = varInt.readVarInt(bodyCopy, 0);
  } catch (_) {
    return;
  }
  const id = idInfo.value;
  let p = idInfo.bytes;
  // 把包ID格式化成像 0x0f 这种两位十六进制喵
  const hb = '0x' + (id < 0x10 ? '0' : '') + id.toString(16);
  switch (id) {
    case t.chat: {
      // 聊天:一个VarInt+字符串喵~ (前缀常是Chat类型字节,这里直接读字符串)
      const r = readPrefixedString(bodyCopy, p);
      if (!r) break;
      safeLog(L, 'CHAT (' + hb + ') [' + t.tag + ']', r.str);
      break;
    }
    case t.kick: {
      // 踢人:也是一个字符串,内容是踢人原因喵
      const r = readPrefixedString(bodyCopy, p);
      if (!r) break;
      safeLog(L, 'KICK_DISCONNECT (' + hb + ') [' + t.tag + ']', r.str);
      break;
    }
    case t.title: {
      // 标题包第一个字段是"动作"VarInt喵~(0=set title 文本,1=set subtitle,2=set action bar等)
      let act;
      try {
        act = varInt.readVarInt(bodyCopy, p);
      } catch (_) {
        break;
      }
      p += act.bytes;
      // 只有"带文本"的动作,本喵才会试着把字符串读出来喵
      if (t.titleTextActions.has(act.value)) {
        const r = readPrefixedString(bodyCopy, p);
        if (r) safeLog(L, 'TITLE (' + hb + ' action=' + act.value + ') [' + t.tag + ']', r.str);
      } else {
        // 不带文本的动作(比如times clear)本喵只记一行无文本喵
        L.info('=-=-=-= TITLE (' + hb + ' action=' + act.value + ', 无文本字段) [' + t.tag + '] =-=-=-');
      }
      break;
    }
    case t.header: {
      // playerList header/footer: 接着两个字符串(头、尾)喵~
      const h = readPrefixedString(bodyCopy, p);
      if (!h) break;
      p = h.next;
      safeLog(L, 'PLAYERLIST_HEADER (' + hb + ') [' + t.tag + '] header', h.str);
      const f = readPrefixedString(bodyCopy, p);
      if (f) safeLog(L, 'PLAYERLIST_HEADER (' + hb + ') [' + t.tag + '] footer', f.str);
      break;
    }
    default:
      // 别的包本喵不关心喵~ (悄悄走开)
      break;
  }
}

module.exports = { dumpTextPacket, TABLES };
