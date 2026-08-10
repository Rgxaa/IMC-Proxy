// 本喵负责Minecraft世界里最迷你的"VarInt"读写喵~
// (竖起耳朵,这就是MC协议里到处都在用的变长整数啦)
// 一个字节的高位是"还要不要继续读"的旗子,低7位才是真正的内容喵~
// 最多5个字节=35位有效,所以叫5字节上限喵!

'use strict';

// VarInt 的最大长度,超过这个就该报错啦喵(挡住乱来的数据)
const MAX_VARINT_LEN = 5;

// 把一个整数写进 VarInt,放进 out 的 offset 位置喵~
// (用 >>> 无符号右移,这样符号位才不会被带到下一个字节去喵)
function writeVarInt(value, out, offset) {
  let v = value | 0;
  let i = offset || 0;
  while (true) {
    // 高位为0说明剩下的7位就够了,这就是最后一个字节喵~
    if ((v & ~0x7f) === 0) {
      out[i++] = v;
      return i;
    }
    // 还没完喵~ 把低7位放进去,顺便点亮"继续"旗子(0x80)
    out[i++] = v & 0x7f | 0x80;
    // 剩下的部分再往右挪7位,继续写喵~
    v >>>= 7;
  }
}

// 算一下这个数值写成 VarInt 要占几个字节喵
// (提前知道长度,好分配Buffer,免得后面手忙脚乱喵)
function varIntSize(value) {
  let v = value | 0;
  let n = 0;
  while (true) {
    v >>>= 7;
    n++;
    if (v === 0) return n;
  }
}

// 从 buf 的 offset 处读出一个 VarInt 喵~
// 返回读到的值和用了几个字节,读不动就抛异常不许耍赖喵
function readVarInt(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset || 0;
  let bytes = 0;
  let b;
  do {
    // 没东西可读了?那是数据不够喵,大声抗议!
    if (i >= buf.length) throw new Error('VarInt 越界(数据不足)');
    b = buf[i++];
    // 把这个字节低7位,放到它该去的位置上喵
    result |= (b & 0x7f) << shift;
    shift += 7;
    bytes++;
    // 读太多字节也不对喵,这分明是个坏掉的 VarInt
    if (bytes > MAX_VARINT_LEN) throw new Error('VarInt 过长');
  } while ((b & 0x80) !== 0);
  return { value: result, bytes };
}

// 把本喵的本领都交出去喵~
module.exports = {
  MAX_VARINT_LEN,
  writeVarInt,
  varIntSize,
  readVarInt
};
