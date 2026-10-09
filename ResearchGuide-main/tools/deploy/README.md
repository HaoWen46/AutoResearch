# 启研云端发布（阿里云函数计算）

按量 ECS 在帐号后付费门槛不够时开不了。接口走杭州函数计算 HTTP 函数。

`*.fcapp.run` 会强制 `Content-Disposition: attachment`，浏览器会下载 htm。所以页面发布在 GitHub Pages：

https://chengcanwu.github.io/AutoResearch/

## 本机准备

1. 在 `product/.env` 写 `AccessKey_ID`、`AccessKey_Secret`，以及 `DEEPSEEK_API_KEY` 或 `LLM_API_KEY`。
2. 不要提交 `.env`、`.deploy.env`、`*.zip`、`vendor_wheels/`。

## 发布

在 `ResearchGuide-main/tools/deploy`（发布脚本要阿里云 SDK，用 uv 临时带上，不装进项目）：

```
uv run --no-project --with pip python download_wheels.py
uv run --no-project --with alibabacloud_fc20230330 --with alibabacloud_tea_openapi --with alibabacloud_tea_util python deploy_fc.py
```

更新函数时保留函数上已有的环境变量（控制台里配的 `WECHAT_*`、改过的 `QIYAN_DB`）；本机 `.env` 写了 `QIYAN_DB` 就用它。

函数名 `qiyan`，地域 `cn-hangzhou`。公网地址写在已忽略的 `.deploy.env` 的 `PUBLIC_URL`。

## 验收

- `GET $PUBLIC_URL/` 返回启研首页
- `GET $PUBLIC_URL/api/health` 返回 `ok: true`，且 `llm.enabled` 为 true

## 限制

SQLite 在 `/tmp/qiyan.db`，实例回收后用户数据不会保留。要长期库需要 NAS/OSS 或一台常驻 ECS。
