# imc-proxy

让**原版 Minecraft Java Edition 1.8.8 与 1.12.2** 客户端,通过本地一个 TCP 端口,加入只放行 **EaglerCraft 网页客户端**的 EaglerXServer 服务器。代理把原版 MC 的 TCP 协议翻译成 EaglerCraft 的 WebSocket 握手协议,**单一端口、自动判断版本**:1.8 客户端加入时伪装成 EaglercraftX 1.8(`gameVers=47`),1.12.2 客户端加入时伪装成 EaglercraftX 1.12.2(`gameVers=340`),由 EaglerXServer 服务端按 `gameVers` 自动适配,故同一端口能同时讲两版本。

```
原版 MC 1.8.8 / 1.12.2 客户端
        │  TCP(原版 MC 协议,VarInt 分帧)
        ▼
   imc-proxy(本地,监听 0.0.0.0:25565)
        │  WebSocket(EaglerCraft 握手协议 + 伪造 Origin,
        │  PLAY 期与 MC 协议同形,仅加/拆 VarInt 长度前缀)
        ▼
   目标 EaglerCraft 服务器  (如 wss://mc.smgoro.com)
```

> 仅支持**离线模式**(在线模式会在 LOGIN 期收到 Encryption Request,本代理直接断开)。要求 **Node.js ≥ v22**(内部用了 `zlib.crc32`)。

## 它做了什么

1. **HANDSHAKE 阶段** — 收到原版客户端第一个 Handshake 包,按 `protocolVersion` 选定"伪装身份":`47→1.8`、`340→1.12.2`。不认得的版本伪装成 1.12,**STATUS 放行**(让客户端至少能看一眼服务器列表),**LOGIN 秒踢**。
2. **STATUS 阶段** — 客户端要服务器列表时,代理去问 EaglerCraft 的 MOTD(优先喂 LAN 广播维护的缓存,没缓存才现连一次),翻译成原版 Server Info JSON,可选带上 64×64 RGBA 图标(服务器原文是 16384 字节 RGBA,本代理手缝成 PNG 再 base64 成 favicon)。`ping` 包则原样回弹 8 字节 payload。
3. **LOGIN 阶段** — 驱动 EaglerCraft 自有握手:
   `CLIENT_VERSION 0x01 → SERVER_VERSION 0x02 → CLIENT_REQUEST_LOGIN 0x04 → SERVER_ALLOW_LOGIN 0x05 → CLIENT_PROFILE_DATA 0x07 → CLIENT_FINISH_LOGIN 0x08 → SERVER_FINISH_LOGIN 0x09`。
   收到 `SERVER_FINISH_LOGIN` 后,用服务器回传的 UUID(MSB/LSB 两半)给原版客户端回 `Login Success`,进入 PLAY。
   途中任何 `VERSION_MISMATCH / SERVER_DENY_LOGIN / SERVER_ERROR / SERVER_REDIRECT_TO` 都会被解析并把原因回踢给客户端;服务器若要求认证(authType≠NONE)直接拒绝(离线代理做不来密码)。
4. **PLAY 阶段** — **纯透传**。双方握手已经对齐(EaglerXServer 按 `gameVers` 适配了对应 MC 版本),代理只在 TCP↔WebSocket 之间加/拆一个 VarInt 长度前缀,不翻译 PLAY 协议。`debug` 日志级下会**只读**偷瞄文本类包(chat / kick / title / playerList header),按 1.8/1.12.2 两套包 ID 表解析后打印,绝不改动包内容。

另外,代理会向局域网多播广播自己(让同 LAN 的原版客户端在"多人游戏 → 局域网"里自动发现它),并周期性地把目标服务器的 MOTD 刷进缓存,供 STATUS 请求秒回。

## 用法

```bash
npm install            # 安装 ws
npm start              # node src/index.js,info 级日志
npm run dev            # = node src/index.js --log debug,开启 PLAY 文本包转储
node src/index.js --log warn   # 任选 debug/info/warn/error 覆盖 config 里的日志等级
```

随后在原版 **1.8.8** 或 **1.12.2** 客户端以**离线模式**登录,把服务器地址指向本机端口(默认 `127.0.0.1:25565`,或在 LAN 上直接连本机 IP)即可。需要看到 LAN 广播时,请把 `config.json` 的 `listen.host` 设成 `"0.0.0.0"`(或本机 LAN IP),否则同 LAN 客户端点入会 Connection refused。

## 配置(`config.json`)

与默认值深度合并,未写的键由默认值兜底。每个字段都经校验,非法值会在启动时直接报错。

```jsonc
{
  "listen":  { "host": "0.0.0.0", "port": 25565 },             // 监听地址(0.0.0.0 才能被 LAN 发现)
  "target":  {
    "url":     "wss://mc.smgoro.com",                          // 必须 ws:// 或 wss://
    "origin":  "https://mc.smgoro.com",                         // 伪造的 Origin,骗过 originblacklist(必须 http(s)://)
    "headers": { "User-Agent": "Mozilla/5.0 ..." }             // 附带的自定义请求头(会被 merge 进 ws 握手头)
  },
  "eagler":  {
    "requestedServer": "default",                              // Eagler 握手里报的"目标子服"名
    "v1_8":  { "brand": "EaglercraftX", "version": "u53" },     // 伪装成 1.8 网页客户端的 品牌与版本字符串
    "v1_12": { "brand": "EaglercraftX", "version": "u24" }      // 伪装成 1.12.2 网页客户端的 品牌与版本字符串
  },
  "logLevel": "info",                                          // debug / info / warn / error
  "lan":  { "broadcast": true, "refreshMs": 10000, "group": "224.0.2.60", "port": 4445 }  // LAN 多播广播
}

```

字段说明:

| 字段 | 说明 |
| --- | --- |
| `listen.port` | 本地监听端口,1–65535。 |
| `listen.host` | 监听地址。`127.0.0.1` 等环回地址会让 LAN 广播失效(启动时会有 warn)。 |
| `target.url` | 目标 EaglerCraft 服务器 WebSocket 地址。 |
| `target.origin` | 伪造的 `Origin` 头,绕过服务器的 `originblacklist` 校验。 |
| `target.headers` | 任意自定义请求头,会和默认的 `Origin`、`User-Agent` 合并进 ws 握手。 |
| `eagler.requestedServer` | Eagler 握手中"要进的子服"名(字符串)。 |
| `eagler.v1_8` / `eagler.v1_12` | 两版本各自的 `{ brand, version }` 网页客户端伪装身份。也兼容旧式扁平写法 `eagler.brand / eagler.version`(会被搬进 `v1_8`)。 |
| `logLevel` | 日志等级;`debug` 才会额外做 PLAY 文本包转储。 |
| `lan.broadcast` | 是否开启 LAN 多播广播。 |
| `lan.refreshMs` | MOTD 缓存刷新间隔,最小 1000。 |
| `lan.group` | 多播组地址,必须是合法 IPv4 组播(224–239 开头),否则回退默认。 |
| `lan.port` | 多播端口,1–65535 的整数。 |

## 源码结构(`src/`)

| 文件 | 职责 |
| --- | --- |
| `index.js` | 入口。读配置 → 起本地 TCP 服务器 → 每条连接交给 `bridge`;解析 `--log` 覆盖、解析目标 IP 打印、`SIGINT` 优雅退出、`uncaughtException`/`unhandledRejection` 兜底。 |
| `config.js` | 读取并校验 `config.json`,与默认值深度合并,非法字段精确报错。导出 `load`/`validateConfig`/`DEFAULTS`。 |
| `bridge.js` | 核心桥接。一段 TCP 连接的全生命周期:HANDSHAKE 分版本、STATUS 查 MOTD、LOGIN 驱动 Eagler 握手、PLAY 切透传。 |
| `handshake.js` | EaglerCraft 自有握手协议的拼包/拆包(`ByteBuilder`/`ByteReader`),含 `CLIENT_VERSION`/`SERVER_VERSION`/`ALLOW_LOGIN`/`PROFILE_DATA`/`FINISH_LOGIN` 及错误控制帧、UUID MSB/LSB 还原。 |
| `vanilla.js` | 原版 MC(1.8/1.12.2)一侧的协议编解码:VarInt `frameLoop` 切包、`ServerInfo`/`Pong`/`Login Disconnect`/`Login Success`/`Set Compression` 打包、`Handshake`/`LoginStart` 解析。 |
| `varint.js` | MC VarInt 读写(5 字节上限)。 |
| `wsclient.js` | 建立到目标服务器的 WebSocket,伪造 `Origin`、关闭 `perMessageDeflate`、每 15s `ping` 保活、15s 握手超时。 |
| `query.js` | EaglerCraft MOTD 查询:发文本帧 `Accept: MOTD` → 收 JSON →(若有 icon)收 16384 字节 RGBA 图;并负责把 Eagler MOTD 翻译成原版 Server Info。 |
| `broadcaster.js` | LAN 多播广播 + MOTD 缓存 + 代理玩家列表。每 1.5s 向 `224.0.2.60:4445` 喊 `[MOTD]…[/MOTD][AD]端口[/AD]`;每隔 `refreshMs` 刷新 MOTD 缓存;把延迟/在线人数/代理人数/运行时间/占用内存伪装成 player sample 展示。 |
| `png.js` | 把服务器的 64×64 RGBA 原图手缝成 PNG(IHDR/IDAT/IEND,用 Node v22+ 内建 `zlib.crc32` 算 CRC),作 favicon。 |
| `textdump.js` | `debug` 下的文本包只读转储:按 1.8/1.12.2 两套包 ID 表识别 chat/kick/title/playerList header 并格式化打印。 |
| `log.js` | 带时间戳与等级的日志,每条连接分配 `#编号` 名牌。 |

## 诊断

- `npm run dev`(即 `--log debug`):开启 DEBUG 级日志,同时开启 PLAY 期文本包只读转储(chat / kick / title / header),并按 `clientVer.tag` 自动选用 1.8 或 1.12.2 的包 ID 表。
- `info` 级:诊断零开销,只打印连接建立/结束、登录进展、PLAY 流水统计。
- PLAY 期每结束一条连接会打一行总结(左右两侧各转发了多少个包/字节、多少次 keepalive),便于排查是否单边断流。
