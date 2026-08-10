// 本喵是整条管道的核心桥梁喵~ (蹲在原版MC客户端和EaglerCraft服务器之间)
// 一个TCP连接就对应一个本喵的 attachSocket 调用喵~,本喵把这条连接从头带到尾:
//
//   阶段1  HANDSHAKE  : 解析原版Handshake,看protocolVersion决定伪装成1.8还是1.12.2喵
//                      (47→1.8, 340→1.12.2, 别的版本伪装成1.12并直接踢LOGIN)
//   阶段2a STATUS     : 客户端要服务器列表,本喵去问EaglerCraft的MOTD,翻译成vanilla ServerInfo
//   阶段2b LOGIN      : 本喵一路驱动Eagler自有握手(
//                      CLIENT_VERSION → REQUEST_LOGIN → PROFILE_DATA → FINISH_LOGIN),
//                      等服务器回 SERVER_FINISH_LOGIN,就给客户端发Login Success喵
//   阶段3  PLAY       : 握手完成后纯透传喵! 双向只加/拆一个VarInt长度前缀,
//                      EaglerXServer已经按gameVers自动适配,本喵不用翻译PLAY协议喵~
// (debug时本喵还会偷窥文本包,但只读不改喵)

'use strict';

const { connectEagler, disposeWs } = require('./wsclient');
const { queryMotd, eaglerMotdToVanillaServerInfo } = require('./query');
const { getStatusSnapshot, registerAdapterPlayer, unregisterAdapterPlayer, buildProxySampleExtras } = require('./broadcaster');
const HS = require('./handshake');
const L = require('./vanilla');
const varInt = require('./varint');
const { newCid, connTag } = require('./log');
const { dumpTextPacket } = require('./textdump');

// 认得的两版协议喵~ tag是内部用的简称,motd是给STATUS展示的,gameVers是Eagler握手要报的
const VERSION_TABLE = {
  47: { tag: '1.8', gameVers: 47, motd: { name: '1.8.8', protocol: 47 }, eaglerKey: 'v1_8' },
  340: { tag: '1.12', gameVers: 340, motd: { name: '1.12.2', protocol: 340 }, eaglerKey: 'v1_12' }
};

// 给每条连接配一个带 `#编号` 前缀的小logger喵(主人日志里好分辨是谁在说话)
function makeConnLogger(base, cid) {
  const tag = connTag(cid);
  return {
    debug: (...a) => base.debug('[' + tag + ']', ...a),
    info: (...a) => base.info('[' + tag + ']', ...a),
    warn: (...a) => base.warn('[' + tag + ']', ...a),
    error: (...a) => base.error('[' + tag + ']', ...a)
  };
}

// 安全地关一条ws喵(出过错了也不让本喵再炸一次)
function tryClose(ws) { try { ws.close(); } catch (_) {} }

// 每来一个TCP连接本喵都attach一次喵~ 主入口!
function attachSocket(socket, cfg, baseLog) {
  // 给这条连接发个号牌cid,顺便造带tag的logger喵
  const cid = newCid();
  const log = makeConnLogger(baseLog, cid);
  log.info('新连接 from', socket.remoteAddress);

  // 监听socket自己的一些碎事喵~ (error/close/timeout 都只是记一下)
  socket.on('error', (e) => log.warn('MC侧 socket error:', e && e.message ? e.message : e));
  socket.on('close', (hadErr) => log.debug('MC侧 socket close hadError=', !!hadErr));
  socket.on('timeout', () => log.debug('MC侧 socket timeout(空闲)'));

  // clientVer 这条连接最终确定下来的"客户端版本身份"喵~
  // 一开始是null,等解析完Handshake才填;未支持的版本会带个unsupported=true的旗子
  let clientVer = null;
  // wsRef 暂存这条连接对应的ws(目前PLAY期的cleanup会用到它的引用喵)
  const wsRef = { ws: null };

  // 不支持但伪装成1.12的"模板身份"喵~ (LOGIN会被秒踢,STATUS放行让客户端能看一眼列表)
  const UNSUPPORTED_1_12 = { tag: '1.12', gameVers: 340, motd: { name: '仅支持 1.8 / 1.12.2', protocol: 340 }, eaglerKey: 'v1_12', unsupported: true };

  // 进入PLAY后,本喵就把左侧TCP的帧处理交出去给透传逻辑了喵~ 设个旗子让左侧包处理闭嘴
  let discard = false;
  // 按vanilla的方式从socket切包喵,切到包就交handleLeftPacket处理
  L.frameLoop(socket, (packetId, fields) => {
    if (discard) return; // PLAY期已交出去透传,左侧的包本喵不接喵
    try { handleLeftPacket(packetId, fields); }
    catch (e) {
      log.warn('MC侧包处理异常:', e && e.stack ? e.stack : e);
      try { socket.destroy(); } catch (_) {}
    }
  }, { onWarn: (...a) => log.warn(...a) });

  // 处理左侧(原版MC客户端)发来的包喵~ 按当前阶段分发
  function handleLeftPacket(packetId, fields) {
    // 还没握手过:第一个包必须是Handshake(0x00)喵~
    if (clientVer === null) {
      // 握手期收到非0x00的包,提醒一下然后忽略喵
      if (packetId !== 0x00) { log.warn('HANDSHAKE 期未知包 0x' + packetId.toString(16)); return; }
      let hs;
      try { hs = L.parseHandshake(fields); }
      catch (e) { log.warn('Handshake 解析失败:', e && e.message); socket.destroy(); return; }
      const v = VERSION_TABLE[hs.protocolVersion];
      const peer = hs.serverAddress + ':' + hs.port;
      if (!v) {
        // 不认得的协议版本喵~ 伪装成1.12对付过去(STATUS放行让客户端看列表,LOGIN秒踢)
        clientVer = Object.assign({ proto: hs.protocolVersion }, UNSUPPORTED_1_12);
        log.warn('不支持的游戏协议版本:', hs.protocolVersion, '(peer=' + peer + ') → 伪装 1.12',
          hs.nextState === 1 ? '(STATUS ping 放行)' : '(LOGIN 秒踢)');
        if (hs.nextState === 1) {
          clientVer.state = 'STATUS';
        } else if (hs.nextState === 2) {
          clientVer.state = 'LOGIN';
        } else {
          log.warn('未知 nextState:', hs.nextState, '断开');
          socket.destroy();
        }
        return;
      }
      // 正经认得的版本喵~ 记下身份并标记状态
      clientVer = Object.assign({ proto: hs.protocolVersion }, v);
      log.info('Handshake protocolVersion=', hs.protocolVersion, '→', clientVer.tag, 'peer=', peer, 'nextState=', hs.nextState);
      if (hs.nextState === 1) {
        clientVer.state = 'STATUS';
      } else if (hs.nextState === 2) {
        clientVer.state = 'LOGIN';
      } else {
        log.warn('未知 nextState:', hs.nextState, '断开');
        socket.destroy();
      }
      return;
    }

    // 已经握过手了,按当前状态分发给对应处理函数喵~
    if (clientVer.state === 'STATUS') {
      handleStatus(packetId, fields);
    } else if (clientVer.state === 'LOGIN') {
      handleLogin(packetId, fields);
    }
  }

  // STATUS期:处理"服务器列表请求"和"ping"两个包喵
  function handleStatus(packetId, fields) {
    if (packetId === 0x00) {
      // 0x00 = 客户端要ServerInfo喵~ 本喵去查MOTD(有缓存就喂缓存),
      // 查不到就降级发一个"连不上"的占位ServerInfo喵
      startStatusQuery().catch((e) => {
        log.warn('status 流程异常:', e && e.stack ? e.stack : e);
        try {
          log.debug('MOTD fallback 原因:', e && e.message ? e.message : e);
          L.writeServerInfo(socket, {
            version: { name: 'timeout', protocol: 0 },
            players: { max: 0, online: 0, sample: buildProxySampleExtras({ online: 0, max: 0 }, null) },
            description: '§4无法连接到目标Eaglercraft服务器'
          });
        } catch (_) {}
      });
    } else if (packetId === 0x01) {
      // 0x01 = ping喵~ 取出客户端给的8字节payload原样回弹(pong)
      const payload = fields.readBigInt64BE ? fields.readBigInt64BE(0) : fields.slice(0, 8).readBigInt64BE(0);
      try { L.writePong(socket, payload); } catch (_) {}
      // 回完pong就把socket优雅关掉喵
      try { socket.end(); } catch (_) {}
    } else {
      log.debug('STATUS 期未知包 0x' + packetId.toString(16));
    }
  }

  // LOGIN期:处理LoginStart和在线模式拒绝喵~
  function handleLogin(packetId, fields) {
    // 第一步:先拦住不支持版本的客户端喵(直接踢)
    if (clientVer && clientVer.unsupported) {
      log.info('LOGIN 秒踢(协议非 1.8/1.12.2, proto=' + clientVer.proto + ')');
      try { L.writeLoginDisconnect(socket, '§c仅支持 Minecraft 1.8 / 1.12.2'); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      return;
    }
    if (packetId === 0x01) {
      // 服务器发来了Encryption Request?那说明在线模式,本喵离线不伺候,断开喵
      log.warn('LOGIN 期收到 Encryption Request/Response(在线模式),本代理仅支持离线,断开');
      try { L.writeLoginDisconnect(socket, '本代理仅支持离线模式'); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      return;
    }
    if (packetId === 0x00) {
      // 0x00 = Login Start喵~ (里面就一个用户名)
      let username;
      try { username = L.parseLoginStart(fields).str; }
      catch (e) { log.warn('Login Start 解析失败:', e && e.message); socket.destroy(); return; }
      log.info('login_start 用户=', username, '[' + clientVer.tag + ']');
      // 拿到用户名,启动到EaglerCraft服务器的完整握手喵~
      startEaglerLogin(username).catch((e) => {
        log.error('login 流程异常:', e && e.stack ? e.stack : e);
        try { L.writeLoginDisconnect(socket, '内部错误: ' + (e && e.message || e)); } catch (_) {}
        try { socket.destroy(); } catch (_) {}
      });
      return;
    }
    // 别的包不该出现在LOGIN期喵~ 提醒一下
    log.warn('LOGIN 期未预期包 0x' + packetId.toString(16), 'len=', fields.length);
  }

  // STATUS期查MOTD喵~ 优先喂LAN广播的缓存(快),没缓存就实时连一次ws去问
  function startStatusQuery() {
    const cached = getStatusSnapshot(clientVer.tag, clientVer.motd);
    if (cached) {
      // 缓存命中喵~ 秒回,不用现连(在线人数见debug日志,ping也立刻答)
      log.debug('STATUS 喂缓存(online/max 见调试, ping 秒回)');
      try { L.writeServerInfo(socket, cached); } catch (_) {}
      return Promise.resolve();
    }
    // 没缓存,本喵现连一次EaglerCraft服务器要MOTD喵~ 拿到后翻译给vanilla
    return queryMotd(cfg.target, log).then((parsed) => {
      const serverInfo = eaglerMotdToVanillaServerInfo(parsed, clientVer.tag, {
        versionOverride: clientVer.motd,
        sampleExtras: buildProxySampleExtras(parsed, null)
      });
      log.debug('MOTD 实查 OK: online=', parsed.online, 'max=', parsed.max, 'icon=', parsed.iconRgba ? 'yes' : 'no');
      L.writeServerInfo(socket, serverInfo);
    });
  }

  // 重头戏! 驱动完整的EaglerCraft自有握手喵~ (把原版客户端的"我要登录"翻译成Eagler那套)
  // 一步步走: 连ws → 报版本 → 请求登录 → 收到准许 → 发profile → 发finish → 收到完成 → 进PLAY
  function startEaglerLogin(username) {
    return new Promise((resolve, reject) => {
      const eaglerCfg = cfg.eagler[clientVer.eaglerKey];
      const ws = connectEagler(cfg.target, log);
      wsRef.ws = ws;
      let phase = 'hs_version';      // 当前握手所在的阶段喵
      let allowLoginRecd = null;     // 收到的SERVER_ALLOW_LOGIN内容(含UUID)喵
      let finishedLoginToLeft = false; // 是否已经把Login Success发回给左侧客户端了喵

      // ws一通就发第一个包:CLIENT_VERSION(报上gameVers)喵
      ws.on('open', () => {
        log.debug('ws 已连接, 发送 CLIENT_VERSION gameVers=' + clientVer.gameVers);
        ws.send(HS.buildClientVersion({
          username,
          brand: eaglerCfg.brand,
          version: eaglerCfg.version,
          gameVers: clientVer.gameVers
        }), { binary: true });
        resolve();
      });

      // 握手期的消息处理器喵(只接二进制帧,文本帧在握手期忽略)
      const hsHandler = (data, isBinary) => {
        if (!isBinary) { log.debug('ws 文本帧(握手期忽略):', String(data).slice(0, 120)); return; }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const id = buf[0];
        log.debug('ws 帧 id=0x' + id.toString(16), 'len=', buf.length, 'phase=', phase);
        switch (id) {
          case HS.PKT.SERVER_VERSION: {
            // 服务器回应它自己的版本+认证类型喵~
            const sv = HS.parseServerVersion(buf);
            log.debug('SERVER_VERSION proto=' + sv.protocolVersion, 'gameVers=' + sv.gameVers, 'authType=' + sv.authType);
            if (sv.authType !== HS.AUTH.NONE) {
              // 要认证?本喵离线代理不会喵,直接告诉客户端"该服要密码",断开
              log.warn('服务器要求认证 type=', sv.authType, '—— 离线代理不支持,断开');
              try { L.writeLoginDisconnect(socket, '该服务器要求密码认证,本代理不支持'); } catch (_) {}
              tryClose(ws); return;
            }
            // ok进入下一步:请求登录喵
            phase = 'hs_login';
            ws.send(HS.buildRequestLogin({ username, requestedServer: cfg.eagler.requestedServer }), { binary: true });
            break;
          }
          case HS.PKT.SERVER_ALLOW_LOGIN: {
            // 服务器准了登录喵! 把它给的UUID拿来,顺手把profile和finish发回去喵
            allowLoginRecd = HS.parseServerAllowLogin(buf);
            log.debug('ALLOW_LOGIN user=' + allowLoginRecd.username,
              'uuid(m=' + allowLoginRecd.uuidMSB + ',l=' + allowLoginRecd.uuidLSB + ')');
            ws.send(HS.buildProfileData(allowLoginRecd.uuidMSB, allowLoginRecd.uuidLSB), { binary: true });
            ws.send(HS.buildFinishLogin(), { binary: true });
            break;
          }
          case HS.PKT.SERVER_FINISH_LOGIN: {
            // 服务器说登录完成喵! 本喵给左侧MC客户端回个Login Success,然后切到PLAY
            log.info('SERVER_FINISH_LOGIN → 进入 PLAY [' + clientVer.tag + ']');
            if (!finishedLoginToLeft) {
              // 用服务器发回的用户名(没有就用客户端报名时那个)喵
              const uname = allowLoginRecd && allowLoginRecd.username || username;

              // 用服务器给的MSB/LSB拼出标准UUID喵(没给就没法发Login Success)
              let uuid = null;
              if (allowLoginRecd && allowLoginRecd.uuidMSB != null && allowLoginRecd.uuidLSB != null) {
                uuid = HS.uuidFromHalves(allowLoginRecd.uuidMSB, allowLoginRecd.uuidLSB);
              }
              if (!uuid) {
                log.warn('0x05 未带 UUID, 无法构造 success, 断开');
                try { L.writeLoginDisconnect(socket, '登录失败: 服务器未返回 UUID'); } catch (_) {}
                tryClose(ws);
                break;
              }

              // 给客户端发Login Success(进入play的前置条件)喵~
              L.writeLoginSuccess(socket, uuid, uname);
              finishedLoginToLeft = true;

              // 把这个玩家登记到broadcaster的"代理玩家列表"里喵
              const adapterPid = registerAdapterPlayer(uname);

              // 摘掉握手处理器,从此交给PLAY透传喵
              ws.off('message', hsHandler);
              // 左侧TCP的帧处理也停掉喵(frameLoop里discard=true)
              discard = true;
              // 把双方交给透传逻辑接管喵
              attachPlayPassthrough(socket, ws, log, cfg.dumpTextPackets, clientVer.tag, adapterPid);
            }
            phase = 'play';
            break;
          }
          case HS.PKT.VERSION_MISMATCH:
          case HS.PKT.SERVER_DENY_LOGIN:
          case HS.PKT.SERVER_ERROR:
          case HS.PKT.SERVER_REDIRECT_TO: {
            // 各种"不让进"的情况喵~ v3标志决定错误消息长度字段是2字节还是1字节
            const v3 = phase !== 'hs_version';
            const r = HS.parseErrorOrControl(buf, v3);
            log.warn('登录被拒:', JSON.stringify(r));
            // 把原因告诉客户端,然后关掉ws喵
            try { L.writeLoginDisconnect(socket, r && r.message ? r.message : '登录被拒'); } catch (_) {}
            tryClose(ws);
            break;
          }
          default:
            log.warn('握手期未知帧 0x' + id.toString(16), 'len=', buf.length);
        }
      };
      ws.on('message', hsHandler);

      // ws本身的错误喵~ 告诉客户端"目标连不上",然后断开
      ws.on('error', (e) => {
        log.error('ws 错误:', e && e.message ? e.message : e);
        disposeWs(ws);
        try { L.writeLoginDisconnect(socket, '目标服务器连接错误'); } catch (_) {}
        try { socket.destroy(); } catch (_) {}
        reject(e);
      });
      // ws在登录还没完成前就关了喵~ 告诉客户端原因再断开
      ws.on('close', (code, reason) => {
        log.debug('ws 关闭 code=' + code, 'reason=' + String(reason));
        disposeWs(ws);
        if (!finishedLoginToLeft) {
          try { L.writeLoginDisconnect(socket, '目标服务器已关闭连接'); } catch (_) {}
          try { socket.destroy(); } catch (_) {}
        }
      });
    });
  }
}

// PLAY期透传接管喵~ 从这一刻起,握手协议双方已经对齐(EaglerXServer按gameVers适配),
// 本喵只做"加长度前缀 / 拆长度前缀"的搬运喵(socket和ws之间互转)
function attachPlayPassthrough(socket, ws, log, dumpText, clientVerTag, adapterPid) {
  // 右侧(EC)→左侧(MC)方向的计数喵(包数/字节数/keepalive)
  let rlCount = 0, rlBytes = 0, rlKeepAlive = 0;
  // EC侧来了一帧喵(已经是裸的Eagler/MC包体),给前面加个VarInt长度前缀,原样发给左侧socket
  const onWsMessage = (data, isBinary) => {
    if (!isBinary) return; // 文本帧PLAY期本喵不转喵
    // 把各种形态的数据都归一成Buffer喵
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) :
      ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) :
        Buffer.isBuffer(data) ? data : Buffer.from(data);
    // 算长度前缀并写好喵
    const prefix = Buffer.allocUnsafe(varInt.varIntSize(buf.length));
    varInt.writeVarInt(buf.length, prefix, 0);
    rlCount++; rlBytes += buf.length;
    // 顺便读一下包ID喵(头几个包debug时会打,keepalive也单独数一下)
    let pid = -1;
    try { pid = varInt.readVarInt(buf, 0).value; } catch (_) {}
    if (pid === 0x00) rlKeepAlive++;
    if (rlCount <= 3) log.debug('PLAY EC→MC #' + rlCount, 'wslen=' + buf.length, 'pid=0x' + pid.toString(16));
    if (dumpText) {
      // 如果开了debug文本转储喵,就偷瞄一眼文本包(只读,转储后照常转发)
      try { dumpTextPacket(Buffer.from(buf), log, clientVerTag); } catch (e) { log.warn('文本包转储异常(已忽略):', e && e.message); }
    }
    // socket还能写就发出去喵(长度前缀+包体)
    if (socket.writable) {
      try { socket.write(Buffer.concat([prefix, buf])); }
      catch (e) { log.warn('EC→MC 写 socket 失败:', e.message); }
    } else {
      // socket不能写了就丢掉这帧喵(避免堵住)
      log.warn('EC→MC socket 不可写,丢弃帧(wslen=' + buf.length + ')');
    }
  };
  ws.on('message', onWsMessage);

  // 左侧(MC)→右侧(EC)方向的缓冲和计数喵
  let inbound = Buffer.alloc(0);
  let lrCount = 0, lrBytes = 0, lrKeepAlive = 0;
  // 左侧socket来数据了喵~ 按VarInt长度切成完整包,把"包体"原样塞进ws(它自己有帧定义长度)
  const onSocketData = (chunk) => {
    if (ws.readyState !== ws.OPEN) return; // ws没开着就不处理喵
    inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
    while (true) {
      let lenInfo;
      try { lenInfo = varInt.readVarInt(inbound, 0); }
      catch (_) { break; } // VarInt没凑齐就等下一段喵
      const len = lenInfo.value;
      const total = lenInfo.bytes + len;
      if (inbound.length < total) break; // 整包还没攒够喵
      // 切出整个包体(含包ID VarInt),把它原样塞给ws~ (ws自带帧长度,本喵不用再加前缀)
      const packetBody = inbound.subarray(lenInfo.bytes, total);
      inbound = inbound.subarray(total);
      lrCount++; lrBytes += len;
      // 顺便读一下包ID做计数和debug喵
      let lrPid = -1;
      try { lrPid = varInt.readVarInt(packetBody, 0).value; } catch (_) {}
      if (lrPid === 0x00) lrKeepAlive++;
      if (lrCount <= 3) log.debug('PLAY MC→EC #' + lrCount, 'pktlen=' + len, 'pid=0x' + lrPid.toString(16));
      try { ws.send(packetBody, { binary: true }); }
      catch (e) { log.warn('MC→EC ws.send 失败:', e.message); }
    }
  };
  socket.on('data', onSocketData);

  // 每15秒喵一声当前流水统计给主人看喵(包数/字节/keepalive)
  const flowTimer = setInterval(() => {
    log.debug('PLAY 流水: EC→MC ' + rlCount + '/' + rlBytes + 'B, MC→EC ' + lrCount + '/' + lrBytes + 'B');
  }, 15000);

  // 清理状态喵~ (只清一次, cleaned防重复)
  let cleaned = false;
  const cleanup = (why) => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(flowTimer);
    // 走的时候打个总结喵(哪边多少包/字节/keepalive)
    log.info('PLAY 结束 ' + why + ' [' + clientVerTag + '] EC→MC ' + rlCount + '/' + rlBytes + 'B keep=' + rlKeepAlive +
      ', MC→EC ' + lrCount + '/' + lrBytes + 'B keep=' + lrKeepAlive);
    // 把监听器都摘下来,关掉ws,注销代理玩家喵
    try { ws.off('message', onWsMessage); } catch (_) {}
    try { socket.off('data', onSocketData); } catch (_) {}
    disposeWs(ws);
    tryClose(ws);
    try { unregisterAdapterPlayer(adapterPid); } catch (_) {}
  };
  // ws关了喵~ 就把socket也优雅关掉,然后清理
  ws.on('close', (code, reason) => {
    log.debug('PLAY EC侧 ws 关闭 code=' + code, 'reason=' + String(reason));
    try { socket.end(); } catch (_) {}
    cleanup('ws-close(' + code + ')');
  });
  // ws拿到意外响应(比如http错误页)喵~ 清理收尾
  ws.on('unexpected-response', (req, res) => {
    log.warn('PLAY EC侧 ws unexpected-response status=' + (res && res.statusCode));
    cleanup('ws-unexpected-response');
  });
  // socket关了喵~ 先关ws再清理
  socket.on('close', (hadErr) => { tryClose(ws); cleanup('sock-close' + (hadErr ? '(err)' : '')); });
  // socket报错喵~ 记下来再清理
  socket.on('error', (e) => { log.warn('PLAY MC侧 socket 错误:', e && e.message); cleanup('sock-error'); });
  // ws报错喵~ 记下来再清理
  ws.on('error', (e) => { log.warn('PLAY EC侧 ws 错误:', e && e.message); cleanup('ws-error'); });
}

module.exports = { attachSocket };
