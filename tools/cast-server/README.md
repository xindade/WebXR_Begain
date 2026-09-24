# 授权服务器（webvr123.site）

EXE 直播端的商业化授权：签发 license、按 15 天续期、可远程吊销。
方案全文见 `docs/tech/08-授权服务器与License方案.md`。

**当前实现状态**

| 段 | 状态 |
|---|---|
| 服务器（本目录） | ✅ 已完成，33 项自测全通过 |
| EXE 接入（`tools/cast-pc`） | ⬜ 待做（P2） |
| 头显接入（`tools/cast-apk`） | ⬜ 待做（P3） |

在 P2/P3 完成之前，两端仍走第十七修的「固定密钥 + 配对窗口」，**不影响现有现场使用**。

---

## 1. 三层结构

```
① webvr123.site（本目录）  用 Ks 私钥签发 license
        ↓ license（含 EXE 实例公钥 ke + 到期时间 exp）
② EXE 直播端（PC）         本地存 license；向头显出示 license + 用 Ke 私钥签的 proof
        ↓ license + proof（局域网，明文可传）
③ 头显 APK                内置 Ks_pub 验 license 签名；用 license 里的 ke 验 proof
```

**为什么这样设计**：license 原文要出示给头显看，在局域网里明文传输。若只是一份静态凭据，
**任何拿到原文的人都能原样转发**。所以凭据里绑了一把**只属于那台 EXE 的密钥**（`ke`），
出示时要求 EXE 用对应私钥签一个**头显当场给的随机数**。

→ 结果：license 可以随便复制，但没有那把私钥就签不出新鲜证明。**整个方案不依赖代码保密**
（打包后的 EXE 可以被完整反编译，只要拿不到两把私钥就伪造不出任何东西）。

---

## 2. 一次性初始化（顺序不能错）

> **走 §3.2 的一键脚本时，这一步不用手动做** —— 脚本会在服务器上自动生成密钥与管理员凭证。
> 本地执行只用于离线测试（跑 `selftest.js`、`xlang/`）。
> ⚠️ 若本地生成了却没上传，服务器会另外生成一套 —— 两套的**公钥不是同一对**，
> 硬编码进两端时必须用服务器那一套（脚本会打印指纹与内容）。

```bash
cd tools/cast-server
node gen-keys.js
```

会生成三个文件（`secrets/`，已进 `.gitignore`）：

| 文件 | 用途 |
|---|---|
| `license-sign.pem` | 🔴 **签发私钥 Ks**。只在服务器上，权限 600 |
| `license-pub.pem` | 🟢 公钥 PEM |
| `public-key.txt` | 🟢 一行 base64 —— **就是要硬编码进 EXE 与 APK 的那串** |

### ⚠️ 立刻做两件事

1. **离线备份 `secrets/license-sign.pem`**（U 盘 / 另一台机器）。
   丢了 = **所有已发 license 都没法续期**，只能重新生成密钥对并**发新版 EXE 和 APK**。
   在门店已铺开的情况下，这是最贵的一次事故。
   → 一条命令搞定（连**备份演练**一起做，见 §3.6）。在**本机**执行（不是在服务器上）：

   PowerShell / cmd（启动器会自动去找 Git Bash 的 bash）：
   ```powershell
   cd E:\AI_Work\WebXR_Begain
   .\tools\cast-server\deploy\backup-license-key.cmd E:\webvr123-backup
   ```

   Git Bash：
   ```bash
   cd /e/AI_Work/WebXR_Begain
   bash tools/cast-server/deploy/backup-license-key.sh /e/webvr123-backup
   ```
2. 把 `public-key.txt` 的内容抄进 `tools/cast-pc/main.js` 与
   `tools/cast-apk/.../MainActivity.java` 的 `LICENSE_PUBKEY_B64`（P2/P3 时做）。

> 私钥**绝不能**进 git、**绝不能**打进 EXE。反过来，公钥是公开的，反编译出来毫无价值。

---

## 3. 部署

### 3.1 上传代码（在你自己的电脑上）

只传代码，**不传 `data/`**（那是本地自测数据）。

```powershell
# Windows PowerShell
cd E:\AI_Work\WebXR_Begain\tools\cast-server
tar -czf "$env:TEMP\cast-server.tgz" --exclude=data --exclude=node_modules --exclude=.git --exclude=secrets .
scp "$env:TEMP\cast-server.tgz" root@<服务器IP>:/tmp/
```

> **`--exclude=secrets` 是推荐做法**：让服务器自己生成签发密钥，私钥从诞生起就只在
> `/opt/webvr123/secrets/`，不经过你的电脑、不经过网络传输。
> 若想沿用本地那一对（已备份、已过跨语言验证），**去掉这个参数** ——
> 脚本检测到密钥已存在会保留、绝不覆盖。
>
> 两种做法只能选一种。**混用会让两端硬编码的公钥与服务器私钥对不上，
> 现象是"永远验签失败"，且因为 ECDSA 每次签名都不同，极难定位。**

### 3.2 一键安装（在服务器上）

```bash
sudo mkdir -p /opt/webvr123
sudo tar -xzf /tmp/cast-server.tgz -C /opt/webvr123
sudo bash /opt/webvr123/deploy/install.sh
```

脚本做 10 件事，**可反复执行**（幂等，升级代码后重跑同一句即可）：

| 步 | 动作 |
|---|---|
| 0 | 检查 root / 是否 Debian 系 / 代码是否完整 |
| 1 | 装 curl、gnupg、rsync |
| 2 | 检查 Node：≥22 直接用；18~21 能用但存储降级；<18 或没有 → 从 NodeSource 装 22 |
| 3 | 装 Caddy |
| 4 | 端口占用检查：发现 nginx 等占着 80/443 → 告警并提示用 `TAKEOVER=1` 接管；本机 `8787` 被别的进程占用时**只告警、不杀**（要杀得显式给 `KILL_PORT=1`） |
| 5 | 建系统用户 `webvr123`（无登录权限）+ 同步代码到 `/opt/webvr123` |
| 6 | 生成签发密钥 `Ks` 与管理员凭证（**已存在则保留，绝不覆盖**） |
| 7 | 装 systemd 服务，`ExecStart` 自动改写成实际 node 路径 |
| 8 | 写 Caddyfile（已有其它站点时**备份但不覆盖**，除非 `FORCE_CADDY=1`） |
| 9 | ufw 放行 80/443（8787 不对外） |
| 10 | 起服务 + 本机健康检查 + DNS 比对 + HTTPS 自测 |

跑完打印的总结块里有 **公钥指纹 + 公钥内容**，那两行就是要抄进 EXE / APK 的。

常用覆盖项：

```bash
DOMAIN=webvr123.site APP_DIR=/opt/webvr123 PORT=8787 sudo bash deploy/install.sh
FORCE_NODE=1  sudo bash deploy/install.sh   # 已有 Node 18~21 时强行升到 22
FORCE_CADDY=1 sudo bash deploy/install.sh   # 覆盖已有 Caddyfile（会先备份）
TAKEOVER=1    sudo bash deploy/install.sh   # 停用占着 80/443 的 nginx，交给 Caddy
PORT=8788     sudo bash deploy/install.sh   # 8787 被占时换个内部端口（零风险，首选）
KILL_PORT=1   sudo bash deploy/install.sh   # 确认可结束时，才结束占用 8787 的进程
```

### 3.2.1 若服务器上已经跑着别的网站（nginx / 宝塔）

很多 VPS 到手时 80 / 443 已经被 nginx 占着 —— 这时 **Caddy 起不来、证书也申请不到**。
脚本第 4 步会探测并告警，但**默认不动它**（避免误伤别人的站点）。

确认可以停掉它之后，加 `TAKEOVER=1` 重跑：

```bash
TAKEOVER=1 sudo bash /opt/webvr123/deploy/install.sh
```

`TAKEOVER=1` 只做三件事，**全部可逆**：

| 动作 | 影响 |
|---|---|
| `systemctl stop` + `disable nginx` | 只停服务，`/etc/nginx` 与网站文件**原样保留**；恢复：`systemctl enable --now nginx` |
| 停用 certbot 续期定时器 | 证书改由 Caddy 申请与续期，避免两边抢 80 端口 |
| ~~结束占用 `$PORT` 的进程~~ | **已移出 `TAKEOVER`** —— 那属于「破坏性动作」，改由 `KILL_PORT=1` 单独授权；默认只告警并建议 `PORT=8788` |

脚本会顺手打印**原网站目录**（从 nginx 配置里解析），方便你回头找它。
原站点若哪天要恢复，把 nginx 装回来即可 —— 我们从未删过它的文件。

### 3.3 依赖

**零 npm 依赖** —— 不用 `npm install`。只需要：

| 组件 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 推荐 **22+**（有内置 `node:sqlite`）；18/20 会自动降级为 JSON 文件存储，功能一样 |
| Caddy | 任意近期版本 | 自动 HTTPS |

### 3.4 手动部署（脚本不合用时照做）

```bash
# 目录与用户
sudo useradd -r -s /usr/sbin/nologin webvr123
sudo mkdir -p /opt/webvr123/data
sudo chown -R webvr123:webvr123 /opt/webvr123
sudo chmod 700 /opt/webvr123/secrets
sudo chmod 600 /opt/webvr123/secrets/license-sign.pem

# systemd（ExecStart 里的 node 路径按 `command -v node` 的实际值改）
sudo cp deploy/webvr123.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now webvr123
systemctl status webvr123          # 应为 active (running)
sudo journalctl -u webvr123 -n 40  # 看启动日志

# HTTPS（webvr123.site 的 A 记录须已指向本机，80/443 放行）
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

> ⚠️ 手动部署**必须先建好 `data/` 并先生成 `secrets/admin.json`**：
> systemd 单元用了 `ProtectSystem=strict`，服务对 `/opt/webvr123` **只读**，只放开 `data/`。
> 缺 `data/` 目录 systemd 直接拒绝启动；缺 `admin.json` 则服务首次启动时写盘失败。
> 想省掉这一串，直接用 §3.2 的脚本。

### 3.5 自测

```bash
curl https://webvr123.site/api/health
# {"ok":true,"server":...,"store":"sqlite","licenses":0,...,"ttlDays":15,...}
```

管理员凭证在 **服务器上** `/opt/webvr123/secrets/admin.json`（安装脚本的总结里也打印过一次）：

```bash
ssh root@103.117.138.250 'cat /opt/webvr123/secrets/admin.json'
# {"user":"admin","pass":"一串随机密码"}     ← /admin 弹窗就填这个
```

改密码（三步，顺序别换）—— 它曾在聊天里明文出现过，建议换掉：

```bash
# ① 生成新密码并写回
ssh root@103.117.138.250 'node -e "const fs=require(\"fs\"),f=\"/opt/webvr123/secrets/admin.json\",j=JSON.parse(fs.readFileSync(f));j.pass=require(\"crypto\").randomBytes(18).toString(\"base64url\");fs.writeFileSync(f,JSON.stringify(j));console.log(j.user,j.pass)"'
# ② 权限收紧（写入一般会保留原权限，习惯性确认一次）
ssh root@103.117.138.250 'chmod 600 /opt/webvr123/secrets/admin.json && chown webvr123: /opt/webvr123/secrets/admin.json'
# ③ 重启 —— 凭证是【服务启动时读一次】进内存的，不重启等于没改
ssh root@103.117.138.250 'systemctl restart webvr123'
```

> ⚠️ 这台服务器的 sshd **只开密码认证**（方法列表里没有 `publickey`），所以每条命令都会问一次
> root 密码 —— 这是正常的。**别为一次性运维去折腾免密**。

### 3.6 私钥离线备份（含演练）

**为什么单独写一节**：私钥 `secrets/license-sign.pem` 是整套授权体系的根。它丢了之后
「重新生成一把」的代价不是改一行代码，而是**给所有已铺开的设备重发新版 EXE + APK**
（两端内置的公钥都要换）。而备份有个要命的特点 —— **肉眼分辨不出对错**：
拷坏了、拷成了换钥前的旧文件、拷成了本地开发用的测试密钥，**看起来完全一样**。

所以 `deploy/backup-license-key.sh` 把「拷贝」和「演练」绑成一步：

| 步 | 做什么 |
|---|---|
| 1/4 | `scp` 从服务器拉 `license-sign.pem`（问一次 root 密码；带 `ConnectTimeout=15`，网络不通 15 秒内失败而不是无限等） |
| 2/4 | 权限收紧 `600` + 文件大小量级检查（正常 ~241 字节） |
| 3/4 | **演练**：用它签一份样本 license，再用**两端源码里硬编码的公钥**验一遍 |
| 4/4 | 收尾清单（第二份副本、是否删本机临时副本、顺手取后台凭证） |

演练的三条判据（`deploy/backup-drill.js`，也可单独对任意 PEM 跑）：

1. 该私钥派生的公钥 **== `LICENSE_PUBKEY_B64`**（先断言 `main.js` 与 `MainActivity.java` 两处**逐字一致**）；
2. 用它签的样本 license 能被这串公钥**验通过**；
3. **负例**：样本改动 1 个字符必须**验不过**（证明验签没空转）。

> **第二关（可选但推荐）：拿真 EXE 再验一次**
> 上面三条验的是「我们自己写的验签代码」。客户机器上真正跑的验签代码是 EXE 里的
> `verifyLicenseLocal()`，所以还想再确认一层时，对着**刚备份下来的这把私钥**跑：
>
> ```bash
> cd tools/cast-server
> node xlang/exe-prodkey-e2e.js --key <私钥.pem>      # 例：--key=E:/webvr123-backup/license-sign.pem
> ```
>
> 它用这把私钥签一份 `ke` 绑到「本机 Ke」的 license，喂给**真启动的 Electron**，看它打出
> 「授权：有效」+ `/api/license/current` 回 `ok:true`（34 项断言，另含 `ke` 不匹配必拒的负例）。
> 全程**不联网**、**不改任何源码**（结尾会断言 `main.js` 的 md5 一字未变）、不碰你真实安装的
> userData 目录。看到 `结论：[OK] 这份备份可以信` 才算这一步过了。
>
> ⚠️ 它签的是**自测编号**的 license（服务器数据库里没有它），只证明「私钥 ↔ 真 EXE 的密码学
> 链路通了」，**不替代**真实装机激活。
>
> **要对「打包产物」再验一层（装机前最后一关）**：给命令加 `--exe` 指向刚打的包：
>
> ```bash
> node xlang/exe-prodkey-e2e.js --key E:/webvr123-backup/license-sign.pem \
>      --exe "E:/AI_Work/WebXR_Begain/tools/cast-pc/dist/win-unpacked/WebXR直播接收端.exe"
> ```
>
> ⚠️ `cast-pc/dist/` 里那份**必须先重打**（`cd tools/cast-pc && npm run dist`，约 70 秒）——
> 实测它是 **798 行、`license` 字样 0 次**的旧包（当前源码 1172 行），拿它验授权只会得到一堆假红灯。
> 夹具会先静态解包核对「包内有 `LICENSE_PUBKEY_B64`」+「包内 `main.js` md5 == 当前源码」再实跑。
> 2026-09-20 实测：重打后包内 `main.js` 与源码**逐字节一致**，34 项断言全通过。详见 `docs/tech/08` §7.7。

**三种入口任选其一**，都在**本机**执行（不是在服务器上）：

```powershell
# A) PowerShell / cmd —— 用同目录的 Windows 启动器（自动找 Git Bash 的 bash）
cd E:\AI_Work\WebXR_Begain
.\tools\cast-server\deploy\backup-license-key.cmd E:\webvr123-backup
```

```bash
# B) Git Bash（开始菜单搜 "Git Bash"；插上 U 盘时目标常是 /e 或 /f）
cd /e/AI_Work/WebXR_Begain
bash tools/cast-server/deploy/backup-license-key.sh /e/webvr123-backup
```

```powershell
# C) 纯 PowerShell，完全不经过 bash（等价于脚本里的 1/4 + 3/4 两步）
cd E:\AI_Work\WebXR_Begain
New-Item -ItemType Directory -Force E:\webvr123-backup | Out-Null
scp -o ConnectTimeout=15 -p root@103.117.138.250:/opt/webvr123/secrets/license-sign.pem E:\webvr123-backup\
node tools\cast-server\deploy\backup-drill.js E:\webvr123-backup\license-sign.pem
```

**判据只看一处**：最后出现 `[OK] 备份可用` 才算备份；出现 `[FAIL]` 就**千万别删服务器上的原件**，
重新拷一份。`[OK]` / `[FAIL]` 是纯 ASCII，**任何终端都不会乱码** —— 中文提示若因为终端编码
显示成乱码，**不影响判定**（老版 Windows PowerShell 的已知毛病；在 Git Bash 里跑就没这问题）。

**脚本自带的三道护栏**（任一触发即 `exit 2`，且不产生任何文件）：

- 目标目录在**本 git 仓库内** → 拒绝（私钥永不进版本库）；
- 目标是**云同步目录**（OneDrive / Dropbox / 坚果云 / Google Drive / 百度网盘） → 拒绝（等于私钥上了云）;
- 缺目标参数 → 打印用法。

**它自己会处理三个环境坑**（都是实测踩出来的）：

| 坑 | 现象 | 脚本的应对 |
|---|---|---|
| 从 PowerShell / cmd 直接拉起 `bash` | 此时 bash **不是 login shell**，PATH 里没有 `/usr/bin` ⇒ `dirname`/`tr`/`wc`/`chmod` 集体 `command not found`，脚本跑到一半崩 | 脚本开头把 `/usr/bin:/bin` 挂回 PATH |
| `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL=*` 存在（IDE / 沙箱 / CI 的 shell 包装器常带，且会**继承进子进程**） | 传给 `node.exe` 的 `/e/...` **不再被自动转换**，node 把它当成「E 盘根下的 `\e\...`」⇒ `MODULE_NOT_FOUND` | 交给 `node` / 原生 `scp.exe` 的本机路径一律先过 `cygpath -w`（**确定性**转换，不受这些变量影响） |
| 写成 Windows 风格路径 `E:\webvr123-backup` | bash 的 `dirname` 会把它拆成 `E:` ⇒ 报「目标目录的上级不存在」 | 自动归一化成 `/e/webvr123-backup` |

> 备份的判据是「**两个物理位置各一份**」—— 脚本第 4 步会提醒你补第二份。

---

## 4. 日常运营

打开 `https://webvr123.site/admin`，浏览器会弹 Basic Auth，填 §3.5 取到的账号密码。

| 操作 | 说明 |
|---|---|
| **生成激活码** | 填客户标识 → 得到形如 `ABCD-EFGH-JKLM` 的码。交给运营商，在直播端填入完成激活 |
| **License 列表** | 看每台的到期时间、剩余天数、续期次数；一眼看出谁快过期 |
| **吊销** | 某台不再合作时点一下。它下次启动会被拒绝（**不是即时生效**，最长等一个心跳周期） |
| **手工签发** | 不走激活码，直接给一套 `dev`/`ke` 签发（调试或特殊情况用） |

### 建议的运营节奏

- license 有效期 **15 天**，EXE 会在**到期前 3 天**开始每 6 小时自动续期 → 正常情况下你什么都不用做。
- 每周扫一眼后台的「剩余天数」，有 < 7 天的说明那台机器续期连线有问题，需要联系现场排查。

---

## 5. 接口速查

| 方法 | 路径 | 调用方 | 鉴权 |
|---|---|---|---|
| GET | `/api/health` | 监控 | 无 |
| GET | `/api/manifest` | PC EXE（每次启动 / 本局结束重拉） | **共享密钥**（`key=`，默认 `webxr-manifest`，第二十四修） |
| POST | `/api/license/activate` | EXE 首次 | 激活码 |
| POST | `/api/license/renew` | EXE 周期 | `Ke` 签名 proof |
| GET | `/api/license/revoked` | EXE 周期 | `Ke` 签名 proof |
| POST | `/api/license/issue` | 后台 | Basic Auth |
| POST | `/api/license/revoke` | 后台 | Basic Auth |
| GET | `/api/admin/licenses` | 后台 | Basic Auth |
| GET | `/api/admin/activations` | 后台 | Basic Auth |
| POST | `/api/admin/activation` | 后台 | Basic Auth |

proof 的签名对象（都是 ASCII 文本）：

```
续期：  "renew|<lic>|<ts>"        EXE 用 Ke 私钥签
吊销：  "revoked|<lic>|<ts>"      EXE 用 Ke 私钥签
出示：  "cast|<nonce>"            EXE 用 Ke 私钥签（P3 用，头显给 nonce）
```

`ts` 为毫秒时间戳，服务器容忍 ±5 分钟偏差 —— **两端都要开 NTP**。

### 错误码

| reason | 含义 | 现场处理 |
|---|---|---|
| `badCode` / `codeUsed` / `codeExpired` | 激活码无效/用尽/过期 | 后台重新生成一个 |
| `machineMismatch` | 机器指纹变了（换硬件） | 需重新激活 |
| `keyMismatch` | EXE 实例密钥被换过 | 需重新激活 |
| `badProof` | 持有证明验不过 | 不是被签的那台机；查是否拷贝了 license |
| `stale` | 时间偏差超 5 分钟 | 校时 |
| `revoked` | 已吊销 | 商业决定，恢复需在后台点「恢复」 |
| `rateLimit` | 尝试过于频繁 | 等 1 分钟 |

---

## 6. 调参

不用改代码，写 `config.json` 覆盖即可：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "ttlDays": 15,
  "renewWindowDays": 3,
  "maxBody": 65536,
  "activateRatePerMin": 10,
  "renewRatePerMin": 60
}
```

| 参数 | 含义 | 备注 |
|---|---|---|
| `ttlDays` | license 有效期（天） | 需求方口述的「管 15 天」 |
| `renewWindowDays` | 到期前几天开始允许续期 | 客户端也按此判断，服务器只做上限校验 |
| `activateRatePerMin` | 单 IP 每分钟激活尝试上限 | 防爆破激活码 |
| `renewRatePerMin` | 单 IP 每分钟续期上限 | **必须与激活分开计数**，否则正常续期会被激活限流误伤 |

---

## 7. 自测与跨语言验证

```bash
node selftest.js
```

起一个临时服务（独立数据目录，不碰生产数据）跑 33 项：激活 / 幂等 / 错误码 /
续期 + proof 验签 / 时间偏差 / 换机 / 吊销 / 鉴权 / 限流 / 存储降级。

### 跨语言验签（改签名相关代码后必跑）

`xlang/` 里放着一套 Node 签 → Java 验的对照工具。**两端算法一旦对不齐，
现象是「永远验不过」，而且因为 ECDSA 每次签名都不同，没法用固定样本比对，极难定位** —— 所以改完密码学代码先跑它：

```bash
# 1) Node 生成样本
cd tools/cast-server && node xlang/gen.js
# 2) Java 按头显的方式验
cd tools/cast-server/xlang && \
  "C:/Program Files/Java/jdk-17/bin/java.exe" -Dfile.encoding=UTF-8 VerifyLicense.java
```

期望输出：正常 license「验签通过」，篡改 payload / 篡改签名 / 换公钥三项都「验签不通过」。

### 六套自测/夹具一览（按「能测到什么」分层）

| # | 夹具 | 命令 | 测什么 | 代价 |
|---|---|---|---|---|
| 1 | 服务器自测 | `node selftest.js` | 33 项：激活 / 幂等 / 错误码 / 续期+proof / 时间偏差 / 换机 / 吊销 / 鉴权 / 限流 / 存储降级 | 无（独立临时数据目录，不碰生产） |
| 2 | 离线跨语言（旧） | `node xlang/gen.js` 后 `java VerifyLicense.java` | **凭据签名本身**：Node 签 → Java 验 + 3 条篡改样本 | 无 |
| 3 | 离线整链（P3） | `node xlang/p3test.js` | **整条授权链**：nonce 回显 / `Ks_pub` 验凭据 / 时间窗 / 用 `ke` 验 proof；25 条样本 + 7 条畸形入参；并断言跑的就是**要打包的那一份** `LicenseVerify.java`（比 md5） | 无 |
| 4 | EXE 门禁实跑 | `node xlang/exe-license-e2e.js` | **真启动 Electron**：无 license / `ke` 匹配放行 / `ke` 不匹配拒服务 —— 3 场景 32 项断言 | 会临时改写 `cast-pc/main.js` 的内置公钥（跑完在 `finally` 里逐字节还原并断言 md5） |
| 5 | **生产私钥·真 EXE 验收** | `node xlang/exe-prodkey-e2e.js --key <私钥.pem>` `[--exe <打包好的.exe>]` | **备份那关的收口**：这份私钥派生公钥 == 两端内置常量，且它签的 license 被**真 EXE** 认（`ke` 匹配放行 / 不匹配必拒）—— 2 场景 34 项断言。加 `--exe` 则先静态核对**包内** `main.js`（含授权代码 + md5 == 当前源码）再实跑 = **装机前最后一关**（⚠ 需先 `cd tools/cast-pc && npm run dist` 重打包） | 无（不联网、不改源码、不碰真实 userData；目标默认开发版 `electron.exe`） |
| 6 | 线上往返 | `node xlang/online-activate-e2e.js <激活码>` | **打生产服务器**：激活 → 用**两端源码里的公钥**验这张 license → 幂等 → 续期 → 吊销名单 + 6 条反例（44 项断言） | ⚠ **消耗 1 次激活码配额**、生产库留 1 行 license（复跑同 `dev` 免费）；只写 `xlang/out/online/` |

> 第 4、5 套共用一个底座 `xlang/exe-harness.js`（启动真 EXE / 探接口 / 场景隔离，
> 以及四个已踩过的环境坑）。新写 EXE 夹具请直接复用它，别把启动逻辑再抄一遍。

> ⚠️ 第 1~4 套都测不到最致命的那类 bug：**服务器实际签发用的私钥 ≠ 两端硬编码的公钥**
> （离线样本是自己用测试密钥签的，所以永远测不出）。它**当下不报错** —— `/api/health` 照常 200、
> 激活照常返回 license，要到**头显验签**才失败。能钉死它的只有两套：
> **第 5 套**（证明你手上那把私钥与两端内置公钥一致，离线可跑）与
> **第 6 套**（证明**服务器正在用的**那把与两端一致，发版前必跑）。
>
> 详细说明与实测结论见真实项目文档 `docs/tech/08-授权服务器与License方案.md` §7.3~§7.5。

---

## 8. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 起不来，日志 `找不到 secrets/license-sign.pem` | 没跑 `node gen-keys.js` | 跑它 |
| `EADDRINUSE` | 8787 被占 | 改 `config.json` 的 `port`，同步改 Caddyfile |
| Caddy 拿不到证书 | DNS 没指过来 / 80 端口没放行 | `dig webvr123.site` 确认 |
| 某台机器每次都要重新激活 | `dev` 机器指纹不稳定 | 见方案 §11.3，采集方式要经得起换网线/重启 |
| 大量 `stale` | 服务器或现场机器没校时 | 两边都开 NTP |
| 门店说「授权已到期」但后台显示有效 | 现场网络不通，续期没连上 | 检查现场出口防火墙是否放行 443 |

**日志**：`sudo journalctl -u webvr123 -f`，同时落盘 `data/server.log`。

---

## 9. 安全须知

- `secrets/` 与 `data/` 都在 `.gitignore` 里，**别手动加进版本库**。
- 私钥权限保持 `600`；`data/license.db` 含客户信息，也要限制读取。
- 服务器只监听 `127.0.0.1`，外部一律经 Caddy 的 HTTPS。
- **备份策略**：`data/` 每天拷一次；`secrets/license-sign.pem` 离线保存且**不进任何自动化备份链路**（避免私钥落到云盘）。

---

---

## 10. 内容清单接口（`GET /api/manifest`，第二十四修 · 2026-09-24）

> 定位：**配置集中管理**，不是防破解（密钥在客户端里，见本文档 §9 与 `docs/tech/09-服务器清单与旧配置清理.md` §10）。

### 10.1 发布一份内容

```bash
# 在项目根执行（会整目录重建，不是增量覆盖）
node tools/cast-server/sync-content.js --ver 1.0.0

# 产物
tools/cast-server/content/manifest.json        { versions, current, updatedAt }
tools/cast-server/content/1.0.0/ver.json       { ver, builtAt, count, bytes, listSha256 }
tools/cast-server/content/1.0.0/src/content/*  ← 6 个关卡/数值文件
tools/cast-server/content/1.0.0/src/core/userConfig.js
```

发布范围 `MANIFEST_ITEMS` 在 `sync-content.js` 里，**必须与 EXE 的 `CONFIG_MANIFEST` 逐字一致**
（`src/content/` 整目录 + `src/core/userConfig.js`）—— 改一处就要改两处。

### 10.2 ⚠ 部署（最容易漏的一步）

`content/` 在 `.gitignore` 里（**发布产物不入库**）。所以服务器上 `git pull` **不会**带来内容，
每次更新配置后必须：

**① 只更新内容（改了 `src/content/**` 或 `userConfig.js`）**：

```bash
node tools/cast-server/sync-content.js --ver 1.0.1     # 建议每次改内容就递增一个版本号
scp -r tools/cast-server/content root@webvr123.site:/opt/webvr123/
ssh root@webvr123.site "systemctl restart webvr123"
```

**② 更新服务器代码（改了 `server.js`）—— 用一键脚本，含备份 + 重启 + 验收**：

```powershell
# 开发机（Windows）：打成更新包
cd E:\AI_Work\WebXR_Begain_Platform
node tools/cast-server/sync-content.js --ver 1.0.0
tar -czf "$env:TEMP\wu.tgz" -C tools\cast-server server.js content deploy\apply-update.sh
scp "$env:TEMP\wu.tgz" root@webvr123.site:/tmp/
ssh root@webvr123.site "mkdir -p /tmp/wu && tar -xzf /tmp/wu.tgz -C /tmp/wu && cd /tmp/wu && sh apply-update.sh"
```

`apply-update.sh` 做四件事：备份旧 `server.js` / `content/`（带时间戳，可回滚）→ 装新 →
`chown webvr123` + 放开读权限（`ProtectSystem=strict` 下服务只读 `/opt/webvr123`）→ 重启并打印
`/api/health`、`/api/manifest` 两条验收；**不碰 `secrets/` 与 `data/`**。
回滚：`cp -p /opt/webvr123/server.js.bak-<时间戳> /opt/webvr123/server.js && systemctl restart webvr123`。

> 本次（2026-09-24）就是这么部署的，验收记录见 `docs/tech/09-服务器清单与旧配置清理.md` §11.1。

### 10.3 接口

| 方法 | 路径 | 调用方 | 鉴权 |
|---|---|---|---|
| GET | `/api/manifest?key=&ver=` | PC EXE（每次启动 / 本局结束重拉） | **共享密钥**（`cfg.manifestKey`，默认 `webxr-manifest`） |

- `ver` 缺省 = `manifest.json` 的 `current`；**指定了就必须命中，绝不回落 `current`**。
- 响应：`{ ok, ver, builtAt, count, bytes, server, files[] }`，
  每个 `file = { path, sha256, size, content }`（文本内联）。
- 请求体上限 `cfg.maxManifestBytes`（默认 2MB）、限速 `cfg.manifestRatePerMin`（默认 120/分）。

### 10.4 环境变量与错误码

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MANIFEST_KEY` | `webxr-manifest` | 覆盖 `cfg.manifestKey` |
| `CONTENT_DIR` | `<ROOT>/content` | 发布根目录（部署后即 `/opt/webvr123/content`，一般不用设） |

| HTTP | `why` | 含义 | 现场处置 |
|---|---|---|---|
| 403 | `badKey` | 密钥不对 | 两端 `manifestKey` / `--manifest-key` 不一致 |
| 404 | `noContentVersion` | 该 `ver` 未发布（响应带 `versions`） | 跑 `sync-content.js`，或把 EXE `--content-ver` 改成已发布版本 |

- ⚠ **systemd 单元的 `ProtectSystem=strict` 不影响本接口**：它只让 `/opt/webvr123` 对服务**只读**，而
  `/api/manifest` 只需要**读** `content/`（实测路径：`readContentIndex()` / `readContentTree()` 全是 `readFileSync`/`readdirSync`）。
  但**上传内容的那一步必须用 root/scp**（服务用户 `webvr123` 写不进 `/opt/webvr123`）。

`/api/health` 的 `content` 字段（`{ dir, current, versions, updatedAt }`）是**服务器侧第一眼**：
监控它就能发现「content 目录空了 / 版本没发上去」。

### 10.5 自测

```bash
node tools/cast-server/sync-content.js --ver 1.0.0
PORT=8795 HOST=127.0.0.1 DATA_DIR=/tmp/srv-test node tools/cast-server/server.js
curl "http://127.0.0.1:8795/api/health"                                   # → content.current = 1.0.0
curl "http://127.0.0.1:8795/api/manifest?key=webxr-manifest&ver=1.0.0"    # → ok:true count:7
curl "http://127.0.0.1:8795/api/manifest?key=wrong"                       # → 403 badKey
curl "http://127.0.0.1:8795/api/manifest?key=webxr-manifest&ver=9.9.9"    # → 404 noContentVersion
```
