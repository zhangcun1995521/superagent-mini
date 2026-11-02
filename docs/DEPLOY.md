# 部署到云

这份文档回答一个问题：**把这套东西从"我本机能跑"变成"一台机器上一直跑"要做什么。**

先说清楚它需要什么，因为它比想象中少：

| 需要 | 不需要 |
|---|---|
| Linux + Node 24 | 公网 IP 之外的任何入站端口 |
| 出站网络（飞书 API、模型 API） | 域名、HTTPS 证书、ICP 备案 |
| 一块可写磁盘（`state/`） | 数据库、Redis、消息队列 |
| 机器常开 | GPU、大带宽、负载均衡、K8s |

**最关键的一条：这套架构是轮询（出站），飞书 API 是我们主动去调的。**
所以不需要开任何入站端口，不需要域名，也就不需要备案、不需要证书。
这是架构省下来的最大一笔——不是省钱，是省掉了整个"对外暴露面"和它带来的所有麻烦。

## 一、买什么

- 轻量应用服务器（腾讯云 / 阿里云都行），**2 核 2G**，Ubuntu 24.04 LTS，系统盘 40G 起
- **地域选国内**（上海 / 北京 / 广州）：飞书 API 和模型 API 都在国内，
  机器放海外每次往返多 200–300ms，而轮询是每 5 秒一次、Worker 每次要几十次往返
- 带宽 3–5M 足够：我们几乎不传文件，流量是 JSON

为什么是 2G 不是 1G：每个 Worker 是一个 `node` 子进程，1G 上同时跑两个就会 OOM；
4G 用不上，因为大部分时间在等 API 返回，不是算。

**先别年付。** 先用最低配置跑一周，看清楚内存水位和 token 消耗再说。

## 二、机器装什么

```bash
# 1) 非 root 用户。常驻服务不以 root 跑，这不是洁癖，是出事了损失范围的问题。
sudo adduser --disabled-password --gecos "" agent

# 2) Node 24。**apt 里的是 18，跑不了这个项目**（用了 .ts 直接执行和顶层 await）。
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # 必须是 v24.x

# 3) lark-cli（飞书命令行）
sudo npm i -g lark-cli
```

## 三、把代码弄上去

推荐 git（有历史、能回滚）。这个目录现在还不是仓库：

```bash
# 本机
cd /opt/superagent
git init && git add -A && git commit -m "init"
# 推到你的私有仓库（Gitee / GitHub 私有仓 / 自建都行）
```

```bash
# 服务器
sudo mkdir -p /opt/superagent && sudo chown agent:agent /opt/superagent
sudo -u agent git clone <仓库地址> /opt/superagent
cd /opt/superagent && sudo -u agent npm i
```

`npm i` 会把 `@deepseek-ai/dsh` 一起装上——`src/dsh.ts` 会优先用项目内的那份，
找不到才退回开发目录并打印警告。**看到那条警告就说明服务器上装错了。**

## 四、凭据（两样，都别进代码）

### 1. 模型

```bash
sudo mkdir -p /etc/superagent
sudo tee /etc/superagent/env >/dev/null <<'EOF'
SAM_CHAT_ID=oc_xxxxxxxxxxxxxxxx
SAM_STATE_DIR=/var/lib/superagent
DEEPSEEK_API_KEY=sk-xxxxxxxx
EOF
sudo chown agent:agent /etc/superagent/env
sudo chmod 600 /etc/superagent/env
```

### 2. 飞书机器人

lark-cli 的凭据在本机 `~/.lark-cli/config.json`，里面是 app_id / app_secret。
**这个文件是密钥，用 scp 直接拷，不要贴到聊天里、不要进 git。**

```bash
# 本机
scp ~/.lark-cli/config.json agent@<服务器IP>:~/.lark-cli/config.json
# 服务器
chmod 600 ~/.lark-cli/config.json
lark-cli auth status     # bot 身份应该显示 ready
```

消息：**这里的 bot 身份用的是本地 app 凭据，不是会过期的用户 token，
所以不存在"跑几天就掉线"的问题。** 用户身份（`--as user`）才是要 OAuth 的，
本项目不用它——也就不需要处理刷新。

## 五、跑起来

```bash
sudo cp /opt/superagent/deploy/superagent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now superagent
sudo systemctl status superagent
sudo journalctl -u superagent -f     # 看日志
```

正常的第一屏应该长这样：

```
启动。群 oc_xxx，状态目录 /var/lib/superagent/，轮询 5000ms
首次启动：只处理 2026-xx-xxTxx:xx:00.000Z 之后的消息，群里的历史不回溯。
在群里说话就会触发。Ctrl-C 停。
```

然后去群里说一句话。**先不要指望它干活，先确认"它收到了"**——
日志里出现 `+ Worker ...` 就说明整条链路通了。

## 六、会踩的坑（按踩到的概率排）

**1. 时区。** 已修：`isoOf` 按 `+08:00` 解析飞书时间，不看本机时区。
改之前的表现是"看着一切正常，但永远收不到消息"——因为水位线把它全滤掉了。
如果你自己改了那块代码，记住这条。

**2. 首次启动会设水位线。** 群里的历史不回溯。这是有意的：
不然第一次跑就会对着半年前的"哈喽在吗"派 Worker。想回放历史用 `FEISHU_SINCE`。

**3. 内存。** 每个 Worker 一个 node 子进程。观察方式：

```bash
free -m
ps -o pid,rss,etime,cmd -C node --sort=-rss | head
```

RSS 涨到 800M 以上就该给 Worker 加超时限制了（`DSH_WORKER_TIMEOUT_MS`）。

**4. token 花钱。** 一次最简往返实测约 14,470 tokens。
群里每触发一次派活就是一笔。凌晨有人闲聊也可能触发。
上线前先把 Router 的提示词认清：它只在"有人明确要求做事"时才 dispatch。

**5. DPoP 签名报错。** 日志里如果有 `key signer is unavailable`，
那是 Windows 上的 CNG 密钥存储问题——Linux 上没有这个坑，这条警告在云上应该消失。
反过来说：**看到这条警告还在，说明你可能跑在了本机，不是在服务器上。**

## 七、本机 vs 云端：值不值

说实话：**这套东西本机常开也能跑，能力上不比云端多。**
买机器的收益是三条，都不是"能力"：

1. 不占自己的电脑，笔记本合盖它还在跑
2. 换机器不受影响，状态在服务器磁盘上
3. 真练一遍 systemd / 日志 / 权限 / 密钥管理——这些是"部署"的实质

如果只是为了验证它能不能跑，本机跑一周就行，成本 0。
如果是想把"部署"这件事学会，那这台机器买得值。
