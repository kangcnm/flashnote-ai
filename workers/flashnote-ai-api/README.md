# 闪记 AI 调用次数限制

本目录是待部署版本，当前正常运行的网站尚未切换到此版本。

## 用户能看到的变化

- 每个网络 IP 在任意连续 60 秒内最多受理 2 次 AI 制卡请求。
- 每个网络 IP 每天最多受理 20 次，北京时间零点恢复。
- 超限返回 429，网页显示等待倒计时。刷新网页无法重置后端计数。
- 在 Turnstile 验证成功后占用一次额度，再调用 DeepSeek。已受理但生成失败的请求仍计数，防止无限重试消耗费用。
- 同一个校园网、家庭或移动网络出口可能共用一个 IP 和额度。IP 限制不是用户账户配额，也不是全站费用硬上限。

## 上线方式

本次增加了持久存储，不能只在编辑器粘贴一份 worker.js。需要把 worker.mjs、quota.mjs 和 wrangler.jsonc 一起部署。

1. 核实当前线上 Worker 的业务代码与本目录基线一致，且没有后续未保存修改。
2. 确认部署账户、计费计划及现有 Worker 配置。本配置目标是现有 flashnote-ai-api；新增 SQLite Durable Object 类 GenerationQuota 和 GENERATION_QUOTA 绑定。不要升级套餐或创建额外付费服务。
3. 用户确认上线后，通过本机 Wrangler 登录 Cloudflare，由用户亲自完成登录授权。
4. 在此目录使用 Wrangler 执行 dry-run，再正式部署；保持现有 TURNSTILE_SECRET_KEY 和 DEEPSEEK_API_KEY 两项 Secret，不读取或重填它们。部署前核对现有绑定、兼容日期与可观测性设置，并保留已有配置。
5. 后端部署成功后再合并前端 index.html。先用无 token 的请求确认仍被拒绝，再由用户完成一次真实 AI 制卡验证。

Durable Objects 的 SQLite 类型支持 Free 计划；Paid 计划超出内含额度时可能计费，实际以账户计划为准。官方说明：https://developers.cloudflare.com/durable-objects/platform/pricing/

## 数据与失败处理

每个 IP 使用现有 Turnstile Secret 做有独立前缀的 HMAC，只有不可直接还原的标识用于对象定位，不持久保存原始 IP、笔记或验证 token。存储只保留当天计数及最近两次受理时间；过期对象由 alarm 清理。轮换 Turnstile Secret 会改变标识，从而重置对应额度。

缺少绑定、缺少可信的 CF-Connecting-IP、存储失败、验证失败，均不会调用 DeepSeek。浏览器提供的 X-Forwarded-For 或自填 IP 不用于限额。健康检查不计数。

## 已完成检查

- Cloudflare 本地运行时模拟：10 个并发请求仅 2 次 AI 调用、不同 IP 隔离、重启保留计数、验证失败不占额度、CORS 和 Retry-After。
- 确定性时间测试：60 秒滑动窗口边界、每日第 21 次拒绝、北京时间零点重置。
- 前端模拟：429 后禁用与倒计时、刷新验证不覆盖错误提示、等待结束仍需有效验证 token。
- Wrangler dry-run 打包通过，没有部署或进行真实付费 AI 调用。

## 回退

保留原来的 Worker 版本和已有密钥。若需回退，选择旧版本部署；不要删除 Durable Object 类或命名空间。前端对旧后端仍兼容，但配额将不再生效。不要修改 migration 标签来尝试重建已经存在的类。