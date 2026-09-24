#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""cap-round.py —— 现场「完整一局」一键采集（抓包 + 平台日志 + 一页报告）

为什么要有它：要回答「游戏结束后平台会不会弹结束、会不会顺手关游戏」，只有两份证据够用 ——
  ① 游戏通道（UDP 51124/51234）的**原始帧**：CMD 6 GameEnd / CMD 7 GameStatistics 到底发没发、
     发了什么字节（平台日志看不到帧内容）；
  ② 平台自己的 DebugLog：平台**收到**了什么、之后做了什么（有没有跟着发 closeGame / kill）。
本脚本一次跑完这两件事，并按「见到 CMD 6 / CMD 7 没有、平台之后关没关游戏」自动出结论。
★ 2026-09-24 首次跑通即结案：平台的「游戏结束」是 **CMD 7 GameStatistics**（CMD 6 从未出现）；
  证据与字节样本见 docs/tech/05-游戏打包方式（EXE与APK）.md 末节。

用法（在这台"跑游戏"的机器上跑，**需要管理员**）：
    python tools\cap-round.py                  # 交互：开始抓 → 你去跑一局 → 按回车结束 → 出报告
    python tools\cap-round.py -s 180           # 抓 180 秒自动停
    python tools\cap-round.py --analyze x.pcap # 只分析已有 pcap（不需管理员）
    python tools\cap-round.py --selftest       # 自检：造一帧 CMD 6 走完整流程（不需管理员）

现场铁律（否则白跑）：
    · 必须让一局**自然结算**（打完 / 打输 / 通关）—— 用平台的「结束游戏」按钮收场，
      只会看到 kill + closeGame，永远看不到 CMD 6/7（之前几份抓包就是这么错过的）。
    · 抓包要在**平台认为在跑游戏的那台机器**上（平台只把开局帧发给那台）。
"""

import argparse
import ctypes
import datetime
import json
import os
import re
import socket
import struct
import sys
import tempfile
import threading
import time

# ── 端口与 CMD 表 ──────────────────────────────────────────────
P_GAME_RECV = 51124      # 平台 → 游戏（本机监听）
P_GAME_SEND = 51234      # 游戏 → 平台（平台监听）
P_CTRL_SEND = 62135      # 平台 → 客户端（字符串指令）
P_CTRL_RECV = 62136      # 客户端 → 平台
DEFAULT_PORTS = [P_GAME_RECV, P_GAME_SEND, P_CTRL_SEND, P_CTRL_RECV]

# VRPlatformLib.ProtocolType（从游戏自带 VRPlatformLib.dll 读出，本机 11 个明文副本一致）
CMD = {
    1: "Connect            玩家/客户端接入",
    2: "DisConnect         玩家断开",
    3: "PlayerInfoChange   玩家信息变化",
    4: "PlayerJoinStatus   加入状态",
    5: "GameStart      ★   开始游戏",
    6: "GameEnd       ★★  对局结束",
    7: "GameStatistics    战绩上报",
    8: "DeviceState        设备状态",
    9: "StepGameStatistics 分段战绩",
    10: "PlayerStore       商店",
    11: "PlayerWXInfoChange 微信信息变化",
    13: "PlayerInfoNew     玩家信息(新)",
    14: "GetIPSCHero       IPS C 英雄",
    15: "LoadSav           读存档",
    16: "CloseGame     ★   关闭游戏",
    17: "GameLevel         关卡",
    88: "GameData          游戏数据",
}

LINKTYPE_RAW = 101       # 裸 IP（raw socket 抓到的就是这个，与取证目录里的旧 pcap 一致）
LINKTYPE_ETHERNET = 1


def now_str():
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def log(msg):
    print(msg, flush=True)


def fix_console():
    """Windows 控制台默认是 GBK，直接打 ✅/❌/★ 会 UnicodeEncodeError —— 切 UTF-8 代码页并重置 stdout。

    （不切的话，报告里那些符号会直接抛异常把脚本打断；报告文件本身始终按 UTF-8 写。）
    """
    try:
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except Exception:
        pass
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# ── pcap 写入（经典格式，linktype 101；每帧 flush，进程被杀也不丢已抓到的帧）──
class PcapWriter:
    def __init__(self, path, linktype=LINKTYPE_RAW):
        self.path = path
        self.fh = open(path, "wb", buffering=0)
        self.fh.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, linktype))

    def write(self, ts, ip_packet):
        sec = int(ts)
        usec = int(round((ts - sec) * 1000000))
        self.fh.write(struct.pack("<IIII", sec, usec, len(ip_packet), len(ip_packet)))
        self.fh.write(ip_packet)

    def close(self):
        try:
            self.fh.close()
        except Exception:
            pass


# ── 报文解析 ──────────────────────────────────────────────────
def parse_ip_udp(pkt):
    """裸 IPv4 报文 → (src, dst, sport, dport, payload)；不是 UDP 就返回 None"""
    if len(pkt) < 20 or (pkt[0] >> 4) != 4:
        return None
    ihl = (pkt[0] & 0x0F) * 4
    if pkt[9] != 17 or len(pkt) < ihl + 8:
        return None
    src = ".".join(str(b) for b in pkt[12:16])
    dst = ".".join(str(b) for b in pkt[16:20])
    sport, dport = struct.unpack(">HH", pkt[ihl:ihl + 4])
    return src, dst, sport, dport, pkt[ihl + 8:]


def parse_classic_pcap(path):
    """读经典 pcap → [(ts, ip_packet)]"""
    raw = open(path, "rb").read()
    magic = raw[:4]
    if magic in (b"\x0a\x0d\x0d\x0a",):       # pcapng
        raise SystemExit("这是 pcapng 格式（pktmon 的产物）。请用 packet_sniffer.py 抓经典 pcap，"
                         "或先用 Wireshark 另存为 pcap。")
    if magic == b"\xd4\xc3\xb2\xa1":
        endian = "<"
    elif magic == b"\xa1\xb2\xc3\xd4":
        endian = ">"
    else:
        raise SystemExit("认不出的文件格式（magic=%s）：%s" % (magic.hex(), path))
    link = struct.unpack(endian + "I", raw[20:24])[0]
    off, out = 24, []
    while off + 16 <= len(raw):
        sec, usec, incl, orig = struct.unpack(endian + "IIII", raw[off:off + 16])
        off += 16
        if off + incl > len(raw):
            break
        pkt = raw[off:off + incl]
        off += incl
        if link == LINKTYPE_ETHERNET:
            if len(pkt) < 14:
                continue
            pkt = pkt[14:]
        elif link == LINKTYPE_RAW:
            pass
        else:
            continue
        out.append((sec + usec / 1e6, pkt))
    return out


def json_preview(payload, limit=220):
    """若载荷是 JSON（或 CMD+JSON），返回美化前的单行摘要"""
    s = payload.decode("utf-8", "replace")
    i = s.find("{")
    if i < 0:
        return s[:limit].replace("\n", " ")
    try:
        obj = json.loads(s[i:])
    except Exception:
        return s[:limit].replace("\n", " ")
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return txt[:limit]


# ── 抓包线程 ──────────────────────────────────────────────────
def primary_ipv4():
    """本机主用 IPv4。

    为 SIO_RCVALL 挑绑定地址：绑具体接口地址最稳（微软文档的写法就是绑本机地址），
    绑 0.0.0.0 在部分 Windows 上收不到包。这里用「连一个外网地址」让系统自己选出
    出口接口的地址 —— 不会真的发包，只是为了问一句路由表。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "0.0.0.0"
    finally:
        try:
            s.close()
        except Exception:
            pass


def ws2_ioctl(sock, code, value):
    """直接调 ws2_32.WSAIoctl，绕开 Python 对控制码/整数范围的两道检查。

    返回 (rc, wsa_error)；rc == 0 表示成功。抽成独立函数是为了能用**不需要管理员**的
    控制码（如 SIO_UDP_CONNRESET = 0x9800000C）在普通 UDP socket 上做连通性自测 ——
    毕竟 SIO_RCVALL 本身只有提权才能试。
    """
    ws2 = ctypes.WinDLL("ws2_32")
    ws2.WSAIoctl.argtypes = [ctypes.c_size_t, ctypes.c_uint32, ctypes.c_void_p,
                             ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                             ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p,
                             ctypes.c_void_p]
    ws2.WSAIoctl.restype = ctypes.c_int
    ws2.WSAGetLastError.restype = ctypes.c_int
    argIn = ctypes.c_uint32(value)
    got = ctypes.c_uint32(0)
    rc = ws2.WSAIoctl(ctypes.c_size_t(sock.fileno()), ctypes.c_uint32(code),
                      ctypes.byref(argIn), ctypes.c_uint32(4),
                      None, ctypes.c_uint32(0), ctypes.byref(got), None, None)
    return rc, (ws2.WSAGetLastError() if rc != 0 else 0)


def enable_promiscuous(sock):
    """打开 SIO_RCVALL（让 raw socket 收到本机全部进出流量）。返回实际生效的方法名。

    这里叠了三个坑，2026-09-24 现场逐个踩过来：
      ① 常量名：Python 的 socket 里叫 `SIO_RCVALL`，**没有** `IOCTL_RCVALL`
         ⇒ 写成 IOCTL_RCVALL 直接 AttributeError；
      ② 数值越界：0x98000001 > INT_MAX，而 setsockopt 的 optname 是 C int
         ⇒ 直接传就是 `OverflowError: Python int too large to convert to C long`，
         得传它的 32 位补码负值（-1744830463）；
      ③ socket.ioctl() 在 Windows 上对 > 0x7fffffff 的控制码也会被拒。
    所以首选绕过 Python 的整数检查，用 ctypes 直呼 ws2_32 的 WSAIoctl；不成再退回
    setsockopt 的补码写法。返回的字符串会打进日志 —— 下次出问题能一眼看出走的哪条路。
    """
    code = getattr(socket, "SIO_RCVALL", 0x98000001)
    val = 1
    tried = []

    # ① ctypes → WSAIoctl（最可靠，不受 Python 整数范围限制）
    try:
        rc, werr = ws2_ioctl(sock, code, val)
        if rc == 0:
            return "ctypes.WSAIoctl"
        tried.append("WSAIoctl rc=%d/WSAError=%d" % (rc, werr))
    except Exception as e:
        tried.append("WSAIoctl raised %r" % (e,))

    # ② setsockopt + 32 位补码（0x98000001 → -1744830463）
    signed = code - 0x100000000 if code > 0x7FFFFFFF else code
    try:
        sock.setsockopt(socket.IPPROTO_IP, signed, val)
        return "setsockopt(signed %d)" % signed
    except Exception as e:
        tried.append("setsockopt(signed) raised %r" % (e,))

    # ③ 兜底：有些版本可能直接吃无符号值
    try:
        sock.setsockopt(socket.IPPROTO_IP, code, val)
        return "setsockopt(unsigned)"
    except Exception as e:
        tried.append("setsockopt(unsigned) raised %r" % (e,))

    raise SystemExit("打开 SIO_RCVALL 失败（三种写法都不行）：" + "；".join(tried))


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


class Capture:
    def __init__(self, ports, bind_ip="0.0.0.0", writer=None):
        self.ports = set(ports)
        self.bind_ip = bind_ip
        self.writer = writer
        self.frames = []            # [(ts, src, dst, sport, dport, first_byte, payload)]
        self.stop_evt = threading.Event()
        self.err = None
        self.sock = None
        self.n_pkt = 0
        self.bound_ip = None
        self.promisc_method = None

    def start(self):
        if not is_admin():
            raise SystemExit("抓包需要管理员权限（raw socket）。请用管理员终端重跑，"
                             "或双击 tools\\collect-round.bat（会自动申请提权）。")
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_IP)
            bind_ip = self.bind_ip
            if bind_ip in ("", "0.0.0.0", None):
                bind_ip = primary_ipv4()      # 具体接口地址最稳
            s.bind((bind_ip, 0))
            self.bound_ip = bind_ip
            self.promisc_method = enable_promiscuous(s)   # 打开 SIO_RCVALL（见函数注释里的三个坑）
        except OSError as e:
            try:
                s.close()
            except Exception:
                pass
            raise SystemExit(
                "抓包不能开始：%s`n"
                "  · WinError 10013 = 权限不足（Windows 原话 access denied）⇒ 必须用管理员跑；`n"
                "    双击 tools\\collect-round.bat 会自动弹 UAC 提权。`n"
                "  · 其它错误请把上面这行原样贴回来。" % e)
        s.settimeout(0.5)
        self.sock = s
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while not self.stop_evt.is_set():
            try:
                pkt, _ = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError as e:
                if self.stop_evt.is_set():
                    break
                self.err = e
                break
            self.n_pkt += 1
            parsed = parse_ip_udp(pkt)
            if not parsed:
                continue
            src, dst, sport, dport, payload = parsed
            if sport not in self.ports and dport not in self.ports:
                continue
            ts = time.time()
            if self.writer:
                self.writer.write(ts, pkt)
            self.frames.append((ts, src, dst, sport, dport,
                                (payload[0] if payload else None), payload))

    def stop(self):
        self.stop_evt.set()
        try:
            self.thread.join(timeout=3)
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


# ── 报告 ──────────────────────────────────────────────────────
def fmt_dir(sport, dport):
    """方向判定：先看目的端口（最可靠），再看源端口。

    实测两种形态都存在：
      · 平台 → 游戏：`<平台临时端口> → 本机:51124`
      · 游戏 → 平台：`本机:51124 → 平台:51234`（我们用同一个 socket 发，源端口就是 51124）
      · 原版游戏的注册帧：`<临时端口> → 平台:51234`
    """
    if dport == P_GAME_SEND:
        return "游戏→平台"
    if dport == P_GAME_RECV:
        return "平台→游戏"
    if sport == P_GAME_SEND:
        return "平台→游戏"
    if sport == P_GAME_RECV:
        return "游戏→平台"
    if dport == P_CTRL_SEND or sport == P_CTRL_RECV:
        return "平台→客户端"
    if dport == P_CTRL_RECV or sport == P_CTRL_SEND:
        return "客户端→平台"
    return "其他"


def build_report(frames, pcap_path, log_dir, t0, t1):
    L = []
    add = L.append
    def _is_game(f):
        return (f[3] in (P_GAME_RECV, P_GAME_SEND)) or (f[4] in (P_GAME_RECV, P_GAME_SEND))

    game = [f for f in frames if _is_game(f)]
    ctrl = [f for f in frames if not _is_game(f)]

    add("=" * 78)
    add("本局采集报告  %s ~ %s" % (
        datetime.datetime.fromtimestamp(t0).strftime("%Y-%m-%d %H:%M:%S"),
        datetime.datetime.fromtimestamp(t1).strftime("%H:%M:%S")))
    add("抓包文件      %s" % pcap_path)
    add("帧数          游戏通道 %d 帧 / 控制通道 %d 帧" % (len(game), len(ctrl)))
    ips = sorted({f[1] for f in frames} | {f[2] for f in frames})
    add("出现过的 IP   %s" % "、".join(ips))
    add("=" * 78)

    # 1) 游戏通道时间线
    add("")
    add("【1】游戏通道（UDP 51124/51234）逐帧 —— CMD 6/7 的字节只有这里看得到")
    if not game:
        add("    （一帧都没有：平台没开、不在同一网段，或者抓包抓在了错的机器上）")
    for ts, src, dst, sport, dport, b0, payload in game:
        cmd = CMD.get(b0, "") if b0 is not None else ""
        add("    %s  %-9s %s:%d → %s:%d  len=%-4d 首字节=0x%02x %s" % (
            datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:-3],
            fmt_dir(sport, dport), src, sport, dst, dport, len(payload),
            b0 if b0 is not None else 0,
            ("CMD %d %s" % (b0, cmd)) if cmd else ""))
        if payload:
            add("              载荷: %s" % json_preview(payload))

    # 2) 控制通道
    add("")
    add("【2】控制通道（UDP 62135/62136）—— 平台的 start / kill / copyfile 都走这里")
    if not ctrl:
        add("    （无）")
    for ts, src, dst, sport, dport, b0, payload in ctrl[:60]:
        add("    %s  %-11s %s → %s  len=%-4d %s" % (
            datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:-3],
            fmt_dir(sport, dport), "%s:%d" % (src, sport), "%s:%d" % (dst, dport),
            len(payload), json_preview(payload, 150)))

    # 3) 平台日志
    add("")
    add("【3】平台 DebugLog（平台收到什么、之后做了什么）")
    log_lines, log_name, notes = scan_platform_log(log_dir, t0, t1)
    if log_lines is None:
        add("    找不到日志目录：%s" % (log_dir or "（未指定）"))
        add("    （平台装在别的机器上时，请在平台机上把当时那份 .log 贴过来）")
    else:
        add("    目录：%s" % log_dir)
        add("    文件：%s（命中 %d 行）" % (log_name, len(log_lines)))
        for nt in notes:
            add("    ⚠ %s" % nt)
        for ln in log_lines[:80]:
            add("    " + ln.rstrip()[:200])
        if not log_lines:
            add("    （没有 cmd / kill / closeGame / SendCloseGameToGame 相关行）")

    # 4) 结论
    saw6 = [f for f in game if f[5] == 6]
    saw7 = [f for f in game if f[5] == 7]
    saw5 = [f for f in game if f[5] == 5]
    saw16 = [f for f in game if f[5] == 16]
    add("")
    add("【4】结论")
    add("    CMD 5  GameStart      %s" % ("✅ 见到 %d 次" % len(saw5) if saw5 else "— 未见"))
    add("    CMD 6  GameEnd        %s" % ("✅✅ 见到 %d 次：%s" % (
        len(saw6), "; ".join(f[6][:40].hex() for f in saw6)) if saw6 else "❌ 未见到（没有任何一方发过）"))
    add("    CMD 7  GameStatistics %s" % (
        "✅ 见到 %d 次（末次 %d 字节）" % (len(saw7), len(saw7[-1][6])) if saw7 else "❌ 未见到"))
    add("    CMD 16 CloseGame      %s" % ("见到 %d 次" % len(saw16) if saw16 else "— 未见"))

    if saw7:
        t7 = max(f[0] for f in saw7)
        close_after = [f for f in game if f[0] > t7 and f[5] == 16]
        kill_after = [f for f in ctrl if f[0] > t7 and b"kill" in (f[6] or b"")]
        add("    ⇒ 本局「结束」走的是 **CMD 7 战绩上报**，**不是** CMD 6")
        add("    ⇒ 上报之后（**抓包窗口内**）：CloseGame %s，kill %s" % (
            "%d 次" % len(close_after) if close_after else "0 次",
            "%d 次" % len(kill_after) if kill_after else "0 次"))
        # 平台日志比抓包窗口多看到约 10 分钟 —— 那里才能回答真正的那个问题：
        #   「上报结算之后，平台会不会顺手把游戏关掉」（实测：不会；关是 82 秒后**人点「结束游戏」**）
        lg_after = []
        for ln in (log_lines or []):
            ts = log_line_ts(ln)
            if ts is not None and ts > t7 and re.search(r"kill|closeGame|SendCloseGameToGame", ln, re.I):
                lg_after.append(ts)
        if lg_after:
            add("    ⇒ 平台日志（覆盖到采集之后）：上报后 **%+.0f 秒**才出现 kill / closeGame" % (min(lg_after) - t7))
            add("      —— 隔这么久才关，基本可断定是**人点「结束游戏」**触发的，不是 CMD 7 的后果")
        elif log_lines is not None:
            add("    ⇒ 平台日志里：上报之后**没有任何** kill / closeGame ⇒ CMD 7 本身不会让平台关游戏")
    if saw6 and saw16:
        last6 = max(f[0] for f in saw6)
        after = [f for f in saw16 if f[0] > last6]
        add("    ⇒ 平台在收到 GameEnd 后%s发了 CloseGame/关闭动作" % ("**又**" if after else "**没有**"))

    ends = saw6 + saw7
    if ends:
        gap = t1 - max(f[0] for f in ends)
        if gap < 30:
            add("    ⚠ 最后一次结算上报之后只观察到 %.0f 秒 —— 平台的反应可能更晚；" % gap)
            add("      建议下次上报后再等 30~60 秒才结束采集（或 -s 多给点时间）")

    add("")
    add("    下一步：")
    if saw6:
        add("      · 已有 CMD 6 的真实字节 —— 可按它实现上报")
        add("      · 同时看【3】里平台在 cmd = 6 之后有没有 SendCloseGameToGame / kill")
    elif saw7:
        add("      · 权威答案：本局自然结束时上报走的是 **CMD 7 GameStatistics**，**没有** CMD 6；")
        add("      · 上报后平台没有 closeGame / kill ⇒ 「上报结算」不会让平台关游戏，正是我们要的；")
        add("      · 若本局跑的是**我们的**游戏 ⇒ 说明我方还没上报 CMD 7，按【1】里那份负载实现即可。")
    else:
        add("      · 既没有 CMD 6 也没有 CMD 7 ⇒ 这一局大概率没跑到「自然结束」；")
        add("      · 请让一局**自然打完**（打完 / 打输 / 通关）再抓一次。")
    add("=" * 78)
    return "\n".join(L)


KEY = re.compile(r"cmd\s*=\s*\d+|closeGame|CloseGame|ClearData|SendCloseGameToGame|"
                 r'"cmd"\s*:\s*"(kill|start|copyfile)"|Inithead', re.I)

# 平台可能装了好几份（DXGames / DXGames2 / DXGames3 …），只有**正在跑**的那份在更新日志。
LOG_DIR_CANDIDATES = [
    r"G:\01_Work\DXGames2\VRPlatform-2.3.4.3\DebugLog",
    r"G:\01_Work\DXGames\VRPlatform-2.3.4.3\DebugLog",
    r"G:\DXGames\VRPlatform-2.3.4.3\DebugLog",
    r"G:\01_Work\DXGames3\VRPlatform-2.3.4.3\DebugLog",
]


def pick_log_dir(explicit):
    """没给 --log-dir 时，自动挑「日志最新在动」的那份平台。

    2026-09-24 现场踩过：默认写死 `DXGames\\...` 那份，它的日志停在 9/20 ——
    报告里于是贴了一份两天前的旧日志，看着像本局的，其实毫无关系。
    """
    if explicit:
        return explicit
    best, best_t = None, -1
    for d in LOG_DIR_CANDIDATES:
        if not os.path.isdir(d):
            continue
        try:
            t = max([os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d)
                     if f.lower().endswith(".log")] or [-1])
        except Exception:
            continue
        if t > best_t:
            best, best_t = d, t
    return best or LOG_DIR_CANDIDATES[0]


LOG_LINE_TS = re.compile(
    r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)", re.I)


def log_line_ts(ln):
    """从平台日志行里抠时间戳（格式：`【113】9/24/2026 6:10:20 PM : …`）。抠不到返回 None。"""
    m = LOG_LINE_TS.search(ln)
    if not m:
        return None
    mo, d, y, hh, mm, ss, ap = m.groups()
    hh = int(hh) % 12
    if ap.upper() == "PM":
        hh += 12
    try:
        return datetime.datetime(int(y), int(mo), int(d), hh, int(mm), int(ss)).timestamp()
    except Exception:
        return None


def scan_platform_log(log_dir, t0, t1):
    """挑**覆盖本次采集时段**的那份日志，而不是简单取「最新 mtime 的那份」。

    平台每次启动新建一个 `YYYY-MM-DD-HH-MM-SS.log`，所以按文件名里的起始时间判断：
    取「起始时间 <= 采集开始」里最晚的一份。同时把三件事如实说出来，别再让人误读：
      · 这个目录里有没有一份起始于采集之前的日志（没有 ⇒ 目录挑错了）；
      · 选中的文件是不是 0 字节（平台还开着、日志没落盘）；
      · 它的最后写入时间是不是早于本次采集（⇒ 平台侧视角缺失，只能看抓包）。

    命中行还要**按时段过滤**：这份日志里必然带着上一局的 start/kill（2026-09-24 实测，
    17:38 那份日志里有 17:43/17:44 的旧 start+kill，看着像是本局发生的，极易误读）。
    保留 [t0-60s, t1+600s] —— 尾巴给 10 分钟，好看见「上报之后平台隔了多久才关游戏」。
    返回 (命中行列表 | None, 文件名, 提示列表)。
    """
    if not log_dir or not os.path.isdir(log_dir):
        return None, None, []
    entries = []
    for fn in os.listdir(log_dir):
        if not fn.lower().endswith(".log"):
            continue
        p = os.path.join(log_dir, fn)
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})", fn)
        try:
            st = datetime.datetime(*[int(x) for x in m.groups()]).timestamp() if m else os.path.getmtime(p)
        except Exception:
            st = os.path.getmtime(p)
        entries.append((st, p, fn))
    if not entries:
        return None, None, []
    entries.sort()

    notes = []
    pick = None
    for e in entries:
        if e[0] <= t0 + 5:
            pick = e
    if pick is None:
        pick = entries[0]
        notes.append("这个目录里没有任何一份日志起始于本次采集之前 ⇒ 它多半不是本次在跑的那份平台。")
    _, path, name = pick

    size = os.path.getsize(path)
    mt = os.path.getmtime(path)
    if size == 0:
        notes.append("这份日志是 0 字节 —— 平台可能还开着、日志没落盘（平台退出后再看一次）。")
    if mt < t0:
        notes.append("这份日志最后写入 %s，早于本次采集开始 %s ⇒ 平台侧视角缺失，只能看抓包。" % (
            datetime.datetime.fromtimestamp(mt).strftime("%m-%d %H:%M:%S"),
            datetime.datetime.fromtimestamp(t0).strftime("%m-%d %H:%M:%S")))

    out = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                if KEY.search(ln):
                    out.append(ln)
    except Exception as e:
        notes.append("读取失败：%s" % e)

    kept, dropped = [], 0
    for ln in out:
        ts = log_line_ts(ln)
        if ts is None or (t0 - 60) <= ts <= (t1 + 600):
            kept.append(ln)
        else:
            dropped += 1
    if dropped:
        notes.append("已按时段过滤：另有 %d 行命中落在采集时段之外（多为上一局的 start/kill），未列出。" % dropped)
    return kept, name, notes
# ── 主流程 ────────────────────────────────────────────────────
def main():
    fix_console()
    ap = argparse.ArgumentParser(description="现场一局采集：抓包 + 平台日志 + 一页报告")
    ap.add_argument("-o", "--out-dir", default="", help="输出目录（默认 E:\\AI_Work\\WebXR_Capture\\<时间戳>）")
    ap.add_argument("-s", "--seconds", type=int, default=0, help="采集秒数；0 = 按回车结束")
    ap.add_argument("--ports", type=int, nargs="*", default=DEFAULT_PORTS, help="要抓的 UDP 端口")
    ap.add_argument("--bind-ip", default="0.0.0.0", help="抓包绑定的本机 IP（默认全部）")
    ap.add_argument("--log-dir", default="",
                    help="平台 DebugLog 目录（默认自动挑：候选目录里日志最新在动的那份）")
    ap.add_argument("--analyze", default="", help="只分析已有 pcap，不抓包")
    ap.add_argument("--selftest", action="store_true", help="自检：造帧走完整流程（不需管理员）")
    args = ap.parse_args()
    log_dir = pick_log_dir(args.log_dir)   # 平台装了好几份，挑正在跑的那份

    out_dir = args.out_dir or os.path.join(
        r"E:\AI_Work\WebXR_Capture",
        datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))

    if args.selftest:
        return selftest(args, log_dir)

    if args.analyze:
        frames = []
        for ts, pkt in parse_classic_pcap(args.analyze):
            parsed = parse_ip_udp(pkt)
            if not parsed:
                continue
            src, dst, sport, dport, payload = parsed
            if sport not in args.ports and dport not in args.ports:
                continue
            frames.append((ts, src, dst, sport, dport, payload[0] if payload else None, payload))
        t0 = min(f[0] for f in frames) if frames else time.time()
        t1 = max(f[0] for f in frames) if frames else time.time()
        print(build_report(frames, args.analyze, log_dir, t0, t1))
        return 0

    os.makedirs(out_dir, exist_ok=True)
    pcap_path = os.path.join(out_dir, "round.pcap")
    writer = PcapWriter(pcap_path)
    cap = Capture(args.ports, args.bind_ip, writer)

    log("=" * 78)
    log("现场一局采集 —— 请现在去做这四步：")
    log("  ① 平台点「启动游戏」")
    log("  ② 平台点「开始游戏」→ 头显进 VR")
    log("  ③ ★ 把这一局**自然打完**（打完 / 打输 / 通关），**不要**点平台的「结束游戏」")
    log("  ④ ★ 打完之后**再等 30~60 秒**——平台对结算的反应可能要过几秒才发出来")
    log("=" * 78)
    cap.start()
    log("已开始抓包（UDP %s，绑定 %s，抓包模式 %s）→ %s" % (args.ports, getattr(cap, "bound_ip", None) or args.bind_ip, getattr(cap, "promisc_method", "?"), pcap_path))
    t0 = time.time()

    try:
        if args.seconds > 0:
            log("采集 %d 秒后自动结束…" % args.seconds)
            for _ in range(args.seconds):
                time.sleep(1)
        else:
            log("")
            log(">>> 跑完这一局、并再等 30~60 秒后，回到本窗口按【回车】结束采集 <<<")
            try:
                input()
            except EOFError:
                log("（stdin 不可用 → 改抓 60 秒）")
                time.sleep(60)
    except KeyboardInterrupt:
        log("（收到 Ctrl+C，结束采集）")
    finally:
        cap.stop()
        t1 = time.time()
        writer.close()

    log("")
    log("采集结束：原始抓包共 %d 个 UDP 包，其中关注端口 %d 帧"
        % (cap.n_pkt, len(cap.frames)))
    if cap.err:
        log("⚠ 抓包异常：%s" % cap.err)
    if not cap.frames:
        log("⚠ 一帧都没抓到：① 平台在跑吗；② 本机就是「跑游戏」的那台机器吗；③ 抓包绑定的是不是不对")
        log("   （本次绑定 %s，可用 --bind-ip 指定；端口 %s）" % (getattr(cap, "bound_ip", args.bind_ip), args.ports))

    report = build_report(cap.frames, pcap_path, log_dir, t0, t1)
    print(report)
    rp = os.path.join(out_dir, "report.txt")
    with open(rp, "w", encoding="utf-8") as fh:
        fh.write(report)
    log("")
    log("报告已存：%s" % rp)
    log("原始抓包：%s（可交给 pcap-inspect.py 做平台全量分析）" % pcap_path)
    return 0


def selftest(args, log_dir=""):
    """不需要管理员：造几条帧（含 CMD 6）走 写入→读回→报告 全流程"""
    out_dir = args.out_dir or os.path.join(tempfile.gettempdir(), "cap-round-selftest")
    os.makedirs(out_dir, exist_ok=True)
    pcap_path = os.path.join(out_dir, "selftest.pcap")
    w = PcapWriter(pcap_path)
    t0 = time.time()

    def udp(sport, dport, payload, src="192.168.31.228", dst="192.168.31.237"):
        ip = bytearray(20)
        ip[0] = 0x45
        ip[9] = 17
        ip[12:16] = bytes(int(x) for x in src.split("."))
        ip[16:20] = bytes(int(x) for x in dst.split("."))
        udp_h = struct.pack(">HHHH", sport, dport, 8 + len(payload), 0)
        return bytes(ip) + udp_h + payload

    w.write(t0 + 0.1, udp(58734, P_GAME_RECV, b"\x05" + json.dumps(
        {"gameId": 128, "posSum": 2, "difficulty": 0}).encode()))      # 平台 → 游戏：开始游戏
    w.write(t0 + 1.0, udp(P_GAME_RECV, P_GAME_SEND, b"\x01"))          # 游戏 → 平台：注册
    w.write(t0 + 1.1, udp(58740, P_GAME_RECV, b"\x01\x02" + json.dumps({"Machines": []}).encode()))
    w.write(t0 + 2.0, udp(54820, P_GAME_SEND, b"\x01GameVersion:v2.8.3"))
    w.write(t0 + 30.0, udp(P_GAME_RECV, P_GAME_SEND, b"\x06"))         # ★ 游戏 → 平台：CMD 6 GameEnd
    w.write(t0 + 31.0, udp(58750, P_GAME_RECV, b"\x10closeGame  "))    # 平台 → 游戏：CloseGame
    w.write(t0 + 31.2, udp(P_GAME_RECV, P_GAME_SEND, b"\x02"))
    w.write(t0 + 32.0, udp(55555, P_CTRL_SEND, json.dumps(
        {"cmd": "kill", "msgData": "DeepmindHacker"}).encode()))
    w.close()

    frames = []
    for ts, pkt in parse_classic_pcap(pcap_path):
        parsed = parse_ip_udp(pkt)
        if not parsed:
            continue
        src, dst, sport, dport, payload = parsed
        frames.append((ts, src, dst, sport, dport, payload[0] if payload else None, payload))
    log("自检：写入 %d 帧 → 读回 %d 帧" % (8, len(frames)))
    rep = build_report(frames, pcap_path, log_dir, t0, t0 + 33)
    print(rep)
    # 用正则匹配，别盯死空格数（报告里的列对齐一变，断言就假失败 —— 2026-09-24 就是这么踩的）
    ok = (re.search(r"CMD 6\s+GameEnd\s+✅✅ 见到 1 次", rep) is not None
          and re.search(r"CMD 16\s+CloseGame\s+见到 1 次", rep) is not None)
    log("")
    log("自检结果：" + ("✅ 通过（CMD 6 被识别、方向与结论都对）" if ok else "❌ 不通过，检查解码逻辑"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())



