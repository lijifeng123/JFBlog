# 快速开始指南

## 1. 安装依赖

```bash
cd /Users/lijifeng/Desktop/JFBlog/mcp-server
npm install
```

## 2. 在 Cursor 中配置 MCP 服务器

### 方法 1: 通过 Cursor 设置界面

1. 打开 Cursor
2. 进入设置 (Settings)
3. 找到 MCP 或 Model Context Protocol 相关设置
4. 添加新的 MCP 服务器，配置如下：
   - **名称**: `jfblog`
   - **命令**: `node`
   - **参数**: `/Users/lijifeng/Desktop/JFBlog/mcp-server/index.js`

### 方法 2: 直接编辑配置文件

找到 Cursor 的 MCP 配置文件（通常在 `~/.cursor/mcp.json` 或类似位置），添加：

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

**重要**: 请将路径 `/Users/lijifeng/Desktop/JFBlog/mcp-server/index.js` 替换为你的实际项目路径。

## 3. 重启 Cursor

配置完成后，重启 Cursor 以使配置生效。

## 4. 使用

配置完成后，你可以直接对我说：

```
发一篇博客，内容如下：

---
title: 测试文章
date: 2024-01-01 12:00:00
tags: 测试
---

这是文章内容...
```

或者：

```
发一篇博客，标题是"我的新文章"，内容是：

# 我的新文章

这是文章正文...
```

我会自动帮你：
1. ✅ 保存文件到 `source/_posts/`
2. ✅ 提交到 Git (`git add`, `git commit`, `git push`)
3. ✅ 部署到网站 (`hexo deploy`)

## 5. 验证

配置成功后，你可以问我："你能发布博客吗？" 我应该能够看到 `publish_blog_post` 工具。

## 故障排除

### 如果看不到工具
- 检查配置文件路径是否正确
- 确保已重启 Cursor
- 检查 `mcp-server/index.js` 文件是否存在且可执行

### 如果 Git 操作失败
- 确保已配置 Git SSH 密钥
- 检查远程仓库地址是否正确（在 `_config.yml` 中）

### 如果部署失败
- 确保已安装 Hexo 依赖: `cd /Users/lijifeng/Desktop/JFBlog && npm install`
- 检查 `_config.yml` 中的部署配置

