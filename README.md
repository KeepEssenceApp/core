# KeepEssence core

KeepEssence 的核心（服务器）。部署在 Cloudflare 上，你可以用自己的账号部署一套。
The KeepEssence server: self-hostable on your own Cloudflare account.

状态：1.x，内测中，部署在 keepessence.app。本地自动测试全过（见下面「测试」）；线上验过登录、存入、内置助手的初筛和解读、每日摘要、短码接入、助手经 MCP 接入。验收标准和逐条结果见 [spec 的验收标准](https://github.com/KeepEssenceApp/spec/blob/main/product/acceptance.md)。

## 它做什么

| 部分 | 用什么 | 职责 |
|---|---|---|
| HTTP API | Workers | 客户端的接口：存入、读、管理 |
| MCP 端点 | Workers | 助手取活、交回；REST 与 MCP 工具一一对应 |
| 授权 | Workers | 邮箱验证码登录、客户端的短码接入、助手的 OAuth |
| 内置助手 | Workers + Cron | 分派助手做初筛；工作助手出四项解读和每日摘要。它们走和外部助手同一套接口 |
| 定时任务 | Cron Triggers | 每分钟：补抓网页、初筛、解读、每日摘要、通知。每小时：过期归档、清理 |
| 数据 | D1 | 条目、解读、每日摘要、笔记、设备、授权、认领、用量 |
| 附件 | R2 | 图片与文件，地址由核心自己签发，带期限 |

## 先读

- [架构](https://github.com/KeepEssenceApp/spec/blob/main/product/architecture.md)：组件、数据模型、接口清单、认领、过期。
- [第一期技术规格](https://github.com/KeepEssenceApp/spec/blob/main/product/techspec.md)：开工范围。
- [验收标准](https://github.com/KeepEssenceApp/spec/blob/main/product/acceptance.md)：第 3 节的 K1–K22 是核心要过的条目，测试按条目命名。
- [规则](https://github.com/KeepEssenceApp/spec/blob/main/product/rules.md)：必须遵守的产品规则。
- 接口只在 [spec/contract](https://github.com/KeepEssenceApp/spec/tree/main/contract) 定。这里的 `contract/openapi.yaml` 是它的副本，照着实现，不在这里改接口。

## 代码怎么摆

| 位置 | 内容 |
|---|---|
| `contract/openapi.yaml` | 契约的副本 |
| `scripts/gen-contract.mjs` | 从契约生成 `src/generated/contract.ts`：路由、参数和请求的校验规则、数字上限、共用规则、MCP 工具清单 |
| `src/app.ts` | 路由。每条路由都来自生成的契约，一个 `operationId` 对一个处理函数 |
| `src/handlers/` | 各接口的处理函数；`admin.ts` 是管理接口 |
| `src/services/` | 账户、条目、抓网页、附件、认领与交回（`work.ts`）、每日摘要、通知、Web Push、模型 |
| `src/builtin.ts` | 两只内置助手。只调用 `services/work.ts` 里外部助手也在用的函数 |
| `src/mcp.ts` | MCP 端点 |
| `src/cron.ts` | 定时任务 |
| `src/clock.ts` | 唯一的时间来源，测试靠拨它来验过期、21:00、合并通知 |
| `migrations/` | D1 的表 |
| `test/` | 自动测试，名字以验收条目开头，例如 `K9 claims: two assistants cannot hold the same item` |
| `docs/admin-api.md` | 管理接口的定义（不在契约里） |
| `docs/pitfalls.md` | 踩过的坑 |

契约改了之后：把新的 `openapi.yaml` 拷到 `contract/`，跑 `npm run gen`，再跑测试。生成的文件要提交；有一条测试专门检查它是不是最新的。

## 本地开发

需要 Node 22。

```sh
npm install
cp .dev.vars.example .dev.vars    # 本地用的密钥，不进仓库；按需改里面的值
npm run dev                       # 建本地的表，然后在 http://localhost:8801 启动
```

端口是 **8801**。

没有配发信服务时，登录验证码用管理接口取。管理接口不在契约里，用 `ADMIN_SECRET` 保护；没配 `ADMIN_SECRET` 时这些地址一律 404。全部管理接口见 [docs/admin-api.md](docs/admin-api.md)。

```sh
B=http://localhost:8801
A="Authorization: Bearer change-me-local-admin"     # .dev.vars 里的 ADMIN_SECRET

# 1 把邮箱加进邀请名单
curl -X POST $B/admin/invites -H "$A" -H 'content-type: application/json' -d '{"email":"me@example.com"}'

# 2 取一个登录验证码（6 位，10 分钟有效，只能用一次）
curl -X POST $B/admin/login-codes -H "$A" -H 'content-type: application/json' -d '{"email":"me@example.com"}'

# 3 用验证码登录，得到这台设备的凭据（只返回这一次）
curl -X POST $B/v1/auth/sessions -H 'content-type: application/json' \
  -d '{"email":"me@example.com","code":"123456","device_name":"终端","client":"web","timezone":"Asia/Shanghai"}'

# 4 存入一条
curl -X POST $B/v1/items -H "Authorization: Bearer <上一步的 credential>" \
  -H 'Idempotency-Key: my-first-save' -H 'content-type: application/json' \
  -d '{"kind":"link","url":"https://example.com/"}'
```

`POST /admin/invites` 也可以一次加一批：`{"emails":["a@example.com","b@example.com"]}`。`GET /admin/invites` 列出名单，`DELETE /admin/invites`（请求体同第 1 步）移出名单。

### 管理接口

给运营者的后台用的接口，都在 `/admin/` 下，定义在 [docs/admin-api.md](docs/admin-api.md)，代码在 `src/handlers/admin.ts`。后台是做什么的见 [spec 的管理后台](https://github.com/KeepEssenceApp/spec/blob/main/product/admin.md)。

| 接口 | 做什么 |
|---|---|
| `GET /admin/overview` | 概览：用户、邀请、条目、解读、每日摘要、笔记的数量，等着初筛和解读的条数，内置助手的用量，定时任务上次跑完的时间，模型、发信、通知有没有配好 |
| `GET` `POST` `DELETE /admin/invites`、`POST /admin/login-codes` | 邀请名单和登录验证码 |
| `GET /admin/users`、`GET /admin/users/{id}` | 账户列表（可按邮箱查找、按状态筛选）和单个账户的设备、助手、近 30 天数量、各助手用量 |
| `POST /admin/users/{id}/suspend`、`…/restore` | 停用和恢复 |
| `POST /admin/users/{id}/sign-out`、`DELETE /admin/users/{id}/devices/{device_id}` | 让全部设备退出、撤销单个设备 |
| `DELETE /admin/users/{id}` | 删除账户和它的全部数据，请求体要带 `{"confirm_email":"对方的邮箱"}` |
| `GET /admin/usage` | 内置助手每天的调用次数和 token，用得最多的账户 |
| `GET` `POST /admin/audit` | 后台动作的记录 |

几条要记住的：

- **不看内容。** 这些接口只返回数量、时间、设备和助手的名称，不返回任何条目、解读、每日摘要、笔记的标题或正文。有一条测试专门往内容里放标记，再查所有管理接口的返回里有没有它。
- **停用**之后，这个账户的设备和助手的凭据一律 401，不能登录也取不到验证码，内置助手和定时任务跳过它，它的助手认领着的活当场放回。数据原样留着，恢复之后不用重新登录。
- **删除**不能恢复：数据库里每张带 `user_id` 的表（从表结构里现查，不靠手写的清单）、R2 里 `u/{user_id}/` 下的文件、邀请，一并删掉。
- 每个动作都记在 `admin_audit` 表里，记录里不放验证码和凭据。
- 概览里的版本号缺省是 `package.json` 里的版本；想让它显示实际发布的版本，在 `wrangler.toml` 的 `[vars]` 里加 `CORE_VERSION`。

本地不会自动跑定时任务。要手动触发一次：

```sh
curl "http://localhost:8801/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"     # 每分钟的那一组
curl "http://localhost:8801/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"     # 每小时的那一组
```

没配 `LLM_API_KEY` 时内置助手什么都不做，这不算出错：条目照样能存入，等 10 分钟后核心自己补上初筛的缺省值，解读要等有助手来做。

## 测试

```sh
npm test            # 自动测试：在本地的 Workers 运行时里跑真实的 D1 和 R2
npm run typecheck   # 类型检查
```

测试不联网，也不会调用真的模型：模型、网页、推送服务、发信服务都换成了测试里的假的。测试不读 `.dev.vars`。

## 部署

需要一个 Cloudflare 账号（Workers、D1、R2）。模型的密钥可选；没有它就没有内置助手的解读和每日摘要。

1. 登录：`npx wrangler login`。
2. 建数据库和存储桶：

   ```sh
   npx wrangler d1 create keepessence-core
   npx wrangler r2 bucket create keepessence-core-files
   ```

3. 改 `wrangler.toml`：
   - 把 `database_id` 换成上一步打印出来的 id；存储桶换了名字的话把 `bucket_name` 也改掉。两处都标了 `PLACEHOLDER`。
   - `APP_ORIGIN` 改成网页应用的地址，例如 `https://你的域名`。
   - 用自己的域名：去掉 `routes` 那一行的注释，填上域名（域名要已经在这个 Cloudflare 账号里）。
   - 网页应用是另一个 Worker 时：去掉 `[[services]]` 那一段的注释，填它的名字。不是接口的请求会转给它；不配就回 404。
   - 模型不是直连官方接口时，把 `LLM_BASE_URL` 改成你的网关地址（要兼容 Anthropic Messages API）。
   - 内置助手的模型和思考强度按工作分开配（`[vars]`）：初筛用 `LLM_MODEL_TRIAGE` / `LLM_EFFORT_TRIAGE`（缺省 `claude-haiku-5-5` / `low`），解读和每日摘要用 `LLM_MODEL_WORKER` / `LLM_EFFORT_WORKER`（缺省 `claude-sonnet-5-5` / `medium`）。网关上没有这些模型就改成它有的；只想用一个模型，就只写旧的 `LLM_MODEL`，没有单独配的工作都用它。强度只认 `low`、`medium`、`high`，别的值当没配。网关不认强度这个字段（回 400）时，核心去掉它重发一次，不会再多发。换模型名之前，先用编造的内容对网关试一次，见 `docs/pitfalls.md`。
4. 设密钥。密钥只放在 Cloudflare 上，不写进任何文件：

   ```sh
   npx wrangler secret put ADMIN_SECRET        # 管理接口的口令，自己编一个长的
   npx wrangler secret put SIGNING_KEY         # 给上传、下载地址签名用，自己编一个长的随机串
   npx wrangler secret put LLM_API_KEY         # 模型的密钥（可选）
   npm run gen:vapid                           # 生成一对通知用的密钥，把打印的两个值分别存进去：
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put RESEND_API_KEY      # 可选：配了它和 EMAIL_FROM，验证码就发邮件
   npx wrangler secret put EMAIL_FROM          # 可选：例如 "Sign in <login@你的域名>"
   ```

5. 建表并部署：`npm run deploy`。它先跑迁移，再发布。
6. 邀请自己：照「本地开发」里那几条 `curl`，把地址换成线上的，`ADMIN_SECRET` 换成第 4 步设的。

### 可以调的数

都在 `wrangler.toml` 的 `[vars]` 里，改完重新部署。

| 名字 | 缺省 | 是什么 |
|---|---|---|
| `TRIAGE_BATCH`、`TRIAGE_USERS_PER_RUN` | 5、2 | 分派助手每分钟每个用户初筛几条、一次照顾几个用户 |
| `ANALYSIS_BATCH`、`ANALYSIS_USERS_PER_RUN` | 3、1 | 工作助手每分钟每个用户解读几条、一次照顾几个用户 |
| `ANALYSIS_BUDGET_MS` | 40000 | 解读一条用到的所有模型请求合在一起最多多久（第一次最多 25 秒，再问一次拿剩下的；请求最多 3 个） |
| `ANALYSIS_PER_USER_PER_DAY`、`DIGEST_PER_USER_PER_DAY` | 200、1 | 工作助手每个用户每天的上限 |
| `BODY_MAX_CHARS` | 100000 | 抓来的网页正文最多存多少字 |
| `SAVE_RATE_PER_MINUTE` | 120 | 每台设备每分钟最多存入几次 |
| `PUBLIC_RATE_PER_10_MIN` | 30 | 不用登录的接口，每个来源地址每 10 分钟最多几次 |
| `DELETE_COPIES_ON_USER_DELETE` | true | 用户删除条目时是否连数据一起删。`false` 则只是藏起来，之后按下一项清理 |
| `ARCHIVE_RETENTION_DAYS` | 空 | 空：到期的条目一直留着（用户看不见）。N：到期满 N 天后清掉 |

寿命、认领期限、大小上限这些数字在契约的 `x-limits` 里，不在这里改。

Workers 免费档每次调用只有很少的 CPU 时间和 50 次数据库查询。上表的缺省值是按这个限制估的，没有在线上的免费档实测过；用户多了以后升到付费档，再把每分钟的条数调大。

## 参与

见 [贡献指南](https://github.com/KeepEssenceApp/.github/blob/main/CONTRIBUTING.md)。安全问题见 [安全说明](https://github.com/KeepEssenceApp/.github/blob/main/SECURITY.md)。许可证：[AGPL-3.0](LICENSE)。
