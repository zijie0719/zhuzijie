# 部署到阿里云 ECS

> 系统是 **Alibaba Cloud Linux / CentOS**，或者 **Ubuntu** 的 OpenClaw 应用镜像，都适用。
> 用 OpenClaw 镜像的话，**先看下面「先看这里：你的镜像是 OpenClaw」那一节**。

目标：把网站跑在服务器上，用 `http://你的公网IP:3000` 访问，开机自动启动、崩溃自动重启。

全程约 10 分钟。命令可以直接复制粘贴。

> 下面所有 `你的公网IP` 都替换成阿里云控制台上那台 ECS 的**公网 IP**。

---

## 先看这里：你的镜像是 OpenClaw（2026.6.10 之类）

阿里云镜像市场里的 **OpenClaw 应用镜像**是给 OpenClaw 用的，它自带一个 Node.js 运行环境，
而且**基础系统不一定是 Alibaba Cloud Linux，多数是 Ubuntu**。所以下面凡是 `dnf` 的命令，
你得先确认系统到底用 `dnf` 还是 `apt`。

SSH 登上去，先跑这三条，一次把情况摸清：

```bash
cat /etc/os-release                        # 判断包管理器
node -v                                    # 看自带的 Node 版本
ss -lntp | grep -E ':(3000|80|18789)\b'    # 看端口有没有被占
```

怎么解读：

| 情况 | 怎么做 |
| --- | --- |
| `node -v` 显示 **v24 或更高** | 不用装 Node 了，**直接跳过第 2 步** |
| `node -v` 是 v18 / v22 | 必须走第 2 步重装到 24（本项目用 Node 内置 SQLite，低版本没有这个模块，起不来） |
| `ID=` 那行是 `almalinux` / `centos` / `alinux` | 用 `dnf` |
| `ID=` 那行是 `ubuntu` / `debian` | 把下文的 `dnf install` 换成 `apt install`，`dnf remove` 换成 `apt remove` |
| 端口里**没有 3000** | 正常，按下面第 0 步走 |
| 端口里**已经有 3000** | 被别的程序占了，本项目换端口，见下面「换个端口」 |

> OpenClaw 自己的网关默认在 **18789** 端口，正常情况下不会跟本项目的 3000 冲突。
> 两个可以同时跑，互不影响，2 核 2G 的机器带得动。

### ⚠️ 两个必看的坑

**① `which node` 的路径可能不是 `/usr/bin/node`。**
OpenClaw 镜像常用 nvm 装 Node，路径长这样：`/root/.nvm/versions/node/v24.x.x/bin/node`。
systemd **读不到 nvm 的环境变量**，所以第 6 步里 `ExecStart=/usr/bin/node` 必须换成
`which node` 查出来的完整路径，否则服务起不来（报 `status=203/EXEC`）。

**② 镜像自带 Node 版本对，不代表 npm 全局装的东西能用。**
本项目不依赖全局包，只要 `node -v` ≥ 24 就没问题。

### 换个端口（3000 被占时）

把本项目换到 8080（或任意空闲端口）：

1. 改 `deploy/shop.service`：`Environment=PORT=3000` → `Environment=PORT=8080`
2. 安全组和 firewalld 放行改成 8080
3. 访问地址相应变成 `http://你的公网IP:8080`

---

## 第 0 步：放行端口

阿里云有**两层**防火墙，两层都放行才能访问。

### 1. 安全组（必须做，否则死活连不上）

阿里云控制台 → 云服务器 ECS → 实例 → 点进你那台机器 → **安全组** → 配置规则 → **入方向** → 手动添加：

| 端口范围 | 授权对象 | 说明 |
| --- | --- | --- |
| `3000/3000` | `0.0.0.0/0` | 网站访问 |
| `22/22` | `0.0.0.0/0` | SSH 登录（一般默认已开） |

> 以后加了域名走 Nginx，就把 3000 换成 `80/80` 和 `443/443`，并删掉 3000 这条。

### 2. 服务器自带防火墙

SSH 登上去执行，两条都试一下，哪条有用哪条：

```bash
# CentOS / Alibaba Cloud Linux / AlmaLinux 系
systemctl is-active firewalld
```

- 输出 `active` → 执行：
  ```bash
  firewall-cmd --permanent --add-port=3000/tcp
  firewall-cmd --reload
  firewall-cmd --list-ports      # 确认 3000/tcp 在列表里
  ```
- 输出 `inactive` 或 `unknown` → 说明没开，跳过。

```bash
# Ubuntu / Debian 系（OpenClaw 镜像多半是这种）
systemctl is-active ufw
```

- 输出 `active` → 执行：
  ```bash
  ufw allow 3000/tcp
  ufw status                     # 确认 3000/tcp 是 ALLOW
  ```
- 输出 `inactive` 或 `unknown` → 说明没开，跳过。

> 两个都没开的话，服务器本机不拦端口，但**阿里云安全组那一层照样会拦**，所以第 0 步的第 1 小节永远必须做。

---

## 第 1 步：SSH 登录服务器

在自己的电脑上（Windows 用 PowerShell 或 Git Bash）：

```bash
ssh root@你的公网IP
```

第一次连接会问 `Are you sure you want to continue connecting?`，输 `yes` 回车。
密码就是你在阿里云创建实例时设的，忘了可以在控制台重置。

---

## 第 2 步：安装 Node.js 24

> ⚠️ **这一步不能省，也不能用系统自带的 nodejs。**
> 本项目用 Node 内置的 `node:sqlite` 存数据，必须 **Node 24** 以上。
> CentOS / Alibaba Cloud Linux 自带的 nodejs 是 16 或 18，装上去直接起不来。

**先确认要不要装。** 如果你的 OpenClaw 镜像自带的就是 v24+，这一段整个跳过。

在服务器上执行（按上一步 `cat /etc/os-release` 的结果选 `rpm` 还是 `deb`）：

```bash
# ── 系统是 Alibaba Cloud Linux / CentOS / AlmaLinux（用 dnf）──
curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
dnf install -y nodejs

# ── 系统是 Ubuntu / Debian（用 apt）──
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# 确认版本，必须显示 v24.x.x
node -v
npm -v
```

如果 `node -v` 还是老版本，说明系统里有旧的 nodejs，先清掉再装：

```bash
# CentOS 系
dnf remove -y nodejs npm
# Ubuntu 系
apt remove -y nodejs npm

# 再重新执行上面的安装命令，然后
node -v
```

---

## 第 3 步：把代码传上去

**在你自己的电脑上**（不是服务器），用 Git Bash 执行：

```bash
cd /d/ai

# 打包，排除 node_modules 和本地数据
tar --exclude='shop/node_modules' --exclude='shop/data' -czf shop.tar.gz shop

# 传上去（会提示输密码）
scp shop.tar.gz root@你的公网IP:/root/
```

> 没有 Git Bash 的话，用 7-Zip 把 `d:\ai\shop` 压成 `shop.tar.gz`
> （注意先删掉 `node_modules` 和 `data` 两个文件夹），再用 WinSCP 之类的工具传上去。
>
> **不要传 `node_modules`** —— 里面有 Windows 平台的东西，在 Linux 上没用还很大。

**回到服务器**解压：

```bash
mkdir -p /www
tar -xzf /root/shop.tar.gz -C /www/
ls /www/shop          # 应该能看到 server.js、package.json 等
```

---

## 第 4 步：安装依赖

在服务器上：

```bash
cd /www/shop
npm install --omit=dev
```

只装运行需要的依赖（跳过 jsdom 这类测试用的），很快 —— 整个项目**只有一个依赖**（express）。

> 卡住不动的话是 npm 官方源在国内慢，换淘宝源再来一次：
> ```bash
> npm config set registry https://registry.npmmirror.com
> npm install --omit=dev
> ```

---

## 第 5 步：先手动试跑一次

```bash
cd /www/shop
node server.js
```

应该看到：

```
────────────────────────────────────────────────────
  自助下单网站已启动
────────────────────────────────────────────────────
  前台首页   http://localhost:3000/
  管理后台   http://localhost:3000/admin
────────────────────────────────────────────────────
  首次启动已创建管理员，请立即登录并修改密码：
     用户名  admin
     密码    admin123
────────────────────────────────────────────────────
```

**现在用浏览器打开 `http://你的公网IP:3000`** —— 能看到店铺首页就说明通了。

> 打不开的话按顺序排查：
> 1. 安全组规则加了吗？（第 0 步，最容易漏）
> 2. `firewall-cmd --list-ports` 里有 3000 吗？
> 3. 服务器上 `curl -I localhost:3000` 通不通？通说明是防火墙问题，不通是程序问题。
>
> 确认没问题后，在服务器上按 `Ctrl + C` 停掉，继续下一步。

---

## 第 6 步：配置成后台服务（开机自启 + 崩溃自动重启）

```bash
# 复制服务文件
cp /www/shop/deploy/shop.service /etc/systemd/system/shop.service

# ⚠️ 关键：确认 node 的完整路径，不是 /usr/bin/node 就改服务文件
which node
# 比如输出 /root/.nvm/versions/node/v24.20.0/bin/node
# 就把 shop.service 里的 ExecStart 改成
#   ExecStart=/root/.nvm/versions/node/v24.20.0/bin/node server.js
# OpenClaw 镜像常用 nvm 装 Node，这步不做服务一定起不来（报 status=203/EXEC）

# 启动并设置开机自启
systemctl daemon-reload
systemctl enable --now shop

# 看状态，看到绿色的 active (running) 就成了
systemctl status shop
```

**以后再也不用 `npm start` 了**，服务会一直在后台跑。

常用命令：

```bash
systemctl restart shop     # 改了代码后重启
systemctl stop shop        # 停止
systemctl status shop      # 看状态
journalctl -u shop -f      # 实时看日志（Ctrl+C 退出）
```

---

## 第 7 步：改掉默认密码 + 配置收款

浏览器打开 `http://你的公网IP:3000/admin`，用 `admin` / `admin123` 登录，然后：

1. **「账号安全」→ 改掉密码**（必做）
2. **「收款设置」→ 上传你的微信/支付宝收款码**（不传的话买家付款页看不到收款信息）
3. **「系统设置」→ 把店铺名、公告、客服联系方式改成你自己的**
4. 「商品管理」→ 删掉 3 个演示商品，发你自己的

---

## 日常维护

### 更新代码

在本地改完代码后：

```bash
# 本地
cd /d/ai
tar --exclude='shop/node_modules' --exclude='shop/data' -czf shop.tar.gz shop
scp shop.tar.gz root@你的公网IP:/root/

# 服务器
cd /www/shop
tar -xzf /root/shop.tar.gz -C /www/ --overwrite
systemctl restart shop
```

> ⚠️ 如果这次更新动了 `package.json` 的依赖，还要跑一次 `npm install --omit=dev`。
>
> 更新**不会**动 `data/` 和 `public/uploads/`，你的商品、订单、收款码都还在。

### 备份数据

所有数据就在两个地方：

```bash
# 备份（数据库 + 上传的图片）
mkdir -p /root/backup
tar -czf /root/backup/shop-$(date +%F).tar.gz -C /www/shop data public/uploads

# 看备份文件
ls -lh /root/backup/
```

建议写个定时任务每天自动备份，并且**下载到本地或对象存储**（备份和服务器放一起，服务器挂了备份也没了）。

```bash
# 编辑定时任务
crontab -e

# 加上这行：每天凌晨 3:10 自动备份
10 3 * * * tar -czf /root/backup/shop-$(date +\%F).tar.gz -C /www/shop data public/uploads
```

### 恢复数据

```bash
systemctl stop shop
cd /www/shop
rm -rf data public/uploads
tar -xzf /root/backup/shop-2026-10-15.tar.gz -C /www/shop
systemctl start shop
```

---

## 后面想加域名和 HTTPS

现在没有域名也能正常用。等要加的时候：

1. **先备案。** 域名解析到大陆服务器必须有 ICP 备案，否则会被阻断。在阿里云控制台「备案」里申请，一般 7-20 天。**这是绕不过去的，先启动备案流程。**

2. 备案通过后，在阿里云 DNS 把域名解析到这台服务器的公网 IP（A 记录）。

3. 装 Nginx 并配置反代：

   ```bash
   dnf install -y nginx
   cp /www/shop/deploy/nginx-shop.conf /etc/nginx/conf.d/shop.conf
   vi /etc/nginx/conf.d/shop.conf     # 把 your-domain.com 改成你的域名
   nginx -t && systemctl enable --now nginx
   ```

4. 申请 HTTPS 证书（自动续期）：

   ```bash
   dnf install -y certbot python3-certbot-nginx
   certbot --nginx -d your-domain.com
   ```

5. 最后回阿里云安全组放行 `80` 和 `443`，并**删掉 3000 那条规则**（Nginx 会代理到本机的 3000，不再需要对外暴露）。

> Nginx 配好后，`deploy/shop.service` 里的 `TRUST_PROXY=1` 和 `HOST=127.0.0.1` 已经设好了 ——
> 这两项保证限流能拿到买家真实 IP，且 3000 端口不对外。

---

## 出问题时

**服务起不来**

```bash
journalctl -u shop -n 50 --no-pager     # 看最近 50 行日志
node -v                                  # 确认是 v24+
systemctl status shop | grep -i exec    # 看是不是 203/EXEC
```

**启动提示「Node.js 版本太低」**
回到第 2 步重装 Node 24。

**`status=203/EXEC` 或 `No such file or directory`**
`ExecStart` 里的 node 路径不对。用 `which node` 查出完整路径（nvm 装的会很长），
改掉 `shop.service` 后 `systemctl daemon-reload && systemctl restart shop`。

**网页能打开但样式全丢**
浏览器强制刷新（`Ctrl + F5`）。

**浏览器打不开，但服务器上 `curl -I localhost:3000` 是 200**
是安全组或服务器防火墙没放行，回到第 0 步。

**改了代码没生效**
`systemctl restart shop` 重启一下。只改 `public/` 下的前端文件不用重启。

**上传收款码报错**
服务器磁盘满了，`df -h` 看一下。
