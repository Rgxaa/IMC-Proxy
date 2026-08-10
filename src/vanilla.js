// 本喵负责原版Minecraft(1.8/1.12.2)那一侧的协议编解码喵~
// (趴在协议栈上竖起耳朵)
// 活儿包括: 把TCP字节流按VarInt长度切包(frameLoop)、
//          打包/发各种状态包(ServerInfo、Pong、LoginDisconnect、LoginSuccess)、
//          解析客户端发来的Handshake和LoginStart喵~
// 注意本喵不碰协议加密,set compression也只在需要时才会写喵~

'use strict';

const varInt = require('./varint');

// 主循环喵! 盯着socket,把一段段字节按VarInt长度切成一个个完整包
// 切出来后用 (packetId, fields) 回调通知主人,主人爱怎么处理就怎么处理喵
function frameLoop(socket, onPacket, opts) {
  let inbound = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    // 新数据接在inbound尾巴后面,慢慢拼完整包喵
    inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
    while (true) {
      let lenInfo;
      try {
        lenInfo = varInt.readVarInt(inbound, 0);
      } catch (_) {
        // VarInt都还没凑齐,等下一段数据再来看喵(先趴着)
        break;
      }
      const total = lenInfo.bytes + lenInfo.value;
      // 包太大肯定不怀好意喵,33MB上限,超过直接踹掉连接
      if (total > 0x2000000) {
        socket.destroy(new Error('vanilla 包过大: ' + total));
        return;
      }
      // 还没攒够整包,继续等喵
      if (inbound.length < total) break;
      const frame = inbound.subarray(lenInfo.bytes, total);
      inbound = inbound.subarray(total);

      // 包体第一个VarInt才是真正的packetId喵~
      let idInfo;
      try {
        idInfo = varInt.readVarInt(frame, 0);
      } catch (e) {
        opts && opts.onWarn && opts.onWarn('包ID 解析失败:', e && e.message);
        continue;
      }
      const packetId = idInfo.value;
      const fields = frame.subarray(idInfo.bytes);
      try {
        onPacket(packetId, fields);
      } catch (e) {
        // 回调里炸了也得本喵来收拾喵(先记下来,再踹掉连接)
        opts && opts.onWarn && opts.onWarn('onPacket 回调异常:', e && e.stack ? e.stack : e);
        try { socket.destroy(); } catch (_) {}
      }
    }
  });
  // socket报错就吞掉,别让没监听器的报错炸出来吓人喵
  socket.on('error', () => {});
}

// 把一个(packetId + body)打成完整MC包喵(前缀VarInt长度+id+body)
function buildPacket(packetId, bodyBuf) {
  bodyBuf = bodyBuf || Buffer.alloc(0);
  // 先把id编码成VarInt喵
  const idBytes = Buffer.allocUnsafe(varInt.varIntSize(packetId));
  varInt.writeVarInt(packetId, idBytes, 0);
  const inner = Buffer.concat([idBytes, bodyBuf]);
  // 内层len是idBytes+body的总长度喵
  const lenBytes = Buffer.allocUnsafe(varInt.varIntSize(inner.length));
  varInt.writeVarInt(inner.length, lenBytes, 0);
  return Buffer.concat([lenBytes, inner]);
}

// 打好包就立刻发给socket喵(socket不可写就乖乖闭嘴)
function writePacket(socket, packetId, bodyBuf) {
  if (socket.writable) socket.write(buildPacket(packetId, bodyBuf));
}

// 单独编码一个VarInt字段喵(给set compression之类用)
function writeVarIntField(value) {
  const b = Buffer.allocUnsafe(varInt.varIntSize(value));
  varInt.writeVarInt(value, b, 0);
  return b;
}

// MC里的字符串其实是 VarInt(长度) + UTF8字节 喵~ (本喵来打包)
function writeString(str) {
  const utf8 = Buffer.from(String(str), 'utf8');
  return Buffer.concat([writeVarIntField(utf8.length), utf8]);
}

// 从buf的offset处读一个MC字符串喵~ 读不下去就抛异常抗议
function readString(buf, offset) {
  const lenInfo = varInt.readVarInt(buf, offset);
  const start = offset + lenInfo.bytes;
  const end = start + lenInfo.value;
  if (end > buf.length) throw new Error('string 越界');
  return { str: buf.toString('utf8', start, end), next: end };
}

// 写一个无符号大端short(2字节)喵
function writeUShort(v) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(v & 0xffff, 0);
  return b;
}

// 写一个8字节大端long喵(给ping里的时间戳用)
function writeLongBigInt(value) {
  const b = Buffer.allocUnsafe(8);
  const v = BigInt(value);
  b.writeBigInt64BE(v, 0);
  return b;
}

// 解析客户端发来的第一个包:Handshake 喵~
// 里面有协议版本、要连的地址、端口、和"下一个状态"(STATUS/LOGIN)
function parseHandshake(fields) {
  let i = 0;
  const pvInfo = varInt.readVarInt(fields, i); i += pvInfo.bytes;
  const addr = readString(fields, i); i = addr.next;
  // 端口在这儿是个无符号大端short喵(虽然实际服务端不一定用它)
  const port = fields[i] << 8 | fields[i + 1]; i += 2;
  const nsInfo = varInt.readVarInt(fields, i); i += nsInfo.bytes;
  return { protocolVersion: pvInfo.value, serverAddress: addr.str, port, nextState: nsInfo.value, bytes: i };
}

// STATUS期:服务器信息包0x00喵,把serverInfo的JSON字符串发回去
function writeServerInfo(socket, json) {
  writePacket(socket, 0x00, writeString(JSON.stringify(json)));
}

// STATUS期:pong包0x01喵,把客户端发来的8字节payload原样回弹
function writePong(socket, longPayload) {
  writePacket(socket, 0x01, writeLongBigInt(longPayload));
}

// 把"踢人理由"写成Login Disconnect包(0x00)发回去喵~
// 输入可以是对象/JSON字符串/纯文本,本喵都给规整成chat JSON喵
function writeLoginDisconnect(socket, chatJsonOrText) {
  let reason;
  if (typeof chatJsonOrText === 'object' && chatJsonOrText !== null) {
    // 本来就是对象,直接.stringify 喵
    reason = JSON.stringify(chatJsonOrText);
  } else {
    const s = String(chatJsonOrText);
    // 看着像JSON(以{开头)就试着解析一下,是对象就用,不行就当纯文本喵
    if (s.charCodeAt(0) === 0x7B) {
      try {
        const obj = JSON.parse(s);
        reason = obj && typeof obj === 'object' ? JSON.stringify(obj) : JSON.stringify({ text: s });
      } catch (_) {
        reason = JSON.stringify({ text: s });
      }
    } else {
      // 纯文本就包成 {text:...} 喵~ (基本所有客户端都认)
      reason = JSON.stringify({ text: s });
    }
  }
  writePacket(socket, 0x00, writeString(reason));
}

// LOGIN期:Login Success包0x02喵,告诉客户端"你进来了喵!"(uuid + 用户名)
function writeLoginSuccess(socket, uuid, username) {
  writePacket(socket, 0x02, Buffer.concat([writeString(uuid), writeString(username)]));
}

// LOGIN期:Set Compression包0x03喵,告诉客户端从此开始启用压缩(阈值VarInt)
function writeSetCompression(socket, threshold) {
  writePacket(socket, 0x03, writeVarIntField(threshold));
}

// 解析客户端发来的Login Start包0x00喵~
// (里面就一个字符串:玩家想用的用户名)
function parseLoginStart(fields) {
  return readString(fields, 0);
}

module.exports = {
  frameLoop,
  buildPacket,
  writePacket,
  writeString,
  readString,
  writeUShort,
  writeVarIntField,
  parseHandshake,
  parseLoginStart,
  writeServerInfo,
  writePong,
  writeLoginDisconnect,
  writeLoginSuccess,
  writeSetCompression
};
