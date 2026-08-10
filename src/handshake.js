// 本喵负责EaglerCraft自有的那套握手协议喵~
// (端坐在网页客户端和虚拟java服之间)
// Eagler握手不走MC协议,而是它自己定义的几个二进制包:
//   CLIENT_VERSION 0x01 → SERVER_VERSION 0x02 →
//   CLIENT_REQUEST_LOGIN 0x04 → SERVER_ALLOW_LOGIN 0x05 →
//   CLIENT_PROFILE_DATA 0x07 → CLIENT_FINISH_LOGIN 0x08 →
//   SERVER_FINISH_LOGIN 0x09 喵!
// 顺便也处理各种错误/控制帧(0x03 0x06 0x0A 0xFF)喵~
// ByteBuilder/ByteReader 是这套协议的小积木,本喵用它一字一字拼包

'use strict';

// Eagler握手协议的包ID定义喵~ (双方约定好的号码)
const PKT = {
  CLIENT_VERSION: 0x01,       // 客户端:报版本喵
  SERVER_VERSION: 0x02,       // 服务器:回应自己版本喵
  VERSION_MISMATCH: 0x03,    // 服务器:版本对不上喵!
  CLIENT_REQUEST_LOGIN: 0x04,// 客户端:请求登录喵
  SERVER_ALLOW_LOGIN: 0x05, // 服务器:准了喵~(发回UUID+用户名)
  SERVER_DENY_LOGIN: 0x06,  // 服务器:不准登录喵(含原因)
  CLIENT_PROFILE_DATA: 0x07, // 客户端:附上profile数据(品牌UUID喵)
  CLIENT_FINISH_LOGIN: 0x08, // 客户端:登录收尾喵
  SERVER_FINISH_LOGIN: 0x09,// 服务器:登录彻底成功喵(进入PLAY)
  SERVER_REDIRECT_TO: 0x0A, // 服务器:让客户端滚去别的URL喵
  SERVER_ERROR: 0xFF         // 服务器:出大问题喵(通用错误)
};

// SERVER_ERROR 帧里的错误代码喵~ (本喵挑着记下来用)
const ERR = {
  UNKNOWN_PACKET: 0x01,
  INVALID_PACKET: 0x02,
  RATELIMIT_BLOCKED: 0x06,   // 被小事限速挡住了喵
  RATELIMIT_LOCKED: 0x07,    // 被锁上了,问题比较严重喵
  CUSTOM_MESSAGE: 0x08,      // 服务器自定义发言喵
  AUTHENTICATION_REQUIRED: 0x09 // 这要密码喵,本喵离线代理可不会
};

// 认证类型喵~ (本喵只认 NONE,别的全都不伺候)
const AUTH = {
  NONE: 0x0,
  EAGLER_SHA256: 0x01,
  AUTHME_SHA256: 0x02,
  PLAINTEXT: 0xFF
};

// 把ASCII字符串一字一字写进ByteBuilder喵~ (按字节&0xff防越界)
function writeASCII(buf, str) {
  for (let i = 0; i < str.length; i++) buf.bytes.push(str.charCodeAt(i) & 0xff);
}

// 造包用的小积木喵~ (一个字节数组,本喵一边push一边存)
class ByteBuilder {
  constructor() {
    this.bytes = [];
  }
  pushByte(v) {
    this.bytes.push(v & 0xff);
  }
  pushBytes(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
  }
  // 大端short:高位字节先push,低位字节后push喵
  pushShort(v) {
    this.pushByte(v >> 8 & 0xff);
    this.pushByte(v & 0xff);
  }
  pushBool(v) {
    this.pushByte(v ? 1 : 0);
  }
  pushASCII(str) {
    writeASCII(this, str);
  }
  // 最后给本喵一个Buffer,方便直接拿去发喵~
  buffer() {
    return Buffer.from(this.bytes);
  }
}

// 拆包用的小积木喵~ (维护一个游标i,逐字节往外抠)
class ByteReader {
  constructor(buf) {
    this.buf = buf;
    this.i = 0;
  }
  readByte() {
    return this.buf[this.i++];
  }
  // 读n个字节(注意是subarray,和原buf共享内存喵)
  readBytes(n) {
    const s = this.buf.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }
  readBool() {
    return this.readByte() !== 0;
  }
  // 大端unsigned short喵
  readUShort() {
    return this.readByte() << 8 | this.readByte();
  }
  // 大端8字节long喵~ (转成BigInt,因为正经的long4字节装不下)
  readLong() {
    const hex = this.buf.subarray(this.i, this.i + 8).toString('hex');
    this.i += 8;
    return BigInt('0x' + hex);
  }
  // 剩下还有多少字节没读喵
  remaining() {
    return this.buf.length - this.i;
  }
  readASCII(n) {
    return this.readBytes(n).toString('ascii');
  }
  readUTF(n) {
    return this.readBytes(n).toString('utf8');
  }
}

// 构造 CLIENT_VERSION (0x01) 喵~
// 这是握手第一步,本喵把账号、品牌、版本、游戏协议版本全报上去喵
// 那一串常量(2,2,3,4,1)是Eagler协议头的固定版本字段(别动它喵)
function buildClientVersion({
  username,
  brand,
  version,
  gameVers
}) {
  const gv = typeof gameVers === 'number' ? gameVers : 47;
  const b = new ByteBuilder();
  b.pushByte(PKT.CLIENT_VERSION);
  b.pushByte(2);   // 协议主版本喵(写死的)
  b.pushShort(2); // EaglerX 的沟通版本
  b.pushShort(3); // ...
  b.pushShort(4); // ...
  b.pushShort(1); // ...
  b.pushShort(gv);// 这里才是真正的gameVers(47=1.8 / 340=1.12.2)喵~
  b.pushByte(brand.length);    // 品牌字符串长度
  b.pushASCII(brand);
  b.pushByte(version.length);  // 版本字符串长度
  b.pushASCII(version);
  b.pushBool(false);           // 某个布尔标志位喵
  b.pushByte(username.length); // 用户名长度
  b.pushASCII(username);
  return b.buffer();
}

// 构造 CLIENT_REQUEST_LOGIN (0x04) 喵~
// 第二步:本喵报名字上去,服务器过一会儿就会回 ALLOW_LOGIN 喵
function buildRequestLogin({
  username,
  requestedServer
}) {
  const b = new ByteBuilder();
  b.pushByte(PKT.CLIENT_REQUEST_LOGIN);
  b.pushByte(username.length);
  b.pushASCII(username);
  b.pushByte(requestedServer.length);
  b.pushASCII(requestedServer);
  b.pushByte(0);   // 固定的两个0字节喵
  b.pushBool(false);
  b.pushByte(0);
  return b.buffer();
}

// 构造 CLIENT_PROFILE_DATA (0x07) 喵~
// 第三步:本喵把刚才拿到的服务器UUID(分成MSB/LSB各64位),
// 打成"brand_uuid_v1"数据块发回去喵~
// (服务器要靠这个记住本喵用了什么品牌罐罐)
function buildProfileData(brandUuidMsb, brandUuidLsb) {
  const name = 'brand_uuid_v1';

  // 把MSB/LSB两个BigInt各自分成两个32位,摆进16字节缓冲喵
  const msb = BigInt(brandUuidMsb);
  const lsb = BigInt(brandUuidLsb);
  const u32 = (x) => Number(BigInt.asUintN(64, x) & 0xffffffffn);
  const data = Buffer.alloc(16);
  data.writeUInt32BE(u32(msb >> 32n), 0);
  data.writeUInt32BE(u32(msb), 4);
  data.writeUInt32BE(u32(lsb >> 32n), 8);
  data.writeUInt32BE(u32(lsb), 12);
  const b = new ByteBuilder();
  b.pushByte(PKT.CLIENT_PROFILE_DATA);
  b.pushByte(1);              // 数据块数量=1喵
  b.pushByte(name.length);    // 名字长度
  b.pushASCII(name);
  b.pushShort(data.length);   // 数据块长度
  b.pushBytes(Array.from(data));
  return b.buffer();
}

// 构造 CLIENT_FINISH_LOGIN (0x08) 喵~ (单字节包,本喵说完最后一声!)
function buildFinishLogin() {
  return Buffer.from([PKT.CLIENT_FINISH_LOGIN]);
}

// 解析 SERVER_VERSION (0x02) 喵~
// 服务器回应它的协议号、游戏版本、品牌、版本、认证类型和盐喵~
// (非NONE的authType本喵会直接拒掉,因为离线代理做不来密码喵)
function parseServerVersion(buf) {
  const r = new ByteReader(buf);
  if (r.readByte() !== PKT.SERVER_VERSION) throw new Error('非 0x02');
  const protocolVersion = r.readUShort();
  const gameVers = r.readUShort();
  const brandLen = r.readByte();
  const pluginBrand = r.readASCII(brandLen);
  const versLen = r.readByte();
  const pluginVersion = r.readASCII(versLen);
  const authType = r.readByte();
  const saltLength = r.readUShort();
  const salt = r.readBytes(saltLength);
  // 协议>=5时多了个"昵称选择"的布尔位喵(可选字段,看还有没有字节)
  let nicknameSelection = undefined;
  if (protocolVersion >= 5 && r.remaining() >= 1) nicknameSelection = r.readBool();
  return {
    protocolVersion,
    gameVers,
    pluginBrand,
    pluginVersion,
    authType,
    salt,
    nicknameSelection
  };
}

// 解析 SERVER_ALLOW_LOGIN (0x05) 喵~
// 服务器准了登录,顺便把本喵在这个服上的用户名和UUID发回来喵~
// (UUID分成MSB和LSB两半,各是一个大端long)
function parseServerAllowLogin(buf) {
  const r = new ByteReader(buf);
  if (r.readByte() !== PKT.SERVER_ALLOW_LOGIN) throw new Error('非 0x05');
  const len = r.readByte();
  const username = r.readASCII(len);
  const msb = r.readLong();
  const lsb = r.readLong();
  return {
    username,
    uuidMSB: msb,
    uuidLSB: lsb
  };
}

// 把服务器给的 MSB/LSB 两个64位,拼回标准UUID字符串喵~
// (8-4-4-4-12 这种格式,就是java版UUID的样子喵)
function uuidFromHalves(msb, lsb) {
  const fmt = (x) => x.toString(16).padStart(16, '0');
  const h = fmt(BigInt(msb)) + fmt(BigInt(lsb));
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

// 通用错误/控制帧解析喵~ (0x03 / 0x06 / 0x0A / 0x09 / 0xFF 都进这)
// v3 决定 SERVER_ERROR 消息长度字段是2字节还是1字节(版本差异喵)
function parseErrorOrControl(buf, v3 = true) {
  const r = new ByteReader(buf);
  const id = r.readByte();
  if (id === PKT.SERVER_ERROR) {
    // 通用错误:错误码 +消息喵
    const code = r.readByte();
    const msgLen = v3 ? r.readUShort() : r.readByte();
    const message = v3 ? r.readUTF(msgLen) : r.readASCII(msgLen);
    return { type: 'error', code, message };
  } else if (id === PKT.SERVER_DENY_LOGIN) {
    // 登录被拒:就一句话喵~ (长度是ushort)
    const msgLen = r.readUShort();
    const message = r.readUTF(msgLen);
    return { type: 'deny', message };
  } else if (id === PKT.SERVER_REDIRECT_TO) {
    // 让客户端去别的URL喵~ (长度是ushort)
    const urlLen = r.readUShort();
    const url = r.readUTF(urlLen);
    return { type: 'redirect', url };
  } else if (id === PKT.SERVER_FINISH_LOGIN) {
    // 登录完成的标志喵(没附带数据)
    return { type: 'finish' };
  } else if (id === PKT.VERSION_MISMATCH) {
    // 版本对不上喵:服务器会列出它支持的协议号和游戏版本
    const nProt = r.readUShort();
    const protos = [];
    for (let i = 0; i < nProt; i++) protos.push(r.readUShort());
    const nGame = r.readUShort();
    const games = [];
    for (let i = 0; i < nGame; i++) games.push(r.readUShort());
    // 最后还跟一条ASCII提示消息(这里长度是1字节喵)
    const msgLen = r.readByte();
    const message = r.readASCII(msgLen);
    return { type: 'mismatch', protos, games, message };
  }
  // 啥都不是的本喵就标个unknown喵~
  return { type: 'unknown', id };
}

module.exports = {
  PKT,
  ERR,
  AUTH,
  buildClientVersion,
  buildRequestLogin,
  buildProfileData,
  buildFinishLogin,
  parseServerVersion,
  parseServerAllowLogin,
  parseErrorOrControl,
  uuidFromHalves
};
