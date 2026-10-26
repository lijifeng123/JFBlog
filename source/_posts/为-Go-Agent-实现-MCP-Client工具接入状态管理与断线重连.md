---
title: 为 Go Agent 实现 MCP Client：工具接入、状态管理与断线重连
date: 2026-10-26 12:04:06
tags: [MCP, Go, Agent, AI]
---

# 为 Go Agent 实现 MCP Client：工具接入、状态管理与断线重连

> 参考 Claude Code 的 MCP 实现，用 Go 为自研 Agent 框架 opengiraffe（agentic_os）补上 MCP 工具调用能力，并进一步实现连接状态追踪、指数退避重连与 TUI 实时展示。

## 前言

[MCP（Model Context Protocol）](https://modelcontextprotocol.io) 已经成为 Agent 工具生态的事实标准：外部能力以 MCP Server 的形式提供工具，Agent 作为 Host 通过内置的 Client 去连接并调用。

本文记录我在 opengiraffe（一个 Go 实现的 Agent 框架）中从零接入 MCP Client 的完整过程，分两个阶段：

1. **基础能力**：连接 MCP Server、发现工具、注册为 Agent 可调用的工具；
2. **可靠性增强**：连接状态追踪、断线自动重连、状态变更实时推送到 TUI。

实现思路大量参考了 Claude Code 的 MCP 模块（`src/services/mcp/`）。

---

## 一、先分清 MCP 的三方角色

很多人以为 MCP 只有「Server + Client」两方，按协议定义其实是三方：

| 角色 | 是什么 | 职责 |
| --- | --- | --- |
| **Host** | Trae、Claude Code、Cursor 这类 AI 应用 | 运行模型、管理会话、决定何时调工具 |
| **Client** | 通常内嵌在 Host 中，每个 Server 对应一个实例 | 与某个 Server 建立 **1:1** 连接、能力协商、消息路由 |
| **Server** | 独立进程或远程服务 | 暴露 Tools / Resources / Prompts |

几个关键结论：

- **Client 一般不用自己写**。接入 MCP 时通常只需实现/选择一个 Server，再在 Host 中配置，Client 那半由 Host 自带。
- **通信成立必须两端都有**，但不必自己开发两端。
- **Client 与 Server 是 1:1**，一个 Host 挂多个 MCP 就有多个 Client 实例，某个 Server 挂掉不影响其它。
- **传输层**分两类：`stdio`（本地子进程，Host 通过 `command` + `args` 启动）与 `SSE / Streamable HTTP`（远程 Server 走网络）。

opengiraffe 要做的，正是补齐 **Host 内嵌的 Client 这一侧**。

---

## 二、Claude Code 的 MCP 实现分析

### 2.1 核心数据流

```
MCP Config → Config Parser → Client Manager → Tool Discovery → Tool Registration → Tool Execution
```

### 2.2 关键文件

| 文件 | 作用 |
| --- | --- |
| `mcp/config.ts` | 加载多级配置（local / user / project / enterprise） |
| `mcp/client.ts` | Client 生命周期、工具发现、工具调用（核心，3000+ 行） |
| `mcp/types.ts` | Zod schema + 连接状态类型 |
| `mcp/auth.ts` | OAuth / XAA 认证 |
| `tools/MCPTool/MCPTool.ts` | Tool 适配器（`isMcp=true`） |
| `mcp/mcpStringUtils.ts` | 名称格式化工具 |

### 2.3 两个值得抄的设计

**① 工具命名统一加前缀**，避免与内置工具冲突：

```
mcp__<servername>__<toolname>
```

**② 传输类型抽象**：Stdio / SSE / HTTP / WebSocket / SDK in-process 统一成 `Transport` 接口，上层逻辑不感知差异。本次实现优先落地 `stdio + SSE`。

---

## 三、opengiraffe 的扩展点

opengiraffe 已经有一套 Plugin 体系，MCP 只需作为一个 Plugin 挂进去即可：

- **Plugin 接口**（`pkg/types/plugin.go`）：`Register(api PluginAPI)`，用于注册 Tool / ToolFactory / Hook。
- **Tool 接口**（`pkg/types/interfaces.go`）：`ID / Name / Description / Parameters / Execute`。
- **ToolFactory 接口**：`Names()` / `Create(ToolCreationContext)`，按 session 创建工具。
- **InstanceConfig**（`pkg/types/interfaces.go`）：YAML 配置根 struct，需新增 `MCP` 字段。
- **serve.go**（`internal/cli/serve.go`）：插件注册入口。

现有内置工具的 Plugin 模式长这样：

```go
type BuiltinToolsPlugin struct { cfg types.ToolsConfig }

func (p *BuiltinToolsPlugin) Register(api types.PluginAPI) error {
    api.RegisterTool(&ReadTool{})
    // ...
}
```

照这个模式，MCP 的接入点就很清晰了。

---

## 四、实现方案：把 MCP Server 变成一堆 Tool

### 4.1 选型决策

- **SDK**：`github.com/modelcontextprotocol/go-sdk`（官方）
- **连接策略**：全局共享连接——服务启动时连接所有 MCP Server，所有 session 共用
- **注册方式**：静态注册（`RegisterTool`），不用 ToolFactory，简化生命周期管理

### 4.2 连接生命周期

```
serve.go → MCPPlugin.Register()
  → 遍历 cfg.MCP.Servers
  → MCPClientManager.Connect(name, serverCfg)
  → client.Initialize() + client.ListTools()
  → api.RegisterTool(MCPTool{...})   // 每个发现的工具注册一个
```

### 4.3 配置类型：扩一个 MCPConfig

在 `InstanceConfig` 末尾加一个字段，并定义 Server 配置（同时兼容 stdio / sse）：

```go
type MCPConfig struct {
    Servers map[string]MCPServerConfig `yaml:"servers" json:"servers"`
}

type MCPServerConfig struct {
    Type    string            `yaml:"type"`               // "stdio" | "sse"
    Command string            `yaml:"command"`            // stdio only
    Args    []string          `yaml:"args"`               // stdio only
    Env     map[string]string `yaml:"env"`                // stdio only
    URL     string            `yaml:"url"`                // sse only
    Headers map[string]string `yaml:"headers"`            // sse only
}
```

对应 YAML 大致长这样：

```yaml
mcp:
  servers:
    filesystem:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    remote-server:
      type: sse
      url: "https://example.com/mcp/sse"
      headers:
        Authorization: "Bearer ${MCP_TOKEN}"
```

### 4.4 Client Manager：连接、发现、调用

`MCPClientManager` 负责管理全局连接，核心是「按 name 维护 entry」：

```go
type entry struct {
    session *mcp.ClientSession
    tools   []*mcp.Tool
    cfg     types.MCPServerConfig
}

type MCPClientManager struct {
    mu      sync.RWMutex
    entries map[string]*entry
}

// 连接：按 type 建 transport → Initialize → ListTools
func (m *MCPClientManager) Connect(ctx context.Context, name string, cfg types.MCPServerConfig) error
// 工具发现：tools/list RPC
func (m *MCPClientManager) ListTools(name string) ([]*mcp.Tool, error)
// 工具调用：tools/call RPC
func (m *MCPClientManager) CallTool(ctx context.Context, name, toolName string, args map[string]any) (types.ToolResult, error)
func (m *MCPClientManager) Close(ctx context.Context) error
```

stdio 与 sse 的传输构建：

```go
var transport mcp.Transport
switch cfg.Type {
case "stdio":
    cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
    if len(cfg.Env) > 0 {
        env := cmd.Environ()
        for k, v := range cfg.Env {
            env = append(env, k+"="+v)
        }
        cmd.Env = env
    }
    transport = &mcp.CommandTransport{Command: cmd}
case "sse":
    t := &mcp.SSEClientTransport{Endpoint: cfg.URL}
    if len(cfg.Headers) > 0 {
        t.HTTPClient = &http.Client{
            Transport: &headerTransport{base: http.DefaultTransport, headers: cfg.Headers},
        }
    }
    transport = t
}
```

### 4.5 Tool 适配器：把 MCP Tool 包装成本地 Tool

`MCPTool` 实现 `types.Tool`，把 MCP 的描述与 JSON Schema 直接透传给 Agent：

```go
func (t *MCPTool) ID() string   { return "mcp__" + t.serverName + "__" + t.toolDef.Name }
func (t *MCPTool) Name() string { return t.ID() }

func (t *MCPTool) Description() string { return t.toolDef.Description }
func (t *MCPTool) Parameters() any    { return t.toolDef.InputSchema }

func (t *MCPTool) Execute(ctx context.Context, callID string, args map[string]any, onUpdate types.UpdateFn) (types.ToolResult, error) {
    return t.manager.CallTool(ctx, t.serverName, t.toolDef.Name, args)
}
```

结果转换规则：

- `content[].type == "text"` → 写入 `ToolResult.Content`；
- `isError == true` → 在 Content 中标注错误，**不返回 Go error**，交给模型自行处理。

### 4.6 Plugin 入口：连接失败不阻断启动

```go
func (p *MCPPlugin) Register(api types.PluginAPI) error {
    ctx := context.Background()
    for name, serverCfg := range p.cfg.Servers {
        if err := p.manager.Connect(ctx, name, serverCfg); err != nil {
            log.Warnf("mcp: skipping server %q: %v", name, err) // 失败仅告警
            continue
        }
        tools, err := p.manager.ListTools(name)
        if err != nil {
            log.Warnf("mcp: cannot list tools for server %q: %v", name, err)
            continue
        }
        for _, t := range tools {
            api.RegisterTool(&MCPTool{serverName: name, toolDef: t, manager: p.manager})
        }
        log.Infof("mcp: server %q connected, %d tool(s) registered", name, len(tools))
    }
    return nil
}
```

最后在 `serve.go` 里按配置注册插件即可：

```go
if len(cfg.MCP.Servers) > 0 {
    pluginMgr.Add(mcp.NewMCPPlugin(cfg.MCP))
}
```

到这一步，Agent 就已经能调用外部 MCP 工具了。

---

## 五、连接状态与断线重连

基础版有个明显短板：连接状态只在 `entries` map 里隐式记录（有 entry = 已连接），**没有状态机、感知不到断线、断了只能重启**。参考 Claude Code 补上这一层。

### 5.1 四态状态机

```
connecting    首次连接中（启动或重连中）
connected     连接正常，工具已注册
reconnecting  连接断开，正在退避等待重连（含重试次数）
failed        已达最大重试次数，放弃重连
```

状态转换：

```
[启动]        → connecting
connecting    → connected       (Connect 成功)
connecting    → reconnecting    (Connect 失败，attempt < max)
connecting    → failed         (Connect 失败，attempt >= max)
connected     → reconnecting    (CallTool 返回 transport 错误)
reconnecting  → connecting      (backoff 结束，下次尝试)
reconnecting  → failed         (attempt >= max)
```

### 5.2 扩展 entry：承载状态与重连控制

```go
type MCPServerStatus string

const (
    MCPStatusConnecting   MCPServerStatus = "connecting"
    MCPStatusConnected    MCPServerStatus = "connected"
    MCPStatusReconnecting MCPServerStatus = "reconnecting"
    MCPStatusFailed       MCPServerStatus = "failed"
)

type entry struct {
    session          *mcp.ClientSession
    tools            []*mcp.Tool
    cfg              types.MCPServerConfig // 保存配置供重连使用
    status           MCPServerStatus
    reconnectAttempt int
    lastError        string
    cancelReconnect  context.CancelFunc    // 取消在途重连 goroutine
}
```

对外提供快照查询，供推送和 TUI 使用：

```go
type MCPServerInfo struct {
    Name             string          `json:"name"`
    Status           MCPServerStatus `json:"status"`
    ReconnectAttempt int             `json:"reconnect_attempt,omitempty"`
    Error            string          `json:"error,omitempty"`
    ToolCount        int             `json:"tool_count"`
}

func (m *MCPClientManager) GetServerStatuses() []MCPServerInfo
```

状态变更通过回调往外抛，Manager 不关心谁在听：

```go
func (m *MCPClientManager) SetOnStatusChange(fn func(string, MCPServerStatus, string))
```

### 5.3 指数退避

```go
const (
    maxReconnectAttempts = 5
    initialBackoffMS     = 1_000  // 1s
    maxBackoffMS         = 30_000 // 30s
)

// 等待序列：1s → 2s → 4s → 8s → 16s（上限 30s）
func backoffDuration(attempt int) time.Duration {
    ms := initialBackoffMS * (1 << uint(attempt))
    if ms > maxBackoffMS {
        ms = maxBackoffMS
    }
    return time.Duration(ms) * time.Millisecond
}
```

### 5.4 触发条件与重连循环

采用**被动触发**：`CallTool` 返回 transport 层错误时（区别于 `res.IsError = true` 的工具执行错误）触发重连，暂不做主动心跳。

```go
res, err := e.session.CallTool(callCtx, &mcp.CallToolParams{Name: toolName, Arguments: arguments})
if err != nil {
    // transport 层失败 —— 后台触发重连
    go m.triggerReconnect(serverName, err)
    return types.ToolResult{IsError: true, Content: []types.ContentBlock{
        {Type: "text", Text: fmt.Sprintf("tool call failed (reconnecting): %v", err)},
    }}, nil
}
```

重连 goroutine 的核心逻辑：

```
触发: CallTool err != nil
  1. 加锁：status = reconnecting，attempt++，记录 lastError
  2. 调用 onStatusChange
  3. 启动 goroutine（携带 cancelCtx）：
       loop:
         sleep backoff(attempt)
         尝试 Connect()
         成功 → status = connected，重新 ListTools，更新 tools，通知，退出
         失败 → attempt++
                if attempt >= max → status = failed，通知，退出
                else → 继续 loop
```

两个容易忽略的点：

- **`Close()` 时必须取消在途 goroutine**（调用所有 `cancelReconnect()`），否则会有泄漏的 goroutine 一直重试；
- **状态上报前不要持锁**，避免回调里再访问 Manager 造成死锁。

---

## 六、状态推送与 TUI 展示

### 6.1 新增一个全局事件

状态不属于任何单个 session，所以需要一个「广播给所有连接」的通道：

- `pkg/types/event.go` 新增 `EventMCPStatus = "mcp_status"`；
- gateway 新增 `BroadcastAll` / `BroadcastGlobal`，向所有 WebSocket 连接推送；
- `MCPPlugin` 通过 `SetBroadcaster()` 注入广播函数，在 `onStatusChange` 里组装全量快照后推送。

Payload 采用全量推送（TUI 直接替换本地状态，不做 diff）：

```json
{
  "type": "mcp_status",
  "data": {
    "servers": [
      { "name": "filesystem", "status": "connected", "tool_count": 5 },
      { "name": "my-api", "status": "reconnecting", "reconnect_attempt": 2, "error": "EOF" },
      { "name": "broken-svc", "status": "failed", "error": "connection refused" }
    ]
  }
}
```

发送时机：启动后首次连接结束时推一次，之后任意状态变更各推一次。

### 6.2 TUI 状态栏

TUI 收到 `mcp_status` 后更新 `state.mcpServers`，并按状态着色渲染一行摘要：

```typescript
/** 生成 MCP 状态摘要行，如 "MCP: 3 connected · 1 reconnecting" */
function buildMcpStatusLine(servers: MCPServerInfo[]): string {
  if (servers.length === 0) return "";

  const counts = { connecting: 0, connected: 0, reconnecting: 0, failed: 0 };
  for (const s of servers) counts[s.status]++;

  const parts: string[] = [];
  if (counts.connected)    parts.push(chalk.green(`${counts.connected} connected`));
  if (counts.reconnecting) parts.push(chalk.yellow(`${counts.reconnecting} reconnecting`));
  if (counts.failed)       parts.push(chalk.red(`${counts.failed} failed`));
  if (counts.connecting)   parts.push(chalk.dim(`${counts.connecting} connecting`));

  return parts.length > 0 ? `MCP: ${parts.join(" · ")}` : "";
}
```

效果：

```
opengiraffe tui  ● ws://localhost:9090/ws  session:new
MCP: 3 connected · 1 reconnecting
```

颜色约定：`connected` 绿、`reconnecting` 黄、`failed` 红、`connecting` 灰；计数为 0 的状态不显示，没有 MCP 配置时不显示该行。

---

## 七、验证方案

**单元测试**（`internal/mcp/manager_test.go`）覆盖：

- `backoffDuration` 序列：1s / 2s / 4s / 8s / 16s，超出后封顶 30s；
- `GetServerStatuses` 空集与快照；
- `SetOnStatusChange` 回调触发顺序、未设置回调时空转不 panic；
- `triggerReconnect` 在已 `reconnecting` 状态下的幂等（no-op）。

**编译与测试命令**：

```bash
cd opengiraffe
go build ./...
go test ./internal/mcp/... -race -count=1
golangci-lint run ./internal/mcp/...
```

**集成验证（手动）**：

1. `npx -y @modelcontextprotocol/server-filesystem /tmp` 起一个 filesystem server；
2. 在 `configs/instance.local.yaml` 配置 stdio server；
3. 启动 opengiraffe + TUI，确认状态栏出现 `MCP: 1 connected`；
4. 向 Agent 提问 `/tmp` 目录内容，确认能调用 `mcp__filesystem__list_directory` 并返回结果；
5. kill 掉 MCP 子进程，确认状态栏变为 `MCP: 1 reconnecting` 并随后自动恢复。

---

## 八、风险与注意事项

1. **官方 Go SDK API 仍在演进**：`modelcontextprotocol/go-sdk` 的 `ListTools` / `CallTool` 方法签名需要以实际版本为准。
2. **stdio 子进程管理**：stdio server 是子进程，必须在 `Shutdown()` 中正确关闭，避免僵尸进程。
3. **并发安全**：多个 session 并发调用同一 MCP tool 时，Client 需线程安全（官方 SDK 应保证），Manager 的 `entries` 用 `RWMutex` 保护。
4. **超时控制**：工具调用需设合理超时（建议 30s），防止 MCP Server 无响应把 Agent loop 拖死。
5. **本期不含**：主动心跳、`/mcp reconnect` 手动重连命令、`disabled` 开关、`needs-auth`（OAuth 未实现）。

---

## 小结

整个接入可以拆成两层：

- **能力层**：一个 Plugin + 一个 Manager + 一个 Tool 适配器，就把任意 MCP Server 的工具变成了 Agent 的本地工具，命名统一为 `mcp__<server>__<tool>`；
- **可靠性层**：四态状态机 + 指数退避重连 + 全局事件广播，让「Server 挂了」从「必须重启服务」变成「状态栏上一行黄字，几十秒后自己恢复」。

参考成熟实现（Claude Code）能少走很多弯路，但**适配自家的 Plugin / 事件 / 配置体系才是真正的工作量**——这也是把外部方案「抄」进自己项目时最有价值的部分。
