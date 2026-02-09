'use strict';

/**
 * 规则：首页默认只展示前 5 行文本，第 6 行位置插入 <!-- more -->。
 * 若文章已手动插入 <!-- more -->，则不再自动插入。
 */
const moreTag = '<!-- more -->';
const rMore = /<!--\s*more\s*-->/i;
const EXCERPT_LINES = 5; // 首页展示前 5 行，more 在第 6 行前

hexo.extend.filter.register('before_post_render', function (data) {
  if (!data.content || rMore.test(data.content)) return data;

  const lines = data.content.split('\n');
  if (lines.length <= EXCERPT_LINES) return data;

  const insertIndex = EXCERPT_LINES; // 第 6 行（0-based 为 5）之前插入
  const head = lines.slice(0, insertIndex).join('\n');
  const tail = lines.slice(insertIndex).join('\n');
  data.content = head + '\n\n' + moreTag + '\n\n' + tail;
  return data;
});
