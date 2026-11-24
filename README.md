# KeepEssence core

KeepEssence 的核心（服务器）。部署在 Cloudflare 上，你可以用自己的账号部署一套。
The KeepEssence server: self-hostable on your own Cloudflare account.

状态：还没开工。架构和第一期规格已定，见下面的链接。

## 它做什么

| 部分 | 用什么 | 职责 |
|---|---|---|
| HTTP API | Workers | 客户端的接口：攒存、读、管理 |
| MCP 端点 | Workers | 助手取活、交回；REST 与 MCP 工具一一对应 |
| 授权 | Workers | 客户端的短码授权、助手的 OAuth |
| 分派助手（初筛） | Workers | 决定条目交给哪个助手、保留多久 |
| 定时任务 | Cron Triggers | 过期归档、认领释放、每日摘要到期、通知 |
| 数据 | D1 | 条目、解读、每日摘要、笔记、设备、授权、认领 |
| 附件 | R2 | 图片与文件，预签名上传下载 |

## 先读

- [架构](https://github.com/KeepEssenceApp/spec/blob/main/product/architecture.md)：组件、数据模型、接口清单、认领、过期。
- [第一期技术规格](https://github.com/KeepEssenceApp/spec/blob/main/product/techspec.md)：开工范围。
- [规则](https://github.com/KeepEssenceApp/spec/blob/main/product/rules.md)：必须遵守的产品规则。
- 接口只在 [spec/contract](https://github.com/KeepEssenceApp/spec/tree/main/contract) 定，这里照着实现，不在这里改接口。

## 部署

部署步骤随第一批代码一起写。需要的东西：一个 Cloudflare 账号（Workers、D1、R2）和一个模型的密钥。密钥放 Workers Secrets，不进仓库。

## 参与

见 [贡献指南](https://github.com/KeepEssenceApp/.github/blob/main/CONTRIBUTING.md)。安全问题见 [安全说明](https://github.com/KeepEssenceApp/.github/blob/main/SECURITY.md)。许可证：[AGPL-3.0](LICENSE)。
