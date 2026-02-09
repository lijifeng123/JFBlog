#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
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

// Git 操作（捕获 stderr 以便在失败时给用户更具体的提示）
function gitAddCommitPush(fileName, commitMessage) {
  const cwd = BLOG_ROOT;

  try {
    execSync(`git add source/_posts/${fileName}`, { cwd, encoding: "utf-8" });
    const message = commitMessage || `发布新文章: ${fileName}`;
    execSync(`git commit -m "${message}"`, { cwd, encoding: "utf-8" });
    const currentBranch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    execSync(`git push origin ${currentBranch}`, { cwd, encoding: "utf-8" });
    return true;
  } catch (error) {
    const stderr = (error.stderr || error.stdout || error.message || "").toString().trim();
    let hint = "";
    if (/Permission denied|publickey|Authentication failed/i.test(stderr) || /Permission denied|publickey/i.test(error.message))
      hint = "\n\n💡 可能原因：本机未配置 GitHub 推送权限。请配置 SSH 公钥（或 HTTPS Token）后重试。";
    else if (/tell me who you are|user\.name|user\.email/i.test(stderr))
      hint = "\n\n💡 可能原因：未配置 Git 用户信息。请在终端执行：git config --global user.name \"你的名字\" 与 git config --global user.email \"你的邮箱\"";
    throw new Error(`Git 操作失败: ${error.message}${stderr ? "\n" + stderr : ""}${hint}`);
  }
}

// Hexo 部署：-g 表示先 generate 再 deploy，一条命令完成
function hexoDeploy() {
  const cwd = BLOG_ROOT;

  try {
    if (!existsSync(join(cwd, "package.json"))) {
      throw new Error("未找到 Hexo 项目。请确认当前在 JFBlog 项目根目录，且已存在 package.json。");
    }
    execSync("npx hexo deploy -g", { cwd, encoding: "utf-8" });
    return true;
  } catch (error) {
    const stderr = (error.stderr || error.stdout || error.message || "").toString().trim();
    let hint = "";
    if (/command not found|not recognized|ENOENT/i.test(error.message) || /hexo.*not found/i.test(stderr))
      hint = "\n\n💡 可能原因：未安装 Node 或未在项目里安装依赖。请先安装 Node.js，并在 JFBlog 根目录执行：npm install";
    else if (/Permission denied|publickey|Authentication failed/i.test(stderr))
      hint = "\n\n💡 可能原因：推送静态站到 GitHub 时认证失败，请确认本机已配置 GitHub 推送权限（SSH 或 HTTPS Token）。";
    throw new Error(`Hexo 部署失败: ${error.message}${stderr ? "\n" + stderr : ""}${hint}`);
  }
}

// deploy 后把本地生成内容 reset 掉，避免下次发布时被一起提交
function resetGeneratedFiles() {
  const cwd = BLOG_ROOT;
  try {
    execSync("git checkout HEAD -- public db.json", { cwd, encoding: "utf-8", stdio: "pipe" });
  } catch {
    // 若 public/db.json 未跟踪或不存在，忽略
  }
}

// 根据标题或文件名查找文章（返回 { fileName, filePath } 或 null）
function findPostFile(identifier) {
  const raw = (identifier || "").toString().trim();
  if (!raw) return null;
  const withExt = raw.endsWith(".md") ? raw : raw + ".md";
  const pathWithExt = join(POSTS_DIR, withExt);
  if (existsSync(pathWithExt)) return { fileName: withExt, filePath: pathWithExt };
  const byTitle = generateFileName(raw);
  const pathByTitle = join(POSTS_DIR, byTitle);
  if (existsSync(pathByTitle)) return { fileName: byTitle, filePath: pathByTitle };
  const files = readdirSync(POSTS_DIR);
  const match = files.find((f) => f === withExt || f === byTitle || f.replace(/\.md$/, "") === raw.replace(/\.md$/, ""));
  if (match) return { fileName: match, filePath: join(POSTS_DIR, match) };
  return null;
}

// Git 删除文件并提交推送
function gitRemoveCommitPush(fileName, commitMessage) {
  const cwd = BLOG_ROOT;
  try {
    execSync(`git rm "source/_posts/${fileName}"`, { cwd, encoding: "utf-8" });
    const message = commitMessage || `删除文章: ${fileName}`;
    execSync(`git commit -m "${message}"`, { cwd, encoding: "utf-8" });
    const currentBranch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    execSync(`git push origin ${currentBranch}`, { cwd, encoding: "utf-8" });
    return true;
  } catch (error) {
    const stderr = (error.stderr || error.stdout || error.message || "").toString().trim();
    let hint = "";
    if (/Permission denied|publickey|Authentication failed/i.test(stderr) || /Permission denied|publickey/i.test(error.message))
      hint = "\n\n💡 可能原因：本机未配置 GitHub 推送权限。请配置 SSH 公钥（或 HTTPS Token）后重试。";
    else if (/tell me who you are|user\.name|user\.email/i.test(stderr))
      hint = "\n\n💡 可能原因：未配置 Git 用户信息。请在终端执行：git config --global user.name \"你的名字\" 与 git config --global user.email \"你的邮箱\"";
    throw new Error(`Git 操作失败: ${error.message}${stderr ? "\n" + stderr : ""}${hint}`);
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
        description: "发布博客文章。规则：先输出内容预览，等待用户确认；用户确认后（confirm: true）才执行保存、提交、部署。首次调用请传 confirm: false 或省略 confirm，向用户展示预览并提示确认；用户同意后再调用一次并传 confirm: true。",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "博客文章的 markdown 内容。可含 front matter，也可不含（将自动生成）。",
            },
            title: { type: "string", description: "文章标题（可选）。若内容中已有 front matter 的 title 则忽略。" },
            commitMessage: { type: "string", description: "Git commit 消息（可选）。默认：发布新文章: {文件名}" },
            skipDeploy: { type: "boolean", description: "是否跳过部署（可选）。true 则只提交到 git，不执行 hexo deploy。", default: false },
            confirm: {
              type: "boolean",
              description: "是否确认发布。false 或未设置：仅返回预览，不执行任何写操作；true：在用户已确认的前提下执行保存、git 提交与部署。",
              default: false,
            },
          },
          required: ["content"],
        },
      },
      {
        name: "delete_blog_post",
        description: "删除博客文章。规则：先输出将删除的文章信息，等待用户确认；用户确认后（confirm: true）才执行删除、提交、部署。首次调用请传 confirm: false，向用户展示将删除的项并提示确认；用户同意后再调用并传 confirm: true。",
        inputSchema: {
          type: "object",
          properties: {
            post: {
              type: "string",
              description: "要删除的文章标识：可为文件名（如 xxx.md）或标题（如与文件名对应的标题）。",
            },
            commitMessage: { type: "string", description: "Git commit 消息（可选）。默认：删除文章: {文件名}" },
            skipDeploy: { type: "boolean", description: "是否跳过部署。true 则只从仓库删除并推送，不执行 hexo deploy。", default: false },
            confirm: {
              type: "boolean",
              description: "是否确认删除。false 或未设置：仅返回将删除的项预览，不执行删除；true：在用户已确认的前提下执行删除、git 提交与部署。",
              default: false,
            },
          },
          required: ["post"],
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
        resetGeneratedFiles();
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

  if (name === "delete_blog_post") {
    try {
      const { post, commitMessage, skipDeploy = false, confirm = false } = args;
      if (!post) {
        return { content: [{ type: "text", text: "错误: 必须提供 post 参数（要删除的文章文件名或标题）" }], isError: true };
      }
      const found = findPostFile(post);
      if (!found) {
        return {
          content: [{ type: "text", text: `未找到匹配的文章：${post}。请检查文件名或标题是否正确。` }],
          isError: true,
        };
      }
      const { fileName, filePath } = found;
      const contentPreview = readFileSync(filePath, "utf-8");
      const { frontMatter, body } = parseFrontMatter(contentPreview);
      const postTitle = frontMatter.title || fileName.replace(/\.md$/, "");

      if (!confirm) {
        const previewText =
          `🗑️ **删除预览**\n\n` +
          `**将删除文章**: ${postTitle}\n` +
          `**文件名**: ${fileName}\n` +
          `**路径**: ${filePath}\n\n` +
          `**内容预览（前 300 字）**:\n---\n${body.substring(0, 300)}${body.length > 300 ? "..." : ""}\n---\n\n` +
          `⚠️ **请确认是否删除**\n\n` +
          `确认删除后，请再次调用此工具，并设置 \`confirm: true\`。\n\n` +
          `删除后将执行：\n` +
          `1. 删除文件 source/_posts/${fileName}\n` +
          `2. 提交到 Git 仓库\n` +
          `${skipDeploy ? "3. 跳过部署" : "3. 执行 Hexo 部署以更新网站"}`;
        return { content: [{ type: "text", text: previewText }] };
      }

      unlinkSync(filePath);
      gitRemoveCommitPush(fileName, commitMessage);
      let deployResult = "";
      if (!skipDeploy) {
        hexoDeploy();
        resetGeneratedFiles();
        deployResult = "并已重新部署网站。";
      } else {
        deployResult = "（已跳过部署）。";
      }
      return {
        content: [
          {
            type: "text",
            text: `✅ **文章已删除**\n\n**已删除**: ${postTitle}\n**文件名**: ${fileName}\n\n已提交到 Git 仓库${deployResult}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ **删除失败**: ${error.message}\n\n${error.stack || ""}` }],
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

