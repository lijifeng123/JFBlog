# JFBlog MCP 服务器

这是一个 Model Context Protocol (MCP) 服务器，用于自动化发布博客文章到 JFBlog。

## 功能

- 接收 markdown 内容并保存到 `source/_posts/` 目录
- 自动解析或生成 front matter（YAML 头部）
- 自动提交到 Git 仓库
- 自动执行 Hexo 部署

## 安装

```bash
cd mcp-server
npm install
```

## 配置

### 在 Cursor 中配置

在 Cursor 的设置中添加 MCP 服务器配置。编辑 `~/.cursor/mcp.json` 或 Cursor 的 MCP 配置文件：

```json
{
  "mcpServers": {
    "jfblog": {
      "command": "node",
      "args": ["/Users/lijifeng/Desktop/JFBlog/mcp-server/index.js"],
      "env": {}
    }
  }
}
```

**注意**: 请将路径 `/Users/lijifeng/Desktop/JFBlog/mcp-server/index.js` 替换为你的实际路径。

### 在其他 MCP 客户端中配置

根据你使用的 MCP 客户端，按照其文档配置服务器。基本配置需要：
- **命令**: `node`
- **参数**: `[你的项目路径]/mcp-server/index.js`

## 使用方法

配置完成后，你可以在任何支持 MCP 的 AI 助手中使用以下方式发布博客：

### 示例 1: 直接提供 markdown 内容

```
发一篇博客，内容如下：

---
title: 我的新文章
date: 2024-01-01 12:00:00
tags: 技术, 分享
---

这是文章内容...
```

### 示例 2: 不包含 front matter

```
发一篇博客，标题是"测试文章"，内容是：

# 测试文章

这是测试内容...
```

AI 助手会自动：
1. 解析或生成 front matter
2. 保存文件到 `source/_posts/`
3. 执行 `git add`, `git commit`, `git push`
4. 执行 `hexo deploy`

## 工具说明

### `publish_blog_post`

发布一篇博客文章。

**参数**:
- `content` (必需): 博客文章的 markdown 内容
- `title` (可选): 文章标题。如果内容中已有 front matter 包含 title，此参数将被忽略
- `commitMessage` (可选): Git commit 消息。默认为 "发布新文章: {文件名}"
- `skipDeploy` (可选): 是否跳过部署步骤。如果为 true，只保存文件并提交到 git，不执行 hexo deploy

## 注意事项

1. **Git 配置**: 确保你的 Git 已配置好 SSH 密钥或凭据，以便能够 push 到远程仓库
2. **Hexo 环境**: 确保项目根目录已安装 Hexo 依赖（`npm install`）
3. **文件路径**: 确保 MCP 服务器配置中的路径正确
4. **权限**: 确保有权限写入 `source/_posts/` 目录和执行 git 操作

## 故障排除

### Git 操作失败
- 检查 Git 配置和 SSH 密钥
- 确保远程仓库地址正确（在 `_config.yml` 中配置）

### Hexo 部署失败
- 确保已安装 Hexo 依赖: `npm install`
- 检查 `_config.yml` 中的部署配置
- 确保 `hexo-deployer-git` 插件已安装

### 文件保存失败
- 检查 `source/_posts/` 目录是否存在
- 确保有写入权限

## 开发

修改代码后，需要重启 MCP 服务器才能生效。在 Cursor 中，通常需要重启应用或重新加载 MCP 配置。

