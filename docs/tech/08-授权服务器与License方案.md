# 08 · 授权服务器与 License 方案（webvr123.site）

> **状态**：P1（服务器）**已实现并自测通过（36/36）**，代码在 `tools/cast-server/`；
> P2（EXE 接入）/ P3（头显接入）**待做** —— 在它们完成前，两端仍走第十七修的固定密钥方案，不影响现场。
> **需求背景**（2026-09-20 需求方拍板）：EXE 连 `webvr123.site` 取密钥，密钥约 15 天一换 → 需要一套商业化授权。
> **四项已定**：① 用非对称签名（防伪造 EXE）② 落盘缓存 + 离线可用到硬到期日 ③ 服务器从零规划 ④ EXE 侧游戏数据保护暂缓（靠合同约束）。

---

## 0. 一句话结论

**要做的不是「生成密钥」，是「签发凭据」。**

随机生成一个 15 天有效的字符串，和用服务器私钥签一份带到期时间的 license，防护强度差两个量级。而且只有签名还不够 —— 必须把 license **绑到那台 EXE 独有的密钥**上，否则把 license 原文拷走就能白嫖。

---

## 1. 三层结构

| 段 | 角色 | 现状（第十七修） | 本轮 |
|---|---|---|---|
| ① 授权服务器 `webvr123.site` | 签发 license / 记录客户与到期 / 吊销 | **不存在** | 从零搭 |
| ② EXE 直播端（PC） | 激活、续期、缓存 license、向头显出示 | 有门禁 + 固定密钥 | 加 License 客户端 |
| ③ 头显 APK | 验 license 签名 + 验 EXE 持有其私钥 → 放行 | 有门禁 + 固定密钥 | 加验签模块 |

**为什么②③之间不能继续用共享密钥**：第十七修的 `webxr-cast` 是编译进两端的常量，反编译即得；而且它**必须给头显读**，所以任何"给头显看的凭据"里都不可能藏住一个共享密钥。→ 这一层必须换成**公钥验签**。

---

## 2. 三把钥匙

| 名称 | 存放 | 用途 | 保密级别 |
|---|---|---|---|
| **Ks**（签发私钥） | **只在服务器** `secrets/license-sign.pem`（权限 600） | 签 license | 🔴 最高。丢失 = 全部已发凭据无法续期，必须离线备份 |
| **Ks_pub**（签发公钥） | 硬编码进 EXE 与 APK | 验 license 签名 | 🟢 公开，反编译无害 |
| **Ke / Ke_pub**（EXE 实例密钥） | `Ke` 在 EXE 用户目录；`Ke_pub` 写进 license | 出示时证明「我就是被签的那台 EXE」 | 🟡 `Ke` 保密（影响范围仅那台机器） |

### 为什么非要有 Ke（全案最容易漏的一环）

license 原文是要**出示给头显**的，在店里的局域网上传输。若只签一份静态凭据，那么**任何拿到 license 原文的人都能原样转发**给头显 → 头显照放行 → 白嫖。

绑 Ke 之后，出示时要求 EXE **用 Ke 私钥签一个头显当场给的随机数（nonce）**。license 副本可以随便传，但**没有 Ke 私钥就签不出这个新鲜证明** → 静态字符串升级为**不可复制的持有证明（Proof of Possession）**。

> 设计上的关键收益：**整个方案不依赖代码保密**。攻击者可以完整反编译 EXE 与 APK，只要拿不到 Ks 与 Ke 私钥，就伪造不出 license、也出示不了 proof。

---

## 3. 签名算法与格式（已实测）

### 3.1 选型：ECDSA P-256 + SHA-256

| 候选 | 结论 |
|---|---|
| **ECDSA P-256（推荐）** | Node 原生；Android 从 API 1 起原生支持；**本项目 minSdk 24 无需改动** |
| Ed25519 | Node 原生且格式固定（64B），但 **Android 侧需 API 28+**，而本项目 `minSdk 24`（Android 7）→ 装机面收窄，不选 |

> 出处：`tools/cast-apk/app/build.gradle:14` → `minSdk 24`。

### 3.2 编码对齐（实测数据，务必照抄）

Node `crypto` 对 ECDSA 的**默认输出就是 DER**，与 Java `Signature.getInstance("SHA256withECDSA")` 天然一致：

```
EC P-256 default len= 70 | der len= 71 | ieee-p1363 len= 64
default === der ? false        ← 仅因 ECDSA 每次随机 k，签名字节不同；两者都是 DER
ed25519 sign len= 64
```

**结论与硬约束**：

- ✅ Node 侧直接 `crypto.sign('sha256', data, privKey)`（**不要**传 `dsaEncoding`）
- ✅ Java 侧 `Signature.getInstance("SHA256withECDSA")`
- ❌ **绝不要**给 Node 传 `dsaEncoding: 'ieee-p1363'` —— 那会变成 64 字节固定格式，Java 侧验不过
- **公钥传递**：Node `publicKey.export({type:'spki',format:'der'}).toString('base64')` → Java `X509EncodedKeySpec` + `KeyFactory.getInstance("EC")`

### 3.3 license 文本格式

```
<base64url(payloadJSON)>.<base64url(signature)>
```

**签名对象 = 左边那串 base64url 文本本身（ASCII）**，不要签 JSON 原文 —— 否则两端 JSON 键序/空格差异会导致算不出同一串。

| 字段 | 类型 | 含义 |
|---|---|---|
| `v` | int | 格式版本，当前 1 |
| `lic` | string | license 编号（后台主键，吊销按它） |
| `cust` | string | 客户 / 门店标识 |
| `dev` | string | PC 机器指纹，防整机搬走 |
| `ke` | string | EXE 实例公钥（base64url，SPKI DER） |
| `iat` | int(ms) | 签发时刻 |
| `nbf` | int(ms) | 生效时刻 |
| `exp` | int(ms) | **到期时刻**（= iat + 15 天） |
| `n` | string | 随机 nonce，防同 payload 复用 |

示例（格式化后仅供阅读，实际是压缩 JSON）：

```json
{"v":1,"lic":"L20260920-0007","cust":"AcmeArcade-SH-01","dev":"9f2c1e...",
 "ke":"MFkwEwYH...","iat":1789890000000,"nbf":1789890000000,
 "exp":1791186000000,"n":"b7d41c93"}
```

> ⚠️ **payload 里不放共享密钥** —— 它是明文可读的。头显侧的请求鉴权改用第 4 节的 `proof`。

---

## 4. 三条流程

### 4.1 激活（一次性 / 换机时）

```
EXE 首次运行
  ├─ 本地生成 Ke / Ke_pub（P-256，落 userData/license-key.pem）
  ├─ 采集本机指纹 dev
  └─ POST https://webvr123.site/api/license/activate   { actCode, dev, ke }
        ↓ 服务器：校验激活码 → 建档(lic, cust, dev, ke) → 用 Ks 签 payload
        ↓ 返回 license 文本
  EXE 落盘 userData/license.json
```

### 4.2 续期（到期前 3 天起，每 6 小时试一次）

```
POST /api/license/renew  { lic, dev, ke, ts, proof }
     proof = Ke_sign("renew|" + lic + "|" + ts)
        ↓ 服务器：Ke 与建档一致 + ts 偏差 ≤5min + proof 验签通过 + lic 未吊销
        ↓ 返回新 license（exp = now + 15d）
```

### 4.3 头显放行（每局一次）

```
① APK 生成 nonce（16B 随机）
② GET http://<PC>:8443/api/license/current?nonce=<nonce>      ← 无需鉴权，公开出示
      EXE → { license, nonce, proof }        proof = Ke_sign("cast|" + nonce)
③ APK 用内置 Ks_pub 验 license 签名 → 不过 = 伪造 EXE，直接拒绝
④ APK 检查 nbf ≤ now ≤ exp → 过期 = 拒绝（提示「直播端授权已到期」）
⑤ APK 从 license 取 ke → 验 proof → 不过 = 对方拿的是拷贝，拒绝
⑥ APK 查吊销名单（缓存版）→ 命中 = 拒绝
⑦ 确认 EXE 正版 → 继续走既有门禁（launch/request → config/dump）
```

**为什么第 ② 步可以无鉴权**：license 本来就是「给人看」的凭据（像身份证）。安全性不来自保密，而来自**签名不可伪造 + proof 不可复制**。

**⚠️ 请求鉴权怎么办**（`/api/launch/request` 与 `/api/config/dump` 现在用 `HMAC(secret, dev|ts)`）：共享密钥在任何"要出示给头显"的凭据里都是明文，所以两条路：

| 走法 | 做法 | 取舍 |
|---|---|---|
| **A（已采纳 · 2026-09-20 拍板）** | 鉴权从 HMAC 改为 **proof 签名** | 跨端零共享密钥，彻底 |
| B（未采纳） | 保留 HMAC，密钥改为两端各自推导 `HMAC(ke, "cast-key")` | 改动最小，但引入推导常数且无新鲜性 |

### 4.4 ⚠️ 实施 A 的必然推论（原 §6/§7 是按 B 写的，已过时）

上一节写「EXE 用 `Ke` 签、头显用 license 里的 `ke` 验」，**只覆盖了 EXE → 头显这一个方向**。
而 `launch/request` / `config/dump` 是 **头显 → EXE** 方向：头显手里**没有任何私钥**，
所以「零共享密钥」在这一方向**无法只靠 license 完成** —— 必须让头显自己持有一对密钥：

| 步骤 | 谁做 | 内容 |
|---|---|---|
| ① | APK 首次运行 | 本地生成 `Ka` / `Ka_pub`（P-256，落 app 私有目录） |
| ② | APK → EXE | `POST /api/launch/request {dev, ts, kapub, sig}`，`sig = Ka_sign("launch|" + dev + "|" + ts)` |
| ③ | EXE 验 | 用请求里带来的 `kapub` 验签（±30s 时间窗）+ 白名单命中 `kapub` |
| ④ | 白名单语义 | 从 `allowList: ["<dev>"]` 变为 `[{dev, kapub}]`；配对窗口仍自动登记首台 |

**若不接受 ①~④，A 就退化成「丢掉头显→EXE 的鉴权」** —— 等于局域网内**任何设备都能拉走下发的关卡配置**，
比现在的 HMAC 更弱。这一点必须显式拍板，不能默默选。

### 4.5 兜底策略（2026-09-20 拍板：0 天，到期即停）

- 第十七修的 `GUARD_SECRET_DEFAULT` / `GUARD_SECRET_FIXED` **不再作为离线兜底**。
  它在 proof 迁移完成前只充当**过渡期临时鉴权**，迁移后应视为死代码并加显著注释，
  **绝不可重新启用为放行路径**（否则授权形同虚设）。
- ⚠ 代价：授权服务器成为**硬单点**。服务器故障超过 `exp` 后，全国门店立即停玩。必须同时补三件事：
  1. 服务器自动重启 + 监控告警（systemd `Restart=always` 已具备，缺外部告警）；
  2. EXE 界面常显「剩余天数」并提供**一键续期**（P2 必做，写进本轮）；
  3. 私钥 `license-sign.pem` 离线备份 —— 工具已备好（`deploy/backup-license-key.sh` 一条命令 + **强制演练**，见 §11 第 6 项），**待执行一次**（仍是第一优先的运维项）。

---

## 5. 服务器侧（从零）

### 5.1 选型

| 项 | 建议 | 理由 |
|---|---|---|
| 运行时 | Node.js 20+ 单进程 | 与 EXE 同语言，`node:crypto` 一套密码学代码两端复用 |
| Web | 原生 `http` / Express | 只有 5 个路由 |
| 存储 | **SQLite**（`better-sqlite3`） | 单文件、无服务、备份=拷文件 |
| HTTPS | **Caddy 反代**（自动 Let's Encrypt） | 一行配置拿证书 + 自动续期 |
| 守护 | systemd | 开机自启 + 崩溃重启 |
| 机器 | 最小 VPS（1C1G）足够 | 每天几次请求 |

### 5.2 目录结构

```
webvr123/
├─ server.js                  # 入口：路由
├─ lib/license.js             # 签/验、payload 编解码
├─ lib/db.js                  # SQLite 封装
├─ secrets/license-sign.pem   # 🔴 Ks 私钥（600）
├─ secrets/license-pub.pem    # 🟢 Ks_pub（要硬编码进两端）
├─ data/license.db            # SQLite
├─ public/admin.html          # 管理后台（Basic Auth）
└─ gen-keys.js                # 一次性生成 Ks
```

### 5.3 接口

| 方法 | 路径 | 调用方 | 鉴权 | 作用 |
|---|---|---|---|---|
| POST | `/api/license/activate` | EXE 首次 | 激活码 | 建档 + 签发首份 license |
| POST | `/api/license/renew` | EXE 周期 | Ke 签名 proof | 续期 |
| GET | `/api/license/revoked` | EXE 周期 | Ke 签名 proof | 拉吊销列表 |
| POST | `/api/license/issue` | 管理后台 | 管理员 token | 手工签发 |
| POST | `/api/license/revoke` | 管理后台 | 管理员 token | 吊销 |

### 5.4 部署（已实现 → `tools/cast-server/README.md` §3）

`tools/cast-server/deploy/install.sh` 是**一键部署脚本**（Ubuntu / Debian，幂等，可反复执行）。
在服务器上：

```bash
sudo mkdir -p /opt/webvr123
sudo tar -xzf /tmp/cast-server.tgz -C /opt/webvr123
sudo bash /opt/webvr123/deploy/install.sh
```

它做 9 件事：检查环境 → 装 Node 22 / Caddy → 建系统用户 → 同步代码 →
**生成密钥与管理员凭证（已存在则保留，绝不覆盖）** → 装 systemd（自动改写 `ExecStart` 的 node 路径）→
写 Caddyfile（**已有其它站点时备份但不覆盖**，除非 `FORCE_CADDY=1`）→ 放行 80/443 →
起服务 + 本机健康检查 + DNS 比对 + HTTPS 自测。跑完打印 **公钥指纹与内容**。

由于 systemd 单元用了 `ProtectSystem=strict`，有两条顺序上的硬要求（脚本已处理，手工部署时必须照做）：

1. **`data/` 目录必须先存在** —— `ReadWritePaths=/opt/webvr123/data` 指向不存在的路径会让 systemd 直接拒绝启动；
2. **`secrets/admin.json` 必须预先生成** —— 服务对 `/opt/webvr123` 是只读的，等到首次启动再自动生成会写盘失败。

手工部署时的原始初始化清单（顺序不能错）：

1. `node gen-keys.js` → 生成 `secrets/license-sign.pem` + `license-pub.pem` + `public-key.txt`
2. **立刻离线备份私钥**（U 盘 / 另一台机）。丢了只能重发两端的新包。
3. 把 `public-key.txt` 内容硬编码进 `cast-pc/main.js` 与 `MainActivity.java`（P2 / P3 时做）
4. Caddy 配置 `webvr123.site` → `127.0.0.1:8787`
5. systemd 起服务，`curl` 自测各路由

> **密钥从哪来只能选一种**：本地生成后上传，或让服务器自己生成（推荐，私钥不经过任何其它机器）。
> 混用会让两端硬编码的公钥与服务器私钥对不上，现象是"永远验签失败"，且 ECDSA 每次签名都不同、无法用固定样本比对，极难定位。

---

## 6. EXE 侧改动（`tools/cast-pc/main.js`）— ✅ **P2 已实现（2026-09-20）**

现状：`main.js` 798 → **1171 行**（LF）。下表是**实际落点**，不是计划：

| 位置 | 内容 |
|---|---|
| L13 端点注释块 | 已补 `GET /api/license/current` |
| L626~661 | License 密钥契约注释 + 常量 + `LICENSE` 状态对象：`LICENSE_BASE` / `LICENSE_PATH` / `LICENSE_KEY_PATH` / `LICENSE_PUBKEY_B64` / `LICENSE_RENEW_LEAD_MS`（3 天）/ `LICENSE_RENEW_INTERVAL_MS`（6 h）/ `LICENSE_SKEW_MS`（±5 min）/ `LICENSE_GRACE_MS`（**0**） |
| L666~675 | `licenseKey()` —— 生成/载入本机 `Ke`（PKCS#8 PEM），返回 `{priv, ke}`，`ke = base64url(SPKI DER)` |
| L678~680 | `licenseSign(text)` —— `Ke` 签名，`crypto.sign('sha256', …, priv)`，**默认 DER**（与 Java `SHA256withECDSA` 天然对齐） |
| L689~701 | `machineFingerprint()` —— `dev` = sha256(hostname ｜ CPU 型号 ｜ 排序后的非内网 MAC) |
| L708~752 | `verifyLicenseLocal(text)` —— 验签 → **ke 绑定本机** → 时间窗；**纯本地，断网也能判到期** |
| L754~775 | `applyLicense()` / `loadLicense()` / `saveLicenseText()` |
| L778~794 | `licenseState()` —— 供 UI / `/api/info` / `/api/license/current` 读，含 `keyPath` / `licensePath` |
| L800~897 | `licensePost()` / `licenseActivate()` / `licenseRenew()` / `startLicenseWatch()`（启动跑一次 + 每 6 h；只在进入续期窗口或已过期时才联网） |
| L905~910 | `licenseGate()` —— 门禁总闸（兜底 0 天） |
| L919~934 + L419 | `handleLicenseCurrent()` 与它的路由 —— **无鉴权**，且必须排在 `/api/*` 代理**之前** |
| L936~949 | `GUARD_SECRET_DEFAULT` —— **仍是固定共享密钥**（头显 → EXE 方向的 `Ka` 在下一轮） |

**⚠️ 与初版计划的差异（勿照旧计划改回去）**：

1. `GUARD.secret` **没有**改成 `LICENSE.sessionKey` —— 头显 → EXE 方向保留 HMAC 固定串（A 方案只完成了一半，见 §4.4）。
2. 函数名是 `licenseKey()`（不是计划里的 `ensureLicenseKey()` / `loadLicenseKey()`）—— 生成与载入合一，天然幂等。
3. `licenseState()` 多回**两个真实路径**（`keyPath` / `licensePath`）—— 现场排查必备：本次实跑夹具正是靠它证明「读的是临时目录、没碰真实用户目录」。
4. 新增了 `verifyLicenseLocal` 的 **ke 绑定本机**（见 §6.1）—— 初版计划里没有这一条。

### 6.1 新增：ke 绑定本机（实跑加固，2026-09-20）

`main.js` L727~742，位置在「验签通过」之后、「时间窗」之前：

```js
const mine = licenseKey().ke;
if (String(r.payload.ke || '') !== mine) { r.why = 'license 属于另一台机器（ke 不匹配）→ 请在本机重新激活'; return r; }
```

**为什么必须加**：原先只验「Ks 签名 + 时间窗」，不绑定本机身份 ⇒ 把 `license.json` 连同 `license-key.pem`
一起拷到另一台机器，**本机界面照样显示「授权有效、剩余 N 天」**，而头显要到第 ⑤ 步（用 license 里声明的 `ke`
验 proof）才拒绝 —— 现场看到「EXE 说没问题、头显说过不去」，几乎无法判读。补上这条后，两端结论一致。

**⚠️ 刻意不绑 `dev`（机器指纹）**：`dev` 的稳定性（换网线 / 重启是否漂移）尚未按 §11.3 做过「重启 3 次比对」，
过早绑定会把「网络变化」变成「莫名其妙要求重新激活」。
**⚠️ 这条只能防「同一台机器上换 license」，防不住拷贝** —— 权威判据仍是头显的第 ⑤ 步（头显不知道 PC 的指纹）。

实跑验证见 §7.4（3 个场景全过）。

**⚠️ 服务器不可达时**：**不阻塞启动**（EXE 照常监听 8443），只让放行请求带
`why="直播端授权已到期/未激活"`。这样操作员能看到界面与日志，但游戏起不来 —— 比 EXE 直接退出好排障。

**⚠️ 授权服务器请求必须校验证书**：`licensePost()` 走严格校验，绝不写 `rejectUnauthorized: false`，那等于给中间人开门。

**⚠️ 本机服务是纯 HTTP，不是 HTTPS**：`main.js` 起的是 `http.createServer`；`certs/`、`ensureCerts()` 与
`selfsigned` 依赖是**从未被调用**的历史死代码，**已于 2026-09-23 全部删除**
（PICO 不信任自签证书 ⇒ 早已改成纯 HTTP；头显侧同样是 `HttpURLConnection` + `"http://" + pc`）。
别拿 `https://` 去连它（会得到 `SSL: WRONG_VERSION_NUMBER`，且**看起来像接口挂了**）。

---

## 7. APK 侧改动（`tools/cast-apk/.../MainActivity.java`）— ✅ **P3 已实现（2026-09-20）**

现状：`MainActivity` 2852 → **3022 行**；另新增 `LicenseVerify.java`（纯 Java 校验核心，见 §7.2）。

| 位置（实现后的行号） | 内容 |
|---|---|
| L347 `LICENSE_PUBKEY_B64` | 生产签发公钥（**标准** base64 / SPKI DER），来源 `GET /api/pubkey`，fingerprint `4156b73a…`。**必须与 `cast-pc/main.js` 逐字一致**；由 `tools/cast-apk/patch-license-pubkey.py` 程序内注入 + 双口径哈希自证 |
| L354-356 | `LICENSE_FETCH_TIMEOUT_MS` 2500ms / `LICENSE_SKEW_MS` ±5min / `LICENSE_MAX_BYTES` 64KB |
| L337 `GUARD_SECRET_FIXED` | **降级为过渡期临时鉴权**（兜底 0 天）；注释已写明：迁移到头显 `Ka` 后应视为死代码，**绝不可重新启用为放行路径** |
| L1365 `guardSecret()` | **暂不动**（头显 → EXE 方向仍是 HMAC）；注释写明 A 的剩余一半（`Ka` / `Ka_pub`）在下一轮 |
| L1412 `guardNonce()` | 16 字节 → **32 位 hex**，`SecureRandom` 当场生成（hex 全字符合法，不会被 EXE 侧的清洗逻辑改掉） |
| L1423 `LicenseFetch` / L1438 `fetchExeLicense()` | `GET /api/license/current?nonce=`（**无鉴权**）；`code ≤ 0` = 连不上/超时 |
| L1483 `licenseCheck()` | 主入口：非 200 → 过渡态；**404 → `KIND_ABSENT`（旧版 EXE）**；200 → 交 `LicenseVerify.evaluate()` |
| L968 `guardWaitLoop()` | 在「已放行」之后、`fetchExeConfig()` 之前插入校验 |
| L959 | 拒因来自**对面**（`why` 含「直播端」，即 EXE 侧 `licenseGate()` 的文案）时，标题由「本机未获授权」改为「**直播端授权异常**」；展示时长 1200ms → 4000ms（原来短到读不完） |

**⚠️ 校验点的位置是刻意选的**：排在「已确认是本机直播端**且它已放行**」之后，而不是重试循环的最前面。理由：

1. 既让 license 成为「继续拉配置的**必要条件**」（授权不过 → 配置下不来 → 游戏起不来），
2. 又**一根手指都不动**既有的四态分类（地址定性 / 旧版 EXE / 连不上），不会把硬约束 61 那个坑踩回去；
3. 旧版 EXE 因此得到的是**确定的结论**「直播端版本过旧 → 换 EXE」，而不是等满 20 秒的超时。

`retry()` ⇒ **落回循环尾继续等**（留痕 + 700ms 后重试，仍受 20s 预算约束）；`KIND_ABSENT` / 其他 `DENY` ⇒ 立刻出结论 + 黑底提示 + `finish()`。

### 7.2 新增 `LicenseVerify.java`：把校验逻辑抽成可离线测试的一类

除 `android.util.Base64` 与 `org.json` 外**零 Android 依赖**（不碰 Activity/Context/网络），
所以能在 PC 上跑**同一份源码**。这不是洁癖：跨语言签名对不齐的现象**只有「永远验不过」**，
而 ECDSA 每次签名随机、无法用固定样本比对 —— 唯一的可靠办法就是两套独立实现各算一次。

| 成员 | 作用 |
|---|---|
| `evaluate(body, nonce, ksPubB64, nowMs, skewMs)` | 一次判定整份响应 → `Verdict{kind, why, lic, cust, exp, daysLeft}`，**永不抛异常、永不返回 null** |
| `KIND_OK / DENY / ABSENT / RETRY` | 四态分类：决定调用方「出结论」还是「继续重试」 |
| `b64Decode()` | base64 与 base64url 通吃（先归一化填充，见下） |
| `verifyAscii(pub, msg, sigB64u)` | `SHA256withECDSA` + DER；**所有异常吞掉 → false**（Java 对畸形签名是抛异常，放任会崩 App） |

校验链：**nonce 回显 → Ks_pub 验 license → 时间窗（纯本地，断网也能判到期）→ 取 `ke` → 用 `ke` 验 proof**。

⚠️ **两处必须照抄的编码细节**（都属于「现象只有永远验不过」的类型）：

1. **不依赖 `Base64.NO_PADDING`**。AOSP 里该 flag 既作用于编码也作用于解码，且各实现对「缺填充 / 多填充」的容忍度不一致，一旦抛 `IllegalArgumentException` 就表现为验签永远失败。做法：`-`→`+`、`_`→`/`，**没有 `=` 时**才按 `len % 4` 补足填充，再交 `Base64.DEFAULT` 解。
2. **`Ks_pub` 是标准 base64（带 `=`），而 payload 里的 `ke` 与签名是 base64url（无填充）** —— 同一份代码里两种写法并存，**不要统一**，也不要「顺手」把 ke 改成标准 base64。

### 7.3 离线互认夹具（新增；改任何签名相关代码后必跑）

```bash
cd tools/cast-server && node xlang/p3test.js
```

- 用 `secrets/` 下的**测试**密钥造 **25 条** `license/current` 响应样本：正常 / 篡改签名 / 篡改 payload / **换一把 Ks 签** / 过期 / 未生效 / nonce 不符 / **proof 由别台机器的 Ke 签**（= 拷贝 license 的形态）/ 缺 `ke` / `ke` 非法 / 对端自称未激活 / HTML 响应 …
- 把 APK 工程里那份 `LicenseVerify.java` **原样拷贝**进构建目录，**打印两侧 md5 并断言一致** ⇒ 保证「跑过的」就是「要打包的」；
- `android.util.Base64` 与 `org.json` 由 `xlang/stub/` 下的 JDK 替身提供（真机用系统实现）；
- **Node 用独立实现**（`lib/license.js` 原语）算出每一条的结论，与声明值断言一致 ⇒ 两套实现逐条吻合才算通过；
- 另有 **7 项畸形入参探针**（`null` / 空串 / 数字当字符串 / 数组 / 垃圾公钥…），只要求「不抛异常」。

**当前结果：25/25 样本 + 7/7 探针通过。**

> ⚠️ 夹具用的是**测试**密钥，只能验证「算法与编码对齐」，**不能**验证「生产公钥是否正确」——
> 后者由 `patch-license-pubkey.py` 的双口径哈希负责。
> ⚠️ `HTTP 404 → KIND_ABSENT` 与「连不上 → KIND_RETRY」属 HTTP 层，**离线测不到，必须现场覆盖**。

### 7.4 EXE 侧端到端实跑夹具（**真启动 Electron**；改任何门禁代码后必跑）

```bash
cd tools/cast-server && node xlang/exe-license-e2e.js
```

**为什么必须实跑**：`verifyLicenseLocal()` 里新增的 **ke 绑定本机**分支（`main.js` L727~742）一旦误判，
后果是**所有真实客户被锁死**。这条分支读代码看不出问题 —— 上一轮就有一个「看着完全正确」的版本
因为启动方式不对而**根本没被跑到**（三个场景日志一模一样）。所以必须让真 Electron 去读真
`userData/license.json`，看三条分支各走哪一条。

用 `--user-data-dir=<临时目录>` 隔离，**绝不碰**真实用户目录（断言返回的 `state.licensePath` 确实落在临时目录里）。

| 场景 | 预置 | 期望启动横幅 | 期望 `/api/license/current` |
|---|---|---|---|
| `fresh` | 只有 `license-key.pem` | ⚠ 授权：\*\*未激活\*\* | `ok:false`、`why=未激活（无 license）`、带 `state`（含真实 `licensePath`） |
| `ke-match` | license 的 `ke` = 本机 Ke | 授权：有效，`lic=L-SELFTEST-01`，剩余 9 天（未进续期窗口，不联网） | `ok:true` + `license` + `proof` + `state.daysLeft=9` |
| `ke-mismatch` | license 的 `ke` = 别台机器 | ⚠ 授权不可用：license 属于另一台机器（ke 不匹配）→ 请在本机重新激活 | `ok:false`、`why` 同上、**响应体里没有 `license` 字段** |

`ke-match` 场景还会把 EXE 返回的 `license` + `proof` **重放一遍头显那整套 P3 判定链**（用 `lib/license.js`
独立复核，不依赖 EXE 的自述）：
① nonce 原样回显 → ② 用 `Ks_pub` 离线验 license 签名 → ③ `payload.ke` 就是本机 Ke →
④ 时间窗 `nbf ≤ now ≤ exp` → ⑤ 用**本机** Ke 公钥验 `proof` **通过**、用**别台** Ke 公钥验**必须失败**、
换一个 nonce 重放**必须失效**。
这样才能证明「EXE 吐出的材料真能被头显接受」，而不只是「EXE 自己说有效」。

**当前结果：3/3 场景、29 项断言全通过**（含 `main.js` 的 md5 逐字节还原断言）。

> ⚠️ 夹具会**临时改写** `cast-pc/main.js` 里的内置公钥（生产 `Ks_pub` → 测试 `Ks_pub`），
> 跑完在 `finally` 里**逐字节还原**并断言 md5 等于打补丁前的值 ⇒ **不要在它运行时同时打包 EXE**。
> ⚠️ 实跑 Electron 的三个环境坑（`ELECTRON_RUN_AS_NODE=1` 使 electron 退化成纯 Node /
> 换 userData 必须用 `--user-data-dir`（覆盖 `APPDATA` **无效**）/ cast-pc 是纯 HTTP 不是 HTTPS，
> 自签 HTTPS 分支（`ensureCerts()` / `certs/`）**已删除**，不再是陷阱）见 skill 的 **Gotcha 30 的 ①⑤⑥**；
> 夹具自身的可靠性纪律见 skill 硬约束 **85、86**。

---

### 7.5 线上往返实跑（**拿真实激活码打生产服务器**；发版前必跑）

```bash
cd tools/cast-server && node xlang/online-activate-e2e.js <激活码>
```

**为什么非要打真服务器**：§7.3、§7.4 两套夹具用的都是**本地测试密钥**，只能证明「算法与编码对齐」。
真正会把所有客户**一次锁死**的 bug 只有一类 ——
**服务器实际签发用的私钥 ≠ 两端源码里硬编码的那串公钥**
（换机迁移、误覆盖 `secrets/`、装了两个实例、手工替换公钥……）。
它离线**永远测不到**（离线样本是自己用测试密钥签的），而且**当下不报错**：`/api/health` 照常 200、
激活照常返回 license，要到**头显拿去验签**才失败 —— 那时现场只能看到「EXE 说有效、头显说过不去」。
唯一的办法：让生产服务器**真签一张**，再用**两端源码里那串字面量**去验。

固化的三条断言（缺一不可）：

1. `/api/pubkey.keyB64` == `cast-pc/main.js` 的 `LICENSE_PUBKEY_B64` == `cast-apk/MainActivity.java` 的同名常量（**逐字节**）；
2. 该串能被解析成 `ec/prime256v1`（不是一段坏文本），且 `derSha256` 与本地复算一致（防手抄错字符）；
3. ★ **生产服务器当场签发的 license，用 ① 里那串公钥验签通过** —— 外加负例：正文改 1 个字符必须验不过。

**2026-09-20 实测结果：44 项断言全通过**（`lic=L20260920-0001`，`cust=测试`）：
激活往返 ✓ → 用两端公钥验签 ✓ → 时间窗/字段 ✓ → 头显第 ⑤ 步（nonce+proof，含换机/换 nonce 两条负例）✓ →
同 dev 幂等复跑 ✓ → 续期往返（新 exp 推后 15 天、`iat` 不变）✓ → 吊销名单 ✓ → 6 条反例 ✓。

四条实测结论（都会再踩，先记下来）：

1. **`renew` / `revoked` 的 `lic` 参数是「编号」**（`payload.lic`，形如 `L20260920-0001`），
   **不是**整段 license 文本。传整段文本**不报格式错**，而是 `404 notFound`「license 不存在」
   —— 极易被误读成「服务器把数据弄丢了」（本轮就误判了一次）。
2. **同 `dev` 激活是幂等的 ⇒ 夹具复跑免费**：夹具把 Ke 与 dev 一起持久化在 `xlang/out/online/`，
   复跑走「本机已激活」分支，**不再消耗配额**；要验「全新签发」必须显式 `--new-dev`（那会再扣 1 次）。
3. **`daysLeft` 有两个口径**：激活响应里的是**名义值**（= `ttlDays` = 15），而两端一律按
   `floor((exp - now) / 86400000)` **实算** ⇒ 激活当天界面显示 **14 天** 而不是 15；
   同一张 license 走幂等分支时服务器也改报实算值 14。属**显示口径**不一致，不影响判定。
   （推论：最后 24 小时界面会显示「剩余 **0** 天 + 即将到期」——license 其实还有效，
   而本项目兜底是 0 天，容易被现场误读成「已经死了」。`licenseState()` 已经给了 `hoursLeft`，
   P5 的到期文案应当用它。）
4. 6 条反例全部**零消耗**：`403 badCode` / `400 badParam` / `403 badProof` / `403 machineMismatch` /
   `400 stale`（时钟差超 5 分钟）/ `404 notFound` —— 顺带把 P4 的 `/api/license/revoked` 也验通了
   （`count=0`、`revoked` 是数组）。

> ⚠️ 它会**真的消耗 1 次激活码配额**，并在生产库留下 1 行 license（绑定一个**虚构** `dev`，
> 永远不会续期，15 天后自然过期）。报告末尾会把 `lic` / `dev` / 「这次到底消耗没消耗」**如实打印**；
> 要清理就去 `https://webvr123.site/admin` 吊销那一行。
> ⚠️ 夹具只写 `xlang/out/online/`（已 gitignore），**绝不碰真实 userData**；TLS **严格校验**（不写 `rejectUnauthorized:false`）。

---

### 7.6 生产私钥 · 真 EXE 验收（2026-09-20 新增；**备份那关的收口**）

```bash
cd tools/cast-server && node xlang/exe-prodkey-e2e.js --key <私钥.pem>
```

**要解决的问题**：§3.6 的备份演练（`deploy/backup-drill.js`）验的是**我们自己写的验签代码**。
客户机器上真正跑的验签代码是 EXE 里的 `verifyLicenseLocal()`。私钥备份是不是「能用的备份」，
最终得由**真 EXE** 说了算 —— 否则可能出现「演练全绿、装到客户机上全拒」这种最坏情形。

**与 §7.4 的区别**（两者容易混）：

| | §7.4 `exe-license-e2e.js` | §7.6 `exe-prodkey-e2e.js` |
|---|---|---|
| 用的私钥 | `secrets/` 里的**测试**密钥 | **生产私钥**（备份件） |
| 需要改源码吗 | **必须**临时改 `main.js` 内置公钥（跑完还原） | **一个字都不许改**（本来就该对得上） |
| 证明什么 | 门禁三条分支各走哪一条 | 这份私钥签的凭据能被真 EXE 接受 |
| 联网 | 否 | 否（`--license-url` 指向 discard 端口） |

**固化的断言（2 场景 34 项）**：

1. 私钥可解析；派生公钥为 P-256 SPKI（91 字节 / base64 124 字符）；
2. ★ 派生公钥 **== `main.js` 与 `MainActivity.java` 两处内置常量**（先断言两端逐字一致）+ 复核器自检（改 1 字符必败）；
3. ★ **真 EXE 打出「授权：有效」+ `/api/license/current` 回 `ok:true`**，且 `lic` / `剩余 14 天` 与喂进去的一致；
4. 用该私钥派生公钥**离线复核** EXE 出示的 license；`payload.ke` == 本机 Ke；proof 用本机 Ke 公钥验通过、用**别台** Ke 公钥必败；nonce 原样回显；
5. **负例**：license 的 `ke` 指向别台机器 ⇒ 横幅明说 `ke 不匹配`、API `ok:false`、响应体无 `license` 字段；
6. ★ 全程 **`main.js` md5 未变**（验收这份私钥不需要动源码）。

**2026-09-20 实测结果：34 项断言全通过**，目标 `E:\webvr123-backup\license-sign.pem`，
`lic=L-BACKUP-EXE-01`，结论 `[OK] 这份备份可以信`。

四条实测结论：

1. **「授权有效」分支的 `state` 是精简版**（`{lic,cust,exp,daysLeft}`，`main.js` L932）——
   故意不回 `licensePath`，免得把装机目录透露给头显。夹具若照抄「未激活」分支的
   `licensePath` 断言，会**自己造出一个假红灯**（本轮就踩了）。反过来的正确判据：
   用「真实 userData 里不该出现本次自测编号」来证明隔离。
2. **`exp` 要留半天余量**（取 `now + 14.5 天` ⇒ `daysLeft` 稳定为 14）：两端都用
   `Math.floor` 折算天数，正好整 14 天会因毫秒流逝折成 13，断言变成「时快时慢地失败」。
   同时 14.5 天 > 3 天续期窗口 ⇒ 走「有效且不联网」分支，夹具不会去打生产服务器。
3. **取属性前必须兜底**：验签失败时 `verifyLicense` 不返回 `payload`，直接取 `payload.nbf`
   会抛异常并让整个场景静默跳过（§7.4 也踩过同一坑）。
4. **夹具公共底座 `xlang/exe-harness.js`**：启动真 EXE / 探接口 / 场景隔离 + 四个环境坑
   集中在那里；§7.4 已改为复用它（改完复跑 36 项全绿、`main.js` md5 逐字节还原）。

> ⚠️ 它签的是**自测编号**的 license（生产库没有这一行），全程不联网 ⇒ 只证明「私钥 ↔ 真 EXE
> 的密码学链路」，**不替代**真实装机激活（激活码 + 生产服务器，见 §7.5 与 `cast-server/README.md` §3）。
> 目标 EXE 默认为开发版 `electron.exe`；要验**打包产物**用 `--exe <路径>`，见 §7.7。

---

### 7.7 打包产物验收（2026-09-20 新增；**装机前的最后一关**）

```bash
cd tools/cast-server
node xlang/exe-prodkey-e2e.js --key <私钥.pem> \
     --exe "E:/AI_Work/WebXR_Begain/tools/cast-pc/dist/win-unpacked/WebXR直播接收端.exe"
```

**为什么必须单独验一次**：`dist/` 里的包与当前源码**可能差几百行**，而且**看不出来**。
2026-09-20 实测：`cast-pc/dist/` 里那份安装包内的 `main.js` 只有 **37100 字节 / 798 行**、
`license` 字样出现 **0 次**（`webvr123` 也是 0 次）—— 是 LaunchGuard 时代的产物，
**完全不含授权代码**。拿它去验授权会得到一堆莫名其妙红灯，让人误以为密钥或代码坏了。

**正确顺序**：

1. `cd tools/cast-pc && npm run dist`（本次实测 **1 分 9 秒**；缓存齐时可离线打）
2. **静态比对**：包内 `main.js` 的 md5 **== 当前源码**的 md5 —— 一致才说明「打包源就是当前源码」
3. `--exe` 实跑 §7.6 那套（夹具第 0 步会自动做第 2 步，并且先确认包内**有** `LICENSE_PUBKEY_B64`）

**2026-09-20 实测结果**：重打后包内 `main.js` = **57573 B / 1172 行 / md5 `6d3fbe4e…`**，
与源码**逐字节一致**；`--exe` 实跑 **34 项断言全通过** —— 打包版真 EXE 打出
「授权：有效 `lic=L-BACKUP-EXE-01` 剩余 14 天」，`ke` 不匹配的负例也照样被拒。

#### ★ 读 asar 的两个坑（本轮踩实，已修进 `xlang/exe-harness.js`）

1. **数据区起点必须 4 字节对齐**。header JSON 从 offset 16 开始、长 `hlen`，其后有 1~3 字节 padding。
   实测该包 `hlen` = **17587** ⇒ `16+hlen` = 17603（`%4 == 3`）。若直接拿它当起点，读
   `renderer/index.html` 会得到 `\n<!DOCTYPE html>`（**整体偏 1 字节**）⇒ 文本首尾各错一字节、
   **md5 永远对不上**，还会让「包内公钥 / 关键字比对」在边界处误判。正解：`(16 + hlen + 3) & ~3`。
   ⚠ 这个坑**极隐蔽**：`hlen` 恰好 4 字节对齐时完全看不出来 —— 早先那个旧包就是（所以它一直没暴露），
   直到这次新包 `hlen % 4 == 3` 才现形。
   **它的症状值得记住**：包内 md5 与源码不符、**长度却完全相同**。
   「等长不等哈希」= 有字节被替换（或被整体错位）的强烈信号，不要当成"打包时重新格式化了"糊过去。
2. **header 里的 `offset` 是字符串**（实测 `offset='1597895'`）。守卫若写成
   `typeof ent.offset !== 'number'`，打包产物会**永远读不出来** → 被误判成
   「旧包 / 不含授权代码，请重新打包」。正解：`Number()` 归一后判 `Number.isFinite`。

**误判代价**：这两条都会把「包是好的」报成「包坏了」，而且方向完全指反 —— 第一条让人去怀疑
密钥或验签代码，第二条让人白等一轮重打包。

#### ★ 打包版会「吃掉」第一个自定义参数（隔离能成立的前提）

`app.isPackaged` 为真时 `process.argv` 比开发模式**少一个「app 目录」项**，而 `main.js` 用的是
`process.argv.slice(2)`（L35）⇒ 传进去的**第一个**自定义参数会被吞掉。
所以夹具把 `--user-data-dir=<临时目录>` 放在**第一位**当"牺牲品"，`--port` / `--license-url` 排在后
（仍然生效）。**`--user-data-dir` 换目录依然有效**，因为 Chromium 自己扫的是**完整** `process.argv`
（C++ 层，不受 JS 里 `slice(2)` 影响）—— 这正是「验打包产物时不会污染真实 userData」能成立的原因。

推论：**别指望用命令行参数去区分/隔离打包版的自定义行为**，要判断打包版跑成什么样，看启动横幅 +
`/api/*` 的输出。

---

## 8. 行为矩阵（P3 后的**实际**行为）

兜底天数 = **0**（§4.5 拍板），所以下表的「到期」一律 = **立即停放行**，**没有宽限期**。

| 场景 | EXE | 头显（P3 后） | 影响玩家 |
|---|---|---|---|
| 授权有效 | 正常 | 正常放行 + license/proof 校验通过 | 无感 |
| 到期前 3 天 | 后台静默续期 | 正常 | 无感 |
| 服务器临时 500 | 不阻塞启动，只记日志 | 用**本地缓存**的 license（时间窗本地判） | 无 |
| 真的过期（联网也没续上） | `licenseGate()` 拒全部请求；界面提示「授权已到期」 | 直播端根本放行不了 → 标题「**直播端授权异常**」，正文带 EXE 的原话 | **停玩** |
| EXE 未激活 | 同上，`why` =「直播端未激活：请在接收端界面填入激活码」 | 同上 | **停玩** |
| **头显这边是旧版接收端 EXE**（无 `/api/license/current`） | —— | **404 → `KIND_ABSENT`** → 「直播端版本过旧 → 必须更新 EXE」 | 停玩，但一次就能定位 |
| 授权服务器暂时不可达 | 用本地缓存继续；续期失败只记日志 | 正常（时间窗本地判，无需联网） | 无 |
| license 被吊销 | 下次拉名单后停放行 | 拒绝 | 停玩 |
| **把 `license.json` + `license-key.pem` 拷到另一台机器** | `verifyLicenseLocal` 的 **ke 绑定**直接判「属于另一台机器」 | 第 ⑤ 步 proof 验不过 | **防住** |
| **拷 license 到假冒 EXE**（它自己有另一把 Ke） | —— | 第 ⑤ 步 proof 验不过（license 声明的 `ke` 与签 proof 的私钥不配对） | **防住** |
| 换机器 / `dev` 变化（如插拔网卡） | 本地**不判** `dev`（刻意，见 §6 加固说明）；续期时由服务器比对建档值 → 续不上 | 到期后拒绝 | 停玩（界面提示需重新激活） |
| 有人冒充头显去要配置（头显 → EXE 方向） | HMAC 是**共享**固定串，知道的人能过 | ℹ️ **本轮未加强**：`Ka` / `Ka_pub` 在下一轮（§4.4） | —— |
| 门店网络访问不了 `webvr123.site:443` | 激活/续期失败（**但已激活的机器到 `exp` 前照常跑**） | 正常 | 到期前无感，之后停玩 |

---

## 9. 与第十七修的衔接（迁移路径）— 已按「兜底 0 天」定案

第十七修把密钥做成了「两端固定常量」。**它不再是放行路径**，只充当 **proof 迁移完成之前的过渡期临时鉴权**。

⚠️ 这里要纠正本文档早期版本的一个自相矛盾：早期曾建议「保留兜底路径，只是标注离线模式」，
同时又建议「给兜底加最长兜底天数」—— 需求方 2026-09-20 已拍板 **0 天（到期即停）**，
所以现在只有一种判定：

```
1. license 有效（本地 Ks_pub 验签 + 时间窗通过）
   → EXE：放行；头显：还要能验过 license 与 proof
2. 其余一切情况 → 拒绝
```

- 第十七修的 `GUARD_SECRET_FIXED` / `GUARD_SECRET_DEFAULT` **保留但降级**：
  两端注释都已写明「待头显 `Ka`/`Ka_pub` 落地后应视为死代码，**绝不可重新启用为放行路径**」。
- **代价必须正视**：授权服务器成为**硬单点**（§4.5）——
  服务器故障超过 `exp` 后全国门店立即停玩。因此必须补：① 服务器监控告警（缺）；
  ② EXE 界面常显剩余天数 + 一键续期（P2 已做）；③ 私钥离线备份（**工具已备好，待执行一次** —— §11 第 6 项）。
- 「过渡期」何时结束：头显侧 `Ka`/`Ka_pub` 落地（即 §4.4 的 ①~④）之后。

---

## 10. 分阶段实施（含进度）

| 阶段 | 内容 | 状态（截至 2026-09-20） |
|---|---|---|
| P1 | 服务器：gen-keys + 5 路由 + SQLite + Caddy + systemd | ✅ **已上线**：`:443` 有 Let's Encrypt 证书（到 2026-12-19）、`/api/health` 200、`/api/pubkey` 200；服务器自测 **40/40** |
| P2 | EXE：License 模块 + `/api/license/current` + 门禁总闸 `licenseGate()` + 界面授权面板 + 一键续期 | ✅ **已完成**（`main.js` 798 → 1155 行）；额外加固：`verifyLicenseLocal` 增加 **ke 绑定本机** |
| P3 | APK：`LicenseVerify` + proof + 接入 `guardWaitLoop` + **四套夹具**（§7.3~§7.6） | ✅ **已完成**（`MainActivity` 2852 → 3022 行；离线互认夹具 25/25 样本 + 7/7 探针；EXE 侧实跑夹具 3/3 场景、32 项断言，见 §7.4；**线上往返 44 项断言全通过**，见 §7.5；生产私钥·真 EXE 验收 34 项，见 §7.6） |
| P4 | 管理后台 + 吊销名单落地 | 部分：后台激活码/吊销入口已有；**头显侧的吊销名单未实现**（服务器的 `/api/license/revoked` 端点已在 §7.5 顺带验通） |
| P5 | 到期文案 / 现场手册 | 未做（已知一处待改：最后 24 小时界面显示「剩余 0 天」，应改用已有的 `hoursLeft`，见 §7.5 结论 3） |
| P6 | 头显侧 `Ka` / `Ka_pub`（补完 §4.4 的 A，替掉头显 → EXE 方向的 HMAC） | 未做（下一轮） |

> ⚠️ 「兜底开关」与「离线宽限」两项原本列在 P4/P5，**已被「兜底 0 天」拍板直接取消**（不再需要开关，也没有宽限期）。

✅ **线上往返已实测（2026-09-20，§7.5）**：用真实激活码打通了
「生产服务器 → 签发 license → 用**两端源码里的公钥**验签通过 → 续期 → 吊销名单」，
并用 6 条反例确认了拒绝路径。生产库现有 **1 行** license：`L20260920-0001`（`cust=测试`，
绑定一个**虚构** `dev`，可随时在 admin 吊销）。

✅ **私钥备份验收已收口（2026-09-20，§7.6）**：用户把生产私钥拷到本机后，
① `deploy/backup-drill.js` 判全绿（指纹 `4156b73a8b5d` == 线上 `/api/pubkey`）；
② `xlang/exe-prodkey-e2e.js` 用**真 EXE** 复核 34/34 通过 —— 结论「这份备份可以信」。
**仍未做完的**：把第二份副本存到**另一个物理位置**（单份不算备份）。

**仍未走过的**：真实 EXE（真机 `Ke`）与真实 PICO 这一趟 —— 即「现场装机演练」。
⚠️ 另注：`tools/cast-pc/dist/` 里现有的安装包内含的是 **798 行的旧 `main.js`**（不含任何授权代码），
装机前必须 `cd tools/cast-pc && npm run dist` 重新打包，并建议再用 `--exe` 把打包产物验一遍。

---

## 11. 进实现前必须确认的验证项

1. **签名算法可用性**：选 P-256（`minSdk 24` 下 Ed25519 不可用）。落地时在 PICO 上跑一次自检，确认 `Signature.getInstance("SHA256withECDSA")` 可用。
2. **两端签名互认**：先用一段脱机脚本（Node 签 → `keytool`/JVM 验，或反过来）验证 DER 对齐，再动业务代码。
3. **机器指纹稳定性**：`dev` 要经得起"换网线/重启"不变，换主板后变化。采集后重启 3 次比对。
4. **`webvr123.site` 可达性**：EXE 所在网络能否访问 443（部分门店网络有白名单限制）。
5. **时间同步**：license 的 `nbf/exp` 判定依赖时间。服务器与 EXE 均需 NTP，并允许 ±5 分钟偏差。
6. **私钥备份演练**：真的把 `license-sign.pem` 拷出来一次，**并当场用备份签名 + 用两端内置公钥验回来**。
   已工具化（2026-09-20）：
   - `bash tools/cast-server/deploy/backup-license-key.sh <离线目录>` —— `scp` 拷贝 → 权限 600 → 自动跑演练；
   - `node tools/cast-server/deploy/backup-drill.js <私钥.pem>` —— 演练本体，可单独对任意 PEM 跑。
   演练判据（三条全过才算备份）：① 该私钥派生出的公钥 **== 两端源码里硬编码的公钥**（并断言两端一致）；
   ② 用它签的样本 license 能被该公钥**验通过**；③ **负例**：改动 1 个字符必须验不过（证明验签没空转）。
   实测三态：本地测试密钥 → 判废（公钥不匹配）· 配套公钥 → 全绿 · 截断文件 → 解析失败并提示**别删原件**。
   2026-09-20 对**真实生产私钥**跑通（指纹 `4156b73a8b5d`，与 `GET /api/pubkey` 一致），并再用**真 EXE**
   收口一次：`node tools/cast-server/xlang/exe-prodkey-e2e.js --key <私钥.pem>`（详见 §7.6，34 项断言全过）。
   ⚠ 服务器 sshd **只开了密码认证**（`Permission denied (password).`，列表里没有 `publickey`），
   所以这类一次性运维动作就是手输一次 root 密码，不必投入做免密。

---

## 12. 风险与已知限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 服务器单点 | 挂了所有门店续期失败（**兜底 0 天 ⇒ 它现在是硬单点**） | 界面常显剩余天数 + 一键续期 + 服务器监控告警 + 私钥离线备份（§11 第 6 项）；已激活的机器到 `exp` 前照常跑 |
| 私钥丢失 | 所有已发 license 无法续期 | 离线备份 + 后台记录 |
| **游戏数据仍在客户机** | `src/content/` 等 6 个文件经 EXE 实时托管（留痕实测 6 文件 / 31971 B），拷贝或反编译即得 | **本轮按需求方决定暂缓**；后续可做「数据由服务器下发」 |
| 头显 ↔ PC 局域网明文 | license 与 proof 在店里局域网传输 | proof 绑 nonce、一次性，拷贝无用；需更强可上 TLS |
| asar 可解包 | EXE 代码可读 | **设计上不依赖代码保密** —— 只要 Ks 与 Ke 私钥不在包里，读到全部代码也伪造不出 license |

---

## 附：与既有文档的关系

- 第十七修的固定密钥与门禁现状 → `VR+平台版本号实现.md` §28
- 双端打包与直播链路 → `cast-implementation-and-packaging.md`
- 复现入口（含 skill 模板） → skill `webxr-cast-dual-package`

---

## 附 · 2026-09-23 晚：`masterAllow()` 新增「本局放行（ROUND）」判据

引入 `ROUND` 之后，`/api/master/allow` 的判定从两段变三段：

| 段 | 判据 | 说明 |
|---|---|---|
| ① | `licenseGate()` | 内容授权门禁（License），原逻辑不变 |
| ② | 凭据三选一 | 签名 `dev+ts+sig` / 放行条 `dev+exp+voucher` / **仅 `device`**；最后一种专供游戏页面每 2~5s 轮询 |
| ③ | `ROUND.armed` | **仅当 `requireRound:true`**（`/api/master/allow` 默认）；`/api/launch/request` 传 `false` |

- 未过 ③ 时返回 `allow:false` + `reason:"尚未开始本局（请在 PC 主控端点「开始本局」）"`，并附 `round: { armed:false, … }`。
- **与 License 的关系**：`ROUND` 是 License 之外的第二道「这一局允不允许」，**不替代** `licenseGate()`；
  平台若要求「按局计费/按场授权」，落点就是这一段（响应里已预留 `license` 字段）。
- 收回放行的入口有两个：PC 界面 `round:set(false, …)`、画面侧 `POST /api/round/end`。二者都走 `roundSet()` 单一入口。
