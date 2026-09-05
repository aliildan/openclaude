# openclaude Agnes / OpenAI-compatible 协议适配补丁

这是 `Keep-maker/openclaude` 内置的第三种 provider（在原 openclaude 的 Anthropic / Ollama 之外新增 `openai-compatible`）：

```text
Claude Code (Anthropic /v1/messages)
        ↓
openclaude
        ↓  Anthropic → OpenAI Chat Completions
Agnes /v1/chat/completions
        ↓  OpenAI SSE → 严格 Anthropic SSE 状态机
stream-fixup.js（最后安全网）
        ↓
Claude Code
```

目标是解决 OpenAI 兼容网关转换 tool calls 时容易出现的：

```text
API Error: Content block not found
```

## 已实现

- Anthropic `system/messages` → OpenAI Chat Completions `messages`
- Anthropic `tool_use` → OpenAI `assistant.tool_calls`
- Anthropic `tool_result` → OpenAI `role: tool`
- Anthropic tool schema → OpenAI function tools
- `tool_choice` 与 `disable_parallel_tool_use` 映射
- base64 / URL 图片 → OpenAI `image_url`
- OpenAI 普通 JSON response → Anthropic Message
- OpenAI SSE text delta → Anthropic text content block
- **并行 OpenAI tool_calls 缓冲并串行输出为 Anthropic tool_use blocks**
- 工具 arguments 为增量分片，按 OpenAI 规范逐片原样拼接（不会因重复 token 丢字符）
- 每个 block 严格 `start → delta → stop`
- 非法 tool id 清洗
- 非法 tool JSON 包装为 `_raw_arguments`，防止 Claude parser 崩溃
- 不把第三方 reasoning 伪装成 Anthropic signed thinking block
- `/v1/messages/count_tokens` 本地估算，避免 Agnes 404
- OpenAI error → Anthropic error shape
- 上游响应头阶段超时保护（默认 60s，可配 `timeoutMs`），避免网关挂起时永久卡死
- `/v1/models` 可发现配置中的 Agnes 模型
- 转换后的流再次经过 openclaude 原有 `stream-fixup.js`

## 1. 获取源码

在你自己的机器上：

```powershell
git clone https://github.com/Keep-maker/openclaude.git
cd openclaude
```

Node.js 要求与 openclaude 一致，建议 Node 20+。

## 2. 安装依赖

本仓库已经内置下文列出的全部 Agnes 适配文件，**无需再运行任何 apply/overlay 补丁脚本**，直接安装依赖即可：

```powershell
npm install
```

适配已包含：`src/router/openai-compat.js`、`src/router/provider/openai-compatible.js`、router 注册、`/v1/models` 配置型模型发现，以及对应的 regression test。

## 3. 配置 Agnes

编辑：

```text
%USERPROFILE%\.openclaude\config.json
```

把 `config.agnes.example.json` 中的 `agnes` provider 合并进去。中国站：

```json
"agnes": {
  "type": "openai-compatible",
  "baseUrl": "https://api.agnes-ai.cn/v1",
  "apiKey": "$AGNES_API_KEY",
  "chatPath": "chat/completions",
  "models": ["agnes-2.5-flash", "agnes-2.0-flash"]
}
```

国际主站可改为：

```text
https://apihub.agnes-ai.com/v1
```

不要把 API Key 明文写进 config.json。`apiKey` / `headers` 支持环境变量插值，`$VAR` 与 `${VAR}` 两种写法都可以，变量名允许大小写混合；未设置的变量会被替换为空字符串。

## 4. 设置 Key

PowerShell 当前窗口：

```powershell
$env:AGNES_API_KEY="你的 key"
```

持久化到当前用户环境：

```powershell
[Environment]::SetEnvironmentVariable("AGNES_API_KEY", "你的 key", "User")
```

设置后重新开一个终端。

## 5. 测试

在源码目录：

```powershell
npm test
```

测试覆盖：普通工具调用、并行工具调用（含乱序分片）、重复 token 增量不丢字符、SSE 任意切片、非法 arguments、图片、token estimate、环境变量插值、上游超时 504、正常 SSE 端到端转换。

## 6. 本地安装

在源码目录：

```powershell
npm install -g .
```

然后：

```powershell
oc start
```

进入 Claude Code 后 `/model` 应出现 `Agnes 2.5 Flash` / `Agnes 2.0 Flash`（启用 discovery 时）。也可以直接输入：

```text
/model agnes:agnes-2.5-flash
```

## 7. 建议先做稳定性压测

让 Claude Code 连续执行 20~50 轮串行工具操作，例如 Read/Bash/Edit。然后再测试两个并行 tool calls。

如果还出现 `Content block not found`：

```powershell
$env:OPENCLAUDE_DEBUG_STREAM="1"
oc start
```

查看：

```text
%USERPROFILE%\.openclaude\stream-debug.log
```

本适配器故意把 OpenAI 并行 tool calls **全部缓存到 finish 后再以稳定的 Anthropic block 顺序输出**。这会牺牲一点工具调用流式延迟，但最大限度降低 content block index 生命周期错乱。

## 安全注意（重要）

- 路由默认只监听 `127.0.0.1`（本机回环），且**不带任何访问鉴权**。请勿把监听地址改成 `0.0.0.0` 后直接暴露到公网，否则任何能访问该端口的人都能无偿消耗你 config 中上游账号的额度。需要远程使用时，请走 SSH 端口转发，或自行在前面加一层带 Authorization 校验的反代。
- 单个 provider 只配置**一个** `apiKey`，本项目不提供多 Key 轮询 / 账号池 / 故障切换；429 会被转换为 Anthropic `rate_limit_error` 交给 Claude Code 自身重试。

## 配置扩展

若某个 OpenAI-compatible 网关需要额外参数：

```json
"agnes": {
  "type": "openai-compatible",
  "baseUrl": "https://api.agnes-ai.cn/v1",
  "apiKey": "${AGNES_API_KEY}",
  "models": ["agnes-2.5-flash"],
  "timeoutMs": 60000,
  "requestDefaults": {
    "temperature": 0
  },
  "headers": {
    "X-Custom-Header": "$MY_HEADER_VALUE"
  }
}
```

- `timeoutMs`：等待上游**响应头**的毫秒数，默认 60000；响应头到达后即停止计时，因此不会误杀正常的长流式输出。上游在该时间内无响应会返回 504，让 Claude Code 走重试而不是无限等待。
- `model` 和 `messages` 始终由 router 控制，不会被 `requestDefaults` 覆盖。

## 当前有意不做的功能

- 不将 Agnes reasoning/thinking 输出成 Anthropic `thinking` block。第三方 reasoning 没有 Anthropic 签名，伪装后会污染会话并导致后续 replay 失败。
- `count_tokens` 是本地估算，不是精确 tokenizer。它的目的主要是避免 Claude Code 请求 `/v1/messages/count_tokens` 时直接 404。
- tool call 在 OpenAI SSE 中先缓冲再输出，因此工具参数不会逐 token 显示；这是为了协议稳定性。
