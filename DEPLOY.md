# VPS 容器部署

本项目使用 Node.js 24，无需安装 npm 依赖。默认对外端口为 **18790**，容器内部端口为 8790。支持普通 x86 VPS（amd64）和 ARM VPS（arm64）。

## 首次启动

VPS 需先安装 Docker Engine 和 Docker Compose v2，确保 `docker compose version` 可用。以下命令在有 Docker 权限的终端执行；若当前账号没有权限，使用 `sudo docker compose`。

镜像发布完成、GHCR 软件包设为公开后，在 VPS 执行：

```sh
mkdir -p game-supermarket
cd game-supermarket
curl -fL https://raw.githubusercontent.com/Alumos/game-supermarket/v1.3.18/compose.yaml -o compose.yaml
# 启动前配置 .env 中的 SUPERMARKET_TEACHER_PASSWORD（见下文）
docker compose up -d
docker compose ps
```

默认会从 `ghcr.milu.moe/alumos/game-supermarket:v1.3.18` 拉取固定版本。安全组和防火墙放行 TCP 18790，然后打开：

- 教师入口：`http://你的VPS公网IP:18790/teacher.html`
- 学生入口：`http://你的VPS公网IP:18790/`
- 健康检查：`http://你的VPS公网IP:18790/healthz`，正常返回 `{"ok":true}`。

## 设置后台密码

推荐在 `compose.yaml` 同目录建立 `.env`，写入自己选择的密码（示例中的占位文字需要替换）：

```dotenv
SUPERMARKET_TEACHER_PASSWORD='替换为你自己的后台密码'
```

也可以直接修改 `compose.yaml` 的 `environment` 对应项，把环境变量表达式替换为带引号的密码：

```yaml
      SUPERMARKET_TEACHER_PASSWORD: '替换为你自己的后台密码'
```

YAML 中若密码包含单引号，需写成两个连续单引号；密码中的 `$` 若直接写在 Compose YAML 中，需写作 `$$`，避免被 Compose 当作变量替换。推荐使用单引号 `.env` 方式，Compose 会按字面读取其中的 `$`。只需选择一种配置方式，不要提交含密码的文件。

修改配置后执行 `docker compose up -d`，在教师登录页输入此后台密码。**非空配置在已有数据卷上也会覆盖原教师密钥，无需删卷、重建课堂或清空作品**。密码不会打印到启动日志或学生页面。更换密码后原教师登录状态会失效，需重新登录。

留空或未设置 `SUPERMARKET_TEACHER_PASSWORD` 时，继续使用持久卷中的 `teacher-key.txt`；首次空配置启动会生成该文件。可在自己的 VPS 终端读取文件用于登录，请妥善保管，不要公开。容器日志默认不显示原密钥。

教师登录后新建课堂，该课堂自动成为当前接入课堂；把站点根地址或邀请二维码交给学生。学生打开即自动领取 A1、A2…编号，无需课堂码、组号或姓名；同课刷新保留编号。教师可从游戏左上角的“教师演示”输入同一后台密码，独立切换四个场景；演示进度仅保存在本浏览器，不改变课堂安排。结束或删除当前课会停止接收新学生，不会自动回到旧课。

## EdgeOne 加速规则

仓库中的 `EDGEONE-SEQ-ALUMOS.json` 按 EdgeOne JSON Mode 的规范结构（主规则 Actions + SubRules）编写，可以直接导入。根规则开启 FollowOrigin，只有公开静态文件通过 `file_extension` 子规则缓存 5 分钟；API、页面入口和 SSE 由源站的 `Cache-Control: no-store/no-cache` 控制，不进入缓存。这样不使用 EdgeOne 不支持的路径变量条件。

导入后清理旧缓存一次；发布新镜像后如需立即更新学生端，清理 `/app.js`、`/app.css`、`/browser-identity.mjs`、`/shared/engine.mjs` 和 `/sw.js`。静态资源源站同时返回 ETag 和 `max-age=0`，浏览器会向 EdgeOne 重新校验。

不要关闭 FollowOrigin，也不要对 `/api/*/stream` 开启缓存或代理缓冲；否则可能出现课堂状态、学生身份或工牌响应串给其他客户端。

## 端口、地址与镜像源

在 `compose.yaml` 同目录新建 `.env`，按需填写，例如：

```dotenv
SUPERMARKET_PORT=18790
SUPERMARKET_PUBLIC_URL=http://你的VPS公网IP:18790
```

`SUPERMARKET_PUBLIC_URL` 是学生实际能访问的完整站点地址，不带 `/teacher.html` 或其他路径。直接通过公网 IP 访问时可省略；容器默认不把容器内网 IP 当作学生入口。通过域名反向代理时请务必填写，例如 `https://classroom.example.com`。配置 HTTPS 地址后，登录 cookie 会自动带 `Secure` 标记；所有人也须通过此 HTTPS 地址登录。应用以配置的站点地址检查跨站写入请求，不信任客户端传来的 `X-Forwarded-*` 头。

改端口后同步调整安全组、访问地址和 `SUPERMARKET_PUBLIC_URL`，然后执行 `docker compose up -d`。

加速源暂不可用或刚发布尚未同步时，将 `.env` 中的镜像改为 GHCR 官方地址：

```dotenv
SUPERMARKET_IMAGE=ghcr.io/alumos/game-supermarket:v1.3.18
```

然后执行：

```sh
docker compose pull
docker compose up -d
```

`ghcr.milu.moe` 仅作为拉取加速源；Actions 始终发布到 `ghcr.io`。公开镜像不需要在 VPS 登录 GHCR。若出现 `denied`，先确认 GitHub 软件包已设为 Public。

## 日常管理和数据

教师后台的课堂列表旁提供“删除所选课堂”和“清理已结束课堂”。当前接入课堂先点“结束课堂”；输入完整课堂名或“清理已结束课堂”后，才永久删除对应课堂及学生作品。需要保留的课堂可先用教师端导出或按下文备份。删除不会重置后台密码或删除其他进行中的课堂，空出的 SQLite 数据页会供新课堂复用，数据库文件不一定立即缩小。

后端使用 Node.js 原生 HTTP、SQLite 和 SSE，无额外数据库服务。地图与音效在客户端执行。自 v1.3.12 起，教师列表只查询作品摘要，打开详情时才读取所选学生的完整历史；增量查询从数据库筛选，学生保存不再引发全班确认。容器内存会受到历史作品数量、导出量和 Node.js 内存回收影响，镜像体积也不等于运行内存；不能只从截图中的累计 CPU 时间判断负载。

可用 `docker stats --no-stream` 查看实际资源使用，用 `docker compose logs --tail=100` 查看是否有异常。更新镜像后容器会重建；先在真实课堂中观察多客户端连接、后台查看作品时的内存与响应，再按 VPS 情况配置资源，不必为本项目额外安装 Redis 或 MySQL。

```sh
docker compose ps                 # 查看运行与健康状态
docker compose logs --tail=100    # 查看最近日志
docker compose restart           # 重启，保留课堂与后台密码配置
docker compose down              # 停止并删除容器，保留数据卷
docker compose up -d             # 再次启动，恢复原课堂
```

数据位于 Docker 命名卷 **game-supermarket-data**，挂载到容器 `/app/data/`。其中 `supermarket.sqlite` 保存课堂、学生作品及登录状态，`teacher-key.txt` 保存空密码配置时使用的原教师密钥；自定义后台密码由 Compose / `.env` 提供。服务以普通用户 `node`（UID/GID 1000）运行；首次使用新命名卷会自动带上正确目录权限，无须手动 `chmod 777`。

不要执行 `docker compose down -v` 或删除 `game-supermarket-data` 卷，除非确实准备清空课堂和密钥。更新镜像不需要删除卷。

备份时先停服务，确保 SQLite 数据与 WAL 文件一致；打包整个数据目录：

```sh
mkdir -p backups
docker compose stop supermarket
docker compose run --rm --no-deps -T supermarket tar -C /app/data -czf - . > backups/classroom.tar.gz
docker compose start supermarket
```

备份包含教师密钥与学生作品，应妥善保存。恢复到空白安装时，先把备份放在 `backups/classroom.tar.gz`，再执行：

```sh
docker compose down
docker compose run --rm --no-deps -T supermarket tar -C /app/data -xzf - < backups/classroom.tar.gz
docker compose up -d
```

恢复操作会写入备份中的同名文件；已有安装先备份，需完整替换时使用空的新数据卷。若迁移本机 `data/`，先停止本机 Node 服务，把整个 `data/` 目录内容（含 SQLite、WAL 和密钥）按上述方式归档恢复。不要只复制运行中的 `.sqlite` 文件。

如需把数据直接放在 VPS 的 `./data/`，先建立权限正确的目录，再把 Compose 的卷挂载改为 `./data:/app/data`：

```sh
sudo install -d -m 700 -o 1000 -g 1000 data
# 若目录中已有数据，先停服务，再修复所有文件的所有者：
sudo chown -R 1000:1000 data
```

## 域名反向代理（可选）

若已有 Nginx/Caddy，设置 `SUPERMARKET_BIND=127.0.0.1` 和 `SUPERMARKET_PUBLIC_URL=https://你的域名`，把代理指向 `http://127.0.0.1:18790`。下面是 Nginx `location /` 示例，课堂状态通过 SSE 长连接推送，需要关闭缓冲：

```nginx
location / {
    proxy_pass http://127.0.0.1:18790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

应用应部署在域名根路径，代理需自行配置证书。无需向应用传递代理协议头。

## 发布新版本（维护者）

GitHub Actions 配置位于 `.github/workflows/image.yml`。代码推送到仓库后，推送形如 `v1.3.18` 的正式版本标签即可触发：

```sh
git tag v1.3.18
git push origin v1.3.18
```

工作流先在 Node.js 24 上执行 `npm test`，成功后构建 `linux/amd64` 和 `linux/arm64`，使用仓库的 `GITHUB_TOKEN` 向 GHCR 推送镜像。发布名称会自动转成小写，`v1.3.18` 对应：

```text
ghcr.io/alumos/game-supermarket:v1.3.18
ghcr.io/alumos/game-supermarket:1.3.18
ghcr.io/alumos/game-supermarket:latest
```

首次发布后打开 [镜像设置](https://github.com/users/Alumos/packages/container/game-supermarket/settings) → Danger Zone → Change visibility，将镜像设为 **Public**，输入包名确认。这一步只需做一次，仓库公开不代表软件包自动公开。若组织或仓库禁用了 Actions 的包写入权限，需允许工作流使用 `packages: write`。

以后发布新版本前同步更新 `compose.yaml` 的固定 tag 与本文示例，再推送新 tag。已经发布的 tag 应保持不变，修复使用新的版本号。VPS 更新时先备份，然后把 `.env` 中的 `SUPERMARKET_IMAGE` 改为新固定 tag。

从 v1.3.0～v1.3.13 更新时只需将镜像 tag 改为 `v1.3.18`，保留原有密码和数据卷。若从 v1.2.0 或更早版本更新，还需在现有 Compose `environment` 中加入 `SUPERMARKET_TEACHER_PASSWORD: ${SUPERMARKET_TEACHER_PASSWORD:-}`（或换用本版本 Compose 文件并保留自己的端口等配置），在 `.env` 中设好密码，再执行：

```sh
docker compose pull
docker compose up -d
docker compose ps
```

仅修改 `.env` 而未在旧 Compose 中添加该环境变量，不会把密码传入容器。更新保留原数据卷，无需清空数据。需要回退时改回旧 tag；数据卷继续保留，跨数据格式版本回退时应恢复相应备份。

本地已有 Docker 时可执行 `docker build -t game-supermarket:local .` 构建，或执行 `SUPERMARKET_IMAGE=game-supermarket:local docker compose up -d` 使用本地镜像。Docker 构建上下文只包含运行必需源码，不包含本机 `data/`、教师密钥、`.env` 或测试产物。
