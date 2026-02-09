#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BLOG_ROOT = join(__dirname, "..");
const POSTS_DIR = join(BLOG_ROOT, "source", "_posts");

// 解析 front matter
function parseFrontMatter(content) {
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontMatterRegex);
  
  if (match) {
    const frontMatterText = match[1];
    const body = match[2];
    const frontMatter = {};
    
    // 简单解析 YAML front matter
    frontMatterText.split("\n").forEach((line) => {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value = line.substring(colonIndex + 1).trim();
        // 移除引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        frontMatter[key] = value;
      }
    });
    
    return { frontMatter, body };
  }
  
  return { frontMatter: {}, body: content };
}

// 生成文件名（从标题）
function generateFileName(title) {
  // 支持中文和英文，移除特殊字符，替换空格为连字符
  return title
    .replace(/[^\w\s\u4e00-\u9fa5-]/g, "") // 保留中文、英文、数字、连字符
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") // 多个连字符合并为一个
    .replace(/^-|-$/g, "") // 移除首尾连字符
    + ".md";
}

// 生成 front matter
function generateFrontMatter(title, date, tags = []) {
  const tagsStr = Array.isArray(tags) ? tags.join(", ") : tags;
  return `---
title: ${title}
date: ${date}
tags: ${tagsStr}
---

`;
}

// 保存文章
function savePost(content, title) {
  const { frontMatter, body } = parseFrontMatter(content);
  
  // 生成当前日期时间字符串的辅助函数
  function getCurrentDateTime() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  }
  
  // 如果没有 front matter，生成一个
  let finalContent;
  if (Object.keys(frontMatter).length === 0) {
    const postTitle = title || "新文章";
    finalContent = generateFrontMatter(postTitle, getCurrentDateTime()) + body;
  } else {
    // 确保有 title
    if (!frontMatter.title && title) {
      frontMatter.title = title;
    }
    // 确保有 date，如果日期是过去的（2024年），更新为当前日期
    if (!frontMatter.date) {
      frontMatter.date = getCurrentDateTime();
    } else {
      // 检查日期是否是过去的年份（比如 2024），如果是则更新为当前日期
      const dateMatch = frontMatter.date.match(/^(\d{4})-/);
      if (dateMatch && parseInt(dateMatch[1]) < new Date().getFullYear()) {
        frontMatter.date = getCurrentDateTime();
      }
    }
    
    // 重新生成 front matter
    const tagsStr = frontMatter.tags || "";
    finalContent = `---
title: ${frontMatter.title}
date: ${frontMatter.date}
tags: ${tagsStr}
---

${body}`;
  }
  
  // 确定文件名
  const fileName = frontMatter.title 
    ? generateFileName(frontMatter.title)
    : (title ? generateFileName(title) : `post-${Date.now()}.md`);
  
  const filePath = join(POSTS_DIR, fileName);
  writeFileSync(filePath, finalContent, "utf-8");
  
  return { filePath, fileName };
}

// Git 操作
function gitAddCommitPush(fileName, commitMessage) {
  const cwd = BLOG_ROOT;
  
  try {
    // git add
    execSync(`git add source/_posts/${fileName}`, { cwd, stdio: "inherit" });
    
    // git commit
    const message = commitMessage || `发布新文章: ${fileName}`;
    execSync(`git commit -m "${message}"`, { cwd, stdio: "inherit" });
    
    // git push - 自动检测当前分支
    const currentBranch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    execSync(`git push origin ${currentBranch}`, { cwd, stdio: "inherit" });
    
    return true;
  } catch (error) {
    throw new Error(`Git 操作失败: ${error.message}`);
  }
}

// Hexo 部署
function hexoDeploy() {
  const cwd = BLOG_ROOT;
  
  try {
    // 确保在正确的目录
    if (!existsSync(join(cwd, "package.json"))) {
      throw new Error("未找到 Hexo 项目");
    }
    
    // 先执行 hexo generate 生成静态文件
    execSync("npx hexo generate", { cwd, stdio: "inherit" });
    
    // 再执行 hexo deploy 部署到 GitHub Pages
    execSync("npx hexo deploy", { cwd, stdio: "inherit" });
    
    // 确保部署仓库正确配置远程并推送
    const deployGitDir = join(cwd, ".deploy_git");
    if (existsSync(deployGitDir)) {
      try {
        // 检查并配置远程仓库
        try {
          execSync("git remote get-url origin", { cwd: deployGitDir, stdio: "pipe" });
        } catch {
          // 如果没有远程仓库，添加它
          execSync("git remote add origin git@github.com:lijifeng123/lijifeng123.github.io.git", { 
            cwd: deployGitDir, 
            stdio: "pipe" 
          });
        }
        
        // 确保远程 URL 正确
        execSync("git remote set-url origin git@github.com:lijifeng123/lijifeng123.github.io.git", { 
          cwd: deployGitDir, 
          stdio: "pipe" 
        });
        
        // 强制推送到远程
        execSync("git push origin main --force", { cwd: deployGitDir, stdio: "inherit" });
      } catch (pushError) {
        // 如果推送失败，记录但不中断流程（hexo deploy 应该已经推送了）
        console.error("额外推送步骤失败（可能已经推送）:", pushError.message);
      }
    }
    
    return true;
  } catch (error) {
    throw new Error(`Hexo 部署失败: ${error.message}`);
  }
}

// 创建 MCP 服务器
const server = new Server(
  {
    name: "jfblog-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出可用工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "publish_blog_post",
        description: "发布一篇博客文章。接收 markdown 内容，保存到 source/_posts/，提交到 git，并执行 hexo 部署。",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "博客文章的 markdown 内容。可以包含 front matter（YAML 头部），也可以不包含。如果不包含，将自动生成。",
            },
            title: {
              type: "string",
              description: "文章标题（可选）。如果内容中已有 front matter 包含 title，此参数将被忽略。",
            },
            commitMessage: {
              type: "string",
              description: "Git commit 消息（可选）。默认为 '发布新文章: {文件名}'",
            },
            skipDeploy: {
              type: "boolean",
              description: "是否跳过部署步骤（可选）。如果为 true，只保存文件并提交到 git，不执行 hexo deploy。",
              default: false,
            },
            confirm: {
              type: "boolean",
              description: "确认发布（必需）。必须设置为 true 才会真正发布文章。如果为 false 或未设置，只会返回预览信息。",
              default: false,
            },
          },
          required: ["content"],
        },
      },
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "publish_blog_post") {
    try {
      const { content, title, commitMessage, skipDeploy = false, confirm = false } = args;
      
      if (!content) {
        return {
          content: [
            {
              type: "text",
              text: "错误: 必须提供 content 参数",
            },
          ],
          isError: true,
        };
      }
      
      // 解析内容以获取预览信息
      const { frontMatter, body } = parseFrontMatter(content);
      const postTitle = frontMatter.title || title || "新文章";
      const postDate = frontMatter.date || "（将自动生成当前日期）";
      const postTags = frontMatter.tags || "（无标签）";
      
      // 生成文件名预览
      function generateFileNamePreview(title) {
        return title
          .replace(/[^\w\s\u4e00-\u9fa5-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          + ".md";
      }
      const previewFileName = generateFileNamePreview(postTitle);
      
      // 如果没有确认，只返回预览
      if (!confirm) {
        const previewText = `📝 **博客文章预览**\n\n` +
          `**标题**: ${postTitle}\n` +
          `**日期**: ${postDate}\n` +
          `**标签**: ${postTags}\n` +
          `**文件名**: ${previewFileName}\n\n` +
          `**内容预览**:\n` +
          `---\n` +
          `${body.substring(0, 500)}${body.length > 500 ? '...' : ''}\n` +
          `---\n\n` +
          `⚠️ **请确认是否发布**\n\n` +
          `如果确认发布，请再次调用此工具，并设置 \`confirm: true\` 参数。\n\n` +
          `发布后将执行以下操作：\n` +
          `1. 保存文件到 source/_posts/${previewFileName}\n` +
          `2. 提交到 Git 仓库\n` +
          `${skipDeploy ? '3. 跳过部署步骤' : '3. 执行 Hexo 部署到网站'}`;
        
        return {
          content: [
            {
              type: "text",
              text: previewText,
            },
          ],
        };
      }
      
      // 确认发布，执行实际操作
      // 保存文章
      const { filePath, fileName } = savePost(content, title);
      
      // Git 操作
      gitAddCommitPush(fileName, commitMessage);
      
      // 部署（如果未跳过）
      let deployResult = "";
      if (!skipDeploy) {
        hexoDeploy();
        deployResult = "并已部署到网站。";
      } else {
        deployResult = "（已跳过部署步骤）。";
      }
      
      return {
        content: [
          {
            type: "text",
            text: `✅ **博客文章发布成功！**\n\n` +
              `**标题**: ${postTitle}\n` +
              `**文件路径**: ${filePath}\n` +
              `**文件名**: ${fileName}\n\n` +
              `已提交到 Git 仓库${deployResult}\n\n` +
              `文章链接: http://blog.lijifeng168.com/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}/${String(new Date().getDate()).padStart(2, '0')}/${previewFileName.replace('.md', '')}/`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ **发布失败**: ${error.message}\n\n${error.stack || ""}`,
          },
        ],
        isError: true,
      };
    }
  }
  
  return {
    content: [
      {
        type: "text",
        text: `未知工具: ${name}`,
      },
    ],
    isError: true,
  };
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("JFBlog MCP 服务器已启动");
}

main().catch((error) => {
  console.error("服务器启动失败:", error);
  process.exit(1);
});

