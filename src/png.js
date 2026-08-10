// 本喵负责把 EaglerCraft 服务器发来的 RGBA 原图,亲手绣成一张 PNG 喵~
// (主要是因为MC的favicon只吃PNG格式,服务器却给的是原始像素,本喵来当裁缝喵)
// Node v22 起内置了 zlib.crc32 喵,本喵再也不用手搓 CRC32 啦(收起小算盘)~

'use strict';

const zlib = require('zlib');

// PNG 文件的前8个字节签名,所有PNG文件都长这样喵(对不上就肯定不是PNG啦)
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// v22+(本机 v24.19.0)内建的 CRC32 喵~ 算出来的值和本喵当年手搓的完全一致,放心用喵
const CRC32 = zlib.crc32;

// 把一个 PNG 数据块(chunk)打包:长度+类型+数据+CRC 喵~
// 类型就是4个ASCII字符,比如 IHDR/IDAT/IEND,数据长度放最前面
function _chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  // CRC 是对"类型+数据"一起算的喵,可不能只算数据哦~
  crcBuf.writeUInt32BE(CRC32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// 主角登场喵! 把 RGBA 像素缓冲包成一张完整PNG~
// (width*height*4 必须和缓冲长度对得上,不然本喵会生气的喵)
function encodeRgbaPng(rgbaBuf, width, height) {
  if (!Buffer.isBuffer(rgbaBuf)) rgbaBuf = Buffer.from(rgbaBuf);
  // 长度对不上?那本喵可不敢乱缝喵(直接报错)
  if (rgbaBuf.length !== width * height * 4) {
    throw new Error('encodeRgbaPng: 输入长度 ' + rgbaBuf.length + ' 与 ' + width + 'x' + height + 'x4 不符');
  }

  // PNG 要每行前面加个"滤镜类型"字节(本喵这里用0=不加滤镜),所以行长+1喵
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowLen + 1);
    raw[off] = 0x00; // 滤镜类型0:原样照搬喵
    rgbaBuf.copy(raw, off + 1, y * rowLen, (y + 1) * rowLen);
  }
  // 像素行用 deflate 压一压,图才小喵
  const idat = zlib.deflateSync(raw);

  // IHDR 头部13个字节:宽(4)+高(4)+位深(1)+颜色类型(1)+3个保留位喵
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // 位深=8, 每个通道一个字节
  ihdr[9] = 6;    // 颜色类型=6, RGBA真彩色喵
  ihdr[10] = 0;   // 压缩方式=0(默认deflate)
  ihdr[11] = 0;   // 滤镜方式=0
  ihdr[12] = 0;   // 隔行扫描=0(不隔行喵)

  // 拼成完整PNG: 签名 + IHDR + IDAT + IEND 喵~
  return Buffer.concat([
    PNG_SIGNATURE,
    _chunk('IHDR', ihdr),
    _chunk('IDAT', idat),
    _chunk('IEND', Buffer.alloc(0))]
  );
}

module.exports = { encodeRgbaPng };
